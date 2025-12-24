import type { DashboardJob, AuthStatusUpdate, SyncStatus } from '../../ipc.js';
import type { Config } from '../../../config.js';

export type { DashboardJob, AuthStatusUpdate, SyncStatus, Config };

export type JobCounts = {
  pending: number;
  processing: number;
  synced: number;
  blocked: number;
};
