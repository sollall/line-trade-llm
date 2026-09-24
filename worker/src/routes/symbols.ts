import { getExchangeClient } from "shared";
import type { Env } from "../env.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * GET /symbols — markets tradable on the configured EXCHANGE, most liquid (24h volume) first,
 * so the UI only offers symbols the Cron poller can actually price.
 */
export async function handleListSymbols(env: Env): Promise<Response> {
  try {
    return json(await getExchangeClient(env.EXCHANGE).listSymbols());
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to fetch symbols";
    return json({ error: message }, 502);
  }
}
