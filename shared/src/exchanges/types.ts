import type { ExchangeId, OHLCV } from "../types.js";

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
  getCurrentPrice(symbol: string, fetchImpl?: typeof fetch): Promise<CurrentPrice>;
  getCandles(
    symbol: string,
    intervalMinutes: number,
    startTime: number,
    endTime: number,
    fetchImpl?: typeof fetch,
  ): Promise<OHLCV[]>;
}
