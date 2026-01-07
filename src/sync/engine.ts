/**
 * Sync Engine
 *
 * Orchestrates the sync process: coordinates watcher, queue, and processor.
 * Includes inode-based rename/move detection and content hash comparison.
 */

import { join, basename, dirname } from 'path';
import { db } from '../db/index.js';
import { SyncEventType } from '../db/schema.js';
import { logger } from '../logger.js';
import { registerSignalHandler } from '../signals.js';
import { isPaused } from '../flags.js';
import { sendStatusToDashboard } from '../dashboard/server.js';
import { getConfig, onConfigChange } from '../config.js';

import type { Config } from '../config.js';
import type { ProtonDriveClient } from '../proton/types.js';
import {
  initializeWatcher,
  closeWatcher,
  queryAllChanges,
  setupWatchSubscriptions,
  cleanupOrphanedSnapshots,
  type FileChange,
} from './watcher.js';
import { enqueueJob, cleanupOrphanedJobs } from './queue.js';
import {
  processAvailableJobs,
  waitForActiveTasks,
  getActiveTaskCount,
  drainQueue,
  setSyncConcurrency,
} from './processor.js';
import {
  getStoredHash,
  deleteStoredHash,
  deleteStoredHashesUnderPath,
  updateStoredHashesUnderPath,
  cleanupOrphanedHashes,
} from './hashes.js';
import {
  getNodeMapping,
  deleteNodeMapping,
  deleteNodeMappingsUnderPath,
  updateNodeMappingsUnderPath,
  cleanupOrphanedNodeMappings,
} from './nodes.js';
import { JOB_POLL_INTERVAL_MS, SHUTDOWN_TIMEOUT_MS } from './constants.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncOptions {
  config: Config;
  client: ProtonDriveClient;
  dryRun: boolean;
  watch: boolean;
}

