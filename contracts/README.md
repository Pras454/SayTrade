# SayTrade contracts

Foundry project for the SayTrade `StrategyVault` (HSK Chain Horizon Hackathon, Track 1).

- `src/StrategyVault.sol` — guarded vault (size cap, TWAP slippage cap, daily loss cap, cooldown).
- `src/interfaces/IExternal.sol` — minimal HSKSwap pool / router / WHSK interfaces.
- `src/libraries/` — TickMath, FullMath, FixedPoint96 vendored from Uniswap v3-core (MIT), pragma `^0.8.24`.
- `test/` — 19 mocked unit tests + 5 fork tests (real router swaps on a local fork).
- `script/Deploy.s.sol` — deploy script (dry-run by default; `--broadcast` to deploy).

See `../README.md` for the full picture (concept, verified facts, deploy steps).

```bash
forge build
forge test                                        # unit tests
forge test --fork-url https://mainnet.hsk.xyz    # + fork tests (no broadcast)
forge script script/Deploy.s.sol --rpc-url https://mainnet.hsk.xyz  # deploy dry-run
```
