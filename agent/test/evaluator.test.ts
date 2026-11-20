// Evaluator unit tests — pure decision logic.
import { describe, expect, it } from "vitest";
import { evaluate, type MarketState } from "../src/evaluator.js";
import { DEFAULTS } from "../src/parser.js";

const base: MarketState = {
  spotPrice: 0.0827,
  twapPrice: 0.0827,
  whskBalance: 10n * 10n ** 18n,
  usdtBalance: 1_000_000n, // 1 USDT
  lastTradeAt: 0,
  now: 1_800_000_000,
};

describe("evaluate", () => {
  it("holds when price equals TWAP", () => {
    const d = evaluate(DEFAULTS, base);
    expect(d.action).toBe("hold");
  });

  it("buys on a 2% dip", () => {
    const d = evaluate(DEFAULTS, { ...base, spotPrice: 0.0827 * 0.98 });
    expect(d.action).toBe("buy");
    if (d.action === "buy") {
      // 0.5 HSK * $0.0810 ≈ $0.0405 = 40,5xx USDT units
      expect(d.amountInUsdt).toBeGreaterThan(40_000n);
      expect(d.amountInUsdt).toBeLessThan(41_000n);
    }
  });

  it("does not buy on a 1% dip (below threshold)", () => {
    const d = evaluate(DEFAULTS, { ...base, spotPrice: 0.0827 * 0.99 });
    expect(d.action).toBe("hold");
  });

  it("sells on a 3% rise", () => {
    const d = evaluate(DEFAULTS, { ...base, spotPrice: 0.0827 * 1.03 });
    expect(d.action).toBe("sell");
    if (d.action === "sell") {
      expect(d.amountInWhsk).toBe(500000000000000000n); // 0.5 WHSK
    }
  });

  it("does not sell on a 2% rise (below threshold)", () => {
    const d = evaluate(DEFAULTS, { ...base, spotPrice: 0.0827 * 1.02 });
    expect(d.action).toBe("hold");
  });

  it("caps the buy at the USDT balance", () => {
    const d = evaluate(DEFAULTS, {
      ...base,
      spotPrice: 0.0827 * 0.95,
      usdtBalance: 10_000n, // only 0.01 USDT
    });
    expect(d.action).toBe("buy");
    if (d.action === "buy") expect(d.amountInUsdt).toBe(10_000n);
  });

  it("caps the sell at the WHSK balance", () => {
    const d = evaluate(DEFAULTS, {
      ...base,
      spotPrice: 0.0827 * 1.05,
      whskBalance: 100000000000000000n, // only 0.1 WHSK
    });
    expect(d.action).toBe("sell");
    if (d.action === "sell") expect(d.amountInWhsk).toBe(100000000000000000n);
  });

  it("holds during cooldown even with a signal", () => {
    const d = evaluate(DEFAULTS, {
      ...base,
      spotPrice: 0.0827 * 0.95,
      lastTradeAt: base.now - 60, // traded 1 min ago, cooldown 5 min
    });
    expect(d.action).toBe("hold");
    if (d.action === "hold") expect(d.reason).toMatch(/Cooldown/);
  });

  it("trades again after cooldown expires", () => {
    const d = evaluate(DEFAULTS, {
      ...base,
      spotPrice: 0.0827 * 0.95,
      lastTradeAt: base.now - 301, // 5m01s ago
    });
    expect(d.action).toBe("buy");
  });

  it("holds with a buy signal but no USDT", () => {
    const d = evaluate(DEFAULTS, { ...base, spotPrice: 0.0827 * 0.95, usdtBalance: 0n });
    expect(d.action).toBe("hold");
  });

  it("holds with a sell signal but no WHSK", () => {
    const d = evaluate(DEFAULTS, { ...base, spotPrice: 0.0827 * 1.05, whskBalance: 0n });
    expect(d.action).toBe("hold");
  });
});
