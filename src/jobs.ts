/**
 * Proton Drive Sync - Job Queue
 *
 * Manages the sync job queue for buffered file operations.
 */

import { eq, and, lte, inArray, isNull } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { SyncJobStatus, SyncEventType } from './db/schema.js';
import { createNode } from './api/create.js';
import { deleteNode } from './api/delete.js';
import { logger, isDebugEnabled } from './logger.js';
import { registerSignalHandler, unregisterSignalHandler } from './signals.js';
import type { ProtonDriveClient } from './api/types.js';

// ============================================================================
// Constants
// ============================================================================

// Retry delays in seconds (×4 exponential backoff, capped at ~1 week)
const RETRY_DELAYS_SEC = [
  1,
  4,
  16,
  64,
  256, // ~4 minutes
  1024, // ~17 minutes
  4096, // ~1 hour
  16384, // ~4.5 hours
  65536, // ~18 hours
  262144, // ~3 days
  604800, // ~1 week (cap)
];

const JITTER_FACTOR = 0.25;
const STALE_PROCESSING_MS = 2 * 60 * 1000;
const NETWORK_RETRY_CAP_INDEX = 4;
const REUPLOAD_NEEDED_RETRY_SEC = 256;
const SYNC_CONCURRENCY = 64;

export const ErrorCategory = {
  NETWORK: 'network',
  REUPLOAD_NEEDED: 'reupload_needed',
  OTHER: 'other',
} as const;
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

export interface ErrorClassification {
  category: ErrorCategory;
  maxRetries: number;
}

const MAX_RETRIES: Record<ErrorCategory, number> = {
  [ErrorCategory.OTHER]: RETRY_DELAYS_SEC.length,
  [ErrorCategory.REUPLOAD_NEEDED]: 7,
  [ErrorCategory.NETWORK]: Infinity,
};

// ============================================================================
// Job Queue Functions
// ============================================================================

/**
 * Add a sync job to the queue, or update if one already exists for this localPath.
 * Uses upsert logic: if a job for localPath exists, update it; otherwise insert.
 * No-op if dryRun is true.
 */
export function enqueueJob(
  params: {
    eventType: SyncEventType;
    localPath: string;
    remotePath: string;
  },
  dryRun: boolean
): void {
  if (dryRun) return;

  // Check if job is already being processed (only query if debug enabled)
  if (isDebugEnabled()) {
    const inFlight = db
      .select()
      .from(schema.processingQueue)
      .where(eq(schema.processingQueue.localPath, params.localPath))
      .get();

    if (inFlight) {
      logger.debug(`Job for ${params.localPath} is in-flight, will be re-queued as PENDING`);
    }
  }

  // INSERT ... ON CONFLICT DO UPDATE is a single atomic SQL statement - no transaction needed
  db.insert(schema.syncJobs)
    .values({
      eventType: params.eventType,
      localPath: params.localPath,
      remotePath: params.remotePath,
      status: SyncJobStatus.PENDING,
      retryAt: new Date(),
      nRetries: 0,
      lastError: null,
    })
    .onConflictDoUpdate({
      target: schema.syncJobs.localPath,
      set: {
        eventType: params.eventType,
        remotePath: params.remotePath,
        status: SyncJobStatus.PENDING,
        retryAt: new Date(),
        nRetries: 0,
        lastError: null,
      },
    })
    .run();
}

/**
 * Get the next job to process and atomically mark it as PROCESSING.
 * Cleans up stale processing queue entries first.
 * Returns the job or undefined if no pending jobs.
 */
