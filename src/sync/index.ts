/**
 * Sync Module
 *
 * Re-exports all sync-related functionality.
 */

// Engine (orchestration)
export { runOneShotSync, runWatchMode, type SyncOptions } from './engine.js';

// Watcher (file change detection)
export {
  waitForWatchman,
  closeWatchman,
  queryAllChanges,
  setupWatchSubscriptions,
  type FileChange,
  type FileChangeHandler,
} from './watcher.js';

// Queue (job management)
export {
  jobEvents,
  enqueueJob,
  getNextPendingJob,
  markJobSynced,
  markJobBlocked,
  setJobError,
  categorizeError,
  scheduleRetry,
  getJobCounts,
  getRecentJobs,
  getBlockedJobs,
  getProcessingJobs,
  ErrorCategory,
  type Job,
  type JobEvent,
  type JobEventType,
  type ErrorClassification,
} from './queue.js';

// Processor (job execution)
export {
  processAvailableJobs,
  waitForActiveTasks,
  drainQueue,
  setSyncConcurrency,
} from './processor.js';
