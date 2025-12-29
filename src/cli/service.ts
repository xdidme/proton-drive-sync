/**
 * Service install/uninstall commands for macOS launchd
 */

import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as readline from 'readline';
import { sendSignal } from '../signals.js';
import { setFlag, clearFlag, hasFlag, FLAGS } from '../flags.js';
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

const SERVICE_NAME = 'com.damianb-bitflipper.proton-drive-sync';
const PLIST_PATH = join(PLIST_DIR, `${SERVICE_NAME}.plist`);

function getBinPathSafe(): string | null {
  const result = Bun.spawnSync(['which', 'proton-drive-sync']);
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim();
}

function generateSyncPlist(binPath: string): string {
  const home = homedir();
  return syncPlistTemplate
    .replace('{{SERVICE_NAME}}', SERVICE_NAME)
    .replace('{{BIN_PATH}}', binPath)
    .replace(/\{\{HOME\}\}/g, home);
}

function loadService(name: string, plistPath: string): void {
  const uid = new TextDecoder().decode(Bun.spawnSync(['id', '-u']).stdout).trim();
  const bootstrap = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, plistPath]);
  if (bootstrap.exitCode !== 0) {
    // Already loaded, try kickstart instead
    Bun.spawnSync(['launchctl', 'kickstart', '-k', `gui/${uid}/${name}`]);
  }
}

function unloadService(name: string, plistPath: string): void {
  const uid = new TextDecoder().decode(Bun.spawnSync(['id', '-u']).stdout).trim();
  const bootout = Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}/${name}`]);
  if (bootout.exitCode !== 0) {
    // Try legacy unload
    Bun.spawnSync(['launchctl', 'unload', plistPath]);
  }
}

export async function serviceInstallCommand(interactive: boolean = true): Promise<void> {
  if (process.platform !== 'darwin') {
    if (interactive) {
      console.error('Error: Service installation is only supported on macOS.');
      process.exit(1);
    }
    return;
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
    return;
  }

  // Create LaunchAgents directory if it doesn't exist
  if (!existsSync(PLIST_DIR)) {
    mkdirSync(PLIST_DIR, { recursive: true });
  }

  // Install proton-drive-sync service
  const installSync = interactive ? await askYesNo('Install proton-drive-sync service?') : true;
  if (installSync) {
    console.log('Installing proton-drive-sync service...');
    if (existsSync(PLIST_PATH)) {
      unloadService(SERVICE_NAME, PLIST_PATH);
    }
    await Bun.write(PLIST_PATH, generateSyncPlist(binPath));
    console.log(`Created: ${PLIST_PATH}`);
    setFlag(FLAGS.SERVICE_INSTALLED);
    loadSyncService();
    console.log('proton-drive-sync service installed and started.');
    console.log('View logs with: proton-drive-sync logs');
  } else {
    console.log('Skipping proton-drive-sync service.');
  }
}

export async function serviceUninstallCommand(interactive: boolean = true): Promise<void> {
  if (process.platform !== 'darwin') {
    if (interactive) {
      console.error('Error: Service uninstallation is only supported on macOS.');
      process.exit(1);
    }
    return;
  }

  // Uninstall proton-drive-sync service
  if (existsSync(PLIST_PATH)) {
    const uninstallSync = interactive
      ? await askYesNo('Uninstall proton-drive-sync service?')
      : true;
    if (uninstallSync) {
      console.log('Uninstalling proton-drive-sync service...');
      unloadSyncService();
      unlinkSync(PLIST_PATH);
      clearFlag(FLAGS.SERVICE_INSTALLED);
      console.log('proton-drive-sync service uninstalled.');
    } else {
      console.log('Skipping proton-drive-sync service.');
    }
  } else if (interactive) {
    console.log('No service is installed.');
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
