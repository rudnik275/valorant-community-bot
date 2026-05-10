ALTER TABLE `users` ADD `current_tier_id` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `current_tier_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD `peak_tier_id` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `peak_tier_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD `peak_season_short` text;--> statement-breakpoint
ALTER TABLE `users` ADD `mmr_fetched_at` integer;