CREATE TABLE `match_rosters` (
	`match_id` text NOT NULL,
	`riot_puuid` text NOT NULL,
	`team` text NOT NULL,
	`name` text,
	`tag` text,
	`inserted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`match_id`, `riot_puuid`)
);
--> statement-breakpoint
CREATE INDEX `idx_match_rosters_puuid` ON `match_rosters` (`riot_puuid`);--> statement-breakpoint
CREATE INDEX `idx_match_rosters_match_team` ON `match_rosters` (`match_id`,`team`);