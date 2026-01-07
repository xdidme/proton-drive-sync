/**
 * Reset Command - Clear sync state from database
 */

import { confirm } from '@inquirer/prompts';
import { gt } from 'drizzle-orm';
import { db, schema, run } from '../db/index.js';
import { logger } from '../logger.js';
import { clearAllSnapshots } from '../sync/watcher.js';

export async function resetCommand(options: {
  yes: boolean;
  signals: boolean;
  retries: boolean;
}): Promise<void> {
  const { yes, signals: signalsOnly, retries: retriesOnly } = options;

  if (!yes) {
    let message: string;
    if (retriesOnly) {
      message =
        'This will clear the retry delay for all pending retry jobs so they get picked up immediately. Continue?';
    } else if (signalsOnly) {
      message = 'This will clear all signals from the database. Continue?';
    } else {
      message =
        'This will reset the sync state, forcing proton-drive-sync to sync all files as if it were first launched. Continue?';
    }

    const confirmed = await confirm({
      message,
      default: false,
    });

    if (!confirmed) {
      logger.info('Aborted.');
      return;
    }
  }

  if (retriesOnly) {
    const result = run(
      db.update(schema.syncJobs).set({ retryAt: new Date() }).where(gt(schema.syncJobs.nRetries, 0))
    );
    logger.info(`Cleared retry delay for ${result.changes} job(s).`);
  } else if (signalsOnly) {
    db.delete(schema.signals).run();
    logger.info('Signals cleared.');
  } else {
    // Clear all sync-related tables atomically
    db.transaction((tx) => {
      tx.delete(schema.syncJobs).run();
      tx.delete(schema.processingQueue).run();
      tx.delete(schema.fileState).run();
      tx.delete(schema.nodeMapping).run();
    });

    // Clear file state to force full resync
    const snapshotsCleared = clearAllSnapshots();
    if (snapshotsCleared > 0) {
      logger.info(`Cleared ${snapshotsCleared} file state entry(ies).`);
    }

    logger.info('State reset.');
  }
}
