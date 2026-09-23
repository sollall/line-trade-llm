import type { OHLCV } from "../types.js";
import type { CurrentPrice, ExchangeClient, TradableSymbol } from "./types.js";

// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
const INFO_URL = "https://api.hyperliquid.xyz/info";

function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

interface HyperliquidCandle {
  t: number; // open time ms
  T: number; // close time ms
  s: string; // symbol
  i: string; // interval
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

interface HyperliquidMeta {
  universe: { name: string; isDelisted?: boolean }[];
}

interface HyperliquidAssetCtx {
  dayNtlVlm: string;
}

async function postInfo<T>(body: unknown, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hyperliquid info error ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const hyperliquidClient: ExchangeClient = {
  id: "hyperliquid",

  // Perps on the main dex only: their `name` is what allMids/candleSnapshot take as `coin`.
  // Delisted assets stay in the universe (so asset indices remain stable) and are filtered out.
  async listSymbols(fetchImpl = fetch): Promise<TradableSymbol[]> {
    const [meta, ctxs] = await postInfo<[HyperliquidMeta, HyperliquidAssetCtx[]]>(
      { type: "metaAndAssetCtxs" },
      fetchImpl,
    );
    return meta.universe
      .map((asset, i) => ({ asset, dayVolume: Number(ctxs[i]?.dayNtlVlm ?? 0) }))
      .filter(({ asset }) => !asset.isDelisted)
      .map(({ asset, dayVolume }) => ({ symbol: asset.name, dayVolume }))
      .sort((a, b) => b.dayVolume - a.dayVolume);
  },

  async getCurrentPrice(symbol, fetchImpl = fetch): Promise<CurrentPrice> {
    const mids = await postInfo<Record<string, string>>({ type: "allMids" }, fetchImpl);
    const raw = mids[symbol];
    if (raw === undefined) {
      throw new Error(`Hyperliquid: no mid price for symbol "${symbol}"`);
    }
    return { price: Number(raw), timestamp: Date.now() };
  },

  async getCandles(symbol, intervalMinutes, startTime, endTime, fetchImpl = fetch): Promise<OHLCV[]> {
    const candles = await postInfo<HyperliquidCandle[]>(
      {
        type: "candleSnapshot",
        req: {
          coin: symbol,
          interval: intervalLabel(intervalMinutes),
          startTime,
          endTime,
        },
      },
      fetchImpl,
    );
    return candles.map((c) => ({
      timestamp: c.t,
      open: Number(c.o),
      high: Number(c.h),
      low: Number(c.l),
      close: Number(c.c),
      volume: Number(c.v),
    }));
  },
};
