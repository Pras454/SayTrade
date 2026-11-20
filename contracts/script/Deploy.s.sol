// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {StrategyVault} from "../src/StrategyVault.sol";

/// @notice Deploys StrategyVault to HSK Chain mainnet (chain 177).
///         DOES NOTHING unless run with --broadcast. Safe to simulate with:
///           forge script script/Deploy.s.sol --rpc-url https://mainnet.hsk.xyz
///         Deploy (only after the deployer is funded with ~6 HSK):
///           DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x... \
///           forge script script/Deploy.s.sol --rpc-url https://mainnet.hsk.xyz \
///             --broadcast --verify --verifier sourcify
///         NEVER commit a real private key. DEPLOYER_PRIVATE_KEY is read from
///         the environment only.
contract Deploy is Script {
    address internal constant POOL = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC;
    address internal constant ROUTER = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent = vm.envAddress("AGENT_ADDRESS");

        // Demo strategy (same as tests): max 0.5 HSK/trade, 1% slippage,
        // 5% daily loss cap, 5-minute cooldown, 1-hour TWAP.
        StrategyVault.Strategy memory strategy = StrategyVault.Strategy({
            maxBuyUsdt: 41_500,
            maxSellWhsk: 0.5 ether,
            maxSlippageBps: 100,
            dailyLossCapBps: 500,
            cooldown: 300,
            twapWindow: 3600
        });

        vm.startBroadcast(deployerKey);
        StrategyVault vault =
            new StrategyVault(POOL, ROUTER, WHSK, USDT, agent, strategy);
        vm.stopBroadcast();

        console.log("StrategyVault deployed:", address(vault));
        console.log("Owner (deployer):", vm.addr(deployerKey));
        console.log("Agent:", agent);
        console.log("Pool:", POOL);
        console.log("NEXT: fund vault with HSK + USDT, then call resetDailyBaseline()");
    }
}
