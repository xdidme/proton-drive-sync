#!/usr/bin/env node

/**
 * Proton Drive - Create File or Directory
 *
 * Creates a file or directory on Proton Drive.
 * - For files: uploads the file content. If the file exists, creates a new revision.
 * - For directories: creates an empty directory. If it exists, does nothing.
 *
 * Path handling:
 * - If the path starts with my_files/, that prefix is stripped.
 * - Parent directories are created automatically if they don't exist.
 */

import { createReadStream, statSync, Stats } from 'fs';
import { Readable } from 'stream';
import { basename, dirname } from 'path';
import { input, password, confirm } from '@inquirer/prompts';
// @ts-expect-error - keychain doesn't have type definitions
import keychain from 'keychain';
import { promisify } from 'util';
import {
    ProtonAuth,
    createProtonHttpClient,
    createProtonAccount,
    createSrpModule,
    createOpenPGPCrypto,
    initCrypto,
} from './auth.js';

// ============================================================================
// Types
// ============================================================================

interface NodeData {
    name: string;
    uid: string;
    type: string;
}

interface NodeResult {
    ok: boolean;
    value?: NodeData;
    error?: unknown;
}

interface RootFolderResult {
    ok: boolean;
    value?: { uid: string };
    error?: unknown;
}

interface UploadController {
    pause(): void;
    resume(): void;
    completion(): Promise<string>;
}

interface FileUploader {
    getAvailableName(): Promise<string>;
    writeStream(
        stream: ReadableStream,
        thumbnails: [],
        onProgress?: (uploadedBytes: number) => void
    ): Promise<UploadController>;
}

interface FileRevisionUploader {
    writeStream(
        stream: ReadableStream,
        thumbnails: [],
        onProgress?: (uploadedBytes: number) => void
    ): Promise<UploadController>;
}

interface UploadMetadata {
    mediaType: string;
    expectedSize: number;
    modificationTime?: Date;
}

interface CreateFolderResult {
    ok: boolean;
    value?: { uid: string };
    error?: unknown;
}

interface ProtonDriveClientType {
    iterateFolderChildren(folderUid: string): AsyncIterable<NodeResult>;
    getMyFilesRootFolder(): Promise<RootFolderResult>;
    createFolder(
        parentNodeUid: string,
        name: string,
        modificationTime?: Date
    ): Promise<CreateFolderResult>;
    getFileUploader(
        parentFolderUid: string,
        name: string,
        metadata: UploadMetadata,
        signal?: AbortSignal
    ): Promise<FileUploader>;
    getFileRevisionUploader(
        nodeUid: string,
        metadata: UploadMetadata,
        signal?: AbortSignal
    ): Promise<FileRevisionUploader>;
}

interface StoredCredentials {
    username: string;
    password: string;
}

interface ApiError extends Error {
    requires2FA?: boolean;
    code?: number;
}

// ============================================================================
// Keychain Helpers
// ============================================================================

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT_PREFIX = 'proton-drive-sync:';

const keychainGetPassword = promisify(keychain.getPassword).bind(keychain);
const keychainSetPassword = promisify(keychain.setPassword).bind(keychain);
const keychainDeletePassword = promisify(keychain.deletePassword).bind(keychain);

async function getStoredCredentials(): Promise<StoredCredentials | null> {
    try {
        const username = await keychainGetPassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
            service: KEYCHAIN_SERVICE,
        });
        const pwd = await keychainGetPassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
            service: KEYCHAIN_SERVICE,
        });
        return { username, password: pwd };
    } catch {
        return null;
    }
}

async function storeCredentials(username: string, pwd: string): Promise<void> {
    await keychainSetPassword({
        account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
        service: KEYCHAIN_SERVICE,
        password: username,
    });
    await keychainSetPassword({
        account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
        service: KEYCHAIN_SERVICE,
        password: pwd,
    });
}

async function deleteStoredCredentials(): Promise<void> {
    try {
        await keychainDeletePassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
            service: KEYCHAIN_SERVICE,
        });
    } catch {
        // Ignore
    }
    try {
        await keychainDeletePassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
            service: KEYCHAIN_SERVICE,
        });
    } catch {
        // Ignore
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a Node.js Readable stream to a Web ReadableStream
 */
function nodeStreamToWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            nodeStream.on('data', (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            nodeStream.on('end', () => {
                controller.close();
            });
            nodeStream.on('error', (err) => {
                controller.error(err);
            });
        },
        cancel() {
            nodeStream.destroy();
        },
    });
}

/**
 * Find an existing file by name in a folder.
 *
 * Note: We iterate through ALL children even after finding a match to ensure
 * the SDK's cache is marked as "children complete". See findFolderByName for details.
 */
async function findFileByName(
    client: ProtonDriveClientType,
    folderUid: string,
    fileName: string
): Promise<string | null> {
    let foundUid: string | null = null;
    for await (const node of client.iterateFolderChildren(folderUid)) {
        if (!foundUid && node.ok && node.value?.name === fileName && node.value.type === 'file') {
            foundUid = node.value.uid;
        }
    }
    return foundUid;
}

