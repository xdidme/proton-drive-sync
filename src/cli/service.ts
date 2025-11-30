/**
 * Service install/uninstall commands for macOS launchd
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents');

const WATCHMAN_SERVICE_NAME = 'com.github.watchman';
const WATCHMAN_PLIST_PATH = join(PLIST_DIR, `${WATCHMAN_SERVICE_NAME}.plist`);

const SERVICE_NAME = 'com.damianb-bitflipper.proton-drive-sync';
const PLIST_PATH = join(PLIST_DIR, `${SERVICE_NAME}.plist`);

function getWatchmanPath(): string {
    try {
        return execSync('which watchman', { encoding: 'utf-8' }).trim();
    } catch {
        console.error('Error: watchman not found in PATH.');
        console.error('Install from: https://facebook.github.io/watchman/docs/install');
        process.exit(1);
    }
}

function getBinPath(): string {
    try {
        return execSync('which proton-drive-sync', { encoding: 'utf-8' }).trim();
    } catch {
        console.error('Error: proton-drive-sync not found in PATH.');
        console.error(
            'Make sure the CLI is installed globally with: npm install -g proton-drive-sync'
        );
        process.exit(1);
    }
}

function generateWatchmanPlist(watchmanPath: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${WATCHMAN_SERVICE_NAME}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${watchmanPath}</string>
      <string>--foreground</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

function generateSyncPlist(binPath: string): string {
    const home = homedir();
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${binPath}</string>
        <string>sync</string>
        <string>--watch</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${home}/Library/Logs/proton-drive-sync.out.log</string>
    <key>StandardErrorPath</key>
    <string>${home}/Library/Logs/proton-drive-sync.err.log</string>
</dict>
</plist>
`;
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

export function serviceInstallCommand(): void {
    if (process.platform !== 'darwin') {
        console.error('Error: Service installation is only supported on macOS.');
        process.exit(1);
    }

    const watchmanPath = getWatchmanPath();
    const binPath = getBinPath();

    // Create LaunchAgents directory if it doesn't exist
    if (!existsSync(PLIST_DIR)) {
        mkdirSync(PLIST_DIR, { recursive: true });
    }

    // Install watchman service
    console.log('Installing watchman service...');
    if (existsSync(WATCHMAN_PLIST_PATH)) {
        unloadService(WATCHMAN_SERVICE_NAME, WATCHMAN_PLIST_PATH);
    }
    writeFileSync(WATCHMAN_PLIST_PATH, generateWatchmanPlist(watchmanPath));
    console.log(`Created: ${WATCHMAN_PLIST_PATH}`);
    loadService(WATCHMAN_SERVICE_NAME, WATCHMAN_PLIST_PATH);
    console.log('Watchman service installed and started.');

    // Install proton-drive-sync service
    console.log('\nInstalling proton-drive-sync service...');
    if (existsSync(PLIST_PATH)) {
        unloadService(SERVICE_NAME, PLIST_PATH);
    }
    writeFileSync(PLIST_PATH, generateSyncPlist(binPath));
    console.log(`Created: ${PLIST_PATH}`);
    loadService(SERVICE_NAME, PLIST_PATH);
    console.log('proton-drive-sync service installed and started.');
    console.log('View logs with: proton-drive-sync logs');
}

export function serviceUninstallCommand(): void {
    if (process.platform !== 'darwin') {
        console.error('Error: Service uninstallation is only supported on macOS.');
        process.exit(1);
    }

    if (!existsSync(PLIST_PATH)) {
        console.log('Service is not installed.');
        process.exit(0);
    }

    // Unload the service
    try {
        execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' });
    } catch {
        // Ignore if not loaded
    }

    // Remove plist file
    unlinkSync(PLIST_PATH);
    console.log('Service uninstalled.');
}

export function serviceStopCommand(): void {
    if (process.platform !== 'darwin') {
        console.error('Error: Service stop is only supported on macOS.');
        process.exit(1);
    }

    // Unload the service to stop it and prevent restart
    if (existsSync(PLIST_PATH)) {
        try {
            execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' });
        } catch {
            // Ignore if not loaded
        }
    }

    // Also kill any running proton-drive-sync processes
    try {
        execSync('pkill -f "proton-drive-sync.*/index.js.*sync"', { stdio: 'ignore' });
    } catch {
        // Ignore if no processes found
    }

    console.log('proton-drive-sync stopped. Run `proton-drive-sync service start` to restart.');
}

export function serviceStartCommand(): void {
    if (process.platform !== 'darwin') {
        console.error('Error: Service start is only supported on macOS.');
        process.exit(1);
    }

    if (!existsSync(PLIST_PATH)) {
        console.error('Service is not installed. Run `proton-drive-sync service install` first.');
        process.exit(1);
    }

    try {
        execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'ignore' });
        console.log('Service started.');
    } catch {
        console.error('Failed to start service.');
        process.exit(1);
    }
}

export function serviceReloadCommand(): void {
    if (process.platform !== 'darwin') {
        console.error('Error: Service reload is only supported on macOS.');
        process.exit(1);
    }

    if (!existsSync(PLIST_PATH)) {
        console.error('Service is not installed. Run `proton-drive-sync service install` first.');
        process.exit(1);
    }

    try {
        execSync(`launchctl stop ${SERVICE_NAME}`, { stdio: 'ignore' });
    } catch {
        // Ignore if not running
    }

    try {
        execSync(`launchctl start ${SERVICE_NAME}`, { stdio: 'ignore' });
        console.log('Service reloaded.');
    } catch {
        console.error('Failed to reload service.');
        process.exit(1);
    }
}
