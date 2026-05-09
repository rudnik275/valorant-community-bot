-- inject-mock-events.sql
-- Idempotent fixture for staging smoke tests.
-- Apply to a clean staging DB only. Do not run in production.
--
-- Usage (on VPS):
--   docker exec -i valorant-bot-app sqlite3 /app/data/data.db < inject-mock-events.sql
--
-- Or from local machine:
--   scp tests/staged-rollout/inject-mock-events.sql deploy@<VPS_IP>:/tmp/inject-mock-events.sql
--   docker exec -i valorant-bot-app sqlite3 /app/data/data.db < /tmp/inject-mock-events.sql
--
-- Uses negative telegram_id values (-1001 through -1010) to avoid collisions.
-- Uses explicit riot_puuid strings ('mock-puuid-1' through 'mock-puuid-7').
-- All match_id values begin with 'mock-' for easy cleanup.

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Users (5–10 rows, varied opt-out states)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO users
  (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, riot_region, joined_at, onboarded_at, last_message_at)
VALUES
  -- Normal users (opted IN)
  (-1001, 'mock_alpha',   'mock-puuid-1', 'Alpha',       'EU1',  'EU',   strftime('%s','now')*1000, strftime('%s','now')*1000, strftime('%s','now')*1000),
  (-1002, 'mock_bravo',   'mock-puuid-2', 'Bravo',       'EU2',  'EU',   strftime('%s','now')*1000, strftime('%s','now')*1000, strftime('%s','now')*1000 - 3600000),
  (-1003, 'mock_charlie', 'mock-puuid-3', 'Charlie',     'NA99', 'NA',   strftime('%s','now')*1000, strftime('%s','now')*1000, strftime('%s','now')*1000 - 7200000),
  (-1004, 'mock_delta',   'mock-puuid-4', 'Delta',       'AP42', 'AP',   strftime('%s','now')*1000, strftime('%s','now')*1000, NULL),
  (-1005, 'mock_echo',    'mock-puuid-5', 'Echo',        'EU3',  'EU',   strftime('%s','now')*1000, strftime('%s','now')*1000, strftime('%s','now')*1000 - 86400000),
  -- Opted-OUT users (chat_realtime_disabled=1 set in opt_outs below)
  (-1006, 'mock_foxtrot', 'mock-puuid-6', 'Foxtrot',     'EU4',  'EU',   strftime('%s','now')*1000, strftime('%s','now')*1000, NULL),
  -- HTML injection test user
  (-1007, 'mock_inject',  'mock-puuid-7', '<b>X</b>',    'INJ1', 'EU',   strftime('%s','now')*1000, strftime('%s','now')*1000, NULL);

-- Opt-out rows
INSERT OR IGNORE INTO opt_outs (telegram_id, chat_realtime_disabled, updated_at)
VALUES
  (-1006, 1, strftime('%s','now')*1000);  -- Foxtrot opted out

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Match records (10–15 rows with realistic kill_events_compact JSON)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO match_records
  (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result,
   rounds_played, rank_before, rank_after, enemy_avg_rank, fall_damage_kills, kill_events_compact)
