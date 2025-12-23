/**
 * Pause Command
 *
 * Pauses the syncing loop without stopping the process.
 */

import { sendSignal, hasSignal, isAlreadyRunning } from '../signals.js';

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

  // Send pause signal to the process
  sendSignal('pause-sync');
  console.log('Pause signal sent. Waiting for confirmation...');

  // Wait for up to 5 seconds for the process to consume the signal
  const startTime = Date.now();
  const timeout = 5000;
  const checkInterval = 100;

  const waitForAck = (): void => {
    // Signal consumed = process acknowledged
    if (!hasSignal('pause-sync')) {
      console.log('Syncing paused.');
      return;
    }

    if (Date.now() - startTime < timeout) {
      setTimeout(waitForAck, checkInterval);
    } else {
      console.log('Process did not respond to pause signal.');
    }
  };

  waitForAck();
}
