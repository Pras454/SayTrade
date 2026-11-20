// Parser unit tests — deterministic Indonesian + English strategies.
import { describe, expect, it } from "vitest";
import { parseStrategy, toVaultStrategy } from "../src/parser.js";

describe("parseStrategy — Indonesian (example from the brief)", () => {
  const text =
    "Beli WHSK kalau harga turun 2% dari TWAP 1 jam, jual kalau naik 3%, maksimal 0,5 HSK per trade, berhenti kalau rugi 5% dalam sehari.";
  const { params, warnings } = parseStrategy(text);

  it("extracts the pair", () => {
    expect(params.base).toBe("WHSK");
    expect(params.quote).toBe("USDT");
  });
  it("extracts buy dip 2%", () => expect(params.buyDipPct).toBe(2));
  it("extracts sell rise 3%", () => expect(params.sellRisePct).toBe(3));
  it("extracts max trade 0.5 HSK (comma decimal)", () => expect(params.maxTradeHsk).toBe(0.5));
  it("extracts daily loss 5%", () => expect(params.dailyLossPct).toBe(5));
  it("extracts TWAP 1 hour", () => expect(params.twapHours).toBe(1));
  it("has no warnings", () => expect(warnings).toEqual([]));
});

describe("parseStrategy — English", () => {
  const { params } = parseStrategy(
    "Buy WHSK/USDT on a 1.5% dip from the 30 minute TWAP, sell on a 4% rise, max 2 HSK per trade, daily loss 10%, cooldown 10 minutes, slippage 0.5%.",
  );
  it("extracts the pair", () => {
    expect(params.base).toBe("WHSK");
    expect(params.quote).toBe("USDT");
  });
  it("extracts dip/rise", () => {
    expect(params.buyDipPct).toBe(1.5);
    expect(params.sellRisePct).toBe(4);
  });
  it("extracts max trade", () => expect(params.maxTradeHsk).toBe(2));
  it("extracts daily loss", () => expect(params.dailyLossPct).toBe(10));
  it("extracts cooldown in minutes", () => expect(params.cooldownMinutes).toBe(10));
  it("extracts TWAP 30 minutes as 0.5h", () => expect(params.twapHours).toBe(0.5));
  it("extracts slippage", () => expect(params.slippagePct).toBe(0.5));
});

describe("parseStrategy — defaults & guards", () => {
  it("uses defaults when nothing is specified", () => {
    const { params, sources } = parseStrategy("Trading WHSK saja.");
    expect(params.buyDipPct).toBe(2);
    expect(params.sellRisePct).toBe(3);
    expect(params.maxTradeHsk).toBe(0.5);
    expect(params.dailyLossPct).toBe(5);
    expect(sources.buyDipPct).toBe("default");
  });
  it("clamps an absurd max trade to the default with a warning", () => {
    const { params, warnings } = parseStrategy("Maksimal 9999 HSK per trade.");
    expect(params.maxTradeHsk).toBe(0.5);
    expect(warnings.length).toBeGreaterThan(0);
  });
  it("clamps an absurd dip to the default with a warning", () => {
    const { params, warnings } = parseStrategy("Beli kalau turun 90%.");
    expect(params.buyDipPct).toBe(2);
    expect(warnings.length).toBeGreaterThan(0);
  });
  it("converts hours for TWAP and cooldown", () => {
    const { params } = parseStrategy("TWAP 2 jam, jeda 1 jam.");
    expect(params.twapHours).toBe(2);
    expect(params.cooldownMinutes).toBe(60);
  });
});

describe("toVaultStrategy", () => {
  it("converts to vault units at $0.0827/WHSK", () => {
    const { params } = parseStrategy(
      "Beli WHSK kalau harga turun 2% dari TWAP 1 jam, jual kalau naik 3%, maksimal 0,5 HSK per trade, berhenti kalau rugi 5% dalam sehari.",
    );
    const v = toVaultStrategy(params, 0.0827);
    expect(v.maxSellWhsk).toBe(500000000000000000n); // 0.5 WHSK
    expect(v.maxBuyUsdt).toBe(41350n); // 0.5 * 0.0827 USDT (6 dec)
    expect(v.maxSlippageBps).toBe(100n);
    expect(v.dailyLossCapBps).toBe(500n);
    expect(v.cooldown).toBe(300n);
    expect(v.twapWindow).toBe(3600);
  });
  it("keeps the on-chain guard above execution slippage + pool fee (regression: 1% default reverted every live trade with SlippageTooHigh, 21 Nov 2026)", () => {
    const { params } = parseStrategy("Trading WHSK saja.");
    const v = toVaultStrategy(params, 0.0827);
    expect(params.slippagePct).toBe(0.5);
    // execution slippage (0.5%) + pool fee (0.3%) must stay below the guard (1.0%)
    expect(params.slippagePct + 0.3).toBeLessThan(Number(v.maxSlippageBps) / 100);
  });
});