export function getNextPendingJob(dryRun: boolean = false) {
  const now = new Date();
  const staleThreshold = new Date(Date.now() - STALE_PROCESSING_MS);

  // Clean up stale entries from processing queue (startedAt > 2 min ago)
  const staleCleanup = db
    .delete(schema.processingQueue)
    .where(lte(schema.processingQueue.startedAt, staleThreshold))
    .run();

  if (staleCleanup.changes > 0) {
    logger.debug(`Cleaned up ${staleCleanup.changes} stale processing queue entries`);
  }

  // Transaction: select next PENDING job and mark as PROCESSING atomically
  return db.transaction((tx) => {
    // Select next PENDING job not currently being processed
    // LEFT JOIN with processing_queue and filter for NULL = job not in processing queue
    const job = tx
      .select({
        id: schema.syncJobs.id,
        eventType: schema.syncJobs.eventType,
        localPath: schema.syncJobs.localPath,
        remotePath: schema.syncJobs.remotePath,
        status: schema.syncJobs.status,
        nRetries: schema.syncJobs.nRetries,
        retryAt: schema.syncJobs.retryAt,
        lastError: schema.syncJobs.lastError,
        createdAt: schema.syncJobs.createdAt,
      })
      .from(schema.syncJobs)
      .leftJoin(
        schema.processingQueue,
        eq(schema.syncJobs.localPath, schema.processingQueue.localPath)
      )
      .where(
        and(
          eq(schema.syncJobs.status, SyncJobStatus.PENDING),
          lte(schema.syncJobs.retryAt, now),
          isNull(schema.processingQueue.localPath)
        )
      )
      .orderBy(schema.syncJobs.retryAt)
      .limit(1)
      .get();

    // If no job found or dryRun, return without marking as PROCESSING
    if (!job || dryRun) return job;

    // Mark as PROCESSING and add to processing queue
    tx.update(schema.syncJobs)
      .set({ status: SyncJobStatus.PROCESSING })
      .where(eq(schema.syncJobs.id, job.id))
      .run();
    tx.insert(schema.processingQueue)
      .values({ localPath: job.localPath, startedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.processingQueue.localPath,
        set: { startedAt: new Date() },
      })
      .run();

    return job;
  });
}

/**
 * Mark a job as synced (completed successfully).
 * Only sets SYNCED if status is still PROCESSING (not if a new update set it back to PENDING).
 * Always removes from processing_queue regardless.
 * No-op if dryRun is true.
 */
export function markJobSynced(jobId: number, localPath: string, dryRun: boolean): void {
  if (dryRun) return;

  logger.debug(`Marking job ${jobId} as SYNCED (${localPath})`);

  // Transaction: update status and remove from processing queue
  db.transaction((tx) => {
    tx.update(schema.syncJobs)
      .set({ status: SyncJobStatus.SYNCED, lastError: null })
      .where(
        and(eq(schema.syncJobs.id, jobId), eq(schema.syncJobs.status, SyncJobStatus.PROCESSING))
      )
      .run();
    tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();
  });

  // Separate transaction: cleanup old SYNCED jobs (low watermark: 1024, high watermark: 1280)
  const syncedCount = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.SYNCED))
    .all().length;

  if (syncedCount > 1280) {
    db.transaction((tx) => {
      const oldestSynced = tx
        .select({ id: schema.syncJobs.id })
        .from(schema.syncJobs)
        .where(eq(schema.syncJobs.status, SyncJobStatus.SYNCED))
        .orderBy(schema.syncJobs.id)
        .limit(256)
        .all();

      const idsToDelete = oldestSynced.map((row) => row.id);
      tx.delete(schema.syncJobs).where(inArray(schema.syncJobs.id, idsToDelete)).run();

      logger.debug(`Cleaned up ${idsToDelete.length} old SYNCED jobs`);
    });
  }
}

/**
 * Mark a job as blocked (failed permanently after max retries).
 * Only sets BLOCKED if status is still PROCESSING.
 * Always removes from processing_queue.
 * No-op if dryRun is true.
 */
export function markJobBlocked(
  jobId: number,
  localPath: string,
  error: string,
  dryRun: boolean
): void {
  if (dryRun) return;

  logger.debug(`Marking job ${jobId} as BLOCKED (${localPath})`);

  // Transaction: update status and remove from processing queue
  db.transaction((tx) => {
    tx.update(schema.syncJobs)
      .set({ status: SyncJobStatus.BLOCKED, lastError: error })
      .where(
        and(eq(schema.syncJobs.id, jobId), eq(schema.syncJobs.status, SyncJobStatus.PROCESSING))
      )
      .run();
    tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();
  });
}

/**
 * Set the last error message for a job.
 * No-op if dryRun is true.
 */
function setJobError(jobId: number, error: string, dryRun: boolean): void {
  if (dryRun) return;
  db.update(schema.syncJobs).set({ lastError: error }).where(eq(schema.syncJobs.id, jobId)).run();
}

