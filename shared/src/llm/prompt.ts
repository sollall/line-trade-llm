import { lineValueAt } from "../line.js";
import type { Line, LineState, OHLCV } from "../types.js";

export interface LineCheckContext {
  symbol: string;
  line: Line;
  intervalMinutes: number;
  /** Most recent closed candles, chronological order, last element = latest closed candle. */
  candles: OHLCV[];
  /** Recent volume divided by the average volume over the candle window. */
  volumeRatioVsAverage: number;
  /** State reported by the previous check, null on the first check of this line. */
  previous: { state: LineState; since: number; reasoning: string } | null;
}

const SYSTEM_PROMPT = `You are a discretionary price-action trading assistant. The trader drew a line on
their chart (a horizontal support/resistance level or a trend line), and you are asked on every
candle close where price stands relative to that line. Classify the current state as one of:

- holding_above: price is above the line and the line is not being challenged, or it is acting as
  support (wicks into it get rejected and bodies close above).
- holding_below: price is below the line and the line is not being challenged, or it is acting as
  resistance (wicks into it get rejected and bodies close below).
- testing: price is interacting with the line right now (closing at it, or crossing it without a
  convincing close on either side), so it is too early to call a hold or a break.
- broken_up: candle bodies have decisively closed above a line that price was previously below or
  testing, i.e. an upside break has just been confirmed.
- broken_down: candle bodies have decisively closed below a line that price was previously above
  or testing, i.e. a downside break has just been confirmed.

broken_up / broken_down mark the moment a break is confirmed. If the previous state was already
broken_up and price keeps holding above the line, report holding_above (likewise holding_below
after broken_down). Judge using classic price-action reasoning: body close position relative to
the line, wick length, and whether volume confirms a genuine break. Do not give trading advice
beyond the classification. Always call the report_line_state tool exactly once.`;

function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function buildLineCheckPrompt(ctx: LineCheckContext): string {
  const latest = ctx.candles[ctx.candles.length - 1];
  const latestLineValue = latest ? lineValueAt(ctx.line, latest.timestamp) : null;
  const isTrend = ctx.line.kind === "trend";

  const lineDescription = isTrend
    ? `trend line (its value at each candle is given as "line")`
    : `horizontal line at ${latestLineValue}`;

  let position = "unknown";
  if (latest && latestLineValue) {
    const pct = ((latest.close - latestLineValue) / latestLineValue) * 100;
    position = `${pct >= 0 ? "+" : ""}${pct.toFixed(3)}% vs line`;
  }

  const previous = ctx.previous
    ? `${ctx.previous.state} (since candle ${new Date(ctx.previous.since).toISOString()}). Previous reasoning: ${ctx.previous.reasoning}`
    : "none (first check of this line)";

  const candleLines = ctx.candles
    .map((c, i) => {
      const t = new Date(c.timestamp).toISOString();
      const lineField = isTrend ? `,"line":${lineValueAt(ctx.line, c.timestamp)}` : "";
      const tag = i === ctx.candles.length - 1 ? " (latest)" : "";
      return `  {"t":"${t}","o":${c.open},"h":${c.high},"l":${c.low},"c":${c.close},"v":${c.volume}${lineField}}${tag}`;
    })
    .join("\n");

  return `Symbol: ${ctx.symbol}
Timeframe: ${intervalLabel(ctx.intervalMinutes)} candles
Line: ${lineDescription}
Line value at latest candle: ${latestLineValue}
Latest close: ${latest?.close} (${position})
Recent volume vs average: ${ctx.volumeRatioVsAverage.toFixed(2)}x
Previous state: ${previous}

Recent closed OHLCV candles, oldest first, most recent last:
[
${candleLines}
]

Classify the line's current state and call report_line_state.`;
}

export const SYSTEM = SYSTEM_PROMPT;