/**
 * Find a folder by name in a parent folder.
 * Returns the folder UID if found, null otherwise.
 *
 * Note: We iterate through ALL children even after finding a match to ensure
 * the SDK's cache is marked as "children complete". The SDK only sets the
 * `isFolderChildrenLoaded` flag after full iteration. If we exit early, the
 * cache flag isn't set, and subsequent calls would hit the API again.
 */
async function findFolderByName(
    client: ProtonDriveClientType,
    parentFolderUid: string,
    folderName: string
): Promise<string | null> {
    let foundUid: string | null = null;
    for await (const node of client.iterateFolderChildren(parentFolderUid)) {
        if (
            !foundUid &&
            node.ok &&
            node.value?.type === 'folder' &&
            node.value.name === folderName
        ) {
            foundUid = node.value.uid;
        }
    }
    return foundUid;
}

/**
 * Parse a path and return its components.
 * Strips my_files/ prefix if present.
 * Returns { parentParts: string[], name: string }
 */
function parsePath(localPath: string): { parentParts: string[]; name: string } {
    let relativePath = localPath;

    // Strip my_files/ prefix if present
    if (relativePath.startsWith('my_files/')) {
        relativePath = relativePath.slice('my_files/'.length);
    } else if (relativePath.startsWith('./my_files/')) {
        relativePath = relativePath.slice('./my_files/'.length);
    }

    // Remove trailing slash for directories
    if (relativePath.endsWith('/')) {
        relativePath = relativePath.slice(0, -1);
    }

    const name = basename(relativePath);
    const dirPath = dirname(relativePath);

    // If there's no directory (item is at root), return empty array
    if (dirPath === '.' || dirPath === '') {
        return { parentParts: [], name };
    }

    // Split by / to get folder components
    const parentParts = dirPath.split('/').filter((part) => part.length > 0);
    return { parentParts, name };
}

/**
 * Ensure all directories in the path exist, creating them if necessary.
 * Returns the UID of the final (deepest) folder.
 *
 * This is O(d) API calls where d = path depth, which is unavoidable for tree traversal.
 * Once we need to create a folder, all subsequent folders must be created (no more searching).
 */
async function ensureRemotePath(
    client: ProtonDriveClientType,
    rootFolderUid: string,
    pathParts: string[]
): Promise<string> {
    let currentFolderUid = rootFolderUid;
    let needToCreate = false;

    for (const folderName of pathParts) {
        if (needToCreate) {
            // Once we start creating, all subsequent folders need to be created
            console.log(`  Creating folder: ${folderName}`);
            const result = await client.createFolder(currentFolderUid, folderName);
            if (!result.ok) {
                throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
            }
            currentFolderUid = result.value!.uid;
        } else {
            // Search for existing folder
            const existingFolderUid = await findFolderByName(client, currentFolderUid, folderName);

            if (existingFolderUid) {
                console.log(`  Found existing folder: ${folderName}`);
                currentFolderUid = existingFolderUid;
            } else {
                // Folder doesn't exist, create it and all subsequent folders
                console.log(`  Creating folder: ${folderName}`);
                const result = await client.createFolder(currentFolderUid, folderName);
                if (!result.ok) {
                    throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
                }
                currentFolderUid = result.value!.uid;
                needToCreate = true; // All subsequent folders must be created
            }
        }
    }

    return currentFolderUid;
}

