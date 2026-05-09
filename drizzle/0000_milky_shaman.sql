CREATE TABLE `detected_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`riot_puuid` text,
	`match_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`detected_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`posted_at` integer,
	`posted_message_id` integer,
	FOREIGN KEY (`riot_puuid`) REFERENCES `users`(`riot_puuid`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "status_check" CHECK("detected_events"."status" IN ('pending','posted','digest-only','silent','opted-out'))
);
--> statement-breakpoint
CREATE INDEX `idx_de_status_detected_at` ON `detected_events` (`status`,`detected_at`);--> statement-breakpoint
CREATE INDEX `idx_de_puuid_detected_at` ON `detected_events` (`riot_puuid`,`detected_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_de_match_event` ON `detected_events` (`match_id`,`event_type`,`riot_puuid`);--> statement-breakpoint
CREATE TABLE `users` (
	`telegram_id` integer PRIMARY KEY NOT NULL,
	`telegram_username` text,
	`telegram_avatar_file_id` text,
	`telegram_avatar_url` text,
	`telegram_avatar_fetched_at` integer,
	`riot_puuid` text,
	`riot_name` text,
	`riot_tag` text,
	`last_message_at` integer,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`onboarded_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_riot_puuid_unique` ON `users` (`riot_puuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_riot_puuid` ON `users` (`riot_puuid`);--> statement-breakpoint
CREATE INDEX `idx_users_last_message_at` ON `users` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `match_records` (
	`riot_puuid` text,
	`match_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`map` text NOT NULL,
	`agent` text NOT NULL,
	`kills` integer NOT NULL,
	`deaths` integer NOT NULL,
	`assists` integer NOT NULL,
	`result` text NOT NULL,
	`rounds_played` integer NOT NULL,
	`rank_before` text,
	`rank_after` text,
	`enemy_avg_rank` text,
	`fall_damage_kills` integer DEFAULT 0 NOT NULL,
	`kill_events_compact` text NOT NULL,
	`inserted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`riot_puuid`, `match_id`),
	FOREIGN KEY (`riot_puuid`) REFERENCES `users`(`riot_puuid`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "result_check" CHECK("match_records"."result" IN ('win','loss','draw'))
);
--> statement-breakpoint
CREATE INDEX `idx_match_records_puuid_started_at` ON `match_records` (`riot_puuid`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_match_records_inserted_at` ON `match_records` (`inserted_at`);--> statement-breakpoint
CREATE TABLE `opt_outs` (
	`telegram_id` integer PRIMARY KEY NOT NULL,
	`chat_realtime_disabled` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`telegram_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE cascade
);
