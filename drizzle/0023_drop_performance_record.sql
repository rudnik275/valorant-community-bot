-- #394: the «Любимчик Riot» record (#387) was withdrawn; drop the rows it left behind.
DELETE FROM `all_time_records` WHERE `record_type` = 'performance_score_match';--> statement-breakpoint
DELETE FROM `detected_events` WHERE `event_type` = 'record_performance_score_match';