interface FileChangeWithPaths extends FileChange {
  localPath: string;
  remotePath: string;
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Build local and remote paths for a file change event.
 */
function buildPaths(file: FileChange, config: Config): { localPath: string; remotePath: string } {
  const localPath = join(file.watchRoot, file.name);

  // Find the sync dir config for this watch root
  const syncDir = config.sync_dirs.find((d) => file.watchRoot.startsWith(d.source_path));
  const remoteRoot = syncDir?.remote_root || '';

  // Build remote path: remote_root/dirName/file.name
  const dirName = basename(file.watchRoot);
  const remotePath = remoteRoot
    ? `${remoteRoot}/${dirName}/${file.name}`
    : `${dirName}/${file.name}`;

  return { localPath, remotePath };
}

// ============================================================================
// Batch File Change Handler
// ============================================================================

/**
 * Process a batch of file change events with rename/move detection.
 */
function handleFileChangeBatch(files: FileChange[], config: Config, dryRun: boolean): void {
  if (files.length === 0) return;

  // Augment files with computed paths
  const filesWithPaths: FileChangeWithPaths[] = files.map((file) => ({
    ...file,
    ...buildPaths(file, config),
  }));

  // Separate events by type
  const deletes = filesWithPaths.filter((f) => !f.exists);
  const creates = filesWithPaths.filter((f) => f.exists && f.new);
  const updates = filesWithPaths.filter((f) => f.exists && !f.new);

  // Build inode maps for rename/move detection
  const deletesByIno = new Map<number, FileChangeWithPaths>();
  for (const file of deletes) {
    deletesByIno.set(file.ino, file);
  }

  const createsByIno = new Map<number, FileChangeWithPaths>();
  for (const file of creates) {
    createsByIno.set(file.ino, file);
  }

  // Match renames/moves (same ino in both maps)
  const renames: Array<{ from: FileChangeWithPaths; to: FileChangeWithPaths }> = [];
  for (const [ino, deleteFile] of deletesByIno) {
    const createFile = createsByIno.get(ino);
    if (createFile) {
      renames.push({ from: deleteFile, to: createFile });
      deletesByIno.delete(ino);
      createsByIno.delete(ino);
    }
  }

  // Identify directory renames in this batch
  const directoryRenames = renames.filter(({ from }) => from.type === 'd');

  // Filter out children whose parent directory is also being renamed in the same batch.
  // When a directory is renamed, Proton Drive moves all children implicitly, so we don't
  // need separate MOVE jobs for them - they would fail with "item already exists".
  const filteredRenames = renames.filter(({ from }) => {
    // Always keep directory renames
    if (from.type === 'd') return true;

    // Check if this file's old path is under any directory being renamed
    for (const { from: dirFrom } of directoryRenames) {
      const oldDirPath = dirFrom.localPath;
      if (from.localPath.startsWith(oldDirPath + '/')) {
        logger.debug(`[skip] child of renamed directory: ${from.name}`);
        return false;
      }
    }
    return true;
  });

  // Process renames/moves (one transaction per event)
  for (const { from, to } of filteredRenames) {
    db.transaction((tx) => {
      const isFile = from.type !== 'd';
      const isSameParent = dirname(from.localPath) === dirname(to.localPath);
      const nodeMapping = getNodeMapping(from.localPath, tx);

      // Check if we need DELETE_AND_CREATE (no mapping, or content changed for files)
      const noMapping = !nodeMapping;
      const storedHash = isFile ? getStoredHash(from.localPath, tx) : null;
      // Use mtime:size as change indicator (no content hashing with @parcel/watcher)
      const newHash = `${to.mtime_ms}:${to.size}`;
      const contentChanged = isFile && storedHash && storedHash !== newHash;

      if (noMapping || contentChanged) {
        const reason = noMapping ? 'no mapping' : 'content changed';
        logger.info(`[delete+create] ${from.name} -> ${to.name} (${reason})`);
        enqueueJob(
          {
            eventType: SyncEventType.DELETE_AND_CREATE,
            localPath: to.localPath,
            remotePath: to.remotePath,
            contentHash: newHash,
            oldLocalPath: from.localPath,
            oldRemotePath: from.remotePath,
          },
          dryRun,
          tx
        );
        deleteStoredHash(from.localPath, dryRun, tx);
        deleteNodeMapping(from.localPath, dryRun, tx);
        if (!isFile) {
          deleteStoredHashesUnderPath(from.localPath, tx);
          deleteNodeMappingsUnderPath(from.localPath, tx);
        }
        return;
      }

      // Pure rename/move (no content change)
      const eventType = isSameParent ? SyncEventType.RENAME : SyncEventType.MOVE;
      const typeLabel = to.type === 'd' ? 'dir' : 'file';
      logger.info(`[${eventType.toLowerCase()}] ${from.name} -> ${to.name} (type: ${typeLabel})`);

      enqueueJob(
        {
          eventType,
          localPath: to.localPath,
          remotePath: to.remotePath,
          contentHash: `${to.mtime_ms}:${to.size}`,
          oldLocalPath: from.localPath,
          oldRemotePath: from.remotePath,
        },
        dryRun,
        tx
      );

      // For directory renames, update all child mappings/hashes to their new paths.
      // The children were filtered out above, so we need to update their paths here.
      if (!isFile) {
        updateNodeMappingsUnderPath(from.localPath, to.localPath, dryRun, tx);
        updateStoredHashesUnderPath(from.localPath, to.localPath, dryRun, tx);
      }
    });
  }

  // Process remaining deletes (one transaction per event)
  for (const file of deletesByIno.values()) {
    db.transaction((tx) => {
      const typeLabel = file.type === 'd' ? 'dir' : 'file';
      logger.info(`[watcher] [delete] ${file.name} (type: ${typeLabel})`);
      logger.debug(
        `[watcher] [delete] ${file.name} (type: ${typeLabel}, ino: ${file.ino}, size: ${file.size})`
      );

      enqueueJob(
        {
          eventType: SyncEventType.DELETE,
          localPath: file.localPath,
          remotePath: file.remotePath,
          contentHash: null,
          oldLocalPath: null,
          oldRemotePath: null,
        },
        dryRun,
        tx
      );

      deleteStoredHash(file.localPath, dryRun, tx);
      deleteNodeMapping(file.localPath, dryRun, tx);
      if (file.type === 'd') {
        deleteStoredHashesUnderPath(file.localPath, tx);
        deleteNodeMappingsUnderPath(file.localPath, tx);
      }
    });
  }

  // Process remaining creates (one transaction per event)
  for (const file of createsByIno.values()) {
    db.transaction((tx) => {
      const typeLabel = file.type === 'd' ? 'dir' : 'file';

      // For files, check if mtime+size already matches stored value (already synced)
      if (file.type !== 'd') {
        const storedHash = getStoredHash(file.localPath, tx);
        const newHash = `${file.mtime_ms}:${file.size}`;
        if (storedHash && storedHash === newHash) {
          logger.debug(`[skip] create mtime+size unchanged: ${file.name}`);
          return;
        }
      } else {
        // For directories, check if we already have a node mapping (already synced)
        const existingMapping = getNodeMapping(file.localPath, tx);
        if (existingMapping) {
          logger.debug(`[skip] create directory already synced: ${file.name}`);
          return;
        }
      }

      logger.info(`[watcher] [create] ${file.name} (type: ${typeLabel})`);
      logger.debug(
        `[watcher] [create] ${file.name} (type: ${typeLabel}, mtime: ${file.mtime_ms}, ino: ${file.ino}, size: ${file.size})`
      );

      enqueueJob(
        {
          eventType: SyncEventType.CREATE,
          localPath: file.localPath,
          remotePath: file.remotePath,
          contentHash: `${file.mtime_ms}:${file.size}`,
          oldLocalPath: null,
          oldRemotePath: null,
        },
        dryRun,
        tx
      );
    });
  }

  // Process updates (one transaction per event, files only)
  for (const file of updates) {
    if (file.type === 'd') {
      // Directory metadata change - skip
      logger.debug(`[skip] directory metadata change: ${file.name}`);
      continue;
    }

    db.transaction((tx) => {
      // File update - compare mtime+size
      const storedHash = getStoredHash(file.localPath, tx);
      const newHash = `${file.mtime_ms}:${file.size}`;

      if (storedHash && storedHash === newHash) {
        // Content unchanged - skip
        logger.debug(`[skip] mtime+size unchanged: ${file.name}`);
        return;
      }

      logger.info(
        `[watcher] [update] ${file.name} (mtime+size: ${storedHash || 'none'} -> ${newHash})`
      );
      logger.debug(
        `[watcher] [update] ${file.name} (mtime+size: ${storedHash || 'none'} -> ${newHash}, ino: ${file.ino})`
      );

      enqueueJob(
        {
          eventType: SyncEventType.UPDATE,
          localPath: file.localPath,
          remotePath: file.remotePath,
          contentHash: newHash,
          oldLocalPath: null,
          oldRemotePath: null,
        },
        dryRun,
        tx
      );
    });
  }
}

// ============================================================================
// One-Shot Sync
// ============================================================================

/**
 * Run a one-shot sync: query all changes and process them.
 */
export async function runOneShotSync(options: SyncOptions): Promise<void> {
  const { config, client, dryRun } = options;

  await initializeWatcher();

  // Clean up stale/orphaned data from previous run
  db.transaction((tx) => {
    cleanupOrphanedJobs(dryRun, tx);
    cleanupOrphanedHashes(tx);
    cleanupOrphanedNodeMappings(tx);
  });

  // Query all changes and enqueue jobs (batch handler)
  const totalChanges = await queryAllChanges(
    config,
    (files) => handleFileChangeBatch(files, config, dryRun),
    dryRun
  );

  if (totalChanges === 0) {
    logger.info('No changes to sync');
    return;
  }

  logger.info(`Found ${totalChanges} changes to sync`);

  // Process all jobs until queue is empty
  await drainQueue(client, dryRun);
  logger.info('Sync complete');

  closeWatcher();
}

// ============================================================================
// Watch Mode
// ============================================================================

/**
 * Run in watch mode: continuously watch for changes and process them.
 */
export async function runWatchMode(options: SyncOptions): Promise<void> {
  const { config, client, dryRun } = options;

  await initializeWatcher();

  // Initialize concurrency from config
  setSyncConcurrency(config.sync_concurrency);

  // Helper to create file change batch handler with current config
  const createBatchHandler = () => (files: FileChange[]) =>
    handleFileChangeBatch(files, getConfig(), dryRun);

  // Clean up stale/orphaned data from previous run
  db.transaction((tx) => {
    cleanupOrphanedJobs(dryRun, tx);
    cleanupOrphanedHashes(tx);
    cleanupOrphanedNodeMappings(tx);
  });
  cleanupOrphanedSnapshots(config);

  // Set up file watching
  await setupWatchSubscriptions(config, createBatchHandler(), dryRun);

  // Wire up config change handlers
  onConfigChange('sync_concurrency', () => {
    setSyncConcurrency(getConfig().sync_concurrency);
  });

  onConfigChange('sync_dirs', async () => {
    logger.info('sync_dirs changed, reinitializing watch subscriptions...');
    const newConfig = getConfig();
    db.transaction((tx) => {
      cleanupOrphanedJobs(dryRun, tx);
      cleanupOrphanedHashes(tx);
      cleanupOrphanedNodeMappings(tx);
    });
    cleanupOrphanedSnapshots(newConfig);
    await setupWatchSubscriptions(newConfig, createBatchHandler(), dryRun);
  });

  // Start the job processor loop
  const processorHandle = startJobProcessorLoop(client, dryRun);

  // Wait for stop signal
  await new Promise<void>((resolve) => {
    const handleStop = (): void => {
      logger.info('Stop signal received, shutting down...');
      resolve();
    };

    const handleSigint = (): void => {
      logger.info('Ctrl+C received, shutting down...');
      resolve();
    };

    registerSignalHandler('stop', handleStop);
    process.once('SIGINT', handleSigint);
  });

  // Cleanup
  await processorHandle.stop();
}

// ============================================================================
// Job Processor Loop
// ============================================================================

interface ProcessorHandle {
  stop: () => Promise<void>;
}

/**
 * Start the job processor loop that polls for pending jobs.
 */
function startJobProcessorLoop(client: ProtonDriveClient, dryRun: boolean): ProcessorHandle {
  let running = true;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let loopCount = 0;
  const processLoop = (): void => {
    loopCount++;

    // Debug log occasionally to ensure the loop is alive
    if (loopCount % 25 === 0) {
      logger.debug('processLoop iteration');
    }
    if (!running) return;

    const paused = isPaused();

    // Always send heartbeat (merged with job processing)
    sendStatusToDashboard({ paused });

    if (!paused) {
      processAvailableJobs(client, dryRun);
    }

    if (running) {
      timeoutId = setTimeout(processLoop, JOB_POLL_INTERVAL_MS);
    }
  };

  // Start the loop
  processLoop();

  return {
    stop: async () => {
      running = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      // Wait for active tasks to complete (with timeout)
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS)
      );
      const result = await Promise.race([
        waitForActiveTasks().then(() => 'done' as const),
        timeoutPromise,
      ]);
      if (result === 'timeout') {
        logger.warn(`Shutdown timeout: ${getActiveTaskCount()} tasks abandoned`);
      }
    },
  };
}
