import type { Line, LineKind, LinePoint } from "shared";
import { deleteLine, getLine, insertLine, listLines } from "../db.js";
import type { Env } from "../env.js";

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

function validateCreateLineBody(body: unknown): { symbol: string; kind: LineKind; points: LinePoint[] } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.symbol !== "string" || !b.symbol) return null;
  if (b.kind !== "horizontal" && b.kind !== "trend") return null;
  if (!Array.isArray(b.points) || !b.points.every(isValidPoint)) return null;

  const expectedPoints = b.kind === "horizontal" ? 1 : 2;
  if (b.points.length !== expectedPoints) return null;

  return { symbol: b.symbol, kind: b.kind, points: b.points };
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
      { error: "expected { symbol: string, kind: 'horizontal'|'trend', points: {price,timestamp}[] }" },
      400,
    );
  }

  const line: Line = {
    id: crypto.randomUUID(),
    symbol: validated.symbol,
    kind: validated.kind,
    points: validated.points,
    created_at: new Date().toISOString(),
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
