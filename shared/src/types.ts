export type LineKind = "horizontal" | "trend";

export interface LinePoint {
  price: number;
  timestamp: number; // epoch ms
}

export interface Line {
  id: string;
  symbol: string;
  kind: LineKind;
  points: LinePoint[]; // horizontal: 1 point, trend: 2 points
  created_at: string; // ISO datetime
  /** Timeframe (minutes) whose candle closes trigger a periodic LLM check of this line. */
  check_interval_minutes: number;
  /** Latest state judged by the LLM, null until the first check. */
  state: LineState | null;
  /** Open time (epoch ms) of the candle on which `state` was first reported. */
  state_since: number | null;
  /** Open time (epoch ms) of the last closed candle this line was checked against. */
  last_checked_candle: number | null;
}

/**
 * Where price stands relative to a line, as judged by the LLM on each candle close.
 * broken_up / broken_down are reported only on the check where a break becomes confirmed;
 * once price keeps holding beyond the line afterwards it goes back to holding_above / holding_below.
 */
export type LineState = "holding_above" | "holding_below" | "testing" | "broken_up" | "broken_down";

export const LINE_STATES: readonly LineState[] = ["holding_above", "holding_below", "testing", "broken_up", "broken_down"];

export interface LineCheckResult {
  state: LineState;
  confidence: number;
  reasoning: string;
}

/** One periodic check of a line, kept so the exact prompt and the LLM's answer can be reviewed later. */
export interface LineCheck {
  id: string;
  line_id: string;
  /** Open time (epoch ms) of the latest closed candle that was judged. */
  candle_timestamp: number;
  checked_at: string; // ISO datetime
  state: LineState;
  previous_state: LineState | null;
  state_changed: boolean;
  confidence: number;
  reasoning: string;
  model: string;
  /** The user message sent to the LLM (the system prompt is the fixed SYSTEM constant). */
  prompt: string;
  from_cache: boolean;
}

export interface BacktestResult {
  id: string;
  period_start: string; // ISO datetime
  period_end: string; // ISO datetime
  win_rate: number;
  profit_factor: number;
  max_drawdown: number;
  total_trades: number;
}

export interface OHLCV {
  timestamp: number; // epoch ms, candle open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ExchangeId = "hyperliquid" | "backpack";

/** Timeframes (minutes) supported by both Hyperliquid and Backpack. */
export const SUPPORTED_INTERVALS: readonly number[] = [1, 3, 5, 15, 30, 60, 120, 240, 480, 720, 1440];
