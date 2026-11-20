// SayTrade — shared on-chain configuration (HSK Chain mainnet, chain 177).
// All addresses verified on-chain 21 Nov 2026 (see ../../README.md).

export const HSK_CHAIN_ID = 177;
export const HSK_RPC_URL = "https://mainnet.hsk.xyz";
export const HSK_EXPLORER = "https://hsk.blockscout.com";
export const HSK_SUBGRAPH_URL =
  "https://graphnode.hashkeychain.net/subgraphs/name/hskswap";

export const ADDRESSES = {
  pool: "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC", // WHSK/USDT 0.3%
  factory: "0x972cA9D1662F5e029cD18327D29026532E84c742",
  router: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
  quoter: "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD",
  whsk: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
  usdt: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
} as const;

export const POOL_FEE = 3000; // 0.3%
export const WHSK_DECIMALS = 18;
export const USDT_DECIMALS = 6;

// Vault address is set after deployment (env VAULT_ADDRESS).
export const VAULT_ADDRESS = (process.env.VAULT_ADDRESS ?? "") as `0x${string}`;

export const hskChain = {
  id: HSK_CHAIN_ID,
  name: "HSK Chain",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: [HSK_RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: HSK_EXPLORER } },
} as const;

// Minimal ABIs (human-readable, viem parseAbi compatible).
export const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
] as const;

export const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
] as const;

export const VAULT_ABI = [
  "function executeSwap(bool buyWhsk, uint256 amountIn, uint256 minAmountOut) returns (uint256 amountOut)",
  "function quoteAtTwap(uint256 amountIn, bool buyWhsk) view returns (uint256)",
  "function twapTick(uint32 twapWindow) view returns (int24)",
  "function vaultValueUsdt() view returns (uint256)",
  "function strategy() view returns (uint256 maxBuyUsdt, uint256 maxSellWhsk, uint256 maxSlippageBps, uint256 dailyLossCapBps, uint256 cooldown, uint32 twapWindow)",
  "function lastTradeAt() view returns (uint256)",
  "function paused() view returns (bool)",
  "function agent() view returns (address)",
] as const;

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;
