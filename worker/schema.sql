-- D1 schema. See spec section 5 (data model).

CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('horizontal', 'trend')),
  points TEXT NOT NULL, -- JSON array of {price, timestamp}
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lines_symbol ON lines (symbol);

CREATE TABLE IF NOT EXISTS touch_events (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES lines (id),
  touched_at TEXT NOT NULL,
  price_at_touch REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'timeout', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  llm_judgment TEXT, -- 'break_confirmed' | 'hold_reject' | 'undetermined' | NULL
  llm_raw_response TEXT NOT NULL DEFAULT '[]' -- JSON array of LlmJudgmentAttempt
);

CREATE INDEX IF NOT EXISTS idx_touch_events_line_id ON touch_events (line_id);
CREATE INDEX IF NOT EXISTS idx_touch_events_status ON touch_events (status);

CREATE TABLE IF NOT EXISTS backtest_results (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  win_rate REAL NOT NULL,
  profit_factor REAL NOT NULL,
  max_drawdown REAL NOT NULL,
  total_trades INTEGER NOT NULL
);
