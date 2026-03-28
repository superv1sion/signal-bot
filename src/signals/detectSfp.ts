import type { MarketState, SfpSignal } from '../types/pipeline';

/** Minimal OHLC for sweep detection (Candlestick / Candle compatible). */
export type SfpCandle = { high: number; low: number; close: number };

/**
 * Liquidity sweep + close rejection vs prior window (excludes latest bar).
 * Bearish: high takes prior range high, close back below it.
 * Bullish: low takes prior range low, close back above it.
 * If both fire, prefer larger penetration normalized by ATR; on tie prefer bearish.
 * Set SFP_REQUIRE_RSI=1 to AND legacy RSI filters (bearish: RSI>62, bullish: RSI<38).
 */
export function detectSfp(
    candles: ReadonlyArray<SfpCandle>,
    state: MarketState,
): SfpSignal {
    const window = state.swings.window;
    if (candles.length < window + 1) {
        return { type: 'bearish', valid: false };
    }

    const n = candles.length - 1;
    const start = n - window;
    if (start < 0) {
        return { type: 'bearish', valid: false };
    }

    let priorHigh = -Infinity;
    let priorLow = Infinity;
    for (let i = start; i <= n - 1; i += 1) {
        const c = candles[i]!;
        priorHigh = Math.max(priorHigh, c.high);
        priorLow = Math.min(priorLow, c.low);
    }

    if (!Number.isFinite(priorHigh) || !Number.isFinite(priorLow)) {
        return { type: 'bearish', valid: false };
    }

    const latest = candles[n]!;
    const bearishGeom = latest.high > priorHigh && latest.close < priorHigh;
    const bullishGeom = latest.low < priorLow && latest.close > priorLow;

    if (!bearishGeom && !bullishGeom) {
        return { type: 'bearish', valid: false };
    }

    const atr = state.indicators.atr;
    const bearPen = bearishGeom ? latest.high - priorHigh : 0;
    const bullPen = bullishGeom ? priorLow - latest.low : 0;
    const bearNorm = atr > 0 ? bearPen / atr : bearPen;
    const bullNorm = atr > 0 ? bullPen / atr : bullPen;

    let type: 'bullish' | 'bearish';
    let sweptLevel: number;
    let penetrationAtr: number | undefined;

    if (bearishGeom && bullishGeom) {
        if (bullNorm > bearNorm) {
            type = 'bullish';
            sweptLevel = priorLow;
            penetrationAtr = atr > 0 ? bullPen / atr : undefined;
        } else {
            type = 'bearish';
            sweptLevel = priorHigh;
            penetrationAtr = atr > 0 ? bearPen / atr : undefined;
        }
    } else if (bearishGeom) {
        type = 'bearish';
        sweptLevel = priorHigh;
        penetrationAtr = atr > 0 ? bearPen / atr : undefined;
    } else {
        type = 'bullish';
        sweptLevel = priorLow;
        penetrationAtr = atr > 0 ? bullPen / atr : undefined;
    }

    let valid = true;
    if (process.env.SFP_REQUIRE_RSI === '1') {
        const rsi = state.indicators.rsi;
        if (type === 'bearish' && rsi <= 62) valid = false;
        if (type === 'bullish' && rsi >= 38) valid = false;
    }

    if (!valid) {
        return { type: 'bearish', valid: false };
    }

    return {
        type,
        valid: true,
        sweptLevel,
        penetrationAtr,
    };
}
