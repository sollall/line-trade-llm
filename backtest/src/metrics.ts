import type { SimulatedTrade } from "./types.js";

export interface BacktestMetrics {
  win_rate: number;
  profit_factor: number;
  max_drawdown: number;
  total_trades: number;
}

/** win_rate/profit_factor/max_drawdown/total_trades per spec 5.3, computed over trade pnl_pct (R-multiple-like, unlevered). */
export function computeMetrics(trades: SimulatedTrade[]): BacktestMetrics {
  if (trades.length === 0) {
    return { win_rate: 0, profit_factor: 0, max_drawdown: 0, total_trades: 0 };
  }

  const wins = trades.filter((t) => t.pnl_pct > 0);
  const losses = trades.filter((t) => t.pnl_pct < 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl_pct, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl_pct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    cumulative += trade.pnl_pct;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  return {
    win_rate: wins.length / trades.length,
    profit_factor: profitFactor,
    max_drawdown: maxDrawdown,
    total_trades: trades.length,
  };
}
