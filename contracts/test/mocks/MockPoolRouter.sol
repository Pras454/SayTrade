// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TickMath} from "../../src/libraries/TickMath.sol";
import {FullMath} from "../../src/libraries/FullMath.sol";

/// @notice Minimal Uniswap V3 pool mock holding a single constant tick.
///         observe() returns cumulatives consistent with that tick, so the
///         TWAP mean tick always equals the configured tick.
contract MockPool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    int24 public tick;
    uint128 public liquidityAmount = 1_000_000 ether;

    constructor(address _token0, address _token1, uint24 _fee, int24 _tick) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        tick = _tick;
    }

    function setTick(int24 _tick) external {
        tick = _tick;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick_,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (TickMath.getSqrtRatioAtTick(tick), tick, 0, 1, 1, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128 = new uint160[](secondsAgos.length);
        // Constant tick: cumulative grows linearly with elapsed seconds.
        // observe([w, 0]) must satisfy (c[1] - c[0]) / w == tick.
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] = -int56(tick) * int56(int32(secondsAgos[i]));
        }
        return (tickCumulatives, secondsPerLiquidityCumulativeX128);
    }

    function liquidity() external view returns (uint128) {
        return liquidityAmount;
    }
}

/// @notice SwapRouter02 mock: swaps at a fixed configurable rate.
///         rateBps = amountOut per amountIn, in basis points of the TWAP quote
///         computed from the pool tick (10000 = exact TWAP price, no fee).
///         Fund it with both tokens before use.
contract MockRouter {
    MockPool public immutable pool;

    /// @notice Output as bps of the TWAP-fair quote (10000 = fair, 9900 = 1% worse).
    uint256 public rateBps = 10_000;

    constructor(address _pool) {
        pool = MockPool(_pool);
    }

    function setRateBps(uint256 _rateBps) external {
        rateBps = _rateBps;
    }

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        // Pull input tokens from the caller (the vault).
        (bool okIn,) = params.tokenIn.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), params.amountIn)
        );
        require(okIn, "pull failed");

        // Fair quote at the pool tick, then apply the configured rate.
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(pool.tick());
        uint256 fair;
        if (params.tokenIn == pool.token0()) {
            // token0 -> token1: multiply by price twice.
            fair = FullMath.mulDiv(
                FullMath.mulDiv(params.amountIn, sqrtRatioX96, 2 ** 96), sqrtRatioX96, 2 ** 96
            );
        } else {
            fair = FullMath.mulDiv(
                FullMath.mulDiv(params.amountIn, 2 ** 96, sqrtRatioX96), 2 ** 96, sqrtRatioX96
            );
        }
        amountOut = (fair * rateBps) / 10_000;
        require(amountOut >= params.amountOutMinimum, "Too little received");

        (bool okOut,) =
            params.tokenOut.call(abi.encodeWithSignature("transfer(address,uint256)", params.recipient, amountOut));
        require(okOut, "payout failed");
        return amountOut;
    }
}
