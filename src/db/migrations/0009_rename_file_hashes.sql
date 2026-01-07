-- Migration: Rename file_hashes to file_state and content_hash to change_token
-- Also rename content_hash column in sync_jobs to change_token
-- Note: SQLite doesn't support direct column rename for older versions,
-- so we clear data and recreate tables with correct column names

-- Step 1: Clear existing file hashes (will be recreated on sync)
DELETE FROM `file_hashes`;--> statement-breakpoint

-- Step 2: Recreate file_hashes as file_state with new column name
DROP TABLE `file_hashes`;--> statement-breakpoint
CREATE TABLE `file_state` (
	`local_path` text PRIMARY KEY NOT NULL,
	`change_token` text NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint

-- Step 3: Clear sync_jobs (simpler than migrating column data for change_token rename)
DELETE FROM `sync_jobs`;--> statement-breakpoint

-- Step 4: Recreate sync_jobs with change_token column (replacing content_hash)
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `sync_jobs`;--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`local_path` text NOT NULL,
	`remote_path` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`retry_at` integer NOT NULL,
	`n_retries` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`change_token` text,
	`old_local_path` text,
	`old_remote_path` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_sync_jobs_status_retry` ON `sync_jobs` (`status`,`retry_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sync_jobs_local_remote` ON `sync_jobs` (`local_path`,`remote_path`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
