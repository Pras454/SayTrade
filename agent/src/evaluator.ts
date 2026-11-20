// SayTrade — strategy evaluator (pure logic, no I/O; unit-tested).
// Decides BUY / SELL / HOLD from spot vs TWAP and the parsed strategy.
// The vault re-enforces every limit on-chain; this is the signal layer.
import type { StrategyParams } from "./parser.js";

export interface MarketState {
  spotPrice: number; // USDT per WHSK
  twapPrice: number; // USDT per WHSK
  whskBalance: bigint; // vault WHSK (18 dec)
  usdtBalance: bigint; // vault USDT (6 dec)
  lastTradeAt: number; // unix seconds (0 = never)
  now: number; // unix seconds
}

export type Decision =
  | {
      action: "buy";
      amountInUsdt: bigint; // USDT to spend (6 dec)
      reason: string;
      dipPct: number;
    }
  | {
      action: "sell";
      amountInWhsk: bigint; // WHSK to sell (18 dec)
      reason: string;
      risePct: number;
    }
  | { action: "hold"; reason: string; dipPct: number; risePct: number };

export function evaluate(params: StrategyParams, m: MarketState): Decision {
  const dipPct = ((m.twapPrice - m.spotPrice) / m.twapPrice) * 100;
  const risePct = ((m.spotPrice - m.twapPrice) / m.twapPrice) * 100;
  const EPS = 1e-9; // float tolerance at exact thresholds

  // Cooldown (vault enforces this too — the agent just avoids a doomed tx).
  const cooldownEnd = m.lastTradeAt + params.cooldownMinutes * 60;
  if (m.lastTradeAt > 0 && m.now < cooldownEnd) {
    return {
      action: "hold",
      reason: `Cooldown: ${Math.ceil(cooldownEnd - m.now)}s tersisa`,
      dipPct,
      risePct,
    };
  }

  // BUY: spot dipped below TWAP by at least buyDipPct.
  if (dipPct >= params.buyDipPct - EPS) {
    if (m.usdtBalance <= 0n) {
      return { action: "hold", reason: "Sinyal BELI tapi vault tidak punya USDT", dipPct, risePct };
    }
    // Spend up to maxTradeHsk worth of USDT (capped by balance).
    const wantUsdt = BigInt(Math.floor(params.maxTradeHsk * m.spotPrice * 1e6));
    const amountInUsdt = wantUsdt < m.usdtBalance ? wantUsdt : m.usdtBalance;
    if (amountInUsdt <= 0n) {
      return { action: "hold", reason: "Sinyal BELI tapi jumlah USDT terlalu kecil", dipPct, risePct };
    }
    return {
      action: "buy",
      amountInUsdt,
      reason: `BELI: harga $${m.spotPrice.toFixed(4)} turun ${dipPct.toFixed(2)}% dari TWAP $${m.twapPrice.toFixed(4)} (ambang ${params.buyDipPct}%)`,
      dipPct,
    };
  }

  // SELL: spot rose above TWAP by at least sellRisePct.
  if (risePct >= params.sellRisePct - EPS) {
    if (m.whskBalance <= 0n) {
      return { action: "hold", reason: "Sinyal JUAL tapi vault tidak punya WHSK", dipPct, risePct };
    }
    const wantWhsk = BigInt(Math.floor(params.maxTradeHsk * 1e18));
    const amountInWhsk = wantWhsk < m.whskBalance ? wantWhsk : m.whskBalance;
    return {
      action: "sell",
      amountInWhsk,
      reason: `JUAL: harga $${m.spotPrice.toFixed(4)} naik ${risePct.toFixed(2)}% dari TWAP $${m.twapPrice.toFixed(4)} (ambang ${params.sellRisePct}%)`,
      risePct,
    };
  }

  return {
    action: "hold",
    reason: `Tidak ada sinyal (dip ${dipPct.toFixed(2)}% / rise ${risePct.toFixed(2)}%)`,
    dipPct,
    risePct,
  };
}
