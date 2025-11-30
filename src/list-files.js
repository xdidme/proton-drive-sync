#!/usr/bin/env node

/**
 * Proton Drive - List All Files
 * 
 * Lists all files in your Proton Drive.
 */

import { input, password, confirm } from '@inquirer/prompts';
import keytar from 'keytar';
import {
    ProtonAuth,
    createProtonHttpClient,
    createProtonAccount,
    createSrpModule,
    createOpenPGPCrypto,
    initCrypto,
} from './auth.js';

// ============================================================================
// Keychain Helpers
// ============================================================================

const KEYCHAIN_SERVICE = 'proton-drive-sync';

async function getStoredCredentials() {
    const credentials = await keytar.findCredentials(KEYCHAIN_SERVICE);
    if (credentials.length > 0) {
        return {
            username: credentials[0].account,
            password: credentials[0].password,
        };
    }
    return null;
}

async function storeCredentials(username, pwd) {
    await keytar.setPassword(KEYCHAIN_SERVICE, username, pwd);
}

async function deleteStoredCredentials() {
    const credentials = await keytar.findCredentials(KEYCHAIN_SERVICE);
    for (const cred of credentials) {
        await keytar.deletePassword(KEYCHAIN_SERVICE, cred.account);
    }
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

        const nodeData = node.value;
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

async function main() {
    try {
        await initCrypto();

        let username, pwd;
        
        // Check for stored credentials in Keychain
        const storedCreds = await getStoredCredentials();
        
        if (storedCreds) {
            console.log(`Found stored credentials for: ${storedCreds.username}`);
            const useStored = await confirm({ 
                message: 'Use stored credentials?',
                default: true 
            });
            
            if (useStored) {
                username = storedCreds.username;
                pwd = storedCreds.password;
            } else {
                // Ask if they want to enter new credentials
                username = await input({ message: 'Proton username:' });
                pwd = await password({ message: 'Password:' });
            }
        } else {
            username = await input({ message: 'Proton username:' });
            pwd = await password({ message: 'Password:' });
        }

        if (!username || !pwd) {
            console.error('Username and password are required.');
            process.exit(1);
        }
        
        // Offer to save credentials if they're new
        if (!storedCreds || storedCreds.username !== username || storedCreds.password !== pwd) {
            const saveToKeychain = await confirm({
                message: 'Save credentials to Keychain?',
                default: true
            });
            
            if (saveToKeychain) {
                await deleteStoredCredentials(); // Remove old credentials first
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
            if (error.requires2FA) {
                const code = await input({ message: 'Enter 2FA code:' });
                await auth.submit2FA(code);
                session = auth.getSession();
            } else {
                throw error;
            }
        }

        console.log(`Logged in as: ${session.user?.Name || username}\n`);

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

        const httpClient = createProtonHttpClient(session);
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

        const files = await collectFilesRecursively(client, rootFolder.value.uid);

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
