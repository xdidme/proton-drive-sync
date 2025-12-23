/**
 * Resume Command
 *
 * Resumes the syncing loop after it has been paused.
 */

import { sendSignal, hasSignal, consumeSignal, isAlreadyRunning } from '../signals.js';

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

  // Check if actually paused
  if (!hasSignal('paused')) {
    console.log('Sync is not paused.');
    return;
  }

  // Send resume signal to the process
  sendSignal('resume-sync');
  console.log('Resume signal sent. Waiting for confirmation...');

  // Wait for up to 5 seconds for the process to acknowledge
  const startTime = Date.now();
  const timeout = 5000;
  const checkInterval = 100;

  const waitForAck = (): void => {
    // Check if paused signal was removed (process acknowledged)
    if (!hasSignal('paused')) {
      console.log('Syncing resumed.');
      return;
    }

    // Check if resume-sync was consumed
    if (!hasSignal('resume-sync')) {
      console.log('Syncing resumed.');
      return;
    }

    if (Date.now() - startTime < timeout) {
      setTimeout(waitForAck, checkInterval);
    } else {
      // Timeout - consume signal and report
      consumeSignal('resume-sync');
      console.log('Process did not respond to resume signal.');
    }
  };

  waitForAck();
}
