// SayTrade — deterministic rule-based strategy parser.
//
// Turns a plain-language strategy (Indonesian or English) into structured
// parameters. No LLM API key is required: every extraction is a regex with
// explicit defaults, so the output is fully reproducible and auditable.
//
// Example:
//   "Beli WHSK kalau harga turun 2% dari TWAP 1 jam, jual kalau naik 3%,
//    maksimal 0,5 HSK per trade, berhenti kalau rugi 5% dalam sehari."

export interface StrategyParams {
  base: string; // e.g. "WHSK"
  quote: string; // e.g. "USDT"
  buyDipPct: number; // buy when spot is this far BELOW the TWAP
  sellRisePct: number; // sell when spot is this far ABOVE the TWAP
  maxTradeHsk: number; // max trade size in HSK (per trade, both directions)
  dailyLossPct: number; // stop trading after this daily loss (vault enforces)
  cooldownMinutes: number; // min minutes between trades
  twapHours: number; // TWAP window in hours
  slippagePct: number; // max slippage vs TWAP for minAmountOut
}

export interface ParseResult {
  params: StrategyParams;
  /** Clauses the parser could not understand (shown to the user, never silently dropped). */
  warnings: string[];
  /** Which fields came from the text vs defaults. */
  sources: Partial<Record<keyof StrategyParams, "text" | "default">>;
}

export const DEFAULTS: StrategyParams = {
  base: "WHSK",
  quote: "USDT",
  buyDipPct: 2,
  sellRisePct: 3,
  maxTradeHsk: 0.5,
  dailyLossPct: 5,
  cooldownMinutes: 5,
  twapHours: 1,
  // Default execution slippage 0.5%. INVARIANT (live-verified 21 Nov 2026):
  // the agent's minAmountOut = quoter quote x (1 - slippage), and the quoter
  // already sits ~0.3% (pool fee) below the TWAP quote the vault guards
  // against. So execution slippage + 0.3% fee must stay BELOW the vault's
  // maxSlippageBps, or every trade reverts with SlippageTooHigh. The old
  // default of 1% against the deployed 1% vault guard did exactly that:
  // quoter 0.4877 WHSK x 0.99 = 0.4828 < TWAP floor 0.4842. 0.5% gives
  // 0.4852 > 0.4842 with room to spare. toVaultStrategy() keeps the on-chain
  // guard 0.5pp above the execution slippage for the same reason.
  slippagePct: 0.5,
};

