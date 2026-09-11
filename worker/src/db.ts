import type { Line, LlmDecision, LlmJudgmentAttempt, TouchEvent, TouchEventStatus } from "shared";
import type { Env } from "./env.js";

interface LineRow {
  id: string;
  symbol: string;
  kind: string;
  points: string;
  created_at: string;
}

interface TouchEventRow {
  id: string;
  line_id: string;
  touched_at: string;
  price_at_touch: number;
  status: string;
  retry_count: number;
  llm_judgment: string | null;
  llm_raw_response: string;
}

function rowToLine(row: LineRow): Line {
  return {
    id: row.id,
    symbol: row.symbol,
    kind: row.kind as Line["kind"],
    points: JSON.parse(row.points),
    created_at: row.created_at,
  };
}

function rowToTouchEvent(row: TouchEventRow): TouchEvent {
  return {
    id: row.id,
    line_id: row.line_id,
    touched_at: row.touched_at,
    price_at_touch: row.price_at_touch,
    status: row.status as TouchEventStatus,
    retry_count: row.retry_count,
    llm_judgment: (row.llm_judgment as LlmDecision | null) ?? null,
    llm_raw_response: JSON.parse(row.llm_raw_response),
  };
}

export async function insertLine(env: Env, line: Line): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lines (id, symbol, kind, points, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(line.id, line.symbol, line.kind, JSON.stringify(line.points), line.created_at)
    .run();
}

export async function listLines(env: Env, symbol?: string): Promise<Line[]> {
  const stmt = symbol
    ? env.DB.prepare(`SELECT * FROM lines WHERE symbol = ? ORDER BY created_at DESC`).bind(symbol)
    : env.DB.prepare(`SELECT * FROM lines ORDER BY created_at DESC`);
  const { results } = await stmt.all<LineRow>();
  return results.map(rowToLine);
}

export async function getLine(env: Env, id: string): Promise<Line | null> {
  const row = await env.DB.prepare(`SELECT * FROM lines WHERE id = ?`).bind(id).first<LineRow>();
  return row ? rowToLine(row) : null;
}

export async function deleteLine(env: Env, id: string): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM lines WHERE id = ?`).bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function insertTouchEvent(env: Env, event: TouchEvent): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO touch_events (id, line_id, touched_at, price_at_touch, status, retry_count, llm_judgment, llm_raw_response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      event.id,
      event.line_id,
      event.touched_at,
      event.price_at_touch,
      event.status,
      event.retry_count,
      event.llm_judgment,
      JSON.stringify(event.llm_raw_response),
    )
    .run();
}

export async function updateTouchEvent(
  env: Env,
  id: string,
  patch: Pick<TouchEvent, "status" | "retry_count" | "llm_judgment" | "llm_raw_response">,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE touch_events SET status = ?, retry_count = ?, llm_judgment = ?, llm_raw_response = ? WHERE id = ?`,
  )
    .bind(patch.status, patch.retry_count, patch.llm_judgment, JSON.stringify(patch.llm_raw_response), id)
    .run();
}

/** Touch events still awaiting a decision (pending) or due for cron retry (failed). */
export async function listOpenTouchEvents(env: Env, lineId: string): Promise<TouchEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM touch_events WHERE line_id = ? AND status IN ('pending', 'failed') ORDER BY touched_at ASC`,
  )
    .bind(lineId)
    .all<TouchEventRow>();
  return results.map(rowToTouchEvent);
}

/** All resolved touch events for a line, used to build "prior touch/reject count" context. */
export async function countLineHistory(
  env: Env,
  lineId: string,
): Promise<{ touchCount: number; rejectCount: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS touch_count,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS reject_count
     FROM touch_events WHERE line_id = ? AND status != 'pending'`,
  )
    .bind(lineId)
    .first<{ touch_count: number; reject_count: number | null }>();
  return { touchCount: row?.touch_count ?? 0, rejectCount: row?.reject_count ?? 0 };
}

export function appendAttempt(
  existing: LlmJudgmentAttempt[],
  attempt: LlmJudgmentAttempt,
): LlmJudgmentAttempt[] {
  return [...existing, attempt];
}
