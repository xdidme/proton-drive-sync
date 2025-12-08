/**
 * Dashboard Server - Spawns dashboard as a separate process
 *
 * The dashboard runs in its own Node.js process for true parallelism,
 * communicating via IPC for job events.
 */

import { fork, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { jobEvents, type JobEvent } from '../sync/queue.js';
import { logger } from '../logger.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Accumulate diffs for this interval before sending to child
const DIFF_ACCUMULATE_MS = 100;

// ============================================================================
// Diff Types - Accumulated changes to send to frontend
// ============================================================================

/** A job item for display in the dashboard */
export interface DashboardJob {
  id: number;
  localPath: string;
  remotePath?: string | null;
  lastError?: string | null;
  nRetries?: number;
  createdAt?: Date;
}

/** Accumulated changes to send to frontend */
export interface DashboardDiff {
  /** Stats deltas: positive = increment, negative = decrement */
  statsDelta: {
    pending: number;
    processing: number;
    synced: number;
    blocked: number;
  };
  /** Jobs to add to the processing list */
  addProcessing: DashboardJob[];
  /** Job IDs to remove from the processing list */
  removeProcessing: number[];
  /** Jobs to add to the recent (synced) list */
  addRecent: DashboardJob[];
  /** Jobs to add to the blocked list */
  addBlocked: DashboardJob[];
}

/** Create an empty diff */
function createEmptyDiff(): DashboardDiff {
  return {
    statsDelta: { pending: 0, processing: 0, synced: 0, blocked: 0 },
    addProcessing: [],
    removeProcessing: [],
    addRecent: [],
    addBlocked: [],
  };
}

/** Check if a diff has any changes worth sending */
function hasDiffChanges(diff: DashboardDiff): boolean {
  return (
    diff.statsDelta.pending !== 0 ||
    diff.statsDelta.processing !== 0 ||
    diff.statsDelta.synced !== 0 ||
    diff.statsDelta.blocked !== 0 ||
    diff.addProcessing.length > 0 ||
    diff.removeProcessing.length > 0 ||
    diff.addRecent.length > 0 ||
    diff.addBlocked.length > 0
  );
}

/**
 * Accumulate a job event into the current diff.
 *
 * Event types and their effects on stats:
 * - enqueue: pending++ (job added to queue)
 * - synced: processing--, synced++ (job completed)
 * - blocked: processing--, blocked++ (job failed permanently)
 * - retry: processing--, pending++ (job scheduled for retry)
 *
 * Note: When a job is picked up for processing, we don't get an event -
 * the getNextPendingJob() call handles that. So we track processing
 * additions via the job lists, not stats deltas.
 */
function accumulateEvent(event: JobEvent): void {
  const job: DashboardJob = {
    id: event.jobId,
    localPath: event.localPath,
    remotePath: event.remotePath,
    createdAt: event.timestamp,
  };

  switch (event.type) {
    case 'enqueue':
      accumulatedDiff.statsDelta.pending++;
      break;

    case 'synced':
      accumulatedDiff.statsDelta.processing--;
      accumulatedDiff.statsDelta.synced++;
      accumulatedDiff.removeProcessing.push(event.jobId);
      accumulatedDiff.addRecent.push(job);
      break;

    case 'blocked':
      accumulatedDiff.statsDelta.processing--;
      accumulatedDiff.statsDelta.blocked++;
      accumulatedDiff.removeProcessing.push(event.jobId);
      accumulatedDiff.addBlocked.push({
        ...job,
        lastError: event.error,
      });
      break;

    case 'retry':
      accumulatedDiff.statsDelta.processing--;
      accumulatedDiff.statsDelta.pending++;
      accumulatedDiff.removeProcessing.push(event.jobId);
      break;
  }
}

// ============================================================================
// Server Management
// ============================================================================

let dashboardProcess: ChildProcess | null = null;
let jobEventHandler: ((event: JobEvent) => void) | null = null;
let accumulatedDiff: DashboardDiff = createEmptyDiff();
let diffTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the dashboard in a separate process.
 */
export function startDashboard(dryRun = false): void {
  if (dashboardProcess) {
    logger.warn('Dashboard process already running');
    return;
  }

  logger.debug(`Dashboard starting with dryRun=${dryRun}`);

  // Fork the dashboard subprocess
  const mainPath = join(__dirname, 'main.js');
  dashboardProcess = fork(mainPath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  // Handle messages from child
  dashboardProcess.on('message', (msg: { type: string; port?: number }) => {
    if (msg.type === 'ready') {
      logger.info(`Dashboard running at http://localhost:${msg.port}`);
    }
  });

  // Handle child process errors
  dashboardProcess.on('error', (err) => {
    logger.error(`Dashboard process error: ${err.message}`);
  });

  // Handle child process exit
  dashboardProcess.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      logger.warn(`Dashboard process exited with code ${code}, signal ${signal}`);
    }
    dashboardProcess = null;
    if (jobEventHandler) {
      jobEvents.off('job', jobEventHandler);
      jobEventHandler = null;
    }
  });

  // Send initial config
  dashboardProcess.send({ type: 'config', dryRun });

  // Forward job events to child process via IPC (accumulated into diffs)
  jobEventHandler = (event: JobEvent) => {
    if (!dashboardProcess?.connected) return;

    // Accumulate the event into the diff based on event type
    accumulateEvent(event);

    // Schedule sending the diff if not already scheduled
    if (!diffTimeout) {
      diffTimeout = setTimeout(() => {
        diffTimeout = null;
        if (dashboardProcess?.connected && hasDiffChanges(accumulatedDiff)) {
          dashboardProcess.send({ type: 'diff', diff: accumulatedDiff });
          accumulatedDiff = createEmptyDiff();
        }
      }, DIFF_ACCUMULATE_MS);
    }
  };
  jobEvents.on('job', jobEventHandler);
}

/**
 * Stop the dashboard process.
 */
export function stopDashboard(): void {
  if (dashboardProcess) {
    // Remove event listener
    if (jobEventHandler) {
      jobEvents.off('job', jobEventHandler);
      jobEventHandler = null;
    }

    // Gracefully terminate the child process
    dashboardProcess.kill('SIGTERM');
    dashboardProcess = null;
    logger.debug('Dashboard process stopped');
  }
}
