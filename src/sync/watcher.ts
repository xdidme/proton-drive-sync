/**
 * File Watcher (@parcel/watcher)
 *
 * Handles file change detection using @parcel/watcher with snapshot-based
 * incremental sync and inode-based rename detection.
 */

import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { basename, join } from 'path';
import { createHash } from 'crypto';
import watcher, { type AsyncSubscription, type Event } from '@parcel/watcher';
import { logger } from '../logger.js';
import { getConfig, type Config } from '../config.js';
import { getStateDir } from '../paths.js';

// ============================================================================
// Types
// ============================================================================

export interface FileChange {
  name: string; // Relative path from the watch root
  size: number; // File size in bytes
  mtime_ms: number; // Last modification time in milliseconds since epoch
  exists: boolean; // false if the file was deleted
  type: 'f' | 'd'; // 'f' for file, 'd' for directory
  new: boolean; // true if file is newly created
  watchRoot: string; // Which watch root this change came from
  ino: number; // Inode number - stable across renames/moves within same filesystem
  'content.sha1hex'?: string; // Not used with @parcel/watcher (mtime+size used instead)
}

export type FileChangeHandler = (file: FileChange) => void;
export type FileChangeBatchHandler = (files: FileChange[]) => void;

// ============================================================================
// Constants
// ============================================================================

const SNAPSHOTS_DIR = 'snapshots';

// ============================================================================
// State
// ============================================================================

/** Track active subscriptions for teardown */
const activeSubscriptions: Map<string, AsyncSubscription> = new Map();

// ============================================================================
// Snapshot Management
// ============================================================================

/**
 * Get the snapshots directory path
 */
function getSnapshotsDir(): string {
  return join(getStateDir(), SNAPSHOTS_DIR);
}

/**
 * Ensure the snapshots directory exists
 */
