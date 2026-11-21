# SayTrade — Natural-Language Strategy Trading Agent for HSKSwap

**HSK Chain Horizon Hackathon (Seoul) — Track 1: AI Agent Trading**
DoraHacks: https://dorahacks.io/hackathon/hskchainseoul · Deadline **3 Dec 2026 11:00 WIB** · Demo Day **5 Dec 2026**

> The user writes a strategy in plain language — Indonesian or English — and
> SayTrade turns it into guarded, on-chain trades on HSKSwap. The agent finds
> the signals; the **vault enforces every risk limit on-chain**, so a buggy or
> compromised agent cannot drain funds.

Example strategy:

> "Beli WHSK kalau harga turun 2% dari TWAP 1 jam, jual kalau naik 3%, maksimal
> 0,5 HSK per trade, berhenti kalau rugi 5% dalam sehari."

## How it works

```
User (plain language)
  → parser (deterministic rules, no LLM key needed) → StrategyParams
  → agent polls pool slot0 + TWAP (observe) + HSKSwap subgraph
  → evaluator: BUY on dip vs TWAP / SELL on rise vs TWAP / HOLD
  → executor quotes via QuoterV2 (eth_call) → vault.executeSwap
  → StrategyVault (on-chain guards) → HSKSwap SwapRouter02
```

### On-chain guards (StrategyVault, `contracts/src/StrategyVault.sol`)

All enforced in the contract, not just the agent:

1. **Per-trade size cap** — max USDT per buy / max WHSK per sell (demo: 0.5 HSK).
2. **Slippage cap vs TWAP** — the vault reads the pool's own TWAP (`observe`)
   and rejects any `minAmountOut` below the TWAP-implied floor, so the agent
   cannot smuggle in a worthless floor. The router enforces `minAmountOut` as
   the second layer.
3. **Daily loss cap** — vault value (USDT + WHSK at TWAP) may not fall below
   the day-start value minus the cap (demo: 5%). Baseline resets each UTC day;
   `resetDailyBaseline()` re-anchors it after funding.
4. **Cooldown** between trades (demo: 5 minutes).
5. **Access control** — agent-only execution, owner-only strategy updates,
   owner pause switch, owner-only withdrawal.

### Off-chain agent (`agent/`)

- `src/parser.ts` — deterministic rule-based parser (ID + EN), explicit
  defaults, sanity bounds, and warnings for clauses it cannot understand.
- `src/price.ts` — spot + TWAP from pool `slot0`/`observe` via RPC; pool
  stats from the HSKSwap subgraph.
- `src/evaluator.ts` — pure BUY/SELL/HOLD decision logic (unit-tested).
- `src/executor.ts` — QuoterV2 quote via `eth_call` only (never on-chain);
  `minAmountOut` = quote minus slippage; sends `vault.executeSwap`.
- `src/index.ts` — CLI loop. **Dry-run is the default**; `--live` sends txs.

## Setup

```bash
# Contracts (Foundry) — lib/ is gitignored; install the pinned dependency versions:
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.7.0 Uniswap/v3-core@v1.0.0
forge build
forge test

# Agent (Node.js 20+)
cd ../agent
npm install
npm test
```

## Verified facts (21 Nov 2026, read live during the build)

| Item | Value |
|---|---|
| Chain | HSK Chain mainnet, chain ID 177, RPC https://mainnet.hsk.xyz |
| Traded pool | **WHSK/USDT, fee tier 3000 (0.3%)**, `0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC` |
| Pool verification | `V3Factory.getPool` on-chain + subgraph agree; 26,085 txs, ~3.69M WHSK / $374,680 USDT volume — the most active WHSK pool (WHSK/USDT 0.05% and 1% do not exist) |
| Token addresses | WHSK `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` (18 dec), USDT `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` (6 dec) |
| Spot price | **$0.0827 / WHSK** (slot0 tick −301251; subgraph + quoter agree) |
| Live quotes | 0.5 WHSK → 0.0412 USDT; 0.04 USDT → 0.4823 WHSK (QuoterV2, eth_call) |
| Gas price | ~500 gwei (stable) |
| Deploy cost | **≈ 1.40 HSK** (2,801,350 gas × 500 gwei, from `forge script` dry-run; contract 8,077 bytes) |

