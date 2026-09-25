-- Migrates a database created from the touch-based schema to periodic line checks.
-- Fresh databases don't need this: schema.sql already has the new shape.
--   npm run db:migrate:periodic:remote   (or :local)
--
-- touch_events held judgments from the old touch-triggered flow, which no longer runs. It is dropped
-- because its foreign key to lines (without ON DELETE CASCADE) would otherwise block deleting lines.

ALTER TABLE lines ADD COLUMN check_interval_minutes INTEGER NOT NULL DEFAULT 15;
ALTER TABLE lines ADD COLUMN state TEXT;
ALTER TABLE lines ADD COLUMN state_since INTEGER;
ALTER TABLE lines ADD COLUMN last_checked_candle INTEGER;

DROP TABLE IF EXISTS touch_events;

CREATE TABLE IF NOT EXISTS line_checks (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES lines (id) ON DELETE CASCADE,
  candle_timestamp INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('holding_above', 'holding_below', 'testing', 'broken_up', 'broken_down')),
  previous_state TEXT,
  state_changed INTEGER NOT NULL,
  confidence REAL NOT NULL,
  reasoning TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  from_cache INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_line_checks_line_candle ON line_checks (line_id, candle_timestamp);
