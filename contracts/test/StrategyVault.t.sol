// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StrategyVault} from "../src/StrategyVault.sol";
import {MockERC20, MockWHSK} from "./mocks/MockTokens.sol";
import {MockPool, MockRouter} from "./mocks/MockPoolRouter.sol";

/// @notice Unit tests for StrategyVault using mocked pool/router.
///         Pool tick -301251 mirrors the real WHSK/USDT pool (≈ $0.0827/WHSK,
///         read from slot0 on 21 Nov 2026).
contract StrategyVaultTest is Test {
    int24 internal constant POOL_TICK = -301251;

    MockWHSK internal whsk;
    MockERC20 internal usdt;
    MockPool internal pool;
    MockRouter internal router;
    StrategyVault internal vault;

    address internal agent = address(0xA11CE);
    address internal stranger = address(0xBEEF);

    // Demo strategy: max 0.5 HSK/trade, 1% slippage, 5% daily loss cap,
    // 5-minute cooldown, 1-hour TWAP.
    StrategyVault.Strategy internal strategy = StrategyVault.Strategy({
        maxBuyUsdt: 41_500, // 0.0415 USDT ≈ 0.5 WHSK at $0.083
        maxSellWhsk: 0.5 ether,
        maxSlippageBps: 100,
        dailyLossCapBps: 500,
        cooldown: 300,
        twapWindow: 3600
    });

    function setUp() public {
        vm.warp(1_795_000_000); // fixed timestamp for deterministic UTC-day math
        whsk = new MockWHSK();
        usdt = new MockERC20("Tether USD", "USDT", 6);
        pool = new MockPool(address(whsk), address(usdt), 3000, POOL_TICK);
        router = new MockRouter(address(pool));

        // Fund the router so it can pay out swaps.
        whsk.mint(address(router), 1_000 ether);
        usdt.mint(address(router), 1_000_000_000); // 1000 USDT

        vault = new StrategyVault(
            address(pool), address(router), address(whsk), address(usdt), agent, strategy
        );

        // Fund the vault: 10 WHSK + 1 USDT, then anchor the daily-loss
        // baseline to the funded value (as the deploy steps require).
        whsk.mint(address(vault), 10 ether);
        usdt.mint(address(vault), 1_000_000);
        vault.resetDailyBaseline();
    }

    // -- happy paths ---------------------------------------------------------

    function testBuySucceedsWithinGuards() public {
        uint256 amountIn = 40_000; // 0.04 USDT
        uint256 fair = vault.quoteAtTwap(amountIn, true);
        uint256 minOut = (fair * 9_950) / 10_000; // 0.5% slippage allowance

        uint256 whskBefore = whsk.balanceOf(address(vault));
        vm.prank(agent);
        uint256 out = vault.executeSwap(true, amountIn, minOut);

        assertGt(out, 0);
        assertGe(out, minOut);
        assertEq(whsk.balanceOf(address(vault)), whskBefore + out);
        assertEq(usdt.balanceOf(address(vault)), 1_000_000 - amountIn);
        assertEq(vault.lastTradeAt(), block.timestamp);
    }

    function testSellSucceedsWithinGuards() public {
        uint256 amountIn = 0.1 ether;
        uint256 fair = vault.quoteAtTwap(amountIn, false);
        uint256 minOut = (fair * 9_950) / 10_000;

        uint256 usdtBefore = usdt.balanceOf(address(vault));
        vm.prank(agent);
        uint256 out = vault.executeSwap(false, amountIn, minOut);

        assertGt(out, 0);
        assertGe(out, minOut);
        assertEq(usdt.balanceOf(address(vault)), usdtBefore + out);
        assertEq(whsk.balanceOf(address(vault)), 10 ether - amountIn);
    }

    // -- size guard ----------------------------------------------------------

    function testOversizeBuyReverts() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(StrategyVault.TradeTooLarge.selector, 50_000, strategy.maxBuyUsdt)
        );
        vault.executeSwap(true, 50_000, 0);
    }

    function testOversizeSellReverts() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                StrategyVault.TradeTooLarge.selector, 0.6 ether, strategy.maxSellWhsk
            )
        );
        vault.executeSwap(false, 0.6 ether, 0);
    }

    // -- slippage guard ------------------------------------------------------

    function testSlippageFloorReverts() public {
        // Agent passes a minAmountOut 10% below the TWAP quote: the vault must
        // refuse even though the router would accept it.
        uint256 amountIn = 0.1 ether;
        uint256 fair = vault.quoteAtTwap(amountIn, false);
        uint256 badMinOut = (fair * 9_000) / 10_000;
        uint256 twapFloor = (fair * 9_900) / 10_000;

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(StrategyVault.SlippageTooHigh.selector, badMinOut, twapFloor)
        );
        vault.executeSwap(false, amountIn, badMinOut);
    }

    function testBadExecutionPriceReverts() public {
        // Router suddenly executes 10% worse than TWAP (sandwich / thin book).
        // Agent's minAmountOut is honest (0.5% under TWAP), so the router
        // itself rejects the swap and the whole transaction reverts.
        router.setRateBps(9_000);
        uint256 amountIn = 0.1 ether;
        uint256 fair = vault.quoteAtTwap(amountIn, false);
        uint256 minOut = (fair * 9_950) / 10_000;

        vm.prank(agent);
        vm.expectRevert(bytes("Too little received"));
        vault.executeSwap(false, amountIn, minOut);
    }

    // -- cooldown guard ------------------------------------------------------

    function testCooldownEnforced() public {
        _doSell(0.1 ether);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                StrategyVault.CooldownActive.selector, block.timestamp + strategy.cooldown
            )
        );
        vault.executeSwap(false, 0.1 ether, 0);

        vm.warp(block.timestamp + strategy.cooldown + 1);
        _doSell(0.1 ether); // succeeds after cooldown
    }

    // -- daily loss cap ------------------------------------------------------

    function testDailyLossCapBlocks() public {
        _doSell(0.1 ether); // sets the day baseline implicitly (deployment day)

        // Crash WHSK price 50%: tick down by ln(0.5)/ln(1.0001) ≈ 6931.
        pool.setTick(POOL_TICK - 6931);

        vm.warp(block.timestamp + strategy.cooldown + 1);
        uint256 amountIn = 0.1 ether;
        uint256 fair = vault.quoteAtTwap(amountIn, false);
        uint256 minOut = (fair * 9_950) / 10_000;

        // The revert carries computed (valueAfter, floor) args, so assert the
        // selector via try/catch instead of exact-arg matching.
        vm.prank(agent);
        try vault.executeSwap(false, amountIn, minOut) returns (uint256) {
            fail("trade should have been blocked by the daily loss cap");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), StrategyVault.DailyLossCapBreached.selector);
        }
    }

    function testDailyLossCapResetsNextDay() public {
        _doSell(0.1 ether);
        pool.setTick(POOL_TICK - 6931);

        // Next UTC day: baseline resets to the (crashed) current value, so a
        // small trade is allowed again.
        vm.warp(block.timestamp + 1 days + 1);
        _doSell(0.1 ether);
    }

    // -- access control ------------------------------------------------------

    function testOnlyAgentCanTrade() public {
        vm.prank(stranger);
        vm.expectRevert(StrategyVault.OnlyAgent.selector);
        vault.executeSwap(false, 0.1 ether, 0);
    }

    function testOnlyOwnerCanSetStrategy() public {
        vm.prank(stranger);
        vm.expectRevert(StrategyVault.OnlyOwner.selector);
        vault.setStrategy(strategy);
    }

    function testSetStrategyUpdatesCaps() public {
        StrategyVault.Strategy memory s = strategy;
        s.maxSellWhsk = 0.2 ether;
        vault.setStrategy(s);
        (,,,,, uint32 w) = vault.strategy();
        assertEq(w, strategy.twapWindow);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(StrategyVault.TradeTooLarge.selector, 0.3 ether, 0.2 ether)
        );
        vault.executeSwap(false, 0.3 ether, 0);
    }

    function testPausedBlocksTrades() public {
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(StrategyVault.PausedVault.selector);
        vault.executeSwap(false, 0.1 ether, 0);

        vault.setPaused(false);
        _doSell(0.1 ether); // works again
    }

    // -- funding / admin -----------------------------------------------------

    function testWrapDepositsNative() public {
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        uint256 wrapped = vault.depositAndWrap();
        assertEq(wrapped, 1 ether);
        assertEq(whsk.balanceOf(address(vault)), 11 ether);
        assertEq(address(vault).balance, 0);
    }

    function testWithdrawOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(StrategyVault.OnlyOwner.selector);
        vault.withdraw(address(usdt), 1, stranger);

        vault.withdraw(address(usdt), 100_000, address(this));
        assertEq(usdt.balanceOf(address(this)), 100_000);
    }

    function testInvalidStrategyReverts() public {
        StrategyVault.Strategy memory bad = strategy;
        bad.maxBuyUsdt = 0;
        vm.expectRevert(StrategyVault.InvalidStrategy.selector);
        new StrategyVault(address(pool), address(router), address(whsk), address(usdt), agent, bad);
    }

    // -- views ---------------------------------------------------------------

    function testTwapTickMatchesPoolTick() public view {
        assertEq(vault.twapTick(3600), POOL_TICK);
    }

    function testVaultValueUsdt() public view {
        // 1 USDT + 10 WHSK priced at TWAP.
        uint256 whskValue = vault.quoteAtTwap(10 ether, false);
        assertEq(vault.vaultValueUsdt(), 1_000_000 + whskValue);
    }

    function testQuoteMatchesRealPrice() public view {
        // 1 WHSK should quote ≈ $0.0827 (real pool price, 21 Nov 2026).
        uint256 q = vault.quoteAtTwap(1 ether, false);
        assertGt(q, 75_000); // > $0.075
        assertLt(q, 90_000); // < $0.090
    }

    // -- helpers -------------------------------------------------------------

    function _doSell(uint256 amountIn) internal {
        uint256 fair = vault.quoteAtTwap(amountIn, false);
        uint256 minOut = (fair * 9_950) / 10_000;
        vm.prank(agent);
        vault.executeSwap(false, amountIn, minOut);
    }

    receive() external payable {}
}
