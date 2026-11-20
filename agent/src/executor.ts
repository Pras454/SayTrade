// SayTrade — executor: QuoterV2 quote (eth_call only) + vault.executeSwap.
//
// QuoterV2 reverts by design; the HSK RPC unwraps the revert into a normal
// eth_call result, so viem readContract works. The quote is used ONLY to set
// a sane minAmountOut — the vault ALSO checks minAmountOut against its own
// on-chain TWAP, so a bad quote can never smuggle a bad trade through.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ADDRESSES,
  ERC20_ABI,
  HSK_RPC_URL,
  POOL_FEE,
  QUOTER_ABI,
  VAULT_ABI,
  VAULT_ADDRESS,
  hskChain,
} from "./config.js";

const quoterAbi = parseAbi(QUOTER_ABI);
const vaultAbi = parseAbi(VAULT_ABI);
const erc20Abi = parseAbi(ERC20_ABI);

export const publicClient = createPublicClient({
  chain: hskChain,
  transport: http(HSK_RPC_URL),
});

export function getWalletClient(agentKey: Hex) {
  const account = privateKeyToAccount(agentKey);
  return createWalletClient({
    account,
    chain: hskChain,
    transport: http(HSK_RPC_URL),
  });
}

export interface Quote {
  amountOut: bigint;
  gasEstimate: bigint;
}

/** Quote a swap via QuoterV2 (eth_call only — never on-chain). */
export async function quote(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
): Promise<Quote> {
  const [amountOut, , , gasEstimate] = (await publicClient.readContract({
    address: ADDRESSES.quoter as `0x${string}`,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
  })) as unknown as [bigint, bigint, number, bigint];
  return { amountOut, gasEstimate };
}

/** minAmountOut = quote minus slippagePct. Must stay above the vault's TWAP floor. */
export function minAmountOutFor(quotedOut: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.round(slippagePct * 100));
  return (quotedOut * (10_000n - bps)) / 10_000n;
}

export interface VaultState {
  whskBalance: bigint;
  usdtBalance: bigint;
  lastTradeAt: number;
  paused: boolean;
  strategy: {
    maxBuyUsdt: bigint;
    maxSellWhsk: bigint;
    maxSlippageBps: bigint;
    dailyLossCapBps: bigint;
    cooldown: bigint;
    twapWindow: number;
  };
}

export async function getVaultState(vault: `0x${string}`): Promise<VaultState> {
  const [whskBalance, usdtBalance, lastTradeAt, paused, strategy] = await Promise.all([
    publicClient.readContract({
      address: ADDRESSES.whsk as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    }),
    publicClient.readContract({
      address: ADDRESSES.usdt as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "lastTradeAt" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "paused" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "strategy" }),
  ]);
  const [maxBuyUsdt, maxSellWhsk, maxSlippageBps, dailyLossCapBps, cooldown, twapWindow] =
    strategy as unknown as [bigint, bigint, bigint, bigint, bigint, number];
  return {
    whskBalance: whskBalance as bigint,
    usdtBalance: usdtBalance as bigint,
    lastTradeAt: Number(lastTradeAt),
    paused: paused as boolean,
    strategy: { maxBuyUsdt, maxSellWhsk, maxSlippageBps, dailyLossCapBps, cooldown, twapWindow },
  };
}

export interface ExecutionResult {
  hash: Hex;
  amountOut: bigint;
}

/** Send one guarded trade to the vault. Reverts (guard/cooldown/slippage) surface as errors. */
export async function executeSwap(
  wallet: ReturnType<typeof getWalletClient>,
  vault: `0x${string}`,
  buyWhsk: boolean,
  amountIn: bigint,
  minAmountOut: bigint,
): Promise<ExecutionResult> {
  const hash = await wallet.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: "executeSwap",
    args: [buyWhsk, amountIn, minAmountOut],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Swap tx reverted: ${hash}`);
  // amountOut is not returned in the receipt; read the post-trade balance delta
  // in the caller if needed. Return the hash as the proof of execution.
  return { hash, amountOut: 0n };
}

export function requireVaultAddress(): `0x${string}` {
  if (!VAULT_ADDRESS) {
    throw new Error(
      "VAULT_ADDRESS belum di-set. Deploy dulu (lihat README) lalu export VAULT_ADDRESS=0x...",
    );
  }
  return VAULT_ADDRESS as `0x${string}`;
}
