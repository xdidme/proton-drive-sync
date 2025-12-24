/**
 * Service install/uninstall commands for macOS launchd
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import * as readline from 'readline';
import { sendSignal } from '../signals.js';
import { setFlag, clearFlag, hasFlag, FLAGS } from '../flags.js';
// @ts-expect-error Bun text imports
import watchmanPlistTemplate from './templates/watchman.plist' with { type: 'text' };
// @ts-expect-error Bun text imports
import syncPlistTemplate from './templates/proton-drive-sync.plist' with { type: 'text' };

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents');

const WATCHMAN_SERVICE_NAME = 'com.github.watchman';
const WATCHMAN_PLIST_PATH = join(PLIST_DIR, `${WATCHMAN_SERVICE_NAME}.plist`);

const SERVICE_NAME = 'com.damianb-bitflipper.proton-drive-sync';
const PLIST_PATH = join(PLIST_DIR, `${SERVICE_NAME}.plist`);

function getWatchmanPathSafe(): string | null {
  try {
    return execSync('which watchman', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function getBinPathSafe(): string | null {
  try {
    return execSync('which proton-drive-sync', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function generateWatchmanPlist(watchmanPath: string): string {
  return watchmanPlistTemplate
    .replace('{{SERVICE_NAME}}', WATCHMAN_SERVICE_NAME)
    .replace('{{WATCHMAN_PATH}}', watchmanPath);
}

function generateSyncPlist(binPath: string): string {
  const home = homedir();
  return syncPlistTemplate
    .replace('{{SERVICE_NAME}}', SERVICE_NAME)
    .replace('{{BIN_PATH}}', binPath)
    .replace(/\{\{HOME\}\}/g, home);
}

function loadService(name: string, plistPath: string): void {
  try {
    execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`, { stdio: 'ignore' });
  } catch {
    // Already loaded, try kickstart instead
    try {
      execSync(`launchctl kickstart -k gui/$(id -u)/${name}`, { stdio: 'ignore' });
    } catch {
      // Ignore
    }
  }
}

function unloadService(name: string, plistPath: string): void {
  try {
    execSync(`launchctl bootout gui/$(id -u)/${name}`, { stdio: 'ignore' });
  } catch {
    // Try legacy unload
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
    } catch {
      // Ignore if not loaded
    }
  }
}

export async function serviceInstallCommand(interactive: boolean = true): Promise<boolean> {
  if (process.platform !== 'darwin') {
    if (interactive) {
      console.error('Error: Service installation is only supported on macOS.');
      process.exit(1);
    }
    return false;
  }

  const binPath = getBinPathSafe();
  if (!binPath) {
    if (interactive) {
      console.error('Error: proton-drive-sync not found in PATH.');
      console.error(
        'Install with: curl -fsSL https://www.damianb.dev/proton-drive-sync/install.sh | bash'
      );
      process.exit(1);
    }
    return false;
  }

  // Create LaunchAgents directory if it doesn't exist
  if (!existsSync(PLIST_DIR)) {
    mkdirSync(PLIST_DIR, { recursive: true });
  }

  let installedAny = false;

  // Ask about watchman service (only in interactive mode)
  if (interactive) {
    const watchmanPath = getWatchmanPathSafe();
    if (!watchmanPath) {
      console.log('Watchman not found in PATH. Skipping watchman service.');
      console.log('Install from: https://facebook.github.io/watchman/docs/install');
    } else {
      const installWatchman = await askYesNo('Install watchman service?');
      if (installWatchman) {
        console.log('Installing watchman service...');
        if (existsSync(WATCHMAN_PLIST_PATH)) {
          unloadService(WATCHMAN_SERVICE_NAME, WATCHMAN_PLIST_PATH);
        }
        writeFileSync(WATCHMAN_PLIST_PATH, generateWatchmanPlist(watchmanPath));
        console.log(`Created: ${WATCHMAN_PLIST_PATH}`);
        loadService(WATCHMAN_SERVICE_NAME, WATCHMAN_PLIST_PATH);
        console.log('Watchman service installed and started.');
        installedAny = true;
      } else {
        console.log('Skipping watchman service.');
      }
    }
  }

  // Install proton-drive-sync service
  const installSync = interactive ? await askYesNo('Install proton-drive-sync service?') : true;
  if (installSync) {
    console.log('Installing proton-drive-sync service...');
    if (existsSync(PLIST_PATH)) {
      unloadService(SERVICE_NAME, PLIST_PATH);
    }
    writeFileSync(PLIST_PATH, generateSyncPlist(binPath));
    console.log(`Created: ${PLIST_PATH}`);
    setFlag(FLAGS.SERVICE_INSTALLED);
    loadSyncService();
    console.log('proton-drive-sync service installed and started.');
    console.log('View logs with: proton-drive-sync logs');
    installedAny = true;
  } else {
    console.log('Skipping proton-drive-sync service.');
  }

  if (!installedAny) {
    console.log('\nNo services were installed.');
  }

  return installedAny;
}

export async function serviceUninstallCommand(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('Error: Service uninstallation is only supported on macOS.');
    process.exit(1);
  }

  let uninstalledAny = false;

  // Ask about watchman service
  if (existsSync(WATCHMAN_PLIST_PATH)) {
    const uninstallWatchman = await askYesNo('Uninstall watchman service?');
    if (uninstallWatchman) {
      console.log('Uninstalling watchman service...');
      unloadService(WATCHMAN_SERVICE_NAME, WATCHMAN_PLIST_PATH);
      unlinkSync(WATCHMAN_PLIST_PATH);
      console.log('Watchman service uninstalled.');
      uninstalledAny = true;
    } else {
      console.log('Skipping watchman service.');
    }
  }

  // Ask about proton-drive-sync service
  if (existsSync(PLIST_PATH)) {
    const uninstallSync = await askYesNo('Uninstall proton-drive-sync service?');
    if (uninstallSync) {
      console.log('Uninstalling proton-drive-sync service...');
      unloadSyncService();
      unlinkSync(PLIST_PATH);
      clearFlag(FLAGS.SERVICE_INSTALLED);
      console.log('proton-drive-sync service uninstalled.');
      uninstalledAny = true;
    } else {
      console.log('Skipping proton-drive-sync service.');
    }
  }

  if (!uninstalledAny) {
    console.log('\nNo services were uninstalled.');
  }
}

/**
 * Check if the service is installed (using flag)
 */
