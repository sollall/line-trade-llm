import type { ExchangeId } from "shared";

export interface Env {
  DB: D1Database;
  LLM_CACHE: KVNamespace;

  ANTHROPIC_API_KEY: string;

  EXCHANGE: ExchangeId;
  DEFAULT_CHECK_INTERVAL_MINUTES: string;
  CANDLE_WINDOW: string;
  CHECK_MARGIN_PCT?: string;
  CLAUDE_MODEL: string;
}

/** Check timeframe for lines created without one, and the default /candles timeframe. */
export function defaultCheckIntervalMinutes(env: Env): number {
  return Number(env.DEFAULT_CHECK_INTERVAL_MINUTES) || 15;
}

export function candleWindow(env: Env): number {
  return Number(env.CANDLE_WINDOW) || 15;
}

/** Optional cost filter: skip the LLM for lines this far outside recent prices. null = check every line. */
export function checkMarginPct(env: Env): number | null {
  const value = Number(env.CHECK_MARGIN_PCT);
  return env.CHECK_MARGIN_PCT && Number.isFinite(value) && value >= 0 ? value : null;
}

export function claudeModel(env: Env): string {
  return env.CLAUDE_MODEL || "claude-sonnet-5";
}
