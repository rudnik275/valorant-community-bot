CREATE TABLE `digest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`week_iso` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`posted_at` integer,
	`posted_message_id` integer,
	`posted_text` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_digest_runs_week_iso` ON `digest_runs` (`week_iso`);