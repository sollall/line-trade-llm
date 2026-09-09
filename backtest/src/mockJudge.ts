import type { JudgmentContext, LlmJudgmentResult } from "shared";

/**
 * Deterministic stand-in for the Claude API judgment, used with --llm=mock.
 * Lets the wiring (touch detection -> judgment loop -> trade simulation ->
 * metrics) be validated for free before spending on real Claude calls.
 * Rule: body closed clearly beyond the line -> break_confirmed; wicked
 * through but closed back on the original side -> hold_reject; otherwise
 * (small body move right at the line) -> undetermined, same as the LLM would
 * be asked to keep waiting.
 */
export function mockJudge(ctx: JudgmentContext): LlmJudgmentResult {
  const latest = ctx.candles[ctx.candles.length - 1];
  if (!latest) return { decision: "undetermined", confidence: 0, reasoning: "no candle data" };

  const bodyBeyond = ctx.direction === "resistance" ? latest.close - ctx.lineValue : ctx.lineValue - latest.close;
  const wickBeyond =
    ctx.direction === "resistance" ? latest.high - ctx.lineValue : ctx.lineValue - latest.low;
  const buffer = ctx.lineValue * 0.0008;

  if (bodyBeyond > buffer) {
    return { decision: "break_confirmed", confidence: 0.7, reasoning: "mock: candle body closed beyond the line" };
  }
  if (wickBeyond > buffer && bodyBeyond < 0) {
    return { decision: "hold_reject", confidence: 0.6, reasoning: "mock: wicked through but closed back inside" };
  }
  return { decision: "undetermined", confidence: 0.3, reasoning: "mock: still too close to call" };
}
