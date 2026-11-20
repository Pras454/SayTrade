// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {FullMath} from "./libraries/FullMath.sol";
import {FixedPoint96} from "./libraries/FixedPoint96.sol";
import {IUniswapV3Pool, ISwapRouter02, IWHSK} from "./interfaces/IExternal.sol";

/// @title StrategyVault — SayTrade (HSK Chain Horizon Hackathon, Track 1)
/// @notice Holds HSK/WHSK/USDT and executes HSKSwap trades for an off-chain agent,
///         enforcing ALL risk guards ON-CHAIN so a buggy or compromised agent
///         cannot drain the vault:
///         - per-trade size caps (buy in USDT, sell in WHSK)
///         - slippage cap vs the pool TWAP (agent cannot pass a worthless minAmountOut)
///         - daily loss cap vs the day-start vault value (UTC day)
///         - per-trade cooldown
///         - owner-only strategy updates, agent-only execution, owner pause switch
/// @dev The traded pair is WHSK/USDT on HSKSwap (Uniswap V3 fork).
///      token0 = WHSK (18 decimals), token1 = USDT (6 decimals),
///      pool 0x4ff515761864e7838b0adb8b5b2b8b7a068905dc, fee tier 3000 (0.3%).
contract StrategyVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant ONE_DAY = 1 days;

    struct Strategy {
        uint256 maxBuyUsdt; // max USDT spent per BUY (USDT has 6 decimals)
        uint256 maxSellWhsk; // max WHSK sold per SELL (WHSK has 18 decimals)
        uint256 maxSlippageBps; // max slippage vs TWAP, in bps (100 = 1%)
        uint256 dailyLossCapBps; // max daily loss vs day-start value, in bps
        uint256 cooldown; // seconds between trades
        uint32 twapWindow; // TWAP window in seconds (e.g. 3600 = 1h)
    }

    IUniswapV3Pool public immutable pool;
    ISwapRouter02 public immutable router;
    IERC20 public immutable whsk;
    IERC20 public immutable usdt;
    uint24 public immutable poolFee;

    address public owner;
    address public agent;
    bool public paused;

    Strategy public strategy;
    uint256 public lastTradeAt;

    // Daily loss tracking (UTC day = block.timestamp / 1 days).
    uint256 public dayStartDay;
    uint256 public dayStartValueUsdt; // vault value in USDT (6 decimals) at day start

    event TradeExecuted(
        bool indexed buyWhsk, uint256 amountIn, uint256 amountOut, int24 twapTick, uint256 valueAfterUsdt
    );
    event StrategyUpdated(
        uint256 maxBuyUsdt,
        uint256 maxSellWhsk,
        uint256 maxSlippageBps,
        uint256 dailyLossCapBps,
        uint256 cooldown,
        uint32 twapWindow
    );
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event Paused(bool paused);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Wrapped(uint256 amount);

    error OnlyOwner();
    error OnlyAgent();
    error PausedVault();
    error CooldownActive(uint256 nextTradeAt);
    error TradeTooLarge(uint256 amountIn, uint256 maxAllowed);
    error SlippageTooHigh(uint256 minAmountOut, uint256 twapFloor);
    error DailyLossCapBreached(uint256 valueAfter, uint256 floor);
    error InvalidStrategy();
    error ZeroAddress();
    error InsufficientBalance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert OnlyAgent();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedVault();
        _;
    }

    constructor(
        address _pool,
        address _router,
        address _whsk,
        address _usdt,
        address _agent,
        Strategy memory _strategy
    ) {
        if (_pool == address(0) || _router == address(0) || _whsk == address(0) || _usdt == address(0)) {
            revert ZeroAddress();
        }
        if (_agent == address(0)) revert ZeroAddress();
        _validateStrategy(_strategy);

        pool = IUniswapV3Pool(_pool);
        router = ISwapRouter02(_router);
        whsk = IERC20(_whsk);
        usdt = IERC20(_usdt);
        poolFee = IUniswapV3Pool(_pool).fee();

        owner = msg.sender;
        agent = _agent;
        strategy = _strategy;
        // Anchor the daily-loss baseline to the vault value at deployment.
        dayStartDay = block.timestamp / ONE_DAY;
        dayStartValueUsdt = _vaultValueUsdt(_twapTick(_strategy.twapWindow));
    }

    // ------------------------------------------------------------------------
    // Funding
    // ------------------------------------------------------------------------

    /// @notice Accept native HSK (funding). Use depositAndWrap() to wrap it.
    receive() external payable {}

    /// @notice Wrap the vault's whole native HSK balance into WHSK.
    function depositAndWrap() external nonReentrant returns (uint256 wrapped) {
        wrapped = address(this).balance;
        if (wrapped == 0) revert InsufficientBalance();
        IWHSK(address(whsk)).deposit{value: wrapped}();
        emit Wrapped(wrapped);
    }

    // ------------------------------------------------------------------------
    // Trading — all guards enforced here, on-chain.
    // ------------------------------------------------------------------------

    /// @notice Execute one guarded swap via the HSKSwap router.
    /// @param buyWhsk true = spend USDT to buy WHSK; false = sell WHSK for USDT.
    /// @param amountIn amount of the input token (USDT 6 dec for buys, WHSK 18 dec for sells).
    /// @param minAmountOut agent-proposed slippage floor; ALSO checked against the
    ///        on-chain TWAP so the agent cannot smuggle in a bad floor.
    /// @return amountOut amount of output token received.
    function executeSwap(bool buyWhsk, uint256 amountIn, uint256 minAmountOut)
        external
        onlyAgent
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        Strategy memory s = strategy;

        // Guard 1 — cooldown.
        if (block.timestamp < lastTradeAt + s.cooldown) {
            revert CooldownActive(lastTradeAt + s.cooldown);
        }

        // Guard 2 — per-trade size cap.
        uint256 maxAllowed = buyWhsk ? s.maxBuyUsdt : s.maxSellWhsk;
        if (amountIn == 0 || amountIn > maxAllowed) revert TradeTooLarge(amountIn, maxAllowed);

        // Guard 3 — slippage vs TWAP. The TWAP tick is read from the pool's own
        // oracle (observe), so it cannot be manipulated by a single spot print.
        int24 meanTick = _twapTick(s.twapWindow);
        uint256 expectedOut = _quoteAtTick(meanTick, amountIn, buyWhsk);
        uint256 twapFloor = (expectedOut * (BPS_DENOMINATOR - s.maxSlippageBps)) / BPS_DENOMINATOR;
        if (minAmountOut < twapFloor) revert SlippageTooHigh(minAmountOut, twapFloor);

        // Guard 4 — daily loss cap. On a new UTC day the baseline resets to the
        // current vault value BEFORE the trade. The check runs AFTER the swap so
        // the whole transaction reverts if the cap would be breached.
        uint256 today = block.timestamp / ONE_DAY;
        if (today != dayStartDay) {
            dayStartDay = today;
            dayStartValueUsdt = _vaultValueUsdt(meanTick);
        }
        uint256 lossFloor =
            (dayStartValueUsdt * (BPS_DENOMINATOR - s.dailyLossCapBps)) / BPS_DENOMINATOR;

        // Execute the swap. The router enforces amountOut >= minAmountOut.
        IERC20 tokenIn = buyWhsk ? usdt : whsk;
        IERC20 tokenOut = buyWhsk ? whsk : usdt;
        if (tokenIn.balanceOf(address(this)) < amountIn) revert InsufficientBalance();
        tokenIn.forceApprove(address(router), amountIn);
        amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 valueAfter = _vaultValueUsdt(meanTick);
        if (valueAfter < lossFloor) revert DailyLossCapBreached(valueAfter, lossFloor);

        lastTradeAt = block.timestamp;
        emit TradeExecuted(buyWhsk, amountIn, amountOut, meanTick, valueAfter);
    }

    // ------------------------------------------------------------------------
    // Views — TWAP, quotes, vault value
    // ------------------------------------------------------------------------

    /// @notice Mean tick over the TWAP window (same math as Uniswap OracleLibrary).
    function twapTick(uint32 twapWindow) external view returns (int24) {
        return _twapTick(twapWindow);
    }

    /// @notice Quote an amount at the current TWAP price (no slippage, no fee).
    /// @param buyWhsk true = USDT -> WHSK quote; false = WHSK -> USDT quote.
    function quoteAtTwap(uint256 amountIn, bool buyWhsk) external view returns (uint256) {
        return _quoteAtTick(_twapTick(strategy.twapWindow), amountIn, buyWhsk);
    }

    /// @notice Total vault value in USDT (6 decimals) at the TWAP price:
    ///         USDT balance + (WHSK + native HSK balances priced in USDT).
    function vaultValueUsdt() external view returns (uint256) {
        return _vaultValueUsdt(_twapTick(strategy.twapWindow));
    }

    function _twapTick(uint32 twapWindow) internal view returns (int24 meanTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        meanTick = int24(delta / int56(int32(twapWindow)));
        // Round toward negative infinity for negative deltas (OracleLibrary).
        if (delta < 0 && (delta % int56(int32(twapWindow)) != 0)) meanTick--;
    }

    /// @notice Convert amountIn at a tick price. WHSK (token0) <-> USDT (token1).
    function _quoteAtTick(int24 tick, uint256 amountIn, bool buyWhsk) internal pure returns (uint256) {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        if (buyWhsk) {
            // USDT (token1) -> WHSK (token0): divide by price twice.
            return FullMath.mulDiv(
                FullMath.mulDiv(amountIn, FixedPoint96.Q96, sqrtRatioX96), FixedPoint96.Q96, sqrtRatioX96
            );
        } else {
            // WHSK (token0) -> USDT (token1): multiply by price twice.
            return FullMath.mulDiv(
                FullMath.mulDiv(amountIn, sqrtRatioX96, FixedPoint96.Q96), sqrtRatioX96, FixedPoint96.Q96
            );
        }
    }

    function _vaultValueUsdt(int24 meanTick) internal view returns (uint256) {
        uint256 usdtBal = usdt.balanceOf(address(this));
        uint256 whskTotal = whsk.balanceOf(address(this)) + address(this).balance;
        uint256 whskValueUsdt = _quoteAtTick(meanTick, whskTotal, false);
        return usdtBal + whskValueUsdt;
    }

    // ------------------------------------------------------------------------
    // Admin — owner only
    // ------------------------------------------------------------------------

    function setStrategy(Strategy calldata _strategy) external onlyOwner {
        _validateStrategy(_strategy);
        strategy = _strategy;
        emit StrategyUpdated(
            _strategy.maxBuyUsdt,
            _strategy.maxSellWhsk,
            _strategy.maxSlippageBps,
            _strategy.dailyLossCapBps,
            _strategy.cooldown,
            _strategy.twapWindow
        );
    }

    function setAgent(address _agent) external onlyOwner {
        if (_agent == address(0)) revert ZeroAddress();
        address old = agent;
        agent = _agent;
        emit AgentUpdated(old, _agent);
    }

    /// @notice Re-anchor the daily-loss baseline to the current vault value.
    ///         Call after funding the vault (the constructor baseline is taken
    ///         at deployment, when the vault is usually still empty) and any
    ///         time the owner tops up funds mid-day.
    function resetDailyBaseline() external onlyOwner {
        dayStartDay = block.timestamp / ONE_DAY;
        dayStartValueUsdt = _vaultValueUsdt(_twapTick(strategy.twapWindow));
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    /// @notice Owner-only withdrawal (token == address(0) withdraws native HSK).
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            if (address(this).balance < amount) revert InsufficientBalance();
            (bool ok,) = to.call{value: amount}("");
            require(ok, "native transfer failed");
        } else {
            if (IERC20(token).balanceOf(address(this)) < amount) revert InsufficientBalance();
            IERC20(token).safeTransfer(to, amount);
        }
        emit Withdrawn(token, to, amount);
    }

    function _validateStrategy(Strategy memory s) internal pure {
        if (
            s.maxBuyUsdt == 0 || s.maxSellWhsk == 0 || s.maxSlippageBps == 0
                || s.maxSlippageBps >= BPS_DENOMINATOR || s.dailyLossCapBps == 0
                || s.dailyLossCapBps >= BPS_DENOMINATOR || s.twapWindow == 0
        ) revert InvalidStrategy();
    }
}
