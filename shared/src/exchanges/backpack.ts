import type { OHLCV } from "../types.js";
import type { CurrentPrice, ExchangeClient } from "./types.js";

// https://docs.backpack.exchange/ (public market data endpoints)
// NOTE: verify exact field names/limits against current docs before relying
// on this in production — Backpack's public API has changed shape before.
const BASE_URL = "https://api.backpack.exchange/api/v1";

function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

interface BackpackKline {
  start: string; // ISO datetime
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface BackpackTicker {
  symbol: string;
  lastPrice: string;
}

async function getJson<T>(path: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${BASE_URL}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Backpack API error ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const backpackClient: ExchangeClient = {
  id: "backpack",

  async getCurrentPrice(symbol, fetchImpl = fetch): Promise<CurrentPrice> {
    const ticker = await getJson<BackpackTicker>(`/ticker?symbol=${encodeURIComponent(symbol)}`, fetchImpl);
    return { price: Number(ticker.lastPrice), timestamp: Date.now() };
  },

  async getCandles(symbol, intervalMinutes, startTime, endTime, fetchImpl = fetch): Promise<OHLCV[]> {
    const params = new URLSearchParams({
      symbol,
      interval: intervalLabel(intervalMinutes),
      startTime: String(Math.floor(startTime / 1000)),
      endTime: String(Math.floor(endTime / 1000)),
    });
    const klines = await getJson<BackpackKline[]>(`/klines?${params.toString()}`, fetchImpl);
    return klines.map((k) => ({
      timestamp: new Date(k.start).getTime(),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    }));
  },
};
