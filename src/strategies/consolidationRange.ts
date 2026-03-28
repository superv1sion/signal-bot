import type { MarketState, SignalBundle, StrategyResult } from '../types/pipeline';

function minGapForPrice(close: number): number {
    return Math.max(close * 0.001, 0.01);
}

/** BTC: allow range trades when EMAs are tight even if EMA50 ticked up/down vs prior bar. */
const MAX_EMA20_50_SPREAD_PCT = 0.0035;
const RANGE_ATR_MIN = 1.0;
const RANGE_ATR_MAX = 7.0;
const BB_WIDTH_CAP_FOR_RANGE = 0.06;
const RANGE_LONG_MAX_POS = 0.38;
const RANGE_SHORT_MIN_POS = 0.62;

function trendFlatEnough(state: MarketState, close: number): boolean {
    if (state.trend === 'flat') return true;
    const denom = Math.max(close, 1e-9);
    const emaSpread = Math.abs(state.indicators.ema20 - state.indicators.ema50) / denom;
    return emaSpread < MAX_EMA20_50_SPREAD_PCT;
}

function volatilityOkForRange(state: MarketState): boolean {
    if (state.volatility === 'low' || state.volatility === 'mid') return true;
    return state.indicators.bbWidth < BB_WIDTH_CAP_FOR_RANGE;
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
        trendFlatEnough(state, close) &&
        rangeAtr >= RANGE_ATR_MIN &&
        rangeAtr <= RANGE_ATR_MAX &&
        volatilityOkForRange(state);

    if (!consolidating) {
        return { name: 'range_consolidation', score: 0, context: 'none' };
    }

    const pos = (close - swingLow) / range;

    if (pos <= RANGE_LONG_MAX_POS) {
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

    if (pos >= RANGE_SHORT_MIN_POS) {
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
