import {
  buildLineCheckPrompt,
  callClaudeLineCheck,
  isLineNearCandles,
  lineValueAt,
  volumeRatioVsAverage,
  type Line,
  type LineCheckContext,
  type LineCheckResult,
  type LineState,
  type OHLCV,
} from "shared";
import { mockJudge } from "./mockJudge.js";
import type { ReplayCheckLog, ReplayConfig, ReplayOutput, SimulatedTrade, TradeDirection } from "./types.js";

async function judge(config: ReplayConfig, context: LineCheckContext, prompt: string): Promise<LineCheckResult> {
  if (config.llmMode === "mock") return mockJudge(context);

  if (!config.claudeApiKey) throw new Error("--llm=claude requires --claude-api-key (or ANTHROPIC_API_KEY env var)");
  return callClaudeLineCheck({ apiKey: config.claudeApiKey, model: config.claudeModel, prompt });
}

function simulateTradeExit(
  candles: OHLCV[],
  entryIndex: number,
  direction: TradeDirection,
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  maxHoldBars: number,
): { exitIndex: number; exitPrice: number; reason: SimulatedTrade["exit_reason"] } {
  const lastIndex = Math.min(candles.length - 1, entryIndex + maxHoldBars);
  for (let i = entryIndex + 1; i <= lastIndex; i++) {
    const candle = candles[i]!;
    if (direction === "long") {
      if (candle.low <= stopLoss) return { exitIndex: i, exitPrice: stopLoss, reason: "stop_loss" };
      if (candle.high >= takeProfit) return { exitIndex: i, exitPrice: takeProfit, reason: "take_profit" };
    } else {
      if (candle.high >= stopLoss) return { exitIndex: i, exitPrice: stopLoss, reason: "stop_loss" };
      if (candle.low <= takeProfit) return { exitIndex: i, exitPrice: takeProfit, reason: "take_profit" };
    }
  }
  const last = candles[lastIndex]!;
  return { exitIndex: lastIndex, exitPrice: last.close, reason: "max_hold" };
}

/**
 * Replays one line against the candle history of its check_interval_minutes, running the same
 * periodic check the live Worker cron does on every closed candle (ask the LLM for the line's state
 * with the previous state as context; with --margin-pct, skip candles where price is far away), then
 * simulates a trade whenever the state changes to broken_up / broken_down.
 *
 * Trade rule (not specified by the spec — v0.2 leaves execution/exit design
 * open, see spec section 9): enter in the breakout direction at the
 * confirming candle's close, stop-loss at the broken line's value, take
 * profit at `riskRewardRatio` x that risk, exit at max_hold bars otherwise.
 * No new trade is opened on a line while its previous trade is still open.
 */
export async function replayLine(config: ReplayConfig, line: Line, candles: OHLCV[]): Promise<ReplayOutput> {
  const trades: SimulatedTrade[] = [];
  const checkLog: ReplayCheckLog[] = [];

  let state: LineState | null = null;
  let stateSince: number | null = null;
  let lastReasoning = "";
  let openTradeUntilIndex = -1;

  for (let i = 0; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i - config.candleWindow + 1), i + 1);
    const current = candles[i]!;
    if (config.checkMarginPct !== null && !isLineNearCandles(line, window, config.checkMarginPct)) continue;

    const context: LineCheckContext = {
      symbol: line.symbol,
      line,
      intervalMinutes: line.check_interval_minutes,
      candles: window,
      volumeRatioVsAverage: volumeRatioVsAverage(window),
      previous: state && stateSince !== null ? { state, since: stateSince, reasoning: lastReasoning } : null,
    };
    const prompt = buildLineCheckPrompt(context);
    const result = await judge(config, context, prompt);

    const changed = result.state !== state;
    checkLog.push({
      line_id: line.id,
      candle_timestamp: current.timestamp,
      state: result.state,
      previous_state: state,
      state_changed: changed,
      confidence: result.confidence,
      reasoning: result.reasoning,
      prompt,
    });
    if (changed) stateSince = current.timestamp;
    state = result.state;
    lastReasoning = result.reasoning;

    if (!changed || (result.state !== "broken_up" && result.state !== "broken_down")) continue;
    if (i <= openTradeUntilIndex) continue;

    const lineValue = lineValueAt(line, current.timestamp);
    if (lineValue === null) continue;
    const direction: TradeDirection = result.state === "broken_up" ? "long" : "short";
    const entryPrice = current.close;
    const stopLoss = lineValue;
    const risk = Math.abs(entryPrice - stopLoss);
    const takeProfit = direction === "long" ? entryPrice + risk * config.riskRewardRatio : entryPrice - risk * config.riskRewardRatio;

    const exit = simulateTradeExit(candles, i, direction, entryPrice, stopLoss, takeProfit, config.maxHoldBars);
    const pnlRaw = direction === "long" ? exit.exitPrice - entryPrice : entryPrice - exit.exitPrice;
    openTradeUntilIndex = exit.exitIndex;

    trades.push({
      line_id: line.id,
      direction,
      entry_time: current.timestamp,
      entry_price: entryPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      exit_time: candles[exit.exitIndex]!.timestamp,
      exit_price: exit.exitPrice,
      exit_reason: exit.reason,
      pnl_pct: pnlRaw / entryPrice,
    });
  }

  return { trades, checkLog };
}
