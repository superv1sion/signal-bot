import type { MarketState, SignalBundle, StrategyResult } from '../types/pipeline';

function minGapForPrice(close: number): number {
    return Math.max(close * 0.001, 0.01);
}

/**
 * Mean-reversion within a bounded range: score when primary trend is flat,
 * recent high–low is tight vs ATR, and price sits near the bottom (long) or top (short)
 * of that window.
 */
export function consolidationRangeStrategy(
    state: MarketState,
    _signals: SignalBundle,
): StrategyResult {
    const close = state.latest.close;
    const { swingHigh, swingLow } = state.swings;
    const atr = state.indicators.atr;
    const gap = minGapForPrice(close);

    if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow)) {
        return { name: 'range_consolidation', score: 0, context: 'none' };
    }

    const range = swingHigh - swingLow;
    if (range <= gap * 2) {
        return { name: 'range_consolidation', score: 0, context: 'none' };
    }

    const atrBase = Math.max(atr, gap);
    const rangeAtr = range / atrBase;

    const consolidating =
        state.trend === 'flat' &&
        rangeAtr >= 1.2 &&
        rangeAtr <= 5.5 &&
        (state.volatility === 'low' ||
            state.volatility === 'mid' ||
            state.indicators.bbWidth < 0.045);

    if (!consolidating) {
        return { name: 'range_consolidation', score: 0, context: 'none' };
    }

    const pos = (close - swingLow) / range;

    if (pos <= 0.32) {
        let score = 3;
        if (state.volatility === 'low') score += 1;
        if (state.indicators.rsi < 48) score += 1;
        if (close <= state.indicators.bbLower + atrBase * 0.15) score += 1;
        return {
            name: 'range_consolidation',
            score,
            context: 'range_long',
            invalidation: swingLow - gap,
        };
    }

    if (pos >= 0.68) {
        let score = 3;
        if (state.volatility === 'low') score += 1;
        if (state.indicators.rsi > 52) score += 1;
        if (close >= state.indicators.bbUpper - atrBase * 0.15) score += 1;
        return {
            name: 'range_consolidation',
            score,
            context: 'range_short',
            invalidation: swingHigh + gap,
        };
    }

    return { name: 'range_consolidation', score: 0, context: 'none' };
}
