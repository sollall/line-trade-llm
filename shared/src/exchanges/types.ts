import type { ExchangeId, OHLCV } from "../types.js";

export interface TradableSymbol {
  /** The exact string the other client methods (and lines.symbol) take, e.g. "BTC". */
  symbol: string;
  /** 24h notional volume (quote currency), used to sort the most liquid markets first. */
  dayVolume: number;
}

export interface CurrentPrice {
  price: number;
  timestamp: number; // epoch ms
}

/**
 * Common surface both the live Worker (price polling) and the offline
 * backtest engine (historical replay) use, so both paths exercise the exact
 * same touch-detection and LLM-judgment code against the same data shape.
 */
export interface ExchangeClient {
  readonly id: ExchangeId;
  /** Markets currently open for trading on this exchange, most liquid first. */
  listSymbols(fetchImpl?: typeof fetch): Promise<TradableSymbol[]>;
  getCurrentPrice(symbol: string, fetchImpl?: typeof fetch): Promise<CurrentPrice>;
  getCandles(
    symbol: string,
    intervalMinutes: number,
    startTime: number,
    endTime: number,
    fetchImpl?: typeof fetch,
  ): Promise<OHLCV[]>;
}