/** Parse a number written with either a dot or a comma decimal separator. */
function toNum(raw: string): number {
  return Number(raw.replace(",", "."));
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;

const PATTERNS = {
  pair: /(WHSK|HSK|WETH|WBTC)\s*\/\s*(USDT|USDC(?:\.e)?)/i,
  baseOnly: /\b(WHSK|HSK|WETH|WBTC)\b/i,
  // Buy dip: "turun 2%", "drop 2%", "dip 2%", "down 2%", "1.5% dip"
  buyDip: [
    new RegExp(String.raw`turun\s*${NUM}\s*%`, "i"),
    new RegExp(String.raw`(?:drop|dip|down|fall(?:s)?)\s*(?:by\s*)?${NUM}\s*%`, "i"),
    new RegExp(String.raw`${NUM}\s*%\s*(?:dip|drop|down)`, "i"),
  ],
  // Sell rise: "naik 3%", "rise 3%", "up 3%", "4% rise"
  sellRise: [
    new RegExp(String.raw`naik\s*${NUM}\s*%`, "i"),
    new RegExp(String.raw`(?:ris(?:e|es)|up|gain(?:s)?|pump(?:s)?)\s*(?:by\s*)?${NUM}\s*%`, "i"),
    new RegExp(String.raw`${NUM}\s*%\s*(?:ris(?:e|es)|up|gain|pump)`, "i"),
  ],
  // Max trade: "maksimal 0,5 HSK", "max 0.5 HSK per trade"
  maxTrade: [
    new RegExp(String.raw`maks(?:imal|imum)?\s*${NUM}\s*(?:HSK|WHSK)`, "i"),
    new RegExp(String.raw`max(?:imum)?\s*${NUM}\s*(?:HSK|WHSK)`, "i"),
    new RegExp(String.raw`${NUM}\s*(?:HSK|WHSK)\s*(?:per|\/)\s*(?:trade|transaksi)`, "i"),
  ],
  // Daily loss: "rugi 5% dalam sehari", "rugi 5% per hari", "daily loss 5%"
  dailyLoss: [
    new RegExp(String.raw`rugi\s*${NUM}\s*%`, "i"),
    new RegExp(String.raw`(?:daily\s+loss|loss\s+limit|stop\s+loss)\s*${NUM}\s*%`, "i"),
  ],
  // Cooldown: "jeda 5 menit", "cooldown 10 minutes"
  cooldown: [
    new RegExp(String.raw`jeda\s*${NUM}\s*(menit|jam)`, "i"),
    new RegExp(String.raw`cooldown\s*${NUM}\s*(minutes?|mins?|hours?|hrs?)`, "i"),
  ],
  // TWAP window: "TWAP 1 jam", "TWAP 30 menit", "1h TWAP", "30 minute TWAP"
  twap: [
    new RegExp(String.raw`TWAP\s*${NUM}\s*(jam|menit|hour|minute)`, "i"),
    new RegExp(String.raw`${NUM}\s*(jam|menit|hour|minute)s?\s*TWAP`, "i"),
  ],
  // Slippage: "slippage 1%"
  slippage: [new RegExp(String.raw`slippage\s*${NUM}\s*%`, "i")],
};

function firstMatch(patterns: RegExp[], text: string): RegExpMatchArray | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m;
  }
  return null;
}

function toHours(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("menit") || u.startsWith("minute") || u.startsWith("min")) return value / 60;
  return value; // jam / hour
}

function toMinutes(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("jam") || u.startsWith("hour") || u.startsWith("hr")) return value * 60;
  return value; // menit / minute
}

