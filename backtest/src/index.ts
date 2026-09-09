import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getExchangeClient, type BacktestResult, type ExchangeId, type Line } from "shared";
import { computeMetrics } from "./metrics.js";
import { replaySymbol } from "./replay.js";
import type { ReplayConfig } from "./types.js";

function usage(): never {
  console.error(`Usage: npm run backtest -- --lines <lines.json> --symbol <SYM> [options]

Required:
  --lines <path>          JSON file with an array of Line objects (e.g. exported from GET /lines)
  --symbol <SYM>           Exchange symbol/coin, e.g. BTC
  --start <ISO date>       Backtest period start
  --end <ISO date>         Backtest period end

Options:
  --exchange <id>          hyperliquid | backpack (default: hyperliquid)
  --interval <minutes>     Candle interval in minutes (default: 1)
  --window <n>              Candles fed to the LLM per judgment (default: 15)
  --threshold-pct <n>      Touch distance threshold, fraction of price (default: 0.0005)
  --max-retries <n>        Max undetermined re-judgments before timeout (default: 8)
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
      interval: { type: "string", default: "1" },
      window: { type: "string", default: "15" },
      "threshold-pct": { type: "string", default: "0.0005" },
      "max-retries": { type: "string", default: "8" },
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

  const linesRaw = await readFile(values.lines, "utf8");
  const allLines = JSON.parse(linesRaw) as Line[];
  const lines = allLines.filter((l) => l.symbol === values.symbol);
  if (lines.length === 0) {
    console.error(`No lines for symbol "${values.symbol}" found in ${values.lines}`);
    process.exit(1);
  }

  const startTime = new Date(values.start).getTime();
  const endTime = new Date(values.end).getTime();
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || startTime >= endTime) {
    console.error("--start must be a valid date before --end");
    process.exit(1);
  }

  const client = getExchangeClient(values.exchange as ExchangeId);
  const intervalMinutes = Number(values.interval);
  console.error(`Fetching ${values.symbol} candles from ${values.exchange} (${values.start} -> ${values.end})...`);
  const candles = await client.getCandles(values.symbol, intervalMinutes, startTime, endTime);
  console.error(`Fetched ${candles.length} candles.`);

  const config: ReplayConfig = {
    candleIntervalMinutes: intervalMinutes,
    candleWindow: Number(values.window),
    touchThresholdPct: Number(values["threshold-pct"]),
    maxUndeterminedRetries: Number(values["max-retries"]),
    riskRewardRatio: Number(values.rr),
    maxHoldBars: Number(values["max-hold-bars"]),
    llmMode: values.llm as "claude" | "mock",
    claudeApiKey: values["claude-api-key"] ?? process.env.ANTHROPIC_API_KEY,
    claudeModel: values["claude-model"],
  };

  console.error(`Replaying touch/judgment logic against ${lines.length} line(s), llm mode=${config.llmMode}...`);
  const replayOutput = await replaySymbol(config, lines, candles);
  const metrics = computeMetrics(replayOutput.trades);

  const backtestResult: BacktestResult = {
    id: crypto.randomUUID(),
    period_start: new Date(replayOutput.period_start || startTime).toISOString(),
    period_end: new Date(replayOutput.period_end || endTime).toISOString(),
    win_rate: metrics.win_rate,
    profit_factor: metrics.profit_factor,
    max_drawdown: metrics.max_drawdown,
    total_trades: metrics.total_trades,
  };

  await mkdir(values.out, { recursive: true });
  await writeFile(path.join(values.out, "backtest_result.json"), JSON.stringify(backtestResult, null, 2));
  await writeFile(path.join(values.out, "trades.json"), JSON.stringify(replayOutput.trades, null, 2));
  await writeFile(path.join(values.out, "touch_log.json"), JSON.stringify(replayOutput.touchLog, null, 2));

  console.log(JSON.stringify(backtestResult, null, 2));
  console.error(`\nWrote results to ${values.out}/`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
