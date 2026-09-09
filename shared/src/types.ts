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
}

export type TouchEventStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "timeout"
  | "failed";

export type LlmDecision = "break_confirmed" | "hold_reject" | "undetermined";

export interface LlmJudgmentResult {
  decision: LlmDecision;
  confidence: number;
  reasoning: string;
}

/** One row of the retry history kept in touch_event.llm_raw_response. */
export interface LlmJudgmentAttempt {
  attempted_at: string; // ISO datetime
  candle_count: number; // how many candles were fed in for this attempt
  result: LlmJudgmentResult;
  from_cache: boolean;
}

export interface TouchEvent {
  id: string;
  line_id: string;
  touched_at: string; // ISO datetime
  price_at_touch: number;
  status: TouchEventStatus;
  retry_count: number; // number of undetermined re-judgments so far
  llm_judgment: LlmDecision | null;
  llm_raw_response: LlmJudgmentAttempt[];
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
