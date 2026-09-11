import { getExchangeClient } from "shared";
import { candleIntervalMinutes, type Env } from "../env.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GET /candles?symbol=BTC&limit=300 — chart data for the line-drawing UI. */
export async function handleGetCandles(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol");
  if (!symbol) return json({ error: "symbol query param is required" }, 400);

  const limit = Number(url.searchParams.get("limit") ?? "300") || 300;
  const intervalMinutes = candleIntervalMinutes(env);
  const now = Date.now();
  const startTime = now - intervalMinutes * 60_000 * limit;

  const client = getExchangeClient(env.EXCHANGE);
  try {
    const candles = await client.getCandles(symbol, intervalMinutes, startTime, now);
    return json(candles);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to fetch candles";
    return json({ error: message }, 502);
  }
}
