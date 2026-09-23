import { getExchangeClient, type OHLCV } from "shared";
import { candleIntervalMinutes, type Env } from "../env.js";

/** Timeframes (minutes) the chart UI may request — the ones both Hyperliquid and Backpack support. */
const SUPPORTED_INTERVALS = new Set([1, 3, 5, 15, 30, 60, 120, 240, 480, 720, 1440]);

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
/** Guard against runaway subrequests if an exchange keeps returning tiny pages. */
const MAX_PAGES = 20;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * GET /candles?symbol=BTC&interval=15&limit=1000&endTime=<epoch ms> — chart data for the line-drawing UI.
 * - interval: timeframe in minutes (defaults to CANDLE_INTERVAL_MINUTES)
 * - limit: number of candles ending at endTime (max 5000)
 * - endTime: defaults to now; the UI passes the oldest loaded candle's time to page further back
 *
 * Exchanges cap how many candles a single request returns, so the range is fetched in pages walking
 * forward from the start until endTime is reached. Hyperliquid only serves the most recent 5000
 * candles per timeframe, so older ranges come back empty there.
 */
export async function handleGetCandles(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  if (!symbol) return json({ error: "symbol query param is required" }, 400);

  const intervalParam = url.searchParams.get("interval");
  const intervalMinutes = intervalParam === null ? candleIntervalMinutes(env) : Number(intervalParam);
  if (!SUPPORTED_INTERVALS.has(intervalMinutes)) {
    return json({ error: `unsupported interval: ${intervalParam}` }, 400);
  }

  const limit = Math.min(Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
  const endTime = Number(url.searchParams.get("endTime")) || Date.now();
  const intervalMs = intervalMinutes * 60_000;
  const startTime = endTime - intervalMs * limit;

  const client = getExchangeClient(env.EXCHANGE);
  try {
    const candles: OHLCV[] = [];
    let cursor = startTime;
    for (let page = 0; page < MAX_PAGES && cursor < endTime; page++) {
      const chunk = await client.getCandles(symbol, intervalMinutes, cursor, endTime);
      const lastTimestamp = candles.at(-1)?.timestamp ?? -Infinity;
      const fresh = chunk
        .filter((c) => c.timestamp > lastTimestamp && c.timestamp >= startTime && c.timestamp < endTime)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (fresh.length === 0) break;
      candles.push(...fresh);
      cursor = fresh.at(-1)!.timestamp + intervalMs;
    }
    return json(candles);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to fetch candles";
    return json({ error: message }, 502);
  }
}
