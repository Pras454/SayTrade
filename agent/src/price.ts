// SayTrade — price feeds: pool slot0/observe via RPC + pool stats via subgraph.
import { createPublicClient, http, parseAbi } from "viem";
import {
  ADDRESSES,
  HSK_RPC_URL,
  HSK_SUBGRAPH_URL,
  POOL_ABI,
  USDT_DECIMALS,
  WHSK_DECIMALS,
  hskChain,
} from "./config.js";

export const publicClient = createPublicClient({
  chain: hskChain,
  transport: http(HSK_RPC_URL),
});

const poolAbi = parseAbi(POOL_ABI);

/** Spot price of WHSK in USDT from slot0 sqrtPriceX96. */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint): number {
  // price (USDT raw per WHSK raw) = (sqrtPrice / 2^96)^2, then adjust decimals.
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (WHSK_DECIMALS - USDT_DECIMALS);
}

/** Price of WHSK in USDT implied by a tick: 1.0001^tick, decimal-adjusted. */
export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick) * 10 ** (WHSK_DECIMALS - USDT_DECIMALS);
}

export interface PoolSnapshot {
  spotPrice: number; // USDT per WHSK, from slot0
  spotTick: number;
  twapPrice: number; // USDT per WHSK, mean tick over twapWindow
  twapTick: number;
  liquidity: bigint;
}

/** Read spot + TWAP from the pool's own oracle (observe). */
export async function getPoolSnapshot(twapSeconds: number): Promise<PoolSnapshot> {
  const [slot0, tickCumulatives, liquidity] = await Promise.all([
    publicClient.readContract({
      address: ADDRESSES.pool as `0x${string}`,
      abi: poolAbi,
      functionName: "slot0",
    }),
    publicClient.readContract({
      address: ADDRESSES.pool as `0x${string}`,
      abi: poolAbi,
      functionName: "observe",
      args: [[twapSeconds, 0]],
    }),
    publicClient.readContract({
      address: ADDRESSES.pool as `0x${string}`,
      abi: poolAbi,
      functionName: "liquidity",
    }),
  ]);

  const [sqrtPriceX96, spotTick] = slot0 as unknown as [bigint, number];
  const [cumulatives] = tickCumulatives as unknown as [bigint[]];
  // Mean tick over the window (same math as Uniswap OracleLibrary).
  const delta = cumulatives[1] - cumulatives[0];
  let meanTick = Number(delta / BigInt(twapSeconds));
  if (delta < 0n && delta % BigInt(twapSeconds) !== 0n) meanTick -= 1;

  return {
    spotPrice: sqrtPriceX96ToPrice(sqrtPriceX96),
    spotTick,
    twapPrice: tickToPrice(meanTick),
    twapTick: meanTick,
    liquidity: liquidity as bigint,
  };
}

export interface SubgraphPool {
  id: string;
  token0: { symbol: string };
  token1: { symbol: string };
  feeTier: string;
  liquidity: string;
  txCount: string;
  volumeToken0: string;
  volumeToken1: string;
}

/** Top WHSK pools from the HSKSwap subgraph (context for the demo / logs). */
export async function getSubgraphWhskPools(): Promise<SubgraphPool[]> {
  const res = await fetch(HSK_SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{ pools(first: 20, where: {or: [{token0: "${ADDRESSES.whsk.toLowerCase()}"}, {token1: "${ADDRESSES.whsk.toLowerCase()}"}]}) { id token0 { symbol } token1 { symbol } feeTier liquidity txCount volumeToken0 volumeToken1 } }`,
    }),
  });
  if (!res.ok) throw new Error(`Subgraph HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { pools?: SubgraphPool[] } };
  return json.data?.pools ?? [];
}
