/**
 * Config Command - Open dashboard settings page or set config values
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'fs';

import {
  CONFIG_FILE,
  ensureConfigDir,
  getConfig,
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
} from '../config.js';
import type { ExcludePattern } from '../config.js';
import { isAlreadyRunning } from '../flags.js';
import { logger } from '../logger.js';
import { chownToEffectiveUser } from '../paths.js';
import { startDashboard } from '../dashboard/server.js';
import { validateGlob, clearRegexCache } from '../sync/exclusions.js';

// Valid config keys that can be set via CLI
const SETTABLE_KEYS = ['dashboard_host', 'dashboard_port', 'sync_concurrency'];

interface ConfigOptions {
  set?: string[];
}

export function configCommand(this: Command, options: ConfigOptions): void {
  // If --set provided, update config and exit
  if (options.set && options.set.length > 0) {
    setConfigValues(options.set);
    return;
  }

  // Otherwise, open settings dashboard (existing behavior)
  const config = getConfig();
  const host = config.dashboard_host ?? DEFAULT_DASHBOARD_HOST;
  const port = config.dashboard_port ?? DEFAULT_DASHBOARD_PORT;
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  const settingsUrl = `http://${displayHost}:${port}/controls`;

  if (isAlreadyRunning()) {
    logger.info(`Dashboard is already running. Open settings at:\n\n  ${settingsUrl}\n`);
    return;
  }

  // Start just the dashboard (not the sync client)
  startDashboard(config);
  logger.info(`Dashboard started. Open settings at:\n\n  ${settingsUrl}\n`);

  // Keep process alive
  process.on('SIGINT', () => {
    logger.info('Stopping dashboard...');
    process.exit(0);
  });
}

function setConfigValues(pairs: string[]): void {
  // Ensure config directory exists before writing
  ensureConfigDir();

  // Load existing config file (raw JSON to preserve unknown fields)
  let configData: Record<string, unknown> = {};
  if (existsSync(CONFIG_FILE)) {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    configData = JSON.parse(content);
  }

  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      logger.error(`Invalid format: ${pair}. Use key=value`);
      process.exit(1);
    }

    const key = pair.substring(0, eqIndex);
    const value = pair.substring(eqIndex + 1);

    if (!SETTABLE_KEYS.includes(key)) {
      logger.error(`Unknown config key: ${key}`);
      logger.info(`Valid keys: ${SETTABLE_KEYS.join(', ')}`);
      process.exit(1);
    }

    // Parse value (number for port/concurrency, string otherwise)
    if (key === 'dashboard_port' || key === 'sync_concurrency') {
      const numValue = parseInt(value, 10);
      if (isNaN(numValue)) {
        logger.error(`${key} must be a number`);
        process.exit(1);
      }
      configData[key] = numValue;
    } else {
      configData[key] = value;
    }

    logger.info(`Set ${key} = ${value}`);
  }

  // Write updated config
  writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 2));
  chownToEffectiveUser(CONFIG_FILE);
  logger.info(`Config saved to ${CONFIG_FILE}`);
}

// ============================================================================
// Exclude Subcommand
// ============================================================================

interface ExcludeOptions {
  path?: string;
  add?: string[];
  remove?: string[];
  list?: boolean;
}

/**
 * Exclude subcommand handler - manage file exclusion patterns
 */
export function excludeCommand(options: ExcludeOptions): void {
  const targetPath = options.path ?? '/';

  // Handle --list
  if (options.list) {
    listExclusions(targetPath);
    return;
  }

  // Handle --add
  if (options.add && options.add.length > 0) {
    addExclusions(targetPath, options.add);
    return;
  }

  // Handle --remove
  if (options.remove && options.remove.length > 0) {
    removeExclusions(targetPath, options.remove);
    return;
  }

  // No action specified, show current exclusions
  listExclusions(targetPath);
}

/**
 * Load config file as raw JSON to preserve unknown fields
 */
function loadConfigRaw(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  const content = readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save config file
 */
function saveConfigRaw(config: Record<string, unknown>): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  chownToEffectiveUser(CONFIG_FILE);
  // Clear regex cache since patterns changed
  clearRegexCache();
}

