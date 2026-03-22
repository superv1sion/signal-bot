import type { MarketState, SignalBundle, StrategyResult } from '../types/pipeline';

export function trendFollowStrategy(
    state: MarketState,
    signals: SignalBundle,
): StrategyResult {
    let score = 0;
    const e200 = state.indicators.ema200;
    const emaBull =
        state.indicators.ema20 > state.indicators.ema50 &&
        (e200 === undefined ||
            !Number.isFinite(e200) ||
            state.indicators.ema50 >= e200 * 0.999);
    const emaBear =
        state.indicators.ema20 < state.indicators.ema50 &&
        (e200 === undefined ||
            !Number.isFinite(e200) ||
            state.indicators.ema50 <= e200 * 1.001);

    if (state.trend === 'up' && state.htf.trend === 'up' && emaBull) {
        score += 3;
    } else if (state.trend === 'down' && state.htf.trend === 'down' && emaBear) {
        score += 3;
    }

    if (signals.trendAligned) score += 2;
    if (state.indicators.macdLine > state.indicators.macdSignal && state.trend === 'up') {
        score += 1;
    }
    if (state.indicators.macdLine < state.indicators.macdSignal && state.trend === 'down') {
        score += 1;
    }

    const context =
        state.trend === 'up'
            ? 'trend_long'
            : state.trend === 'down'
              ? 'trend_short'
              : 'flat';
    const rawInv =
        state.trend === 'up'
            ? state.swings.swingLow
            : state.trend === 'down'
              ? state.swings.swingHigh
              : undefined;
    const invalidation =
        rawInv !== undefined && Number.isFinite(rawInv) ? rawInv : undefined;

    return {
        name: 'trend_follow',
        score,
        context,
        invalidation,
    };
}
