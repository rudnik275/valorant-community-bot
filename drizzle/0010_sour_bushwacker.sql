CREATE TABLE `all_time_records` (
	`record_type` text NOT NULL,
	`weapon` text DEFAULT '' NOT NULL,
	`riot_puuid` text NOT NULL,
	`value` real NOT NULL,
	`match_id` text NOT NULL,
	`achieved_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`prev_value` real,
	`prev_puuid` text,
	PRIMARY KEY(`record_type`, `weapon`),
	FOREIGN KEY (`riot_puuid`) REFERENCES `users`(`riot_puuid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_atr_puuid` ON `all_time_records` (`riot_puuid`);