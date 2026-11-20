// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StrategyVault} from "../src/StrategyVault.sol";
import {IUniswapV3Pool} from "../src/interfaces/IExternal.sol";

/// @notice Fork test against HSK Chain mainnet (chain 177).
///         Run with: forge test --match-contract StrategyVaultForkTest
///                   --fork-url https://mainnet.hsk.xyz
///         Everything runs on a LOCAL fork — no transaction is broadcast.
///         If the RPC refuses forking, this test is skipped via FOUNDRY_FORK=0
///         (see README); the mocked unit tests remain the primary suite.
contract StrategyVaultForkTest is Test {
    address internal constant POOL = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC;
    address internal constant ROUTER = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;

    StrategyVault internal vault;
    address internal agent = address(0xA11CE);

    function setUp() public {
        // Deploy the vault against the REAL pool/router on the fork.
        StrategyVault.Strategy memory strategy = StrategyVault.Strategy({
            maxBuyUsdt: 41_500,
            maxSellWhsk: 0.5 ether,
            maxSlippageBps: 100,
            dailyLossCapBps: 500,
            cooldown: 300,
            twapWindow: 3600
        });
        vault = new StrategyVault(POOL, ROUTER, WHSK, USDT, agent, strategy);

        // Fund the vault on the fork (deal = local state change only).
        deal(USDT, address(vault), 1_000_000); // 1 USDT
        deal(WHSK, address(vault), 10 ether);
        vault.resetDailyBaseline();
    }

    function testForkPoolIsLive() public view {
        (uint160 sqrtPriceX96, int24 tick,,,,,) = IUniswapV3Pool(POOL).slot0();
        assertGt(sqrtPriceX96, 0);
        assertLt(tick, 0); // WHSK < $1 so the tick is negative
        assertGt(IUniswapV3Pool(POOL).liquidity(), 0);
        assertEq(IUniswapV3Pool(POOL).token0(), WHSK);
        assertEq(IUniswapV3Pool(POOL).token1(), USDT);
        assertEq(IUniswapV3Pool(POOL).fee(), 3000);
    }

    function testForkTwapIsSane() public view {
        (, int24 spotTick,,,,,) = IUniswapV3Pool(POOL).slot0();
        int24 twap = vault.twapTick(3600);
        // 1h TWAP should be within 2% (in tick terms, ~200 ticks) of spot.
        int256 diff = int256(twap) - int256(spotTick);
        if (diff < 0) diff = -diff;
        assertLt(diff, 200);
    }

    function testForkRealSellThroughRouter() public {
        // Sell 0.01 WHSK through the REAL HSKSwap router on the fork.
        uint256 amountIn = 0.01 ether;
        uint256 fair = vault.quoteAtTwap(amountIn, false);
        assertGt(fair, 0);
        uint256 minOut = (fair * 9_920) / 10_000; // 0.8%: inside the vault 1% TWAP floor, outside the 0.3% pool fee

        uint256 usdtBefore = IERC20(USDT).balanceOf(address(vault));
        vm.prank(agent);
        uint256 out = vault.executeSwap(false, amountIn, minOut);

        assertGe(out, minOut);
        assertEq(IERC20(USDT).balanceOf(address(vault)), usdtBefore + out);
        assertEq(IERC20(WHSK).balanceOf(address(vault)), 10 ether - amountIn);
    }

    function testForkRealBuyThroughRouter() public {
        // Buy WHSK with 0.04 USDT through the REAL router on the fork.
        uint256 amountIn = 40_000;
        uint256 fair = vault.quoteAtTwap(amountIn, true);
        assertGt(fair, 0);
        uint256 minOut = (fair * 9_920) / 10_000; // 0.8%: inside the vault 1% TWAP floor, outside the 0.3% pool fee

        uint256 whskBefore = IERC20(WHSK).balanceOf(address(vault));
        vm.prank(agent);
        uint256 out = vault.executeSwap(true, amountIn, minOut);

        assertGe(out, minOut);
        assertEq(IERC20(WHSK).balanceOf(address(vault)), whskBefore + out);
    }

    function testForkOversizeStillReverts() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(StrategyVault.TradeTooLarge.selector, 1 ether, 0.5 ether)
        );
        vault.executeSwap(false, 1 ether, 0);
    }
}
