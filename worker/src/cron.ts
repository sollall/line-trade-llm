import { getExchangeClient, type Line, type OHLCV, type TouchEvent } from "shared";
import { insertTouchEvent, listLines, listOpenTouchEvents, updateTouchEvent } from "./db.js";
import { candleIntervalMinutes, candleWindow, type Env } from "./env.js";
import { judgeTouchEvent, newlyTouched } from "./judge.js";

function groupBySymbol(lines: Line[]): Map<string, Line[]> {
  const map = new Map<string, Line[]>();
  for (const line of lines) {
    const list = map.get(line.symbol);
    if (list) list.push(line);
    else map.set(line.symbol, [line]);
  }
  return map;
}

async function processLine(env: Env, line: Line, candles: OHLCV[], currentPrice: number, now: number): Promise<void> {
  const openEvents = await listOpenTouchEvents(env, line.id);

  if (openEvents.length > 0) {
    // An existing touch is still being judged (pending) or needs a Cron-cycle
    // retry (failed, per spec 4.2) — resolve that before considering a new touch.
    for (const event of openEvents) {
      const outcome = await judgeTouchEvent(env, line, event, candles);
      await updateTouchEvent(env, event.id, outcome);
    }
    return;
  }

  if (!newlyTouched(line, currentPrice, now, env)) return;

  const event: TouchEvent = {
    id: crypto.randomUUID(),
    line_id: line.id,
    touched_at: new Date(now).toISOString(),
    price_at_touch: currentPrice,
    status: "pending",
    retry_count: 0,
    llm_judgment: null,
    llm_raw_response: [],
  };
  await insertTouchEvent(env, event);

  const outcome = await judgeTouchEvent(env, line, event, candles);
  await updateTouchEvent(env, event.id, outcome);
}

/** Entry point for the 1-minute Cron Trigger (spec section 4/4.2). */
export async function runCronPoll(env: Env): Promise<void> {
  const client = getExchangeClient(env.EXCHANGE);
  const lines = await listLines(env);
  if (lines.length === 0) return;

  const intervalMinutes = candleIntervalMinutes(env);
  const windowSize = candleWindow(env);
  const now = Date.now();
  const startTime = now - intervalMinutes * 60_000 * windowSize;

  for (const [symbol, symbolLines] of groupBySymbol(lines)) {
    let candles: OHLCV[];
    let currentPrice: number;
    try {
      const [candleData, priceData] = await Promise.all([
        client.getCandles(symbol, intervalMinutes, startTime, now),
        client.getCurrentPrice(symbol),
      ]);
      candles = candleData;
      currentPrice = priceData.price;
    } catch {
      // Whole symbol batch failed (rate limit, network) — the next Cron tick
      // retries naturally, per spec 4.2's "let the next cycle be the retry".
      continue;
    }
    if (candles.length === 0) continue;

    for (const line of symbolLines) {
      await processLine(env, line, candles, currentPrice, now);
    }
  }
}
