#!/usr/bin/env node

/**
 * Proton Drive Sync CLI
 */

import { realpathSync } from 'fs';
import { program } from 'commander';
import watchman from 'fb-watchman';
import { input, password, confirm } from '@inquirer/prompts';
import {
    ProtonAuth,
    createProtonHttpClient,
    createProtonAccount,
    createSrpModule,
    createOpenPGPCrypto,
    initCrypto,
} from './auth.js';
import { getStoredCredentials, storeCredentials, deleteStoredCredentials } from './keychain.js';
import { appState, saveState } from './state.js';
import type { ProtonDriveClient, ApiError } from './types.js';
import { createNode } from './create.js';
import { deleteNode } from './delete.js';

// ============================================================================
// Types
// ============================================================================

interface FileChange {
    name: string;
    size: number;
    mtime_ms: number;
    exists: boolean;
    type: 'f' | 'd';
}

// ============================================================================
// Constants
// ============================================================================

const WATCH_DIR = realpathSync('./my_files');
const SUB_NAME = 'proton-drive-sync';

// Debounce time in ms - wait for rapid changes to settle
const DEBOUNCE_MS = 500;

// ============================================================================
// Watchman Client
// ============================================================================

const watchmanClient = new watchman.Client();

// ============================================================================
// Change Queue & Processing
// ============================================================================

// Queue of pending changes (path -> latest change info)
const pendingChanges = new Map<string, FileChange>();
let debounceTimer: NodeJS.Timeout | null = null;
let protonClient: ProtonDriveClient | null = null;
let isProcessing = false;

async function processChanges(): Promise<void> {
    if (isProcessing || !protonClient) return;
    isProcessing = true;

    // Take snapshot of current pending changes
    const changes = new Map(pendingChanges);
    pendingChanges.clear();

    for (const [path, change] of changes) {
        const fullPath = `my_files/${path}`;

        try {
            if (change.exists) {
                // File or directory was created/modified
                const typeLabel = change.type === 'd' ? 'directory' : 'file';
                console.log(`\n[SYNC] Creating/updating ${typeLabel}: ${path}`);

                const result = await createNode(protonClient, fullPath);
                if (result.success) {
                    console.log(`[SYNC] Success: ${path} -> ${result.nodeUid}`);
                } else {
                    console.error(`[SYNC] Failed: ${path} - ${result.error}`);
                }
            } else {
                // File or directory was deleted
                console.log(`\n[SYNC] Deleting: ${path}`);

                const result = await deleteNode(protonClient, fullPath, false);
                if (result.success) {
                    if (result.existed) {
                        console.log(`[SYNC] Deleted: ${path}`);
                    } else {
                        console.log(`[SYNC] Already gone: ${path}`);
                    }
                } else {
                    console.error(`[SYNC] Failed to delete: ${path} - ${result.error}`);
                }
            }
        } catch (error) {
            console.error(`[SYNC] Error processing ${path}:`, (error as Error).message);
        }
    }

    isProcessing = false;

    // If more changes came in while processing, schedule another run
    if (pendingChanges.size > 0) {
        scheduleProcessing();
    }
}

function scheduleProcessing(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        processChanges();
    }, DEBOUNCE_MS);
}

function queueChange(file: FileChange): void {
    const status = file.exists ? (file.type === 'd' ? 'dir changed' : 'changed') : 'deleted';
    const typeLabel = file.type === 'd' ? 'dir' : 'file';
    console.log(`[${status}] ${file.name} (size: ${file.size ?? 0}, type: ${typeLabel})`);

    pendingChanges.set(file.name, file);
    scheduleProcessing();
}

// ============================================================================
// Authentication
// ============================================================================

