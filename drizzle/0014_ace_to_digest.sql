-- Migrate accumulated pending ace rows to digest-only status.
-- ace moved from realtime to digest category (issue #228).
-- Pending rows would otherwise block the realtime queue or fire as realtime
-- notifications when picked up by the publisher loop.
UPDATE detected_events SET status = 'digest-only' WHERE event_type = 'ace' AND status = 'pending';
