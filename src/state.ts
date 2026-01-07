/**
 * Proton Drive Sync - State Management
 *
 * Persists sync state to ~/.local/state/proton-drive-sync/state.db using SQLite.
 * Snapshot management is handled by the watcher module.
 */

import { STATE_DIR } from './db/index.js';

// Re-export STATE_DIR for other modules
export { STATE_DIR };

// Note: Clock management has been removed. The watcher now uses file-based
// snapshots managed by @parcel/watcher. See src/sync/watcher.ts for
// snapshot management functions:
// - writeSnapshots(config)
// - cleanupOrphanedSnapshots(config)
