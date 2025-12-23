/**
 * Pause Command
 *
 * Pauses the syncing loop without stopping the process.
 */

import { sendSignal, hasSignal, consumeSignal, isAlreadyRunning } from '../signals.js';

/**
 * Pause the sync process by sending a pause signal.
 * The process will continue running but stop processing sync jobs.
 */
export function pauseCommand(): void {
  // Check if a sync process is running first
  if (!isAlreadyRunning()) {
    console.log('No running proton-drive-sync process found.');
    return;
  }

  // Check if already paused
  if (hasSignal('paused')) {
    console.log('Sync is already paused. Use "resume" to continue syncing.');
    return;
  }

  // Send pause signal to the process
  sendSignal('pause-sync');
  console.log('Pause signal sent. Waiting for confirmation...');

  // Wait for up to 5 seconds for the process to acknowledge
  const startTime = Date.now();
  const timeout = 5000;
  const checkInterval = 100;

  const waitForAck = (): void => {
    // Check if paused signal appeared (process acknowledged)
    if (hasSignal('paused')) {
      console.log('Syncing paused.');
      return;
    }

    // Check if pause-sync was consumed
    if (!hasSignal('pause-sync')) {
      console.log('Syncing paused.');
      return;
    }

    if (Date.now() - startTime < timeout) {
      setTimeout(waitForAck, checkInterval);
    } else {
      // Timeout - consume signal and report
      consumeSignal('pause-sync');
      console.log('Process did not respond to pause signal.');
    }
  };

  waitForAck();
}
