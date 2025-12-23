/**
 * Resume Command
 *
 * Resumes the syncing loop after it has been paused.
 */

import { sendSignal, hasSignal, isAlreadyRunning } from '../signals.js';

/**
 * Resume the sync process by sending a resume signal.
 * The process will start processing sync jobs again.
 */
export function resumeCommand(): void {
  // Check if a sync process is running first
  if (!isAlreadyRunning()) {
    console.log('No running proton-drive-sync process found.');
    return;
  }

  // Send resume signal to the process
  sendSignal('resume-sync');
  console.log('Resume signal sent. Waiting for confirmation...');

  // Wait for up to 5 seconds for the process to consume the signal
  const startTime = Date.now();
  const timeout = 5000;
  const checkInterval = 100;

  const waitForAck = (): void => {
    // Signal consumed = process acknowledged
    if (!hasSignal('resume-sync')) {
      console.log('Syncing resumed.');
      return;
    }

    if (Date.now() - startTime < timeout) {
      setTimeout(waitForAck, checkInterval);
    } else {
      console.log('Process did not respond to resume signal.');
    }
  };

  waitForAck();
}
