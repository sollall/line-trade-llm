/**
 * Same-situation caching (spec section 8): identical line + close price band +
 * close time band + same retry stage should reuse a prior judgment instead of
 * re-billing the LLM. Callers round price/time into buckets and pass the
 * bucketed values in here.
 */
export function judgmentCacheKey(params: {
  lineId: string;
  priceBucket: number;
  timeBucketMs: number;
  retryAttempt: number;
}): string {
  return `judge:${params.lineId}:${params.priceBucket}:${params.timeBucketMs}:${params.retryAttempt}`;
}

/** Rounds price into buckets sized as a percentage of the price itself. */
export function bucketPrice(price: number, bucketPct: number): number {
  const bucketSize = price * bucketPct;
  if (!bucketSize) return price;
  return Math.round(price / bucketSize) * bucketSize;
}

export function bucketTime(timestampMs: number, bucketMs: number): number {
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

export const DEFAULT_CACHE_PRICE_BUCKET_PCT = 0.0002; // 0.02%
export const DEFAULT_CACHE_TIME_BUCKET_MS = 60_000; // 1 minute, matches candle size
