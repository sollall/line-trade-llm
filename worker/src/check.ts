import {
  buildLineCheckPrompt,
  callClaudeLineCheck,
  isLineNearCandles,
  lineCheckCacheKey,
  volumeRatioVsAverage,
  type Line,
  type LineCheck,
  type LineCheckResult,
  type OHLCV,
} from "shared";
import { latestLineCheck, markLineChecked, recordLineCheck } from "./db.js";
import { checkMarginPct, claudeModel, type Env } from "./env.js";

const LLM_CALL_RETRIES = 2; // spec 4.2: retry in-place a couple of times, then let the next Cron tick retry
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 1 day

async function withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Checks one line against the candle window ending at its latest closed candle and records the
 * LLM's state. Every line is sent to the LLM unless the optional CHECK_MARGIN_PCT filter is set and
 * the line is far from price. On LLM/network failure nothing is recorded, so the next Cron tick
 * retries the same candle (spec 4.2).
 */
export async function checkLine(env: Env, line: Line, candles: OHLCV[]): Promise<void> {
  const latest = candles[candles.length - 1];
  if (!latest) return;

  const marginPct = checkMarginPct(env);
  if (marginPct !== null && !isLineNearCandles(line, candles, marginPct)) {
    await markLineChecked(env, line.id, latest.timestamp);
    return;
  }

  const lastCheck = line.state ? await latestLineCheck(env, line.id) : null;
  const prompt = buildLineCheckPrompt({
    symbol: line.symbol,
    line,
    intervalMinutes: line.check_interval_minutes,
    candles,
    volumeRatioVsAverage: volumeRatioVsAverage(candles),
    previous:
      line.state && line.state_since !== null
        ? { state: line.state, since: line.state_since, reasoning: lastCheck?.reasoning ?? "" }
        : null,
  });

  const model = claudeModel(env);
  const cacheKey = lineCheckCacheKey({
    lineId: line.id,
    intervalMinutes: line.check_interval_minutes,
    candleTimestamp: latest.timestamp,
  });

  let result = (await env.LLM_CACHE.get(cacheKey, "json")) as LineCheckResult | null;
  const fromCache = result !== null;
  if (!result) {
    try {
      result = await withRetries(
        () => callClaudeLineCheck({ apiKey: env.ANTHROPIC_API_KEY, model, prompt }),
        LLM_CALL_RETRIES,
      );
    } catch (err) {
      console.error(`line check failed for ${line.id}:`, err);
      return;
    }
    await env.LLM_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }

  const check: LineCheck = {
    id: crypto.randomUUID(),
    line_id: line.id,
    candle_timestamp: latest.timestamp,
    checked_at: new Date().toISOString(),
    state: result.state,
    previous_state: line.state,
    state_changed: result.state !== line.state,
    confidence: result.confidence,
    reasoning: result.reasoning,
    model,
    prompt,
    from_cache: fromCache,
  };
  await recordLineCheck(env, line, check);
}
