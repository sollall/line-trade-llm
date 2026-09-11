import type { Line, OHLCV } from "../types.js";

export type LineDirection = "support" | "resistance";

export interface JudgmentContext {
  symbol: string;
  line: Line;
  lineValue: number;
  direction: LineDirection;
  /** Most recent N candles, chronological order, last element = latest closed candle. */
  candles: OHLCV[];
  priorTouchCount: number;
  priorRejectCount: number;
  /** Recent volume divided by the average volume over the candle window. */
  volumeRatioVsAverage: number;
  /** 0 = first judgment for this touch event, >0 = re-judgment after `undetermined`. */
  retryAttempt: number;
}

const SYSTEM_PROMPT = `You are a discretionary price-action trading assistant. A price has approached a
line the trader drew on their chart (a horizontal support/resistance level or a trend line).
Your job is ONLY to classify whether the line has been clearly broken by candle bodies, or
whether it has been rejected (wicked into but closed back on the original side), or whether
it is still too early to tell from the candles shown.

Judge using classic price-action reasoning: body close position relative to the line, wick
length, and whether volume confirms a genuine break. Do not give trading advice beyond the
three-way classification. Always call the report_judgment tool exactly once.`;

export function buildJudgmentPrompt(ctx: JudgmentContext): string {
  const directionLabel = ctx.direction === "support" ? "support (line below price)" : "resistance (line above price)";
  const kindLabel = ctx.line.kind === "horizontal" ? "horizontal line" : "trend line";

  const candleLines = ctx.candles
    .map((c, i) => {
      const t = new Date(c.timestamp).toISOString();
      const tag = i === ctx.candles.length - 1 ? " (latest)" : "";
      return `  {"t":"${t}","o":${c.open},"h":${c.high},"l":${c.low},"c":${c.close},"v":${c.volume}}${tag}`;
    })
    .join("\n");

  return `Symbol: ${ctx.symbol}
Line type: ${kindLabel}, currently acting as ${directionLabel}
Line value at latest candle: ${ctx.lineValue}
Prior touches on this line: ${ctx.priorTouchCount} (of which rejected/held: ${ctx.priorRejectCount})
Recent volume vs average: ${ctx.volumeRatioVsAverage.toFixed(2)}x
Re-judgment attempt: ${ctx.retryAttempt} (0 = first look at this touch)

Recent OHLCV candles, oldest first, most recent last:
[
${candleLines}
]

Classify this touch as break_confirmed, hold_reject, or undetermined, and call report_judgment.`;
}

export const SYSTEM = SYSTEM_PROMPT;

export function inferDirection(line: Line, lineValueAtTouchStart: number, priceAtWindowStart: number): LineDirection {
  return priceAtWindowStart < lineValueAtTouchStart ? "resistance" : "support";
}
