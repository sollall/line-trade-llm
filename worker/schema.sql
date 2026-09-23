-- D1 schema. See spec section 5 (data model).

CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('horizontal', 'trend')),
  points TEXT NOT NULL, -- JSON array of {price, timestamp}
  created_at TEXT NOT NULL,
  check_interval_minutes INTEGER NOT NULL DEFAULT 15, -- timeframe whose candle closes trigger a check
  state TEXT, -- latest LineState, NULL until the first check
  state_since INTEGER, -- open time (epoch ms) of the candle the current state was first reported on
  last_checked_candle INTEGER -- open time (epoch ms) of the last closed candle checked
);

CREATE INDEX IF NOT EXISTS idx_lines_symbol ON lines (symbol);

-- One row per periodic LLM check (every closed candle of the line's check_interval_minutes while
-- price is near the line), including the exact prompt sent so judgments can be reviewed.
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

CREATE TABLE IF NOT EXISTS backtest_results (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  win_rate REAL NOT NULL,
  profit_factor REAL NOT NULL,
  max_drawdown REAL NOT NULL,
  total_trades INTEGER NOT NULL
);