VALUES
  -- Alpha: ace match on Ascent (win)
  ('mock-puuid-1', 'mock-match-alpha-01',
   strftime('%s','now')*1000 - 3600000*2,
   'Ascent', 'Jett', 25, 10, 3, 'win', 25,
   'Gold 2', 'Gold 3', 'Gold 1', 0,
   '[{"round":5,"weapon":"Vandal","kills":5},{"round":12,"weapon":"Vandal","kills":5}]'),

  -- Alpha: another match (loss)
  ('mock-puuid-1', 'mock-match-alpha-02',
   strftime('%s','now')*1000 - 3600000*4,
   'Bind', 'Jett', 14, 18, 2, 'loss', 26,
   'Gold 2', 'Gold 2', 'Gold 3', 0,
   '[{"round":3,"weapon":"Sheriff","kills":2}]'),

  -- Bravo: clutch match on Haven (win)
  ('mock-puuid-2', 'mock-match-bravo-01',
   strftime('%s','now')*1000 - 3600000*3,
   'Haven', 'Reyna', 18, 12, 0, 'win', 22,
   'Silver 3', 'Gold 1', 'Silver 3', 0,
   '[{"round":7,"weapon":"Phantom","kills":3},{"round":15,"weapon":"Phantom","kills":4}]'),

  -- Charlie: winstreak match (win #9)
  ('mock-puuid-3', 'mock-match-charlie-01',
   strftime('%s','now')*1000 - 3600000*1,
   'Pearl', 'Sage', 8, 15, 12, 'win', 20,
   'Platinum 1', 'Platinum 1', 'Platinum 2', 0,
   '[]'),

  -- Charlie: rare weapon ace match
  ('mock-puuid-3', 'mock-match-charlie-02',
   strftime('%s','now')*1000 - 3600000*5,
   'Split', 'Sage', 20, 11, 7, 'win', 23,
   'Platinum 1', 'Platinum 1', 'Platinum 1', 0,
   '[{"round":9,"weapon":"Classic","kills":5}]'),

  -- Delta: lostrick / fall-damage / zero-match
  ('mock-puuid-4', 'mock-match-delta-01',
   strftime('%s','now')*1000 - 3600000*6,
   'Fracture', 'Phoenix', 3, 22, 1, 'loss', 24,
   'Iron 3', 'Iron 3', 'Bronze 1', 2,
   '[{"round":1,"weapon":"Classic","kills":1}]'),

  ('mock-puuid-4', 'mock-match-delta-02',
   strftime('%s','now')*1000 - 3600000*7,
   'Lotus', 'Phoenix', 0, 18, 0, 'loss', 12,
   'Iron 3', 'Iron 3', 'Bronze 1', 1,
   '[]'),

  -- Echo: giant slayer match (won vs higher ranked team)
  ('mock-puuid-5', 'mock-match-echo-01',
   strftime('%s','now')*1000 - 3600000*2,
   'Icebox', 'Omen', 19, 9, 4, 'win', 18,
   'Bronze 2', 'Bronze 2', 'Silver 2', 0,
   '[{"round":4,"weapon":"Vandal","kills":3}]'),

  -- Echo: comeback match (was paused 30 days)
  ('mock-puuid-5', 'mock-match-echo-02',
   strftime('%s','now')*1000 - 3600000*48,
   'Breeze', 'Omen', 12, 14, 5, 'win', 21,
   'Bronze 1', 'Bronze 2', 'Bronze 1', 0,
   '[]'),

  -- Foxtrot (opted-out): match exists but events should be opted-out
  ('mock-puuid-6', 'mock-match-foxtrot-01',
   strftime('%s','now')*1000 - 3600000*3,
   'Sunset', 'Killjoy', 22, 8, 6, 'win', 20,
   'Diamond 1', 'Diamond 2', 'Diamond 1', 0,
   '[{"round":2,"weapon":"Vandal","kills":5}]'),

  -- HTML injection user: match for injection test
  ('mock-puuid-7', 'mock-match-inject-01',
   strftime('%s','now')*1000 - 3600000*1,
   'Ascent', 'Viper', 20, 10, 3, 'win', 19,
   'Silver 1', 'Silver 2', 'Silver 1', 0,
   '[{"round":6,"weapon":"Vandal","kills":5}]'),

  -- Alpha: teamkill match
  ('mock-puuid-1', 'mock-match-alpha-03',
   strftime('%s','now')*1000 - 3600000*8,
   'Bind', 'Phoenix', 10, 14, 2, 'loss', 22,
   'Gold 3', 'Gold 3', 'Gold 3', 0,
   '[{"round":3,"team_kill":true},{"round":11,"team_kill":true}]');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Detected events — one of each of the 11 event types, all 'pending'
-- ─────────────────────────────────────────────────────────────────────────────
-- Payloads match what templates.ts expects.
-- Each uses a unique match_id so the UNIQUE constraint (match_id, event_type, riot_puuid) is satisfied.

-- 1. ace
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'ace', 'mock-puuid-1', 'mock-match-alpha-01',
  '{"rounds":[5,12]}',
  strftime('%s','now')*1000 - 60000*10,
  'pending'
);

-- 2. ace_rare_weapon
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'ace_rare_weapon', 'mock-puuid-3', 'mock-match-charlie-02',
  '{"weapons":["Classic"]}',
  strftime('%s','now')*1000 - 60000*9,
  'pending'
);

-- 3. clutch_1vN
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'clutch_1vN', 'mock-puuid-2', 'mock-match-bravo-01',
  '{"n":3,"kills":3}',
  strftime('%s','now')*1000 - 60000*8,
  'pending'
);

-- 4. rank_promo
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'rank_promo', 'mock-puuid-3', 'mock-match-charlie-01',
  '{"from":"Silver 3","to":"Gold 1"}',
  strftime('%s','now')*1000 - 60000*7,
  'pending'
);

-- 5. winstreak_9
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'winstreak_9', 'mock-puuid-3', 'mock-match-charlie-01-ws',
  '{"streak":9}',
  strftime('%s','now')*1000 - 60000*6,
  'pending'
);

-- 6. giant_slayer
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'giant_slayer', 'mock-puuid-5', 'mock-match-echo-01',
  '{"enemy_avg":"Silver 2","own":"Bronze 2"}',
  strftime('%s','now')*1000 - 60000*5,
  'pending'
);

-- 7. comeback (days_paused used by template)
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'comeback', 'mock-puuid-5', 'mock-match-echo-02',
  '{"days_paused":30}',
  strftime('%s','now')*1000 - 60000*4,
  'pending'
);

-- 8. lostrick_9 (antistat)
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'lostrick_9', 'mock-puuid-4', 'mock-match-delta-01',
  '{"streak":9}',
  strftime('%s','now')*1000 - 60000*3,
  'pending'
);

-- 9. teamkill (antistat)
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'teamkill', 'mock-puuid-1', 'mock-match-alpha-03',
  '{"round_numbers":[3,11],"count":2}',
  strftime('%s','now')*1000 - 60000*2,
  'pending'
);

-- 10. fall_damage_death (antistat)
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'fall_damage_death', 'mock-puuid-4', 'mock-match-delta-02',
  '{"count":1}',
  strftime('%s','now')*1000 - 60000*1,
  'pending'
);

-- 11. zero_match (antistat)
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'zero_match', 'mock-puuid-4', 'mock-match-delta-02-zm',
  '{"rounds":12}',
  strftime('%s','now')*1000,
  'pending'
);

-- HTML injection test event (should render escaped name in Telegram)
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'ace', 'mock-puuid-7', 'mock-match-inject-01',
  '{"rounds":[6]}',
  strftime('%s','now')*1000 + 1000,
  'pending'
);

-- Opted-out user event (should become 'opted-out' after publisher tick)
INSERT OR IGNORE INTO detected_events
  (event_type, riot_puuid, match_id, payload_json, detected_at, status)
VALUES (
  'ace', 'mock-puuid-6', 'mock-match-foxtrot-01',
  '{"rounds":[2]}',
  strftime('%s','now')*1000 + 2000,
  'pending'
);

COMMIT;

PRAGMA foreign_keys = ON;