function formatSize(bytes: number): string {
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
// File Upload
// ============================================================================

async function uploadFile(
    client: ProtonDriveClientType,
    targetFolderUid: string,
    localFilePath: string,
    fileName: string,
    fileStat: Stats
): Promise<void> {
    const fileSize = Number(fileStat.size);

    // Check if file already exists in the target folder
    console.log(`Checking if "${fileName}" already exists...`);
    const existingFileUid = await findFileByName(client, targetFolderUid, fileName);

    const metadata: UploadMetadata = {
        mediaType: 'application/octet-stream',
        expectedSize: fileSize,
        modificationTime: fileStat.mtime,
    };

    let uploadController: UploadController;

    if (existingFileUid) {
        console.log(`File exists, uploading new revision...`);

        const revisionUploader = await client.getFileRevisionUploader(existingFileUid, metadata);

        const nodeStream = createReadStream(localFilePath);
        const webStream = nodeStreamToWebStream(nodeStream);

        uploadController = await revisionUploader.writeStream(webStream, [], (uploadedBytes) => {
            const percent = ((uploadedBytes / fileSize) * 100).toFixed(1);
            process.stdout.write(
                `\rUploading: ${formatSize(uploadedBytes)} / ${formatSize(fileSize)} (${percent}%)`
            );
        });
    } else {
        console.log(`File doesn't exist, creating new file...`);

        const fileUploader = await client.getFileUploader(targetFolderUid, fileName, metadata);

        const nodeStream = createReadStream(localFilePath);
        const webStream = nodeStreamToWebStream(nodeStream);

        uploadController = await fileUploader.writeStream(webStream, [], (uploadedBytes) => {
            const percent = ((uploadedBytes / fileSize) * 100).toFixed(1);
            process.stdout.write(
                `\rUploading: ${formatSize(uploadedBytes)} / ${formatSize(fileSize)} (${percent}%)`
            );
        });
    }

    // Wait for completion
    const nodeUid = await uploadController.completion();
    console.log('\n');
    console.log(`Upload complete!`);
    console.log(`Node UID: ${nodeUid}`);
}

// ============================================================================
// Directory Creation
// ============================================================================

async function createDirectory(
    client: ProtonDriveClientType,
    targetFolderUid: string,
    dirName: string
): Promise<void> {
    // Check if directory already exists
    console.log(`Checking if "${dirName}" already exists...`);
    const existingFolderUid = await findFolderByName(client, targetFolderUid, dirName);

    if (existingFolderUid) {
        console.log(`Directory already exists.`);
        console.log(`Node UID: ${existingFolderUid}`);
    } else {
        console.log(`Creating directory: ${dirName}`);
        const result = await client.createFolder(targetFolderUid, dirName);
        if (!result.ok) {
            throw new Error(`Failed to create directory "${dirName}": ${result.error}`);
        }
        console.log(`Directory created!`);
        console.log(`Node UID: ${result.value!.uid}`);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    const localPath = process.argv[2];

    if (!localPath) {
        console.error('Usage: npx ts-node src/create.ts <path>');
        console.error('');
        console.error('Examples:');
        console.error('  npx ts-node src/create.ts my_files/document.txt     # Upload a file');
        console.error('  npx ts-node src/create.ts my_files/photos/          # Create a directory');
        console.error(
            '  npx ts-node src/create.ts my_files/a/b/c/file.txt   # Upload with nested dirs'
        );
        process.exit(1);
    }

    // Check if path exists locally
    let pathStat: Stats | null = null;
    let isDirectory = false;

    try {
        pathStat = statSync(localPath);
        isDirectory = pathStat.isDirectory();
    } catch {
        // Path doesn't exist locally - treat as directory creation if ends with /
        if (localPath.endsWith('/')) {
            isDirectory = true;
        } else {
            console.error(`Error: Path not found: ${localPath}`);
            console.error('For creating a new directory, add a trailing slash: my_files/newdir/');
            process.exit(1);
        }
    }

    const { parentParts, name } = parsePath(localPath);

    if (isDirectory) {
        console.log(`Creating directory: ${localPath}`);
        console.log(`  Name: ${name}`);
        if (parentParts.length > 0) {
            console.log(`  Parent path: ${parentParts.join('/')}`);
        }
    } else {
        console.log(`Uploading file: ${localPath}`);
        console.log(`  Name: ${name}`);
        console.log(`  Size: ${formatSize(pathStat!.size)}`);
        if (parentParts.length > 0) {
            console.log(`  Parent path: ${parentParts.join('/')}`);
        }
    }
    console.log();

    try {
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
            console.error('Username and password are required.');
            process.exit(1);
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
        let sdk: SDKModule;
        try {
            sdk = await import('@protontech/drive-sdk');
        } catch {
            console.error('Error: Could not load @protontech/drive-sdk');
            console.error('Make sure the SDK is built: cd ../sdk/js/sdk && pnpm build');
            process.exit(1);
        }

        const httpClient = createProtonHttpClient(session!);
        const openPGPCryptoModule = createOpenPGPCrypto();
        const account = createProtonAccount(session!, openPGPCryptoModule);
        const srpModuleInstance = createSrpModule();

        const client: ProtonDriveClientType = new sdk.ProtonDriveClient({
            httpClient,
            entitiesCache: new sdk.MemoryCache(),
            cryptoCache: new sdk.MemoryCache(),
            // @ts-expect-error - PrivateKey types differ between openpgp imports
            account,
            // @ts-expect-error - PrivateKey types differ between openpgp imports
            openPGPCryptoModule,
            srpModule: srpModuleInstance,
        });

        // Get root folder
        console.log('Getting root folder...');
        const rootFolder = await client.getMyFilesRootFolder();

        if (!rootFolder.ok) {
            console.error('Failed to get root folder:', rootFolder.error);
            process.exit(1);
        }

        const rootFolderUid = rootFolder.value!.uid;

        // Ensure parent directories exist
        let targetFolderUid = rootFolderUid;

        if (parentParts.length > 0) {
            console.log(`Ensuring parent path exists: ${parentParts.join('/')}`);
            targetFolderUid = await ensureRemotePath(client, rootFolderUid, parentParts);
        }

        // Create file or directory
        if (isDirectory) {
            await createDirectory(client, targetFolderUid, name);
        } else {
            await uploadFile(client, targetFolderUid, localPath, name, pathStat!);
        }

        await auth.logout();
    } catch (error) {
        console.error('\nError:', (error as Error).message);
        if ((error as ApiError).code) {
            console.error('Error code:', (error as ApiError).code);
        }
        process.exit(1);
    }
}

main();
