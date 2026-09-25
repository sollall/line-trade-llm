import type { Line, OHLCV } from "./types.js";

/**
 * Value of a line at a given timestamp.
 * - horizontal: constant, independent of timestamp.
 * - trend: linearly interpolated/extrapolated between its two points (treated
 *   as an infinite ray in both directions — see spec section 9, "segment vs
 *   ray" is still an open question; extrapolation is the safer default for
 *   checking the line against future candles).
 * Returns null if the line doesn't have enough points to be evaluated.
 */
export function lineValueAt(line: Line, timestamp: number): number | null {
  if (line.kind === "horizontal") {
    const p = line.points[0];
    return p ? p.price : null;
  }

  const [p0, p1] = line.points;
  if (!p0 || !p1 || p1.timestamp === p0.timestamp) return null;

  const slope = (p1.price - p0.price) / (p1.timestamp - p0.timestamp);
  return p0.price + slope * (timestamp - p0.timestamp);
}

/**
 * Whether a line is close to the recent candles: its value falls inside the window's low-high range
 * (evaluated per candle, so trend lines work too), widened by `marginPct` of the line value.
 * Only used when the optional CHECK_MARGIN_PCT / --margin-pct filter is enabled to cut API calls;
 * by default every line is sent to the LLM on every candle close.
 */
export function isLineNearCandles(line: Line, candles: OHLCV[], marginPct: number): boolean {
  return candles.some((c) => {
    const value = lineValueAt(line, c.timestamp);
    if (value === null) return false;
    const margin = Math.abs(value) * marginPct;
    return value >= c.low - margin && value <= c.high + margin;
  });
}

/**
 * Open time of the most recent fully closed candle at `now`. Exchange candles are aligned to
 * multiples of the interval since the Unix epoch (daily candles open at 00:00 UTC).
 */
export function latestClosedCandleOpen(now: number, intervalMinutes: number): number {
  const intervalMs = intervalMinutes * 60_000;
  return Math.floor(now / intervalMs) * intervalMs - intervalMs;
}

export function volumeRatioVsAverage(candles: OHLCV[]): number {
  const latest = candles[candles.length - 1];
  if (!latest) return 1;
  const avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
  return avgVolume ? latest.volume / avgVolume : 1;
}
