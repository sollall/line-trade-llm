import type { Line, LlmDecision, LlmJudgmentAttempt } from "shared";

export type TradeDirection = "long" | "short";

export interface SimulatedTrade {
  line_id: string;
  direction: TradeDirection;
  entry_time: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  exit_time: number;
  exit_price: number;
  exit_reason: "stop_loss" | "take_profit" | "max_hold";
  pnl_pct: number; // (exit-entry)/entry, sign-adjusted for direction
  /** How many candles the touch event spent as `undetermined` before resolving. */
  bars_to_resolve: number;
}

export interface ReplayTouchLog {
  line_id: string;
  touched_at: number;
  resolved_status: "confirmed" | "rejected" | "timeout";
  decision: LlmDecision | null;
  bars_to_resolve: number;
  attempts: LlmJudgmentAttempt[];
}

export interface ReplayInput {
  symbol: string;
  lines: Line[];
}

export interface ReplayConfig {
  candleIntervalMinutes: number;
  candleWindow: number;
  touchThresholdPct: number;
  maxUndeterminedRetries: number;
  riskRewardRatio: number;
  maxHoldBars: number;
  llmMode: "claude" | "mock";
  claudeApiKey?: string;
  claudeModel?: string;
}

export interface ReplayOutput {
  period_start: number;
  period_end: number;
  trades: SimulatedTrade[];
  touchLog: ReplayTouchLog[];
}
