/**
 * Proton Drive Sync - Flag Management
 *
 * Flags: Persistent process state (running, paused, etc) stored in SQLite.
 */

import { eq, like } from 'drizzle-orm';
import { db, schema } from './db/index.js';

// Flag names
export const FLAGS = {
  PAUSED: 'paused',
  ONBOARDED: 'onboarded',
  SERVICE_INSTALLED: 'service_installed',
  SERVICE_LOADED: 'service_loaded',
} as const;

// Prefix for the running PID flag (stored as "running_pid:<pid>")
const RUNNING_PID_PREFIX = 'running_pid:';

/**
 * Set a flag (persistent state).
 */
export function setFlag(name: string): void {
  db.insert(schema.flags).values({ name, createdAt: new Date() }).onConflictDoNothing().run();
}

/**
 * Clear a flag (persistent state).
 */
export function clearFlag(name: string): void {
  db.delete(schema.flags).where(eq(schema.flags.name, name)).run();
}

/**
 * Check if a flag is set.
 */
export function hasFlag(name: string): boolean {
  const row = db.select().from(schema.flags).where(eq(schema.flags.name, name)).get();
  return !!row;
}

/**
 * Check if a process with the given PID is currently running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the stored PID from the running_pid flag.
 */
function getStoredPid(): number | null {
  const row = db
    .select()
    .from(schema.flags)
    .where(like(schema.flags.name, `${RUNNING_PID_PREFIX}%`))
    .get();
  if (!row) return null;
  const pid = parseInt(row.name.slice(RUNNING_PID_PREFIX.length), 10);
  return isNaN(pid) ? null : pid;
}

/**
 * Clear any running_pid flag.
 */
function clearRunningPid(): void {
  db.delete(schema.flags)
    .where(like(schema.flags.name, `${RUNNING_PID_PREFIX}%`))
    .run();
}

/**
 * Check if a proton-drive-sync process is currently running.
 */
export function isAlreadyRunning(): boolean {
  const pid = getStoredPid();
  if (!pid) return false;
  return isProcessRunning(pid);
}

/**
 * Check if syncing is paused.
 */
export function isPaused(): boolean {
  return hasFlag(FLAGS.PAUSED);
}

/**
 * Acquire the run lock: checks if another instance is running and marks this process as running.
 * Returns true if lock acquired, false if another instance is already running.
 * If a stale lock exists (process no longer running), it will be cleared and lock acquired.
 */
export function acquireRunLock(): boolean {
  return db.transaction((tx) => {
    // Check if another process holds the lock
    const row = tx
      .select()
      .from(schema.flags)
      .where(like(schema.flags.name, `${RUNNING_PID_PREFIX}%`))
      .get();

    if (row) {
      const pid = parseInt(row.name.slice(RUNNING_PID_PREFIX.length), 10);
      if (!isNaN(pid) && isProcessRunning(pid)) {
        // Process is still running, can't acquire lock
        return false;
      }
      // Process is dead, clear stale lock
      tx.delete(schema.flags).where(eq(schema.flags.name, row.name)).run();
    }

    // Clear all stale signals
    tx.delete(schema.signals).run();

    // Store our PID as the lock
    tx.insert(schema.flags)
      .values({ name: `${RUNNING_PID_PREFIX}${process.pid}`, createdAt: new Date() })
      .run();

    return true;
  });
}

/**
 * Release the run lock: removes the running PID and paused flags.
 * Should be called during graceful shutdown.
 */
export function releaseRunLock(): void {
  clearRunningPid();
  clearFlag(FLAGS.PAUSED);
}
