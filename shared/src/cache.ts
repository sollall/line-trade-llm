/**
 * Same-situation caching (spec section 8): a line is judged at most once per closed candle, so a
 * retried Cron tick (e.g. after a DB write failed) reuses the earlier answer instead of re-billing
 * the LLM.
 */
export function lineCheckCacheKey(params: { lineId: string; intervalMinutes: number; candleTimestamp: number }): string {
  return `check:${params.lineId}:${params.intervalMinutes}:${params.candleTimestamp}`;
}
