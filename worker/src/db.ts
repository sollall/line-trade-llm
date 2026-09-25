import type { Line, LineCheck, LineState } from "shared";
import type { Env } from "./env.js";

interface LineRow {
  id: string;
  symbol: string;
  kind: string;
  points: string;
  created_at: string;
  check_interval_minutes: number;
  state: string | null;
  state_since: number | null;
  last_checked_candle: number | null;
}

interface LineCheckRow {
  id: string;
  line_id: string;
  candle_timestamp: number;
  checked_at: string;
  state: string;
  previous_state: string | null;
  state_changed: number;
  confidence: number;
  reasoning: string;
  model: string;
  prompt: string;
  from_cache: number;
}

function rowToLine(row: LineRow): Line {
  return {
    id: row.id,
    symbol: row.symbol,
    kind: row.kind as Line["kind"],
    points: JSON.parse(row.points),
    created_at: row.created_at,
    check_interval_minutes: row.check_interval_minutes,
    state: row.state as LineState | null,
    state_since: row.state_since,
    last_checked_candle: row.last_checked_candle,
  };
}

function rowToLineCheck(row: LineCheckRow): LineCheck {
  return {
    id: row.id,
    line_id: row.line_id,
    candle_timestamp: row.candle_timestamp,
    checked_at: row.checked_at,
    state: row.state as LineState,
    previous_state: row.previous_state as LineState | null,
    state_changed: row.state_changed === 1,
    confidence: row.confidence,
    reasoning: row.reasoning,
    model: row.model,
    prompt: row.prompt,
    from_cache: row.from_cache === 1,
  };
}

export async function insertLine(env: Env, line: Line): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lines (id, symbol, kind, points, created_at, check_interval_minutes, state, state_since, last_checked_candle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      line.id,
      line.symbol,
      line.kind,
      JSON.stringify(line.points),
      line.created_at,
      line.check_interval_minutes,
      line.state,
      line.state_since,
      line.last_checked_candle,
    )
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
  const [, result] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM line_checks WHERE line_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM lines WHERE id = ?`).bind(id),
  ]);
  return (result?.meta.changes ?? 0) > 0;
}

/** Marks a candle as handled without an LLM call (the line was too far from price to need one). */
export async function markLineChecked(env: Env, lineId: string, candleTimestamp: number): Promise<void> {
  await env.DB.prepare(`UPDATE lines SET last_checked_candle = ? WHERE id = ?`).bind(candleTimestamp, lineId).run();
}

/** Stores a check and moves the line's current state forward in one transaction. */
export async function recordLineCheck(env: Env, line: Line, check: LineCheck): Promise<void> {
  const stateSince = check.state_changed ? check.candle_timestamp : line.state_since;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO line_checks (id, line_id, candle_timestamp, checked_at, state, previous_state, state_changed,
                                confidence, reasoning, model, prompt, from_cache)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      check.id,
      check.line_id,
      check.candle_timestamp,
      check.checked_at,
      check.state,
      check.previous_state,
      check.state_changed ? 1 : 0,
      check.confidence,
      check.reasoning,
      check.model,
      check.prompt,
      check.from_cache ? 1 : 0,
    ),
    env.DB.prepare(`UPDATE lines SET state = ?, state_since = ?, last_checked_candle = ? WHERE id = ?`).bind(
      check.state,
      stateSince,
      check.candle_timestamp,
      line.id,
    ),
  ]);
}

/** Most recent checks of a line, newest first. */
export async function listLineChecks(
  env: Env,
  lineId: string,
  options: { limit: number; changesOnly: boolean },
): Promise<LineCheck[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM line_checks WHERE line_id = ? ${options.changesOnly ? "AND state_changed = 1" : ""}
     ORDER BY candle_timestamp DESC LIMIT ?`,
  )
    .bind(lineId, options.limit)
    .all<LineCheckRow>();
  return results.map(rowToLineCheck);
}

/** Reasoning of the latest check, fed back to the LLM so consecutive judgments stay consistent. */
export async function latestLineCheck(env: Env, lineId: string): Promise<LineCheck | null> {
  const [check] = await listLineChecks(env, lineId, { limit: 1, changesOnly: false });
  return check ?? null;
}
