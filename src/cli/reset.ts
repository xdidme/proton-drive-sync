/**
 * Reset Command - Clear sync state from database
 */

import { confirm } from '@inquirer/prompts';
import { gt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

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
      console.log('Aborted.');
      return;
    }
  }

  if (retriesOnly) {
    const result = db
      .update(schema.syncJobs)
      .set({ retryAt: new Date() })
      .where(gt(schema.syncJobs.nRetries, 0))
      .run();
    console.log(`Cleared retry delay for ${result.changes} job(s).`);
  } else if (signalsOnly) {
    db.delete(schema.signals).run();
    console.log('Signals cleared.');
  } else {
    // Clear all sync-related tables
    db.delete(schema.clocks).run();
    db.delete(schema.syncJobs).run();
    db.delete(schema.processingQueue).run();
    console.log('State reset.');
  }
}