/** Categorize an error message and return category with max retries */
function categorizeError(error: string): ErrorClassification {
  const lowerError = error.toLowerCase();

  // Check for draft revision error first (more specific)
  if (lowerError.includes('draft revision already exists')) {
    return {
      category: ErrorCategory.REUPLOAD_NEEDED,
      maxRetries: MAX_RETRIES[ErrorCategory.REUPLOAD_NEEDED],
    };
  }

  // Check for network-related errors
  const networkPatterns = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'socket hang up',
    'network',
    'timeout',
    'connection',
  ];
  if (networkPatterns.some((pattern) => lowerError.includes(pattern.toLowerCase()))) {
    return {
      category: ErrorCategory.NETWORK,
      maxRetries: MAX_RETRIES[ErrorCategory.NETWORK],
    };
  }

  return {
    category: ErrorCategory.OTHER,
    maxRetries: MAX_RETRIES[ErrorCategory.OTHER],
  };
}

/**
 * Schedule a job for retry with exponential backoff and jitter.
 * Retry strategy depends on error category:
 * - OTHER: normal backoff, blocks after MAX_RETRIES
 * - NETWORK: backoff capped at 256s, retries indefinitely
 * - DRAFT_REVISION: fixed 128s delay, retries indefinitely
 * Also removes from processing_queue.
 * No-op if dryRun is true.
 */
export function scheduleRetry(
  jobId: number,
  localPath: string,
  nRetries: number,
  errorCategory: ErrorCategory,
  dryRun: boolean
): void {
  if (dryRun) return;

  let delaySec: number;
  let newRetries: number;

  if (errorCategory === ErrorCategory.REUPLOAD_NEEDED) {
    // Fixed 128s delay for draft revision errors
    delaySec = REUPLOAD_NEEDED_RETRY_SEC;
    // Don't increment retries (retry indefinitely)
    newRetries = nRetries;
  } else if (errorCategory === ErrorCategory.NETWORK) {
    // Network errors: backoff capped at 256s
    const effectiveRetries = Math.min(nRetries, NETWORK_RETRY_CAP_INDEX);
    const delayIndex = Math.min(effectiveRetries, RETRY_DELAYS_SEC.length - 1);
    const baseDelaySec = RETRY_DELAYS_SEC[delayIndex];
    const jitterSec = baseDelaySec * JITTER_FACTOR * (Math.random() * 2 - 1);
    delaySec = Math.max(1, baseDelaySec + jitterSec);
    // Cap retries to not increment beyond the cap (retry indefinitely)
    newRetries = Math.min(nRetries + 1, NETWORK_RETRY_CAP_INDEX + 1);
  } else {
    // OTHER: normal backoff
    const delayIndex = Math.min(nRetries, RETRY_DELAYS_SEC.length - 1);
    const baseDelaySec = RETRY_DELAYS_SEC[delayIndex];
    const jitterSec = baseDelaySec * JITTER_FACTOR * (Math.random() * 2 - 1);
    delaySec = Math.max(1, baseDelaySec + jitterSec);
    newRetries = nRetries + 1;
  }

  // Transaction: update job and remove from processing queue
  const retryAt = new Date(Date.now() + delaySec * 1000);

  db.transaction((tx) => {
    tx.update(schema.syncJobs)
      .set({
        status: SyncJobStatus.PENDING,
        nRetries: newRetries,
        retryAt,
      })
      .where(eq(schema.syncJobs.id, jobId))
      .run();
    tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();
  });

  logger.info(`Job ${jobId} scheduled for retry in ${Math.round(delaySec)}s`);
}

/** Helper to delete a node, throws on failure */
async function deleteNodeOrThrow(
  client: ProtonDriveClient,
  remotePath: string
): Promise<{ existed: boolean }> {
  const result = await deleteNode(client, remotePath, false);
  if (!result.success) {
    throw new Error(result.error);
  }
  return { existed: result.existed };
}

/** Helper to create/update a node, throws on failure */
async function createNodeOrThrow(
  client: ProtonDriveClient,
  localPath: string,
  remotePath: string
): Promise<string> {
  const result = await createNode(client, localPath, remotePath);
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.nodeUid!;
}

/** Helper to delete and recreate a node */
async function deleteAndRecreateNode(
  client: ProtonDriveClient,
  localPath: string,
  remotePath: string
): Promise<string> {
  await deleteNodeOrThrow(client, remotePath);
  logger.info(`Deleted node ${remotePath}, now recreating`);
  const nodeUid = await createNodeOrThrow(client, localPath, remotePath);
  logger.info(`Successfully recreated node: ${remotePath} -> ${nodeUid}`);
  return nodeUid;
}

