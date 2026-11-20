// SayTrade — agent entry point.
//
// Usage:
//   npm run dry-run -- "Beli WHSK kalau harga turun 2% dari TWAP 1 jam, jual kalau naik 3%, maksimal 0,5 HSK per trade, berhenti kalau rugi 5% dalam sehari."
//   AGENT_PRIVATE_KEY=0x... VAULT_ADDRESS=0x... npm start -- "<strategy>" --live --interval 30
//
// Modes:
//   --dry-run (default): parse + evaluate + quote, but NEVER send a transaction.
//   --live: actually call vault.executeSwap when a signal triggers.
//   --once: evaluate a single cycle then exit (useful for the demo video).
import { parseStrategy, toVaultStrategy } from "./parser.js";
import { evaluate } from "./evaluator.js";
import { getPoolSnapshot, getSubgraphWhskPools } from "./price.js";
import {
  executeSwap,
  getVaultState,
  getWalletClient,
  minAmountOutFor,
  quote,
  requireVaultAddress,
} from "./executor.js";
import { ADDRESSES } from "./config.js";
import type { Hex } from "viem";

function parseArgs(argv: string[]) {
  const args = { live: false, once: false, intervalSec: 30, strategyText: "" };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") args.live = true;
    else if (a === "--once") args.once = true;
    else if (a === "--dry-run") args.live = false;
    else if (a === "--interval") args.intervalSec = Number(argv[++i] ?? 30);
    else positional.push(a);
  }
  args.strategyText = positional.join(" ");
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.strategyText) {
    console.error(
      'Pakai: npm start -- "<strategi bahasa natural>" [--live] [--once] [--interval 30]',
    );
    console.error(
      'Contoh: npm run dry-run -- "Beli WHSK kalau harga turun 2% dari TWAP 1 jam, jual kalau naik 3%, maksimal 0,5 HSK per trade, berhenti kalau rugi 5% dalam sehari."',
    );
    process.exit(1);
  }

  const { params, warnings, sources } = parseStrategy(args.strategyText);
  console.log("=== SayTrade — strategi ===");
  console.log(JSON.stringify(params, null, 2));
  console.log("Sumber:", JSON.stringify(sources));
  for (const w of warnings) console.warn("⚠️", w);
  console.log(`Mode: ${args.live ? "LIVE (transaksi nyata)" : "DRY-RUN (tidak ada transaksi)"}`);

  // Show the subgraph context once (top WHSK pools).
  try {
    const pools = await getSubgraphWhskPools();
    const main = pools.find((p) => p.id.toLowerCase() === ADDRESSES.pool.toLowerCase());
    if (main) {
      console.log(
        `Pool WHSK/USDT 0.3%: ${main.txCount} tx, volume ${Number(main.volumeToken0).toFixed(0)} WHSK / $${Number(main.volumeToken1).toFixed(0)} USDT`,
      );
    }
  } catch (e) {
    console.warn("Subgraph tidak terjangkau (lanjut dengan RPC saja):", (e as Error).message);
  }

  const vault = args.live ? requireVaultAddress() : ("" as `0x${string}`);
  const wallet = args.live
    ? getWalletClient(process.env.AGENT_PRIVATE_KEY as Hex)
    : null;

  const twapSeconds = Math.round(params.twapHours * 3600);

  for (;;) {
    try {
      const snap = await getPoolSnapshot(twapSeconds);
      console.log(
        `\n[${new Date().toISOString()}] spot $${snap.spotPrice.toFixed(4)} | TWAP ${params.twapHours}j $${snap.twapPrice.toFixed(4)} (tick ${snap.twapTick}) | liq ${snap.liquidity}`,
      );

      let vaultState = null;
      if (args.live) {
        vaultState = await getVaultState(vault);
        if (vaultState.paused) {
          console.log("Vault di-pause owner — tidak ada trade.");
          if (args.once) break;
          await sleep(args.intervalSec * 1000);
          continue;
        }
      }

      const decision = evaluate(params, {
        spotPrice: snap.spotPrice,
        twapPrice: snap.twapPrice,
        whskBalance: vaultState?.whskBalance ?? 10n * 10n ** 18n, // dry-run: saldo contoh
        usdtBalance: vaultState?.usdtBalance ?? 1_000_000n, // dry-run: 1 USDT contoh
        lastTradeAt: vaultState?.lastTradeAt ?? 0,
        now: Math.floor(Date.now() / 1000),
      });
      console.log("Keputusan:", decision.reason);

      if (decision.action === "hold") {
        if (args.once) break;
        await sleep(args.intervalSec * 1000);
        continue;
      }

      // A signal fired — quote, then (live only) execute.
      const buy = decision.action === "buy";
      const tokenIn = buy ? ADDRESSES.usdt : ADDRESSES.whsk;
      const tokenOut = buy ? ADDRESSES.whsk : ADDRESSES.usdt;
      const amountIn = buy ? decision.amountInUsdt : decision.amountInWhsk;
      const q = await quote(tokenIn as `0x${string}`, tokenOut as `0x${string}`, amountIn);
      const minOut = minAmountOutFor(q.amountOut, params.slippagePct);
      console.log(
        `Quote: ${amountIn} -> ${q.amountOut} (minOut ${minOut} @ slippage ${params.slippagePct}%, gas est ${q.gasEstimate})`,
      );

      if (!args.live) {
        console.log("DRY-RUN: trade TIDAK dikirim.");
      } else {
        const { hash } = await executeSwap(wallet!, vault, buy, amountIn, minOut);
        console.log(`✅ Trade terkirim: ${hash}`);
        console.log(`   https://hsk.blockscout.com/tx/${hash}`);
      }
    } catch (e) {
      console.error("Siklus gagal:", (e as Error).message);
    }

    if (args.once) break;
    await sleep(args.intervalSec * 1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
