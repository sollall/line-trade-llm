import {
  callClaudeJudge,
  checkTouch,
  inferDirection,
  lineValueAt,
  type Line,
  type LlmJudgmentAttempt,
  type LlmJudgmentResult,
  type OHLCV,
} from "shared";
import { mockJudge } from "./mockJudge.js";
import type { ReplayConfig, ReplayOutput, ReplayTouchLog, SimulatedTrade, TradeDirection } from "./types.js";

interface OpenEvent {
  touched_at: number;
  price_at_touch: number;
  retry_count: number;
  attempts: LlmJudgmentAttempt[];
}

async function judge(
  config: ReplayConfig,
  line: Line,
  candles: OHLCV[],
  lineValue: number,
  retryAttempt: number,
  priorTouchCount: number,
  priorRejectCount: number,
): Promise<LlmJudgmentResult> {
  const latest = candles[candles.length - 1]!;
  const avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
  const direction = inferDirection(line, lineValue, candles[0]!.close);

  const context = {
    symbol: line.symbol,
    line,
    lineValue,
    direction,
    candles,
    priorTouchCount,
    priorRejectCount,
    volumeRatioVsAverage: avgVolume ? latest.volume / avgVolume : 1,
    retryAttempt,
  };

  if (config.llmMode === "mock") return mockJudge(context);

  if (!config.claudeApiKey) throw new Error("--llm=claude requires --claude-api-key (or ANTHROPIC_API_KEY env var)");
  return callClaudeJudge({ apiKey: config.claudeApiKey, model: config.claudeModel, context });
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
 * Replays a symbol's candle history against its saved lines, running the
 * exact same touch-detection + LLM-judgment logic the live Worker cron uses
 * (spec section 4/6), then simulates a trade for every break_confirmed
 * decision to produce the win_rate/profit_factor/max_drawdown inputs
 * (spec 5.3).
 *
 * Trade rule (not specified by the spec — v0.2 leaves execution/exit design
 * open, see spec section 9): enter in the breakout direction at the
 * confirming candle's close, stop-loss at the broken line's value, take
 * profit at `riskRewardRatio` x that risk, exit at max_hold bars otherwise.
 */
export async function replaySymbol(config: ReplayConfig, lines: Line[], candles: OHLCV[]): Promise<ReplayOutput> {
  if (candles.length === 0) {
    return { period_start: 0, period_end: 0, trades: [], touchLog: [] };
  }

  const openEvents = new Map<string, OpenEvent>();
  const resolvedCounts = new Map<string, { touchCount: number; rejectCount: number }>();
  const trades: SimulatedTrade[] = [];
  const touchLog: ReplayTouchLog[] = [];

  for (let i = 0; i < candles.length; i++) {
    const windowStart = Math.max(0, i - config.candleWindow + 1);
    const window = candles.slice(windowStart, i + 1);
    const current = candles[i]!;

    for (const line of lines) {
      const history = resolvedCounts.get(line.id) ?? { touchCount: 0, rejectCount: 0 };
      let open = openEvents.get(line.id);

      if (!open) {
        const check = checkTouch(line, current.close, current.timestamp, { thresholdPct: config.touchThresholdPct });
        if (!check?.touched) continue;
        open = { touched_at: current.timestamp, price_at_touch: current.close, retry_count: 0, attempts: [] };
        openEvents.set(line.id, open);
      }

      const lineValue = lineValueAt(line, current.timestamp) ?? current.close;
      const result = await judge(config, line, window, lineValue, open.retry_count, history.touchCount, history.rejectCount);
      open.attempts.push({
        attempted_at: new Date(current.timestamp).toISOString(),
        candle_count: window.length,
        result,
        from_cache: false,
      });

      if (result.decision === "undetermined") {
        open.retry_count += 1;
        if (open.retry_count <= config.maxUndeterminedRetries) continue; // keep waiting for the next candle

        // timed out -> treated as hold_reject-equivalent (spec 6.4 point 4)
        openEvents.delete(line.id);
        resolvedCounts.set(line.id, { touchCount: history.touchCount + 1, rejectCount: history.rejectCount + 1 });
        touchLog.push({
          line_id: line.id,
          touched_at: open.touched_at,
          resolved_status: "timeout",
          decision: "undetermined",
          bars_to_resolve: open.retry_count,
          attempts: open.attempts,
        });
        continue;
      }

      openEvents.delete(line.id);
      const resolvedStatus = result.decision === "break_confirmed" ? "confirmed" : "rejected";
      resolvedCounts.set(line.id, {
        touchCount: history.touchCount + 1,
        rejectCount: history.rejectCount + (resolvedStatus === "rejected" ? 1 : 0),
      });
      touchLog.push({
        line_id: line.id,
        touched_at: open.touched_at,
        resolved_status: resolvedStatus,
        decision: result.decision,
        bars_to_resolve: open.retry_count,
        attempts: open.attempts,
      });

      if (result.decision !== "break_confirmed") continue;

      const direction: TradeDirection = inferDirection(line, lineValue, window[0]!.close) === "resistance" ? "long" : "short";
      const entryPrice = current.close;
      const stopLoss = lineValue;
      const risk = Math.abs(entryPrice - stopLoss);
      const takeProfit = direction === "long" ? entryPrice + risk * config.riskRewardRatio : entryPrice - risk * config.riskRewardRatio;

      const exit = simulateTradeExit(candles, i, direction, entryPrice, stopLoss, takeProfit, config.maxHoldBars);
      const pnlRaw = direction === "long" ? exit.exitPrice - entryPrice : entryPrice - exit.exitPrice;

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
        bars_to_resolve: open.retry_count,
      });
    }
  }

  return {
    period_start: candles[0]!.timestamp,
    period_end: candles[candles.length - 1]!.timestamp,
    trades,
    touchLog,
  };
}