/**
 * Get exclude_patterns array from config, ensuring it exists
 */
function getExcludePatternsFromRaw(config: Record<string, unknown>): ExcludePattern[] {
  if (!config.exclude_patterns || !Array.isArray(config.exclude_patterns)) {
    return [];
  }
  return config.exclude_patterns as ExcludePattern[];
}

/**
 * Find or create an entry for a specific path
 */
function findOrCreateEntry(patterns: ExcludePattern[], path: string): ExcludePattern {
  let entry = patterns.find((p) => p.path === path);
  if (!entry) {
    entry = { path, globs: [] };
    patterns.push(entry);
  }
  return entry;
}

/**
 * List exclusion patterns
 */
function listExclusions(targetPath: string): void {
  const config = loadConfigRaw();
  const patterns = getExcludePatternsFromRaw(config);

  if (targetPath === '/') {
    // List all exclusions
    if (patterns.length === 0) {
      logger.info('No exclusion patterns configured.');
      logger.info('\nAdd patterns with: proton-drive-sync config exclude --add <pattern>');
      return;
    }

    logger.info('Exclusion patterns:\n');
    for (const entry of patterns) {
      const pathLabel = entry.path === '/' ? '/ (global - all sync dirs)' : entry.path;
      logger.info(`  ${pathLabel}`);
      for (const glob of entry.globs) {
        logger.info(`    - ${glob}`);
      }
    }
  } else {
    // List exclusions for specific path
    const entry = patterns.find((p) => p.path === targetPath);
    if (!entry || entry.globs.length === 0) {
      logger.info(`No exclusion patterns for path: ${targetPath}`);
      return;
    }

    logger.info(`Exclusion patterns for ${targetPath}:\n`);
    for (const glob of entry.globs) {
      logger.info(`  - ${glob}`);
    }
  }
}

/**
 * Add exclusion patterns
 */
function addExclusions(targetPath: string, globs: string[]): void {
  // Validate all patterns first
  for (const glob of globs) {
    const result = validateGlob(glob);
    if (!result.valid) {
      logger.error(`Invalid pattern "${glob}": ${result.error}`);
      process.exit(1);
    }
  }

  const config = loadConfigRaw();
  const patterns = getExcludePatternsFromRaw(config);
  const entry = findOrCreateEntry(patterns, targetPath);

  let addedCount = 0;
  for (const glob of globs) {
    // Skip duplicates silently
    if (!entry.globs.includes(glob)) {
      entry.globs.push(glob);
      addedCount++;
      logger.info(`Added exclusion pattern: ${glob}`);
    }
  }

  if (addedCount === 0) {
    logger.info('All patterns already exist.');
    return;
  }

  config.exclude_patterns = patterns;
  saveConfigRaw(config);

  const pathLabel = targetPath === '/' ? 'global' : targetPath;
  logger.info(`\nSaved ${addedCount} pattern(s) to ${pathLabel} exclusions.`);
}

/**
 * Remove exclusion patterns
 */
function removeExclusions(targetPath: string, globs: string[]): void {
  const config = loadConfigRaw();
  const patterns = getExcludePatternsFromRaw(config);
  const entry = patterns.find((p) => p.path === targetPath);

  if (!entry) {
    logger.info(`No exclusions found for path: ${targetPath}`);
    return;
  }

  let removedCount = 0;
  for (const glob of globs) {
    const index = entry.globs.indexOf(glob);
    if (index !== -1) {
      entry.globs.splice(index, 1);
      removedCount++;
      logger.info(`Removed exclusion pattern: ${glob}`);
    }
  }

  if (removedCount === 0) {
    logger.info('No matching patterns found to remove.');
    return;
  }

  // Remove entry if no globs left
  if (entry.globs.length === 0) {
    const entryIndex = patterns.indexOf(entry);
    patterns.splice(entryIndex, 1);
  }

  config.exclude_patterns = patterns.length > 0 ? patterns : undefined;
  saveConfigRaw(config);

  const pathLabel = targetPath === '/' ? 'global' : targetPath;
  logger.info(`\nRemoved ${removedCount} pattern(s) from ${pathLabel} exclusions.`);
}
