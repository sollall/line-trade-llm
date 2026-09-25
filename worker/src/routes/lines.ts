import { SUPPORTED_INTERVALS, type Line, type LineKind, type LinePoint } from "shared";
import { deleteLine, getLine, insertLine, listLineChecks, listLines } from "../db.js";
import { defaultCheckIntervalMinutes, type Env } from "../env.js";

const DEFAULT_CHECKS_LIMIT = 100;
const MAX_CHECKS_LIMIT = 1000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isValidPoint(p: unknown): p is LinePoint {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as LinePoint).price === "number" &&
    typeof (p as LinePoint).timestamp === "number"
  );
}

interface CreateLineBody {
  symbol: string;
  kind: LineKind;
  points: LinePoint[];
  check_interval_minutes?: number;
}

function validateCreateLineBody(body: unknown): CreateLineBody | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.symbol !== "string" || !b.symbol) return null;
  if (b.kind !== "horizontal" && b.kind !== "trend") return null;
  if (!Array.isArray(b.points) || !b.points.every(isValidPoint)) return null;

  const expectedPoints = b.kind === "horizontal" ? 1 : 2;
  if (b.points.length !== expectedPoints) return null;

  if (b.check_interval_minutes !== undefined && !SUPPORTED_INTERVALS.includes(b.check_interval_minutes as number)) {
    return null;
  }

  return {
    symbol: b.symbol,
    kind: b.kind,
    points: b.points,
    check_interval_minutes: b.check_interval_minutes as number | undefined,
  };
}

export async function handleCreateLine(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const validated = validateCreateLineBody(body);
  if (!validated) {
    return json(
      {
        error: `expected { symbol: string, kind: 'horizontal'|'trend', points: {price,timestamp}[], check_interval_minutes?: ${SUPPORTED_INTERVALS.join("|")} }`,
      },
      400,
    );
  }

  const line: Line = {
    id: crypto.randomUUID(),
    symbol: validated.symbol,
    kind: validated.kind,
    points: validated.points,
    created_at: new Date().toISOString(),
    check_interval_minutes: validated.check_interval_minutes ?? defaultCheckIntervalMinutes(env),
    state: null,
    state_since: null,
    last_checked_candle: null,
  };
  await insertLine(env, line);
  return json(line, 201);
}

export async function handleListLines(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? undefined;
  const lines = await listLines(env, symbol);
  return json(lines);
}

export async function handleDeleteLine(env: Env, id: string): Promise<Response> {
  const existing = await getLine(env, id);
  if (!existing) return json({ error: "not found" }, 404);
  await deleteLine(env, id);
  return new Response(null, { status: 204 });
}

/**
 * GET /lines/{id}/checks?limit=&changes_only=1 — the line's periodic LLM checks, newest first, each
 * with the exact prompt sent and the state/confidence/reasoning returned.
 */
export async function handleListLineChecks(request: Request, env: Env, id: string): Promise<Response> {
  const existing = await getLine(env, id);
  if (!existing) return json({ error: "not found" }, 404);
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || DEFAULT_CHECKS_LIMIT, MAX_CHECKS_LIMIT);
  const changesOnly = url.searchParams.get("changes_only") === "1";
  return json(await listLineChecks(env, id, { limit, changesOnly }));
}