async function authenticate(): Promise<ProtonDriveClient> {
    await initCrypto();

    let username: string;
    let pwd: string;

    const storedCreds = await getStoredCredentials();

    if (storedCreds) {
        console.log(`Found stored credentials for: ${storedCreds.username}`);
        const useStored = await confirm({
            message: 'Use stored credentials?',
            default: true,
        });

        if (useStored) {
            username = storedCreds.username;
            pwd = storedCreds.password;
        } else {
            username = await input({ message: 'Proton username:' });
            pwd = await password({ message: 'Password:' });
        }
    } else {
        username = await input({ message: 'Proton username:' });
        pwd = await password({ message: 'Password:' });
    }

    if (!username || !pwd) {
        throw new Error('Username and password are required.');
    }

    if (!storedCreds || storedCreds.username !== username || storedCreds.password !== pwd) {
        const saveToKeychain = await confirm({
            message: 'Save credentials to Keychain?',
            default: true,
        });

        if (saveToKeychain) {
            await deleteStoredCredentials();
            await storeCredentials(username, pwd);
            console.log('Credentials saved to Keychain.');
        }
    }

    console.log('\nAuthenticating with Proton...');
    const auth = new ProtonAuth();

    let session;
    try {
        session = await auth.login(username, pwd);
    } catch (error) {
        if ((error as ApiError).requires2FA) {
            const code = await input({ message: 'Enter 2FA code:' });
            await auth.submit2FA(code);
            session = auth.getSession();
        } else {
            throw error;
        }
    }

    console.log(`Logged in as: ${session?.user?.Name || username}\n`);

    // Load the SDK
    type SDKModule = typeof import('@protontech/drive-sdk');
    const sdk: SDKModule = await import('@protontech/drive-sdk');

    // Import telemetry module for silent logging (not exported from main index)
    const telemetryModule = await import('@protontech/drive-sdk/dist/telemetry.js');

    const httpClient = createProtonHttpClient(session!);
    const openPGPCryptoModule = createOpenPGPCrypto();
    const account = createProtonAccount(session!, openPGPCryptoModule);
    const srpModuleInstance = createSrpModule();

    // Create a silent telemetry instance (only log errors)
    const silentTelemetry = new telemetryModule.Telemetry({
        logFilter: new telemetryModule.LogFilter({ globalLevel: telemetryModule.LogLevel.ERROR }),
        logHandlers: [new telemetryModule.ConsoleLogHandler()],
        metricHandlers: [], // No metrics logging
    });

    const client = new sdk.ProtonDriveClient({
        httpClient,
        entitiesCache: new sdk.MemoryCache(),
        cryptoCache: new sdk.MemoryCache(),
        // @ts-expect-error - PrivateKey types differ between openpgp imports
        account,
        // @ts-expect-error - PrivateKey types differ between openpgp imports
        openPGPCryptoModule,
        srpModule: srpModuleInstance,
        telemetry: silentTelemetry,
    });

    return client as unknown as ProtonDriveClient;
}

// ============================================================================
// Watchman Setup
// ============================================================================

function setupWatchman(): void {
    // Step 1: Find root (watch-project)
    watchmanClient.command(['watch-project', WATCH_DIR], (err, resp) => {
        if (err) {
            console.error('Watchman error:', err);
            process.exit(1);
        }

        const watchResp = resp as watchman.WatchProjectResponse;
        const root = watchResp.watch;
        const relative = watchResp.relative_path || '';

        // Step 2: Use saved clock or null for initial sync
        const savedClock = appState.clock;

        if (savedClock) {
            console.log('Resuming from last sync state...');
        } else {
            console.log('First run - syncing all existing files...');
        }

        // Step 3: Build a subscription query
        const sub: Record<string, unknown> = {
            expression: ['anyof', ['type', 'f'], ['type', 'd']], // files and directories
            fields: ['name', 'size', 'mtime_ms', 'exists', 'type'],
        };

        // Only set 'since' if we have a saved clock (otherwise get all files)
        if (savedClock) {
            sub.since = savedClock;
        }

        if (relative) {
            sub.relative_root = relative;
        }

        // Step 4: Register subscription
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (watchmanClient as any).command(['subscribe', root, SUB_NAME, sub], (err: Error | null) => {
            if (err) {
                console.error('Subscribe error:', err);
                process.exit(1);
            }
            console.log('Watching for file changes... (press Ctrl+C to exit)\n');
        });
    });

    // Step 5: Listen for notifications
    watchmanClient.on('subscription', (resp: watchman.SubscriptionResponse) => {
        if (resp.subscription !== SUB_NAME) return;

        // Save the clock from this notification for resume capability
        const clock = (resp as unknown as { clock?: string }).clock;
        if (clock) {
            appState.clock = clock;
            saveState(appState);
        }

        for (const file of resp.files) {
            queueChange(file as unknown as FileChange);
        }
    });

    // Step 6: Handle errors & shutdown
    watchmanClient.on('error', (e: Error) => console.error('Watchman error:', e));
    watchmanClient.on('end', () => {});
}

// ============================================================================
// Commands
// ============================================================================

async function syncCommand(): Promise<void> {
    // Authenticate first
    protonClient = await authenticate();

    // Then setup watchman
    setupWatchman();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        watchmanClient.end();
        process.exit(0);
    });
}

// ============================================================================
// CLI Setup
// ============================================================================

program.name('proton-drive-sync').description('Sync local files to Proton Drive').version('1.0.0');

program.command('sync').description('Watch and sync files to Proton Drive').action(syncCommand);

program.parse();