## Live on mainnet (updated 21 Nov 2026 ~08:15 WIB, all values read on-chain)

| Item | Value |
|---|---|
| StrategyVault | [`0xe210a5880792Ae2e2E232Cc1bA219ee44792b19D`](https://hsk.blockscout.com/address/0xe210a5880792Ae2e2E232Cc1bA219ee44792b19D) — Sourcify **exact_match**, deployed 21 Nov ~04:37 WIB ([deploy tx](https://hsk.blockscout.com/tx/0xe5d88e9e74c73f278952f33981d432cf9d9f3f200456060d433b98fb3a9e1737)) |
| Funding | 3 WHSK + 0.2446 USDT, daily-loss baseline anchored 21 Nov ~04:53 WIB |
| First live trade | **BUY 0.4877 WHSK for 0.04 USDT**, 21 Nov ~04:57 WIB — [tx `0xe3754a58…`](https://hsk.blockscout.com/tx/0xe3754a586b17c82dc41359348360e6dd1e59cf46694f6cb0a7c73c0ee9ae8f59), `TradeExecuted` emitted, status 1 |
| Vault value now | **$0.489267** (`vaultValueUsdt()`), day-start $0.48993 → **−0.14% today** (cap: −5%/day) |
| Vault holdings now | 3.4877 WHSK + 0.204603 USDT · not paused · agent key active |
| Live agent loop | Running every 5 min since 21 Nov 05:02 WIB — **39 runs, 39 HOLD, 0 failures**. No loop trade yet: spot $0.0816 ≈ TWAP $0.0816, flat all morning (buy needs a 2% dip, sell a 3% rise). The loop trades autonomously the moment a real signal appears. |
| Live strategy | Buy on 2% dip vs 1h TWAP · sell on 3% rise · max 0.5 HSK/trade · 5%/day loss cap · 5 min cooldown · 0.5% execution slippage |

## Tests

```
contracts:  forge test                                    # 19 unit tests (mocked pool/router)
            forge test --fork-url https://mainnet.hsk.xyz  # + 5 fork tests incl. REAL swaps
                                                            #   through the live router on a local fork
agent:      npm test                                      # 31 tests (parser + evaluator)
            npx tsc --noEmit                              # clean
```

**Results (21 Nov 2026): 19/19 unit + 5/5 fork + 31/31 agent — all passing.**

Unit coverage includes: oversize buy/sell reverts, slippage-floor revert,
bad-execution-price revert, cooldown enforcement, daily-loss-cap block +
next-day reset, only-agent/only-owner access, pause, wrap, withdraw,
TWAP math, and vault valuation. The fork tests execute real buy + sell swaps
through the live HSKSwap router on a local fork (no broadcast).

## Run the agent (dry-run — no transactions)

```bash
cd agent
npm install
npm run dry-run -- "Beli WHSK kalau harga turun 2% dari TWAP 1 jam, jual kalau naik 3%, maksimal 0,5 HSK per trade, berhenti kalau rugi 5% dalam sehari." --once
```

Live mode (only after deploy + funding):

```bash
export VAULT_ADDRESS=0x...        # deployed StrategyVault
export AGENT_PRIVATE_KEY=0x...    # the agent key (NEVER commit this)
npm start -- "<strategy>" --live --interval 30
```

## Deploy

Deployed 21 Nov 2026 on HSK Chain mainnet (chain 177):

- **StrategyVault: `0xe210a5880792Ae2e2E232Cc1bA219ee44792b19D`** ([Blockscout](https://hsk.blockscout.com/address/0xe210a5880792Ae2e2E232Cc1bA219ee44792b19D), Sourcify `exact_match`)
- Deploy tx: `0xe5d88e9e74c73f278952f33981d432cf9d9f3f200456060d433b98fb3a9e1737` (2,153,451 gas × 500 gwei ≈ 1.08 HSK)
- Agent: `0xD8bD4dBC8CdCB7E171892e9b7d7f52135d674032` (separate keypair, funded 1 HSK for gas)
- Vault funded: 3 WHSK + 0.2446 USDT (~$0.49), daily-loss baseline anchored via `resetDailyBaseline()`
- **First live trade 21 Nov 2026:** bought 0.4877 WHSK for 0.04 USDT through the vault ([tx](https://hsk.blockscout.com/tx/0xe3754a586b17c82dc41359348360e6dd1e59cf46694f6cb0a7c73c0ee9ae8f59)); all on-chain guards passed. The agent loop checks for signals every 5 minutes and trades autonomously when one fires.

To redeploy:

```bash
cd contracts
# 1. Fund the deployer (0xF263F79cC709827FD476d6694C7352C2A7De4369) with ~6 HSK
#    via the bridge (see ../../dorahacks-research/hsk-seoul-prep.md §4/§11).
# 2. Simulate first (no broadcast):
forge script script/Deploy.s.sol --rpc-url https://mainnet.hsk.xyz
# 3. Deploy + Sourcify-verify:
DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x... \
  forge script script/Deploy.s.sol --rpc-url https://mainnet.hsk.xyz \
  --broadcast --verify --verifier sourcify
# 4. Fund the vault: send HSK to the vault, call depositAndWrap(), send USDT
#    to the vault, then call resetDailyBaseline() (owner) to anchor the
#    daily-loss baseline to the funded value.
```

Estimated total to go live: deploy ~1.40 HSK + funding (demo: 1–2 HSK + ~1 USDT)
+ a few swaps (~0.1 HSK each) — well inside the ~6 HSK budget.

## Demo steps (for the video)

1. Show the strategy sentence, run the parser (`npm run dry-run -- "<strategy>" --once`)
   and show the extracted parameters + live spot/TWAP.
2. Show the vault on Blockscout + the guard tests passing (`forge test`).
3. Live: trigger a trade (or show a past trade tx) and the guard blocking an
   oversize trade (revert on Blockscout / in the fork test).
4. Show the vault value + trade history.

## What is still needed

- [x] Bridge funding: 23.758 HSK bridged 21 Nov; deployer funded with 22 HSK.
- [x] Deploy + Sourcify-verify StrategyVault (`0xe210a5880792Ae2e2E232Cc1bA219ee44792b19D`, `exact_match`).
- [x] Fund vault (3 WHSK + 0.2446 USDT) + `resetDailyBaseline()`.
- [x] Live agent run — first live trade done 21 Nov; loop checks signals every 5 min.
- [ ] Demo video (≤3 min) + DoraHacks Build submission before 3 Dec 2026 11:00 WIB.

## Notes / design decisions

- **No external LLM API** — the parser is deterministic rules, so strategies
  are reproducible and auditable; swapping in an LLM later only changes
  `parser.ts`.
- **TWAP, not spot, is the guard price** — a single manipulated print cannot
  move the guard.
- **QuoterV2 is eth_call-only** — it reverts by design; the HSK RPC unwraps
  the revert into a normal `eth_call` result, so viem `readContract` works.
- TickMath/FullMath/FixedPoint96 are vendored from Uniswap v3-core (MIT) with
  pragma `^0.8.24` — v3-core itself targets Solidity 0.7. See
  `contracts/src/libraries/` for the attribution note.
- HSKSwap contracts (router, WHSK) are **not Sourcify-verified**; the vault
  only depends on their standard Uniswap V3 interfaces, verified behaviorally
  in the fork tests.