export function parseStrategy(text: string): ParseResult {
  const params: StrategyParams = { ...DEFAULTS };
  const sources: ParseResult["sources"] = {};
  const warnings: string[] = [];
  const mark = (k: keyof StrategyParams, v: number | string) => {
    (params as unknown as Record<string, number | string>)[k] = v;
    sources[k] = "text";
  };

  // Pair
  const pair = text.match(PATTERNS.pair);
  const normalizeBase = (b: string) => (b.toUpperCase() === "HSK" ? "WHSK" : b.toUpperCase());
  if (pair) {
    mark("base", normalizeBase(pair[1]));
    mark("quote", pair[2].toUpperCase());
  } else {
    const baseOnly = text.match(PATTERNS.baseOnly);
    if (baseOnly) mark("base", normalizeBase(baseOnly[1]));
  }

  const dip = firstMatch(PATTERNS.buyDip, text);
  if (dip) mark("buyDipPct", toNum(dip[1]));

  const rise = firstMatch(PATTERNS.sellRise, text);
  if (rise) mark("sellRisePct", toNum(rise[1]));

  const max = firstMatch(PATTERNS.maxTrade, text);
  if (max) mark("maxTradeHsk", toNum(max[1]));

  const loss = firstMatch(PATTERNS.dailyLoss, text);
  if (loss) mark("dailyLossPct", toNum(loss[1]));

  const cd = firstMatch(PATTERNS.cooldown, text);
  if (cd) mark("cooldownMinutes", toMinutes(toNum(cd[1]), cd[2]));

  const tw = firstMatch(PATTERNS.twap, text);
  if (tw) mark("twapHours", toHours(toNum(tw[1]), tw[2]));

  const sl = firstMatch(PATTERNS.slippage, text);
  if (sl) mark("slippagePct", toNum(sl[1]));

  // Sanity bounds — never let a typo create a dangerous strategy.
  if (params.buyDipPct <= 0 || params.buyDipPct > 50) {
    warnings.push(`buyDipPct ${params.buyDipPct}% di luar batas (0-50) — dipakai default ${DEFAULTS.buyDipPct}%.`);
    params.buyDipPct = DEFAULTS.buyDipPct;
    sources.buyDipPct = "default";
  }
  if (params.sellRisePct <= 0 || params.sellRisePct > 50) {
    warnings.push(`sellRisePct ${params.sellRisePct}% di luar batas (0-50) — dipakai default ${DEFAULTS.sellRisePct}%.`);
    params.sellRisePct = DEFAULTS.sellRisePct;
    sources.sellRisePct = "default";
  }
  if (params.maxTradeHsk <= 0 || params.maxTradeHsk > 100) {
    warnings.push(`maxTradeHsk ${params.maxTradeHsk} di luar batas (0-100) — dipakai default ${DEFAULTS.maxTradeHsk}.`);
    params.maxTradeHsk = DEFAULTS.maxTradeHsk;
    sources.maxTradeHsk = "default";
  }
  if (params.dailyLossPct <= 0 || params.dailyLossPct > 50) {
    warnings.push(`dailyLossPct ${params.dailyLossPct}% di luar batas (0-50) — dipakai default ${DEFAULTS.dailyLossPct}%.`);
    params.dailyLossPct = DEFAULTS.dailyLossPct;
    sources.dailyLossPct = "default";
  }
  if (params.twapHours <= 0 || params.twapHours > 24) {
    warnings.push(`twapHours ${params.twapHours} di luar batas (0-24) — dipakai default ${DEFAULTS.twapHours}.`);
    params.twapHours = DEFAULTS.twapHours;
    sources.twapHours = "default";
  }
  if (params.cooldownMinutes < 0 || params.cooldownMinutes > 1440) {
    warnings.push(`cooldown ${params.cooldownMinutes} menit di luar batas — dipakai default ${DEFAULTS.cooldownMinutes}.`);
    params.cooldownMinutes = DEFAULTS.cooldownMinutes;
    sources.cooldownMinutes = "default";
  }

  // Warn about numeric clauses the parser did not understand.
  for (const clause of text.split(/[,;]/)) {
    const c = clause.trim();
    if (!c) continue;
    if (/\d/.test(c) && !/turun|naik|maks|drop|dip|rise|up|rugi|loss|jeda|cooldown|twap|slippage|%|HSK|WHSK|USDT|USDC/i.test(c)) {
      warnings.push(`Klausa tidak dipahami: "${c}" — diabaikan.`);
    }
  }

  for (const k of Object.keys(params) as (keyof StrategyParams)[]) {
    if (!(k in sources)) sources[k] = "default";
  }

  return { params, warnings, sources };
}

/** Render parsed params as the on-chain Strategy struct (vault units). */
export function toVaultStrategy(params: StrategyParams, whskPriceUsdt: number) {
  return {
    // max USDT per buy ≈ maxTradeHsk at current price (6 decimals).
    maxBuyUsdt: BigInt(Math.floor(params.maxTradeHsk * whskPriceUsdt * 1e6)),
    maxSellWhsk: BigInt(Math.floor(params.maxTradeHsk * 1e18)),
    // On-chain guard sits 0.5pp ABOVE the agent's execution slippage: the
    // quoter quote is ~0.3% (pool fee) below the TWAP quote, so a guard equal
    // to the execution slippage would make every trade revert (see DEFAULTS).
    maxSlippageBps: BigInt(Math.round((params.slippagePct + 0.5) * 100)),
    dailyLossCapBps: BigInt(Math.round(params.dailyLossPct * 100)),
    cooldown: BigInt(params.cooldownMinutes * 60),
    twapWindow: Math.round(params.twapHours * 3600),
  };
}
