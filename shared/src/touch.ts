import type { Line } from "./types.js";

/**
 * Value of a line at a given timestamp.
 * - horizontal: constant, independent of timestamp.
 * - trend: linearly interpolated/extrapolated between its two points (treated
 *   as an infinite ray in both directions — see spec section 9, "segment vs
 *   ray" is still an open question; extrapolation is the safer default for
 *   catching future touches).
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

export interface TouchCheckOptions {
  /** Relative distance threshold, e.g. 0.0005 = 0.05% of the line value. */
  thresholdPct: number;
}

export interface TouchCheckResult {
  touched: boolean;
  lineValue: number;
  /** Relative distance between price and lineValue (always >= 0). */
  distancePct: number;
}

/** Rule-based touch detection: pure numeric comparison, no LLM involved. */
export function checkTouch(
  line: Line,
  price: number,
  timestamp: number,
  options: TouchCheckOptions,
): TouchCheckResult | null {
  const lineValue = lineValueAt(line, timestamp);
  if (lineValue === null || lineValue === 0) return null;

  const distancePct = Math.abs(price - lineValue) / Math.abs(lineValue);
  return {
    touched: distancePct <= options.thresholdPct,
    lineValue,
    distancePct,
  };
}

export const DEFAULT_TOUCH_THRESHOLD_PCT = 0.0005; // 0.05%, see spec section 9
