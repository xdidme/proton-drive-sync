import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import type { DashboardJob, SyncStatus, AuthStatusUpdate } from './types.js';
import { PauseButton } from './PauseButton.js';
import { formatPath } from './utils.js';

type Props = {
  jobs: DashboardJob[];
  syncStatus: SyncStatus;
  authStatus: AuthStatusUpdate;
};

export const ProcessingQueue: FC<Props> = ({ jobs, syncStatus, authStatus }) => {
  const isPaused = syncStatus === 'paused';
  const isActive = syncStatus === 'syncing' && authStatus.status === 'authenticated';

  return (
    <>
      {/* Header */}
      <div class="px-5 py-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50 backdrop-blur rounded-t-xl">
        <h2
          id="processing-title"
          class="text-sm font-semibold text-gray-100 uppercase tracking-wider flex items-center gap-2"
          sse-swap="processing-title"
          hx-swap="innerHTML"
        >
          <span
            class={`w-2 h-2 rounded-full ${isPaused ? 'bg-amber-500' : 'bg-blue-500 animate-pulse'}`}
          ></span>
          {isPaused ? 'Paused' : 'Active Transfers'}
        </h2>
        <div class="flex items-center gap-3">
          <div id="pause-button">{raw(PauseButton({ syncStatus }))}</div>
          <span class="text-xs font-mono text-gray-500">{jobs.length} items</span>
        </div>
      </div>

      {/* List */}
      <div class="flex-1 overflow-y-auto custom-scrollbar p-2">
        {jobs.length === 0 ? (
          <div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
            <i data-lucide="zap" class="w-10 h-10 opacity-20"></i>
            <p class="text-sm">Queue is empty</p>
          </div>
        ) : (
          <div class="space-y-1">
            {jobs.map((job) => (
              <div class="px-3 py-2.5 rounded-lg bg-gray-900/50 border border-gray-700/50 hover:border-blue-500/30 transition-colors group">
                <div class="flex items-start gap-3">
                  {isActive ? (
                    <i
                      data-lucide="refresh-cw"
                      class="w-4 h-4 text-blue-500 mt-0.5 shrink-0 animate-spin"
                    ></i>
                  ) : (
                    <i data-lucide="clock" class="w-4 h-4 text-amber-500 mt-0.5 shrink-0"></i>
                  )}
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-mono text-gray-300 truncate">
                      {formatPath(job.localPath)}
                    </div>
                    <div class="text-[10px] text-gray-500 mt-0.5 truncate">{job.localPath}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};
