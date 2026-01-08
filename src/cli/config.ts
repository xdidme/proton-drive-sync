/**
 * Config Command - Open dashboard settings page or set config values
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'fs';

import {
  CONFIG_FILE,
  ensureConfigDir,
  loadConfig,
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
} from '../config.js';
import { isAlreadyRunning } from '../flags.js';
import { logger } from '../logger.js';
import { chownToEffectiveUser } from '../paths.js';
import { startDashboard } from '../dashboard/server.js';

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
  const config = loadConfig();
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
