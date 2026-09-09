import type { ExchangeId } from "../types.js";
import { backpackClient } from "./backpack.js";
import { hyperliquidClient } from "./hyperliquid.js";
import type { ExchangeClient } from "./types.js";

const CLIENTS: Record<ExchangeId, ExchangeClient> = {
  hyperliquid: hyperliquidClient,
  backpack: backpackClient,
};

export function getExchangeClient(id: ExchangeId): ExchangeClient {
  return CLIENTS[id];
}

export * from "./types.js";
export { hyperliquidClient, backpackClient };