export function isServiceInstalled(): boolean {
  return hasFlag(FLAGS.SERVICE_INSTALLED);
}

/**
 * Load the sync service (enable start on login)
 * Returns true on success, false on failure
 */
export function loadSyncService(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }

  if (!existsSync(PLIST_PATH)) {
    return false;
  }

  try {
    loadService(SERVICE_NAME, PLIST_PATH);
    setFlag(FLAGS.SERVICE_LOADED);
    console.info('Service loaded: will start on login');
    return true;
  } catch {
    return false;
  }
}

/**
 * Unload the sync service (disable start on login)
 * Returns true on success, false on failure
 */
export function unloadSyncService(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }

  if (existsSync(PLIST_PATH)) {
    unloadService(SERVICE_NAME, PLIST_PATH);
  }

  clearFlag(FLAGS.SERVICE_LOADED);
  console.info('Service unloaded: will not start on login');
  return true;
}

export function serviceUnloadCommand(): void {
  if (process.platform !== 'darwin') {
    console.error('Error: Service stop is only supported on macOS.');
    process.exit(1);
  }

  unloadSyncService();
  sendSignal('stop');
  console.log('Service stopped and unloaded. Run `proton-drive-sync service start` to restart.');
}

export function serviceLoadCommand(): void {
  if (process.platform !== 'darwin') {
    console.error('Error: Service start is only supported on macOS.');
    process.exit(1);
  }

  if (!existsSync(PLIST_PATH)) {
    console.error('Service is not installed. Run `proton-drive-sync service install` first.');
    process.exit(1);
  }

  if (loadSyncService()) {
    console.log('Service started.');
  } else {
    console.error('Failed to start service.');
    process.exit(1);
  }
}
