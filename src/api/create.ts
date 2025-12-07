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
import type {
  CreateProtonDriveClient,
  UploadMetadata,
  UploadController,
  CreateResult,
} from './types.js';
import {
  parsePath,
  findFileByName,
  findFolderByName,
  nodeStreamToWebStream,
} from './api_helpers.js';
import { logger } from '../logger.js';

// Re-export the client type for backwards compatibility
export type { CreateProtonDriveClient, CreateResult } from './types.js';

// ============================================================================
// Path Creation
// ============================================================================

/**
 * Ensure all directories in the path exist, creating them if necessary.
 * Returns the UID of the final (deepest) folder.
 *
 * This is O(d) API calls where d = path depth, which is unavoidable for tree traversal.
 * Once we need to create a folder, all subsequent folders must be created (no more searching).
 */
async function ensureRemotePath(
  client: CreateProtonDriveClient,
  rootFolderUid: string,
  pathParts: string[]
): Promise<string> {
  logger.debug(`XXX ensureRemotePath: pathParts=${pathParts.join('/')}`);
  let currentFolderUid = rootFolderUid;
  let needToCreate = false;

  for (const folderName of pathParts) {
    if (needToCreate) {
      // Once we start creating, all subsequent folders need to be created
      logger.debug(`XXX ensureRemotePath: creating folder "${folderName}"`);
      const result = await client.createFolder(currentFolderUid, folderName);
      if (!result.ok) {
        throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
      }
      currentFolderUid = result.value!.uid;
      logger.debug(`XXX ensureRemotePath: created folder "${folderName}" uid=${currentFolderUid}`);
    } else {
      // Search for existing folder
      logger.debug(`XXX ensureRemotePath: searching for folder "${folderName}"`);
      const existingFolderUid = await findFolderByName(client, currentFolderUid, folderName);

      if (existingFolderUid) {
        logger.debug(
          `XXX ensureRemotePath: found existing folder "${folderName}" uid=${existingFolderUid}`
        );
        currentFolderUid = existingFolderUid;
      } else {
        // Folder doesn't exist, create it and all subsequent folders
        logger.debug(`XXX ensureRemotePath: folder "${folderName}" not found, creating`);
        const result = await client.createFolder(currentFolderUid, folderName);
        if (!result.ok) {
          throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
        }
        currentFolderUid = result.value!.uid;
        logger.debug(
          `XXX ensureRemotePath: created folder "${folderName}" uid=${currentFolderUid}`
        );
        needToCreate = true; // All subsequent folders must be created
      }
    }
  }

  logger.debug(`XXX ensureRemotePath: done, final uid=${currentFolderUid}`);
  return currentFolderUid;
}

// ============================================================================
// File Upload
// ============================================================================

async function uploadFile(
  client: CreateProtonDriveClient,
  targetFolderUid: string,
  localFilePath: string,
  fileName: string,
  fileStat: Stats
): Promise<string> {
  const fileSize = Number(fileStat.size);
  logger.debug(
    `XXX uploadFile: fileName=${fileName}, size=${fileSize}, targetFolderUid=${targetFolderUid}`
  );

  // Check if file already exists in the target folder
  logger.debug(`XXX uploadFile: checking if file exists`);
  const existingFileUid = await findFileByName(client, targetFolderUid, fileName);

  const metadata: UploadMetadata = {
    mediaType: 'application/octet-stream',
    expectedSize: fileSize,
    modificationTime: fileStat.mtime,
  };

  let uploadController: UploadController;

  if (existingFileUid) {
    logger.debug(`XXX uploadFile: file exists uid=${existingFileUid}, creating revision`);
    const revisionUploader = await client.getFileRevisionUploader(existingFileUid, metadata);
    logger.debug(`XXX uploadFile: got revision uploader`);

    const nodeStream = createReadStream(localFilePath);
    const webStream = nodeStreamToWebStream(nodeStream);

    logger.debug(`XXX uploadFile: starting revision upload`);
    uploadController = await revisionUploader.uploadFromStream(webStream, []);
  } else {
    logger.debug(`XXX uploadFile: file does not exist, creating new file`);
    const fileUploader = await client.getFileUploader(targetFolderUid, fileName, metadata);
    logger.debug(`XXX uploadFile: got file uploader`);

    const nodeStream = createReadStream(localFilePath);
    const webStream = nodeStreamToWebStream(nodeStream);

    logger.debug(`XXX uploadFile: starting file upload`);
    uploadController = await fileUploader.uploadFromStream(webStream, []);
  }

  // Wait for completion
  logger.debug(`XXX uploadFile: waiting for completion`);
  const { nodeUid } = await uploadController.completion();
  logger.debug(`XXX uploadFile: completed, nodeUid=${nodeUid}`);
  return nodeUid;
}

