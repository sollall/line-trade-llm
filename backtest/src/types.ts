import type { LineState } from "shared";

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
}

/** One periodic check during the replay, mirroring the live Worker's line_checks rows. */
export interface ReplayCheckLog {
  line_id: string;
  candle_timestamp: number;
  state: LineState;
  previous_state: LineState | null;
  state_changed: boolean;
  confidence: number;
  reasoning: string;
  prompt: string;
}

export interface ReplayConfig {
  candleWindow: number;
  /** null = send every line to the LLM on every candle (the default, same as the live Worker). */
  checkMarginPct: number | null;
  riskRewardRatio: number;
  maxHoldBars: number;
  llmMode: "claude" | "mock";
  claudeApiKey?: string;
  claudeModel?: string;
}

export interface ReplayOutput {
  trades: SimulatedTrade[];
  checkLog: ReplayCheckLog[];
}