/** Extract error message from unknown error */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Process a single job from the queue.
 * Returns true if a job was processed, false if queue is empty.
 */
export async function processNextJob(client: ProtonDriveClient, dryRun: boolean): Promise<boolean> {
  const job = getNextPendingJob(dryRun);
  if (!job) return false;

  const { id, eventType, localPath, remotePath, nRetries } = job;

  try {
    if (eventType === SyncEventType.DELETE) {
      logger.info(`Deleting: ${remotePath}`);
      const { existed } = await deleteNodeOrThrow(client, remotePath);
      logger.info(existed ? `Deleted: ${remotePath}` : `Already gone: ${remotePath}`);
    } else {
      const typeLabel = eventType === SyncEventType.CREATE ? 'Creating' : 'Updating';
      logger.info(`${typeLabel}: ${remotePath}`);
      const nodeUid = await createNodeOrThrow(client, localPath, remotePath);
      logger.info(`Success: ${remotePath} -> ${nodeUid}`);
    }

    markJobSynced(id, localPath, dryRun);
    return true;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const { category: errorCategory, maxRetries } = categorizeError(errorMessage);

    setJobError(id, errorMessage, dryRun);

    if (errorCategory === ErrorCategory.OTHER && nRetries >= maxRetries) {
      logger.error(
        `Job ${id} (${localPath}) failed permanently after ${maxRetries} retries: ${errorMessage}`
      );
      markJobBlocked(id, localPath, errorMessage, dryRun);
    } else if (errorCategory === ErrorCategory.REUPLOAD_NEEDED && nRetries >= maxRetries) {
      // Proton drive sometimes gets its internal draft revision state corrupted if
      // an upload failed or there was some race condition during uploading. In this case
      // simply delete the node and recreate it seems to fix the issue
      logger.warn(
        `Job ${id} (${localPath}) hit max draft revision retries (${maxRetries}), deleting and recreating`
      );
      try {
        await deleteAndRecreateNode(client, localPath, remotePath);
        markJobSynced(id, localPath, dryRun);
      } catch (recreateError) {
        const recreateErrorMsg = getErrorMessage(recreateError);
        logger.error(`Failed to delete+recreate node: ${recreateErrorMsg}`);
        setJobError(id, recreateErrorMsg, dryRun);
        scheduleRetry(id, localPath, 0, errorCategory, dryRun);
      }
    } else {
      logger.error(`Job ${id} (${localPath}) failed: ${errorMessage}`);
      scheduleRetry(id, localPath, nRetries, errorCategory, dryRun);
    }

    return true;
  }
}

/**
 * Process all pending jobs in the queue with concurrency.
 * Stops processing if a stop signal is received.
 * Returns the number of jobs processed.
 */
export async function processAllPendingJobs(
  client: ProtonDriveClient,
  dryRun: boolean
): Promise<number> {
  let count = 0;
  let stopRequested = false;

  const handleStop = (): void => {
    stopRequested = true;
  };
  registerSignalHandler('stop', handleStop);

  try {
    // Process jobs with up to SYNC_CONCURRENCY in parallel using a worker pool pattern
    const activeJobs = new Set<Promise<boolean>>();

    const startNextJob = (): void => {
      if (stopRequested) return;
      const jobPromise = processNextJob(client, dryRun).then((processed) => {
        activeJobs.delete(jobPromise);
        if (processed) {
          count++;
          startNextJob(); // Replenish the pool
        }
        return processed;
      });
      activeJobs.add(jobPromise);
    };

    // Start initial batch of concurrent jobs
    for (let i = 0; i < SYNC_CONCURRENCY; i++) {
      startNextJob();
    }

    // Wait for pool to drain (all jobs complete or no more jobs available)
    while (activeJobs.size > 0) {
      await Promise.race(activeJobs);
    }
  } finally {
    unregisterSignalHandler('stop', handleStop);
  }

  return count;
}

/**
 * Get counts of jobs by status.
 */
export function getJobCounts(): {
  pending: number;
  processing: number;
  synced: number;
  blocked: number;
} {
  const pending = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.PENDING))
    .all().length;
  const processing = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.PROCESSING))
    .all().length;
  const synced = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.SYNCED))
    .all().length;
  const blocked = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.BLOCKED))
    .all().length;

  return { pending, processing, synced, blocked };
}
