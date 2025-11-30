#!/usr/bin/env node

/**
 * Proton Drive - List All Files
 * 
 * Lists all files in your Proton Drive.
 */

import * as readline from 'readline';
import {
    ProtonAuth,
    createProtonHttpClient,
    createProtonAccount,
    createSrpModule,
    createOpenPGPCrypto,
    initCrypto,
} from './auth.js';

// ============================================================================
// Interactive Prompt
// ============================================================================

async function prompt(question, hidden = false) {
    if (!hidden) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        return new Promise((resolve) => {
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    }

    return new Promise((resolve) => {
        process.stdout.write(question);
        let password = '';

        if (!process.stdin.isTTY) {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            rl.question('', (answer) => {
                rl.close();
                resolve(answer);
            });
            return;
        }

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (char) => {
            char = char.toString();

            switch (char) {
                case '\n':
                case '\r':
                case '\u0004':
                    process.stdin.setRawMode(false);
                    process.stdin.pause();
                    process.stdin.removeListener('data', onData);
                    process.stdout.write('\n');
                    resolve(password);
                    break;
                case '\u0003':
                    process.stdin.setRawMode(false);
                    process.stdout.write('\n');
                    process.exit(0);
                    break;
                case '\u007F':
                case '\b':
                    if (password.length > 0) {
                        password = password.slice(0, -1);
                    }
                    break;
                default:
                    if (char.charCodeAt(0) >= 32) {
                        password += char;
                    }
                    break;
            }
        };

        process.stdin.on('data', onData);
    });
}

// ============================================================================
// File Listing
// ============================================================================

async function collectFilesRecursively(client, folderUid, path = '') {
    const results = [];

    for await (const node of client.iterateFolderChildren(folderUid)) {
        if (!node.ok) {
            results.push({
                type: 'degraded',
                path: path ? `${path}/<unable to decrypt>` : '<unable to decrypt>',
            });
            continue;
        }

        const nodeData = node.data;
        const fullPath = path ? `${path}/${nodeData.name}` : nodeData.name;

        if (nodeData.type === 'folder') {
            results.push({ type: 'folder', path: fullPath });
            const children = await collectFilesRecursively(client, nodeData.uid, fullPath);
            results.push(...children);
        } else {
            results.push({
                type: 'file',
                path: fullPath,
                size: nodeData.activeRevision?.claimedSize ?? null,
            });
        }
    }

    return results;
}

function formatSize(bytes) {
    if (typeof bytes !== 'number' || bytes === null) return 'unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

// ============================================================================
// Main
// ============================================================================

const DEBUG = true; // Set to false to disable debug logging

async function main() {
    try {
        await initCrypto();

        const username = await prompt('Proton username: ');
        const password = await prompt('Password: ', true);

        if (!username || !password) {
            console.error('Username and password are required.');
            process.exit(1);
        }

        console.log('\nAuthenticating with Proton...');
        const auth = new ProtonAuth();

        let session;
        try {
            session = await auth.login(username, password);
        } catch (error) {
            if (error.requires2FA) {
                const code = await prompt('Enter 2FA code: ');
                await auth.submit2FA(code);
                session = auth.getSession();
            } else {
                throw error;
            }
        }

        console.log(`Logged in as: ${session.user?.Name || username}\n`);

        if (DEBUG) {
            console.log('[DEBUG] Session info:');
            console.log('[DEBUG]   UID:', session.UID);
            console.log('[DEBUG]   UserID:', session.UserID);
            console.log('[DEBUG]   Scope:', session.Scope);
            console.log('[DEBUG]   User.Name:', session.user?.Name);
            console.log('[DEBUG]   User.DisplayName:', session.user?.DisplayName);
            console.log('[DEBUG]   User.Email:', session.user?.Email);
            console.log('[DEBUG]   User.Subscribed:', session.user?.Subscribed);
            console.log('[DEBUG]   User.Services:', session.user?.Services);
            console.log('[DEBUG]   User.DriveEarlyAccess:', session.user?.DriveEarlyAccess);
            console.log('[DEBUG]   Addresses count:', session.addresses?.length);
            console.log('[DEBUG]   Has keyPassword:', !!session.keyPassword);
            console.log('[DEBUG]   Has primaryKey:', !!session.primaryKey);
            console.log('');
        }

        // Load the SDK
        let ProtonDriveClient, MemoryCache;
        try {
            const sdk = await import('@protontech/drive-sdk');
            ProtonDriveClient = sdk.ProtonDriveClient;
            MemoryCache = sdk.MemoryCache;
        } catch (error) {
            console.error('Error: Could not load @protontech/drive-sdk');
            console.error('Make sure the SDK is built: cd ../sdk/js/sdk && pnpm build');
            process.exit(1);
        }

        const httpClient = createProtonHttpClient(session, { debug: DEBUG });
        const account = createProtonAccount(session);
        const srpModule = createSrpModule();
        const openPGPCryptoModule = createOpenPGPCrypto();

        const client = new ProtonDriveClient({
            httpClient,
            entitiesCache: new MemoryCache(),
            cryptoCache: new MemoryCache(),
            account,
            openPGPCryptoModule,
            srpModule,
        });

        console.log('Fetching files...');
        const rootFolder = await client.getMyFilesRootFolder();

        if (!rootFolder.ok) {
            console.error('Failed to get root folder:', rootFolder.error);
            process.exit(1);
        }

        const files = await collectFilesRecursively(client, rootFolder.data.uid);

        console.log('\n=== My Files ===\n');

        if (files.length === 0) {
            console.log('  (empty)');
        } else {
            for (const file of files) {
                if (file.type === 'degraded') {
                    console.log(`[DEGRADED] ${file.path}`);
                } else if (file.type === 'folder') {
                    console.log(`[FOLDER]   ${file.path}/`);
                } else {
                    console.log(`[FILE]     ${file.path} (${formatSize(file.size)})`);
                }
            }
        }

        const totalFiles = files.filter((f) => f.type === 'file').length;
        const totalFolders = files.filter((f) => f.type === 'folder').length;

        console.log('\n---');
        console.log(`Total: ${totalFiles} files, ${totalFolders} folders`);

        await auth.logout();
    } catch (error) {
        console.error('\nError:', error.message);
        if (error.code) {
            console.error('Error code:', error.code);
        }
        process.exit(1);
    }
}

main();
