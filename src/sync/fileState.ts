/**
 * Proton Drive Sync - File State Storage
 *
 * Tracks file state (mtime:size) for synced files to detect changes.
 * Used to skip uploads when file content hasn't changed.
 */

import { eq, like } from 'drizzle-orm';
import { type Tx } from '../db/index.js';
import { fileState } from '../db/schema.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

// ============================================================================
// File State CRUD
// ============================================================================

/**
 * Get the stored change token for a local path.
 */
export function getChangeToken(localPath: string, tx: Tx): string | null {
  const result = tx.select().from(fileState).where(eq(fileState.localPath, localPath)).get();
  return result?.changeToken ?? null;
}

/**
 * Delete the stored state for a local path.
 */
export function deleteChangeToken(localPath: string, dryRun: boolean, tx: Tx): void {
  if (dryRun) return;
  tx.delete(fileState).where(eq(fileState.localPath, localPath)).run();
}

/**
 * Delete all stored state under a directory path.
 * Used when a directory is deleted.
 */
export function deleteChangeTokensUnderPath(dirPath: string, tx: Tx): void {
  const pathPrefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  tx.delete(fileState)
    .where(like(fileState.localPath, `${pathPrefix}%`))
    .run();
}

/**
 * Update the local path for stored state (used during rename/move).
 */
export function updateChangeTokenPath(
  oldLocalPath: string,
  newLocalPath: string,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;
  tx.update(fileState)
    .set({ localPath: newLocalPath, updatedAt: new Date() })
    .where(eq(fileState.localPath, oldLocalPath))
    .run();
}

/**
 * Update all stored state under a directory when the directory is renamed.
 * Replaces oldDirPath prefix with newDirPath for all children.
 */
export function updateChangeTokensUnderPath(
  oldDirPath: string,
  newDirPath: string,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;
  const pathPrefix = oldDirPath.endsWith('/') ? oldDirPath : `${oldDirPath}/`;
  const children = tx
    .select()
    .from(fileState)
    .where(like(fileState.localPath, `${pathPrefix}%`))
    .all();

  for (const child of children) {
    const newPath = newDirPath + child.localPath.slice(oldDirPath.length);
    tx.update(fileState)
      .set({ localPath: newPath, updatedAt: new Date() })
      .where(eq(fileState.localPath, child.localPath))
      .run();
  }
}

/**
 * Remove state for paths no longer under any sync directory.
 */
export function cleanupOrphanedChangeTokens(tx: Tx): number {
  const config = getConfig();
  const syncDirs = config.sync_dirs;

  if (syncDirs.length === 0) {
    // No sync dirs configured, clear all state
    tx.delete(fileState).run();
    return 0;
  }

  // Get all state entries
  const allState = tx.select().from(fileState).all();
  let removedCount = 0;

  for (const entry of allState) {
    const isUnderSyncDir = syncDirs.some(
      (dir) =>
        entry.localPath === dir.source_path || entry.localPath.startsWith(`${dir.source_path}/`)
    );

    if (!isUnderSyncDir) {
      tx.delete(fileState).where(eq(fileState.localPath, entry.localPath)).run();
      removedCount++;
    }
  }

  return removedCount;
}

// ============================================================================
// File State - Write Operations
// ============================================================================

/**
 * Store or update the change token for a file after successful sync.
 * Fails silently with a warning log if storage fails.
 */
export function storeChangeToken(
  localPath: string,
  changeToken: string,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;
  try {
    tx.insert(fileState)
      .values({
        localPath,
        changeToken,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: fileState.localPath,
        set: {
          changeToken,
          updatedAt: new Date(),
        },
      })
      .run();
    logger.debug(`Stored change token for ${localPath}`);
  } catch (error) {
    logger.warn(
      `Failed to store change token for ${localPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
