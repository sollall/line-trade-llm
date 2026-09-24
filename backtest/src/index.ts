import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CHECK_MARGIN_PCT, getExchangeClient, type BacktestResult, type ExchangeId, type Line, type OHLCV } from "shared";
import { computeMetrics } from "./metrics.js";
import { replayLine } from "./replay.js";
import type { ReplayCheckLog, ReplayConfig, SimulatedTrade } from "./types.js";

function usage(): never {
  console.error(`Usage: npm run backtest -- --lines <lines.json> --symbol <SYM> [options]

Required:
  --lines <path>          JSON file with an array of Line objects (e.g. exported from GET /lines)
  --symbol <SYM>           Exchange symbol/coin, e.g. BTC
  --start <ISO date>       Backtest period start
  --end <ISO date>         Backtest period end

Options:
  --exchange <id>          hyperliquid | backpack (default: hyperliquid)
  --interval <minutes>     Check timeframe for lines without check_interval_minutes (default: 15)
  --window <n>              Closed candles fed to the LLM per check (default: 15)
  --margin-pct <n>          Skip the LLM when the line is farther than this fraction outside the
                            window's low-high range (default: ${DEFAULT_CHECK_MARGIN_PCT})
  --rr <n>                  Take-profit risk:reward multiple (default: 2)
  --max-hold-bars <n>       Max candles a simulated trade is held (default: 60)
  --llm <mode>              claude | mock (default: mock, no API cost)
  --claude-api-key <key>    Anthropic API key (or set ANTHROPIC_API_KEY env var)
  --claude-model <id>       Claude model id (default: claude-sonnet-5)
  --out <dir>                Output directory (default: ./output)
`);
  process.exit(1);
}

async function main() {
  const { values } = parseArgs({
    options: {
      lines: { type: "string" },
      symbol: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      exchange: { type: "string", default: "hyperliquid" },
      interval: { type: "string", default: "15" },
      window: { type: "string", default: "15" },
      "margin-pct": { type: "string", default: String(DEFAULT_CHECK_MARGIN_PCT) },
      rr: { type: "string", default: "2" },
      "max-hold-bars": { type: "string", default: "60" },
      llm: { type: "string", default: "mock" },
      "claude-api-key": { type: "string" },
      "claude-model": { type: "string", default: "claude-sonnet-5" },
      out: { type: "string", default: "./output" },
    },
  });

  if (!values.lines || !values.symbol || !values.start || !values.end) usage();
  if (values.llm !== "claude" && values.llm !== "mock") usage();

  // `npm run backtest` runs inside the backtest/ workspace, so resolve relative paths against the
  // directory npm was invoked from (INIT_CWD) rather than backtest/.
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const linesPath = path.resolve(baseDir, values.lines);
  const outDir = path.resolve(baseDir, values.out!);

  let linesRaw: string;
  try {
    linesRaw = await readFile(linesPath, "utf8");
  } catch {
    console.error(`Could not read ${linesPath}. Save the lines first, e.g.:
  curl "http://localhost:8787/lines?symbol=${values.symbol}" > lines.json`);
    process.exit(1);
  }
  const allLines = JSON.parse(linesRaw) as Line[];
  const fallbackInterval = Number(values.interval);
  // Lines exported before per-line check timeframes existed have no check_interval_minutes.
  const lines = allLines
    .filter((l) => l.symbol === values.symbol)
    .map((l) => ({ ...l, check_interval_minutes: l.check_interval_minutes ?? fallbackInterval }));
  if (lines.length === 0) {
    console.error(`No lines for symbol "${values.symbol}" found in ${linesPath}`);
    process.exit(1);
  }

  const startTime = new Date(values.start).getTime();
  const endTime = new Date(values.end).getTime();
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || startTime >= endTime) {
    console.error("--start must be a valid date before --end");
    process.exit(1);
  }

  const config: ReplayConfig = {
    candleWindow: Number(values.window),
    checkMarginPct: Number(values["margin-pct"]),
    riskRewardRatio: Number(values.rr),
    maxHoldBars: Number(values["max-hold-bars"]),
    llmMode: values.llm as "claude" | "mock",
    claudeApiKey: values["claude-api-key"] ?? process.env.ANTHROPIC_API_KEY,
    claudeModel: values["claude-model"],
  };

  const client = getExchangeClient(values.exchange as ExchangeId);
  const candlesByInterval = new Map<number, OHLCV[]>();
  for (const intervalMinutes of new Set(lines.map((l) => l.check_interval_minutes))) {
    console.error(`Fetching ${values.symbol} ${intervalMinutes}m candles from ${values.exchange} (${values.start} -> ${values.end})...`);
    const candles = await client.getCandles(values.symbol, intervalMinutes, startTime, endTime);
    candlesByInterval.set(intervalMinutes, candles.sort((a, b) => a.timestamp - b.timestamp));
    console.error(`Fetched ${candles.length} candles.`);
    if (candles.length === 0) {
      console.error(
        `  No ${intervalMinutes}m candles returned for this period. Hyperliquid only serves the most recent 5000 candles per timeframe (15m: ~52 days, 1m: ~3.5 days), so pick a recent --start/--end.`,
      );
    }
  }

  console.error(`Replaying periodic line checks against ${lines.length} line(s), llm mode=${config.llmMode}...`);
  const trades: SimulatedTrade[] = [];
  const checkLog: ReplayCheckLog[] = [];
  for (const line of lines) {
    const output = await replayLine(config, line, candlesByInterval.get(line.check_interval_minutes) ?? []);
    trades.push(...output.trades);
    checkLog.push(...output.checkLog);
  }
  // Drawdown depends on trade order, so interleave the lines' trades chronologically.
  trades.sort((a, b) => a.entry_time - b.entry_time);
  checkLog.sort((a, b) => a.candle_timestamp - b.candle_timestamp);
  const metrics = computeMetrics(trades);

  const allCandles = [...candlesByInterval.values()].flat();
  const periodStart = allCandles.reduce((min, c) => Math.min(min, c.timestamp), Infinity);
  const periodEnd = allCandles.reduce((max, c) => Math.max(max, c.timestamp), -Infinity);

  const backtestResult: BacktestResult = {
    id: crypto.randomUUID(),
    period_start: new Date(allCandles.length ? periodStart : startTime).toISOString(),
    period_end: new Date(allCandles.length ? periodEnd : endTime).toISOString(),
    win_rate: metrics.win_rate,
    profit_factor: metrics.profit_factor,
    max_drawdown: metrics.max_drawdown,
    total_trades: metrics.total_trades,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "backtest_result.json"), JSON.stringify(backtestResult, null, 2));
  await writeFile(path.join(outDir, "trades.json"), JSON.stringify(trades, null, 2));
  await writeFile(path.join(outDir, "check_log.json"), JSON.stringify(checkLog, null, 2));

  console.log(JSON.stringify(backtestResult, null, 2));
  console.error(`\nWrote results to ${outDir}/`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
