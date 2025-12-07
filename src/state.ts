/**
 * Proton Drive Sync - State Management
 *
 * Persists sync state to ~/.local/state/proton-drive-sync/state.db using SQLite.
 */

import { eq } from 'drizzle-orm';
import { db, schema, STATE_DIR } from './db/index.js';
import { logger } from './logger.js';

// Re-export STATE_DIR for other modules
export { STATE_DIR };

// ============================================================================
// Clock Management
// ============================================================================

/**
 * Get the watchman clock for a directory.
 */
export function getClock(directory: string): string | null {
  const row = db.select().from(schema.clocks).where(eq(schema.clocks.directory, directory)).get();
  return row?.clock ?? null;
}

/**
 * Set the watchman clock for a directory.
 * No-op if dryRun is true.
 */
export function setClock(directory: string, clock: string, dryRun: boolean): void {
  if (dryRun) return;

  logger.debug(`Setting clock for ${directory}: ${clock}`);

  db.insert(schema.clocks)
    .values({ directory, clock })
    .onConflictDoUpdate({
      target: schema.clocks.directory,
      set: { clock },
    })
    .run();
}

/**
 * Get all clocks as a record (for compatibility).
 */
export function getAllClocks(): Record<string, string> {
  const rows = db.select().from(schema.clocks).all();
  return Object.fromEntries(rows.map((row) => [row.directory, row.clock]));
}
