import { getExchangeClient, latestClosedCandleOpen, type Line, type OHLCV } from "shared";
import { checkLine } from "./check.js";
import { listLines } from "./db.js";
import { candleWindow, type Env } from "./env.js";

/** Lines sharing a symbol and check timeframe are served by a single candle fetch. */
function groupBySymbolAndInterval(lines: Line[]): Map<string, Line[]> {
  const map = new Map<string, Line[]>();
  for (const line of lines) {
    const key = `${line.symbol}:${line.check_interval_minutes}`;
    const list = map.get(key);
    if (list) list.push(line);
    else map.set(key, [line]);
  }
  return map;
}

/**
 * Entry point for the 1-minute Cron Trigger. Each line is checked once per closed candle of its own
 * check_interval_minutes: a line is due when its latest closed candle is newer than the last one it
 * was checked against, so a missed tick is caught up on the next one.
 */
export async function runCronPoll(env: Env): Promise<void> {
  const client = getExchangeClient(env.EXCHANGE);
  const lines = await listLines(env);
  if (lines.length === 0) return;

  const windowSize = candleWindow(env);
  const now = Date.now();

  for (const group of groupBySymbolAndInterval(lines).values()) {
    const { symbol, check_interval_minutes: intervalMinutes } = group[0]!;
    const target = latestClosedCandleOpen(now, intervalMinutes);
    const due = group.filter((line) => line.last_checked_candle === null || line.last_checked_candle < target);
    if (due.length === 0) continue;

    const intervalMs = intervalMinutes * 60_000;
    let window: OHLCV[];
    try {
      const candles = await client.getCandles(symbol, intervalMinutes, target - intervalMs * windowSize, now);
      // Drop the still-forming candle so the LLM only ever sees closed ones.
      window = candles
        .filter((c) => c.timestamp <= target)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-windowSize);
    } catch {
      // Rate limit / network — the next Cron tick retries naturally (spec 4.2).
      continue;
    }
    // The exchange hasn't published the just-closed candle yet; try again next tick.
    if (window.at(-1)?.timestamp !== target) continue;

    for (const line of due) {
      await checkLine(env, line, window);
    }
  }
}
