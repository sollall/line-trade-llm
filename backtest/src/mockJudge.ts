import { lineValueAt, type LineCheckContext, type LineCheckResult } from "shared";

/**
 * Deterministic stand-in for the Claude API check, used with --llm=mock.
 * Lets the wiring (periodic check -> state transitions -> trade simulation ->
 * metrics) be validated for free before spending on real Claude calls.
 * Rule: latest close within a small buffer of the line -> testing; closed
 * beyond it -> broken_up/broken_down if price was on the other side (or
 * testing) before, otherwise holding_above/holding_below.
 */
export function mockJudge(ctx: LineCheckContext): LineCheckResult {
  const latest = ctx.candles[ctx.candles.length - 1];
  const lineValue = latest ? lineValueAt(ctx.line, latest.timestamp) : null;
  if (!latest || lineValue === null) return { state: "testing", confidence: 0, reasoning: "mock: no candle data" };

  const buffer = Math.abs(lineValue) * 0.0008;
  const distance = latest.close - lineValue;
  if (Math.abs(distance) <= buffer) {
    return { state: "testing", confidence: 0.3, reasoning: "mock: closed right at the line" };
  }

  const above = distance > 0;
  const previous = ctx.previous?.state ?? null;
  const cameFromOtherSide = above
    ? previous === "holding_below" || previous === "broken_down" || previous === "testing"
    : previous === "holding_above" || previous === "broken_up" || previous === "testing";
  if (cameFromOtherSide) {
    return above
      ? { state: "broken_up", confidence: 0.7, reasoning: "mock: body closed above the line" }
      : { state: "broken_down", confidence: 0.7, reasoning: "mock: body closed below the line" };
  }
  return above
    ? { state: "holding_above", confidence: 0.6, reasoning: "mock: price above the line" }
    : { state: "holding_below", confidence: 0.6, reasoning: "mock: price below the line" };
}
