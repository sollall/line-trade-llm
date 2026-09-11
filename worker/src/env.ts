import type { ExchangeId } from "shared";

export interface Env {
  DB: D1Database;
  LLM_CACHE: KVNamespace;

  ANTHROPIC_API_KEY: string;

  EXCHANGE: ExchangeId;
  CANDLE_INTERVAL_MINUTES: string;
  CANDLE_WINDOW: string;
  TOUCH_THRESHOLD_PCT: string;
  MAX_UNDETERMINED_RETRIES: string;
  CLAUDE_MODEL: string;
}

export function candleIntervalMinutes(env: Env): number {
  return Number(env.CANDLE_INTERVAL_MINUTES) || 1;
}

export function candleWindow(env: Env): number {
  return Number(env.CANDLE_WINDOW) || 15;
}

export function touchThresholdPct(env: Env): number {
  return Number(env.TOUCH_THRESHOLD_PCT) || 0.0005;
}

export function maxUndeterminedRetries(env: Env): number {
  return Number(env.MAX_UNDETERMINED_RETRIES) || 8;
}