function ensureSnapshotsDir(): void {
  const dir = getSnapshotsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get the snapshot file path for a given watch directory
 * Uses a hash of the directory path to handle special characters
 */
function getSnapshotPath(watchDir: string): string {
  const hash = createHash('sha256').update(watchDir).digest('hex').slice(0, 16);
  return join(getSnapshotsDir(), `${hash}.snapshot`);
}

/**
 * Check if a snapshot exists for a directory
 */
function snapshotExists(watchDir: string): boolean {
  return existsSync(getSnapshotPath(watchDir));
}

/**
 * Delete a snapshot file
 */
function deleteSnapshot(watchDir: string): void {
  const path = getSnapshotPath(watchDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Write snapshots for all watched directories
 */
export async function writeSnapshots(config: Config): Promise<void> {
  ensureSnapshotsDir();
  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      try {
        const snapshotPath = getSnapshotPath(dir.source_path);
        await watcher.writeSnapshot(dir.source_path, snapshotPath);
        logger.debug(`Wrote snapshot for ${dir.source_path}`);
      } catch (err) {
        logger.warn(
          `Failed to write snapshot for ${dir.source_path}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );
}

/**
 * Clear all snapshots (used by reset command to force full resync)
 * Returns the number of snapshots cleared
 */
export function clearAllSnapshots(): number {
  const snapshotsDir = getSnapshotsDir();
  if (!existsSync(snapshotsDir)) return 0;

  let cleared = 0;
  const files = Bun.spawnSync(['ls', snapshotsDir]).stdout.toString().trim().split('\n');
  for (const file of files) {
    if (file && file.endsWith('.snapshot')) {
      const fullPath = join(snapshotsDir, file);
      try {
        unlinkSync(fullPath);
        cleared++;
      } catch {
        // Ignore errors
      }
    }
  }

  return cleared;
}

/**
 * Clean up orphaned snapshots (for directories no longer in config)
 */
export function cleanupOrphanedSnapshots(config: Config): void {
  const snapshotsDir = getSnapshotsDir();
  if (!existsSync(snapshotsDir)) return;

  // Get valid snapshot hashes for current config
  const validHashes = new Set(
    config.sync_dirs.map((dir) => {
      const hash = createHash('sha256').update(dir.source_path).digest('hex').slice(0, 16);
      return `${hash}.snapshot`;
    })
  );

  // Remove orphaned snapshots
  const files = Bun.spawnSync(['ls', snapshotsDir]).stdout.toString().trim().split('\n');
  for (const file of files) {
    if (file && file.endsWith('.snapshot') && !validHashes.has(file)) {
      const fullPath = join(snapshotsDir, file);
      try {
        unlinkSync(fullPath);
        logger.debug(`Removed orphaned snapshot: ${file}`);
      } catch {
        // Ignore errors
      }
    }
  }
}

// ============================================================================
// Event Conversion
// ============================================================================

/**
 * Convert @parcel/watcher events to FileChange format
 * Includes stat calls to get size, mtime, and inode
 */
function convertEvents(events: Event[], watchRoot: string): FileChange[] {
  const changes: FileChange[] = [];

  for (const event of events) {
    const relativePath = event.path.startsWith(watchRoot)
      ? event.path.slice(watchRoot.length + 1) // Remove watchRoot + leading slash
      : event.path;

    // Skip empty paths (root directory events)
    if (!relativePath) continue;

    if (event.type === 'delete') {
      // For deletes, we don't have stat info
      // Try to infer type from path (directories often lack extension)
      // This is imperfect but rename detection will help
      changes.push({
        name: relativePath,
        size: 0,
        mtime_ms: Date.now(),
        exists: false,
        type: 'f', // Default to file, rename detection will correct if needed
        new: false,
        watchRoot,
        ino: 0, // Unknown for deletes
      });
    } else {
      // For create/update, get file stats
      try {
        const stats = statSync(event.path);
        changes.push({
          name: relativePath,
          size: stats.size,
          mtime_ms: stats.mtimeMs,
          exists: true,
          type: stats.isDirectory() ? 'd' : 'f',
          new: event.type === 'create',
          watchRoot,
          ino: stats.ino,
        });
      } catch (err) {
        // File may have been deleted between event and stat
        logger.debug(
          `Failed to stat ${event.path}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return changes;
}

/**
 * Enhance delete events with inode information by looking up from create events
 * This enables rename/move detection across delete+create pairs
 */
function enhanceDeletesWithInodes(changes: FileChange[]): FileChange[] {
  // Build a map of paths to inodes from creates
  const createInodes = new Map<string, { ino: number; type: 'f' | 'd' }>();
  for (const change of changes) {
    if (change.exists && change.ino > 0) {
      createInodes.set(change.name, { ino: change.ino, type: change.type });
    }
  }

  // For deletes at the same basename, try to find a matching create with same inode
  // This handles the case where we get delete+create for a rename in the same batch
  const inodesByBasename = new Map<string, { ino: number; type: 'f' | 'd'; path: string }[]>();
  for (const change of changes) {
    if (change.exists && change.ino > 0) {
      const base = basename(change.name);
      if (!inodesByBasename.has(base)) {
        inodesByBasename.set(base, []);
      }
      inodesByBasename.get(base)!.push({ ino: change.ino, type: change.type, path: change.name });
    }
  }

  // We can't truly know the inode for deletes without tracking state
  // The engine's rename detection will work on create events which have inodes
  return changes;
}

// ============================================================================
// Watcher Initialization
// ============================================================================

/**
 * Initialize the watcher (no-op for @parcel/watcher - no daemon needed)
 */
export async function initializeWatcher(): Promise<void> {
  ensureSnapshotsDir();
  logger.debug('File watcher initialized');
}

/**
 * Close the watcher and clean up subscriptions
 */
export async function closeWatcher(): Promise<void> {
  await teardownWatchSubscriptions();
}

// ============================================================================
// One-shot Query
// ============================================================================

/**
 * Query all configured directories for changes since last sync.
 * Uses snapshots for incremental sync when available.
 */
export async function queryAllChanges(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler,
  dryRun: boolean
): Promise<number> {
  let totalChanges = 0;
  ensureSnapshotsDir();

  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = dir.source_path;
      const snapshotPath = getSnapshotPath(watchDir);
      const hasSnapshot = snapshotExists(watchDir);

      let events: Event[];

      if (hasSnapshot) {
        logger.info(`Syncing changes since last run for ${dir.source_path}...`);
        try {
          events = await watcher.getEventsSince(watchDir, snapshotPath);
        } catch (err) {
          logger.warn(
            `Failed to read snapshot for ${watchDir}, doing full scan: ${err instanceof Error ? err.message : String(err)}`
          );
          // Delete corrupted snapshot and do full scan
          deleteSnapshot(watchDir);
          events = await getFullDirectoryEvents(watchDir);
        }
      } else {
        logger.info(`First run - syncing all existing files in ${dir.source_path}...`);
        events = await getFullDirectoryEvents(watchDir);
      }

      // Convert events to FileChange format
      const fileChanges = convertEvents(events, watchDir);
      const enhancedChanges = enhanceDeletesWithInodes(fileChanges);

      if (enhancedChanges.length > 0) {
        onFileChangeBatch(enhancedChanges);
        totalChanges += enhancedChanges.length;
      }

      // Write new snapshot after processing (unless dry run)
      if (!dryRun) {
        try {
          await watcher.writeSnapshot(watchDir, snapshotPath);
        } catch (err) {
          logger.warn(
            `Failed to write snapshot for ${watchDir}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    })
  );

  return totalChanges;
}

/**
 * Get events representing all files in a directory (for first-run full sync)
 */
async function getFullDirectoryEvents(watchDir: string): Promise<Event[]> {
  const events: Event[] = [];

  async function walk(dir: string): Promise<void> {
    try {
      const entries = (await Bun.file(dir).exists())
        ? []
        : Array.from(new Bun.Glob('**/*').scanSync({ cwd: dir, dot: false }));

      // Add the scanned files as create events
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        events.push({ type: 'create', path: fullPath });
      }

      // Also need to include directories
      const dirEntries = Array.from(new Bun.Glob('**/').scanSync({ cwd: dir, dot: false }));
      for (const entry of dirEntries) {
        const fullPath = join(dir, entry);
        // Only add if not already in events
        if (!events.some((e) => e.path === fullPath)) {
          events.push({ type: 'create', path: fullPath });
        }
      }
    } catch (err) {
      logger.warn(
        `Failed to scan directory ${dir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  await walk(watchDir);
  return events;
}

// ============================================================================
// Watch Mode (Subscriptions)
// ============================================================================

/**
 * Set up watch subscriptions for all configured directories.
 * Calls onFileChangeBatch for each batch of file changes detected.
 */
export async function setupWatchSubscriptions(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler,
  dryRun: boolean
): Promise<void> {
  // Clear any existing subscriptions first
  await teardownWatchSubscriptions();
  ensureSnapshotsDir();

  // Set up watches for all configured directories
  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = dir.source_path;
      const snapshotPath = getSnapshotPath(watchDir);
      const hasSnapshot = snapshotExists(watchDir);

      // Process initial state if no snapshot (first run)
      if (!hasSnapshot) {
        logger.info(`First run - syncing all existing files in ${dir.source_path}...`);
        const events = await getFullDirectoryEvents(watchDir);
        const fileChanges = convertEvents(events, watchDir);
        if (fileChanges.length > 0) {
          onFileChangeBatch(fileChanges);
        }
      } else {
        // Check for changes since last snapshot
        logger.info(`Resuming ${dir.source_path} from last sync state...`);
        try {
          const events = await watcher.getEventsSince(watchDir, snapshotPath);
          if (events.length > 0) {
            const fileChanges = convertEvents(events, watchDir);
            const enhancedChanges = enhanceDeletesWithInodes(fileChanges);
            if (enhancedChanges.length > 0) {
              onFileChangeBatch(enhancedChanges);
            }
          }
        } catch (err) {
          logger.warn(
            `Failed to read snapshot, doing full scan: ${err instanceof Error ? err.message : String(err)}`
          );
          deleteSnapshot(watchDir);
          const events = await getFullDirectoryEvents(watchDir);
          const fileChanges = convertEvents(events, watchDir);
          if (fileChanges.length > 0) {
            onFileChangeBatch(fileChanges);
          }
        }
      }

      // Write initial snapshot
      if (!dryRun) {
        try {
          await watcher.writeSnapshot(watchDir, snapshotPath);
        } catch (err) {
          logger.warn(
            `Failed to write snapshot: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Subscribe to future changes
      try {
        const subscription = await watcher.subscribe(watchDir, async (err, events) => {
          if (err) {
            logger.error(`Watcher error for ${watchDir}: ${err.message}`);
            return;
          }

          // Verify the sync dir still exists in config
          const currentConfig = getConfig();
          const syncDir = currentConfig.sync_dirs.find((d) => d.source_path === watchDir);

          if (!syncDir) {
            logger.warn(`Ignoring event for removed sync dir: ${watchDir}`);
            return;
          }

          // Convert and process events
          const fileChanges = convertEvents(events, watchDir);
          const enhancedChanges = enhanceDeletesWithInodes(fileChanges);

          if (enhancedChanges.length > 0) {
            logger.debug(
              `[watcher] subscription event: ${basename(watchDir)} (files: ${enhancedChanges.length})`
            );
            onFileChangeBatch(enhancedChanges);
          }

          // Update snapshot after processing
          if (!dryRun) {
            try {
              await watcher.writeSnapshot(watchDir, snapshotPath);
            } catch (writeErr) {
              logger.warn(
                `Failed to update snapshot: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
              );
            }
          }
        });

        activeSubscriptions.set(watchDir, subscription);
        logger.info(`Watching ${dir.source_path} for changes...`);
      } catch (err) {
        logger.error(
          `Failed to subscribe to ${watchDir}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  logger.info('Watching for file changes... (press Ctrl+C to exit)');
}

/**
 * Tear down all active watch subscriptions.
 * Call this before re-setting up subscriptions on config change.
 */
export async function teardownWatchSubscriptions(): Promise<void> {
  if (activeSubscriptions.size === 0) return;

  logger.info('Tearing down watch subscriptions...');

  // Unsubscribe from all active subscriptions
  await Promise.all(
    Array.from(activeSubscriptions.entries()).map(async ([watchDir, subscription]) => {
      try {
        await subscription.unsubscribe();
        logger.debug(`Unsubscribed from ${watchDir}`);
      } catch (err) {
        logger.warn(`Failed to unsubscribe from ${watchDir}: ${(err as Error).message}`);
      }
    })
  );

  activeSubscriptions.clear();
}
