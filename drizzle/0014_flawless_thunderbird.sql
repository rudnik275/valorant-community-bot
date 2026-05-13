CREATE TABLE `daily_digest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_date` text NOT NULL,
	`started_at` integer NOT NULL,
	`posted_at` integer,
	`posted_message_id` integer,
	`posted_text` text,
	`included_event_ids` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_daily_digest_runs_run_date` ON `daily_digest_runs` (`run_date`);