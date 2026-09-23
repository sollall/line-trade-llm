import { DEFAULT_CHECK_MARGIN_PCT, type ExchangeId } from "shared";

export interface Env {
  DB: D1Database;
  LLM_CACHE: KVNamespace;

  ANTHROPIC_API_KEY: string;

  EXCHANGE: ExchangeId;
  DEFAULT_CHECK_INTERVAL_MINUTES: string;
  CANDLE_WINDOW: string;
  CHECK_MARGIN_PCT: string;
  CLAUDE_MODEL: string;
}

/** Check timeframe for lines created without one, and the default /candles timeframe. */
export function defaultCheckIntervalMinutes(env: Env): number {
  return Number(env.DEFAULT_CHECK_INTERVAL_MINUTES) || 15;
}

export function candleWindow(env: Env): number {
  return Number(env.CANDLE_WINDOW) || 15;
}

export function checkMarginPct(env: Env): number {
  return Number(env.CHECK_MARGIN_PCT) || DEFAULT_CHECK_MARGIN_PCT;
}

export function claudeModel(env: Env): string {
  return env.CLAUDE_MODEL || "claude-sonnet-5";
}