// ============================================================================
// Directory Creation
// ============================================================================

async function createDirectory(
  client: CreateProtonDriveClient,
  targetFolderUid: string,
  dirName: string
): Promise<string> {
  logger.debug(`XXX createDirectory: dirName=${dirName}, targetFolderUid=${targetFolderUid}`);
  // Check if directory already exists
  const existingFolderUid = await findFolderByName(client, targetFolderUid, dirName);

  if (existingFolderUid) {
    logger.debug(`XXX createDirectory: already exists uid=${existingFolderUid}`);
    return existingFolderUid;
  } else {
    logger.debug(`XXX createDirectory: creating new directory`);
    const result = await client.createFolder(targetFolderUid, dirName);
    if (!result.ok) {
      throw new Error(`Failed to create directory "${dirName}": ${result.error}`);
    }
    logger.debug(`XXX createDirectory: created uid=${result.value!.uid}`);
    return result.value!.uid;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a file or directory on Proton Drive.
 *
 * @param client - The Proton Drive client
 * @param localPath - The local file path to read from (e.g., "/Users/foo/my_files/bar.txt")
 * @param remotePath - The remote path on Proton Drive (e.g., "backup/my_files/bar.txt")
 * @returns CreateResult with success status and node UID
 */
export async function createNode(
  client: CreateProtonDriveClient,
  localPath: string,
  remotePath: string
): Promise<CreateResult> {
  logger.debug(`XXX createNode: localPath=${localPath}, remotePath=${remotePath}`);

  // Check if path exists locally
  let pathStat: Stats | null = null;
  let isDirectory = false;

  try {
    pathStat = statSync(localPath);
    isDirectory = pathStat.isDirectory();
    logger.debug(`XXX createNode: local stat isDirectory=${isDirectory}, size=${pathStat.size}`);
  } catch {
    // Path doesn't exist locally - treat as directory creation if ends with /
    if (remotePath.endsWith('/')) {
      isDirectory = true;
      logger.debug(`XXX createNode: local path not found, treating as directory (trailing slash)`);
    } else {
      logger.debug(`XXX createNode: local path not found, returning error`);
      return {
        success: false,
        error: `Local path not found: ${localPath}. For creating a new directory, add a trailing slash to remotePath.`,
        isDirectory: false,
      };
    }
  }

  const { parentParts, name } = parsePath(remotePath);
  logger.debug(`XXX createNode: parentParts=${parentParts.join('/')}, name=${name}`);

  // Get root folder
  logger.debug(`XXX createNode: getting root folder`);
  const rootFolder = await client.getMyFilesRootFolder();

  if (!rootFolder.ok) {
    logger.debug(`XXX createNode: failed to get root folder: ${rootFolder.error}`);
    return {
      success: false,
      error: `Failed to get root folder: ${rootFolder.error}`,
      isDirectory,
    };
  }

  const rootFolderUid = rootFolder.value!.uid;
  logger.debug(`XXX createNode: rootFolderUid=${rootFolderUid}`);

  // Ensure parent directories exist
  let targetFolderUid = rootFolderUid;

  if (parentParts.length > 0) {
    logger.debug(`XXX createNode: ensuring parent path exists`);
    targetFolderUid = await ensureRemotePath(client, rootFolderUid, parentParts);
  }

  logger.debug(`XXX createNode: targetFolderUid=${targetFolderUid}`);

  // Create file or directory
  try {
    if (isDirectory) {
      logger.debug(`XXX createNode: creating directory`);
      const nodeUid = await createDirectory(client, targetFolderUid, name);
      logger.debug(`XXX createNode: directory created, nodeUid=${nodeUid}`);
      return { success: true, nodeUid, isDirectory: true };
    } else {
      logger.debug(`XXX createNode: uploading file`);
      const nodeUid = await uploadFile(client, targetFolderUid, localPath, name, pathStat!);
      logger.debug(`XXX createNode: file uploaded, nodeUid=${nodeUid}`);
      return { success: true, nodeUid, isDirectory: false };
    }
  } catch (error) {
    logger.debug(`XXX createNode: error: ${(error as Error).message}`);
    return {
      success: false,
      error: (error as Error).message,
      isDirectory,
    };
  }
}
