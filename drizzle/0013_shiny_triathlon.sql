PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_detected_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`riot_puuid` text,
	`match_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`detected_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`posted_at` integer,
	`posted_message_id` integer,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`riot_puuid`) REFERENCES `users`(`riot_puuid`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "status_check" CHECK("__new_detected_events"."status" IN ('pending','posted','digest-only','silent','opted-out','failed'))
);
--> statement-breakpoint
INSERT INTO `__new_detected_events`("id", "event_type", "riot_puuid", "match_id", "payload_json", "detected_at", "status", "posted_at", "posted_message_id") SELECT "id", "event_type", "riot_puuid", "match_id", "payload_json", "detected_at", "status", "posted_at", "posted_message_id" FROM `detected_events`;--> statement-breakpoint
DROP TABLE `detected_events`;--> statement-breakpoint
ALTER TABLE `__new_detected_events` RENAME TO `detected_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_de_status_detected_at` ON `detected_events` (`status`,`detected_at`);--> statement-breakpoint
CREATE INDEX `idx_de_puuid_detected_at` ON `detected_events` (`riot_puuid`,`detected_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_de_match_event` ON `detected_events` (`match_id`,`event_type`,`riot_puuid`);