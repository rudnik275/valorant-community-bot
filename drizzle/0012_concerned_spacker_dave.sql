CREATE TABLE `weekly_records` (
	`record_type` text NOT NULL,
	`week_iso` text NOT NULL,
	`riot_puuid` text NOT NULL,
	`value` integer NOT NULL,
	PRIMARY KEY(`record_type`, `week_iso`)
);
