import { runCronPoll } from "./cron.js";
import type { Env } from "./env.js";
import { handleGetCandles } from "./routes/candles.js";
import { handleCreateLine, handleDeleteLine, handleListLineChecks, handleListLines } from "./routes/lines.js";
import { handleListSymbols } from "./routes/symbols.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/lines" && request.method === "POST") {
        return withCors(await handleCreateLine(request, env));
      }
      if (url.pathname === "/lines" && request.method === "GET") {
        return withCors(await handleListLines(request, env));
      }
      const lineIdMatch = url.pathname.match(/^\/lines\/([^/]+)$/);
      if (lineIdMatch && request.method === "DELETE") {
        return withCors(await handleDeleteLine(env, lineIdMatch[1]!));
      }
      const lineChecksMatch = url.pathname.match(/^\/lines\/([^/]+)\/checks$/);
      if (lineChecksMatch && request.method === "GET") {
        return withCors(await handleListLineChecks(request, env, lineChecksMatch[1]!));
      }
      if (url.pathname === "/candles" && request.method === "GET") {
        return withCors(await handleGetCandles(request, env));
      }
      if (url.pathname === "/symbols" && request.method === "GET") {
        return withCors(await handleListSymbols(env));
      }

      return withCors(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return withCors(new Response(JSON.stringify({ error: message }), { status: 500 }));
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCronPoll(env));
  },
} satisfies ExportedHandler<Env>;
