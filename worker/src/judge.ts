import {
  DEFAULT_CACHE_PRICE_BUCKET_PCT,
  DEFAULT_CACHE_TIME_BUCKET_MS,
  bucketPrice,
  bucketTime,
  callClaudeJudge,
  checkTouch,
  inferDirection,
  judgmentCacheKey,
  lineValueAt,
  type Line,
  type LlmJudgmentAttempt,
  type LlmJudgmentResult,
  type OHLCV,
  type TouchEvent,
} from "shared";
import { countLineHistory } from "./db.js";
import { maxUndeterminedRetries, touchThresholdPct, type Env } from "./env.js";

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

async function judgeWithCache(
  env: Env,
  line: Line,
  candles: OHLCV[],
  retryAttempt: number,
  history: { touchCount: number; rejectCount: number },
): Promise<{ result: LlmJudgmentResult; fromCache: boolean }> {
  const latest = candles[candles.length - 1];
  if (!latest) throw new Error("judgeWithCache called with no candles");

  const lineValue = lineValueAt(line, latest.timestamp) ?? latest.close;
  const cacheKey = judgmentCacheKey({
    lineId: line.id,
    priceBucket: bucketPrice(latest.close, DEFAULT_CACHE_PRICE_BUCKET_PCT),
    timeBucketMs: bucketTime(latest.timestamp, DEFAULT_CACHE_TIME_BUCKET_MS),
    retryAttempt,
  });

  const cached = await env.LLM_CACHE.get(cacheKey, "json");
  if (cached) {
    return { result: cached as LlmJudgmentResult, fromCache: true };
  }

  const avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
  const direction = inferDirection(line, lineValue, candles[0]!.close);

  const result = await withRetries(
    () =>
      callClaudeJudge({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.CLAUDE_MODEL,
        context: {
          symbol: line.symbol,
          line,
          lineValue,
          direction,
          candles,
          priorTouchCount: history.touchCount,
          priorRejectCount: history.rejectCount,
          volumeRatioVsAverage: avgVolume ? latest.volume / avgVolume : 1,
          retryAttempt,
        },
      }),
    LLM_CALL_RETRIES,
  );

  await env.LLM_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  return { result, fromCache: false };
}

export interface JudgeOutcome {
  status: TouchEvent["status"];
  retry_count: number;
  llm_judgment: TouchEvent["llm_judgment"];
  llm_raw_response: LlmJudgmentAttempt[];
}

/**
 * Runs (or re-runs, for an `undetermined` retry) one LLM judgment for a touch
 * event and decides the next status per spec section 6.3/6.4:
 *   break_confirmed -> confirmed (done)
 *   hold_reject     -> rejected (done)
 *   undetermined    -> stays pending, retry_count++, unless the retry cap is
 *                       hit, in which case it times out as hold_reject-equivalent
 * On LLM/network failure after in-place retries, the event is marked
 * `failed` so the *next* Cron tick retries it (spec 4.2) rather than looping
 * here and burning the Worker's subrequest budget.
 */
export async function judgeTouchEvent(env: Env, line: Line, event: TouchEvent, candles: OHLCV[]): Promise<JudgeOutcome> {
  const retryAttempt = event.retry_count;

  let judged: { result: LlmJudgmentResult; fromCache: boolean };
  try {
    const history = await countLineHistory(env, line.id);
    judged = await judgeWithCache(env, line, candles, retryAttempt, history);
  } catch {
    return {
      status: "failed",
      retry_count: event.retry_count,
      llm_judgment: event.llm_judgment,
      llm_raw_response: event.llm_raw_response,
    };
  }

  const attempt: LlmJudgmentAttempt = {
    attempted_at: new Date().toISOString(),
    candle_count: candles.length,
    result: judged.result,
    from_cache: judged.fromCache,
  };
  const history = [...event.llm_raw_response, attempt];

  if (judged.result.decision === "break_confirmed") {
    return { status: "confirmed", retry_count: event.retry_count, llm_judgment: "break_confirmed", llm_raw_response: history };
  }
  if (judged.result.decision === "hold_reject") {
    return { status: "rejected", retry_count: event.retry_count, llm_judgment: "hold_reject", llm_raw_response: history };
  }

  // undetermined
  const nextRetryCount = event.retry_count + 1;
  if (nextRetryCount > maxUndeterminedRetries(env)) {
    return { status: "timeout", retry_count: nextRetryCount, llm_judgment: "undetermined", llm_raw_response: history };
  }
  return { status: "pending", retry_count: nextRetryCount, llm_judgment: "undetermined", llm_raw_response: history };
}

export function newlyTouched(line: Line, price: number, timestamp: number, env: Env): boolean {
  const check = checkTouch(line, price, timestamp, { thresholdPct: touchThresholdPct(env) });
  return check?.touched ?? false;
}
