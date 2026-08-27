export function calculateEMA(values: number[], period: number): number[] {
    if (period <= 0) {
        throw new Error('EMA period must be > 0');
    }
    if (values.length < period) {
        return [];
    }

    const k = 2 / (period + 1);
    const ema: number[] = [];

    // Seed EMA with SMA of first period
    const seedSMA = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
    ema.push(Number(seedSMA));

    for (let i = period; i < values.length; i += 1) {
        const price = values[i];
        const prevEma = ema[ema.length - 1];
        const next = price * k + prevEma * (1 - k);
        ema.push(Number(next));
    }

    return ema;
}

export function calculateRSI(values: number[], period = 14): number[] {
    if (period <= 0) {
        throw new Error('RSI period must be > 0');
    }
    if (values.length <= period) {
        return [];
    }

    const gains: number[] = [];
    const losses: number[] = [];

    for (let i = 1; i < values.length; i += 1) {
        const change = values[i] - values[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
    }

    // First average gain/loss are simple averages over the first `period`
    let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period;

    const rsi: number[] = [];

    for (let i = period; i < gains.length; i += 1) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

        if (avgLoss === 0) {
            rsi.push(100);
        } else {
            const rs = avgGain / avgLoss;
            rsi.push(100 - 100 / (1 + rs));
        }
    }

    return rsi;
}

export function calculateMACD(
    values: number[],
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9
): { line: number[]; signal: number[]; histogram: number[] } {
    if (values.length < Math.max(fastPeriod, slowPeriod)) {
        return { line: [], signal: [], histogram: [] };
    }

    const emaFast = calculateEMA(values, fastPeriod);
    const emaSlow = calculateEMA(values, slowPeriod);

    const common = Math.min(emaFast.length, emaSlow.length);
    if (common === 0) {
        return { line: [], signal: [], histogram: [] };
    }

    const emaFastTail = emaFast.slice(emaFast.length - common);
    const emaSlowTail = emaSlow.slice(emaSlow.length - common);
    const macdLine = emaFastTail.map((v, i) => Number(v - emaSlowTail[i]));

    const signalLineRaw = calculateEMA(macdLine, signalPeriod);
    const common2 = Math.min(macdLine.length, signalLineRaw.length);
    if (common2 === 0) {
        return { line: [], signal: [], histogram: [] };
    }

    const macdAligned = macdLine.slice(macdLine.length - common2);
    const signalAligned = signalLineRaw.slice(signalLineRaw.length - common2);
    const histogram = macdAligned.map((v, i) => Number(v - signalAligned[i]));

    return { line: macdAligned, signal: signalAligned, histogram };
}

export function calculateBollingerBands(
    values: number[],
    period = 20,
    stdDevMultiplier = 2
): { upper: number[]; middle: number[]; lower: number[] } {
    if (period <= 0) {
        throw new Error('Bollinger period must be > 0');
    }
    if (values.length < period) {
        return { upper: [], middle: [], lower: [] };
    }

    const upper: number[] = [];
    const middle: number[] = [];
    const lower: number[] = [];

    for (let i = period - 1; i < values.length; i += 1) {
        const window = values.slice(i - period + 1, i + 1);
        const mean = window.reduce((s, v) => s + v, 0) / period;
        const variance = window.reduce((s, v) => s + (v - mean) * (v - mean), 0) / period;
        const std = Math.sqrt(variance);
        middle.push(Number(mean));
        upper.push(Number(mean + stdDevMultiplier * std));
        lower.push(Number(mean - stdDevMultiplier * std));
    }

    return { upper, middle, lower };
}



export function calculateATR(
    highs: number[],
    lows: number[],
    closes: number[],
    period = 14
): number[] {
    if (period <= 0) {
        throw new Error('ATR period must be > 0');
    }
    const len = Math.min(highs.length, lows.length, closes.length);
    if (len < period + 1) {
        return [];
    }

    const trueRanges: number[] = [];
    for (let i = 1; i < len; i += 1) {
        const high = highs[i];
        const low = lows[i];
        const prevClose = closes[i - 1];
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trueRanges.push(Number(tr));
    }

    // Seed with SMA of first `period` TR values
    const seed = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
    const atr: number[] = [Number(seed)];

    // Wilder smoothing
    for (let i = period; i < trueRanges.length; i += 1) {
        const prevAtr = atr[atr.length - 1];
        const next = (prevAtr * (period - 1) + trueRanges[i]) / period;
        atr.push(Number(next));
    }

    return atr;
}

export function calculateOBV(closes: number[], volumes: number[]): number[] {
    const len = Math.min(closes.length, volumes.length);
    if (len === 0) return [];
    const obv: number[] = [0];
    for (let i = 1; i < len; i += 1) {
        const prev = obv[obv.length - 1];
        let next = prev;
        if (closes[i] > closes[i - 1]) next = prev + volumes[i];
        else if (closes[i] < closes[i - 1]) next = prev - volumes[i];
        obv.push(Number(next));
    }
    return obv;
}

export function calculateSMA(values: number[], period: number): number[] {
    if (period <= 0) {
        throw new Error('SMA period must be > 0');
    }
    if (values.length < period) {
        return [];
    }

    const sma: number[] = [];
    for (let i = period - 1; i < values.length; i += 1) {
        const window = values.slice(i - period + 1, i + 1);
        const mean = window.reduce((s, v) => s + v, 0) / period;
        sma.push(Number(mean));
    }
    return sma;
}

export type OhlcvBar = { high: number; low: number; close: number; volume: number };

/**
 * Cumulative typical-price-weighted VWAP starting from `anchorIndex` (inclusive) through the end of `candles`.
 * Anchor is a caller-supplied bar index, not auto-detected — see config/analyst-ta.json for how anchors are chosen.
 */
export function calculateAnchoredVWAP(candles: OhlcvBar[], anchorIndex: number): number[] {
    if (anchorIndex < 0 || anchorIndex >= candles.length) {
        throw new Error(`anchorIndex ${anchorIndex} out of range for ${candles.length} candles`);
    }

    const vwap: number[] = [];
    let cumulativePV = 0;
    let cumulativeVolume = 0;

    for (let i = anchorIndex; i < candles.length; i += 1) {
        const c = candles[i];
        const typicalPrice = (c.high + c.low + c.close) / 3;
        cumulativePV += typicalPrice * c.volume;
        cumulativeVolume += c.volume;
        vwap.push(cumulativeVolume === 0 ? Number(typicalPrice) : Number(cumulativePV / cumulativeVolume));
    }

    return vwap;
}

export type VolumeProfileBin = { priceLow: number; priceHigh: number; volume: number };
export type VolumeProfileResult = {
    poc: number;
    vah: number;
    val: number;
    bins: VolumeProfileBin[];
};

/**
 * Fixed-range volume profile over exactly the given candle window (caller slices the range —
 * see config/analyst-ta.json's volumeProfile.startTime/endTime, not an auto-picked lookback).
 * Approximates per-candle volume as concentrated at the candle's typical price, since only
 * OHLCV bars (not tick data) are available.
 */
export function calculateVolumeProfile(candles: OhlcvBar[], numBins = 24): VolumeProfileResult {
    if (numBins <= 0) {
        throw new Error('numBins must be > 0');
    }
    if (candles.length === 0) {
        throw new Error('calculateVolumeProfile requires at least one candle');
    }

    const low = Math.min(...candles.map((c) => c.low));
    const high = Math.max(...candles.map((c) => c.high));
    const range = high - low;
    const binSize = range === 0 ? 1 : range / numBins;

    const bins: VolumeProfileBin[] = Array.from({ length: numBins }, (_, i) => ({
        priceLow: Number(low + i * binSize),
        priceHigh: Number(low + (i + 1) * binSize),
        volume: 0,
    }));

    for (const c of candles) {
        const typicalPrice = (c.high + c.low + c.close) / 3;
        let idx = range === 0 ? 0 : Math.floor((typicalPrice - low) / binSize);
        if (idx >= numBins) idx = numBins - 1;
        if (idx < 0) idx = 0;
        bins[idx].volume += c.volume;
    }

    let pocIdx = 0;
    for (let i = 1; i < bins.length; i += 1) {
        if (bins[i].volume > bins[pocIdx].volume) pocIdx = i;
    }

    const totalVolume = bins.reduce((s, b) => s + b.volume, 0);
    const targetVolume = totalVolume * 0.7;

    let coveredVolume = bins[pocIdx].volume;
    let lowIdx = pocIdx;
    let highIdx = pocIdx;
    while (coveredVolume < targetVolume && (lowIdx > 0 || highIdx < bins.length - 1)) {
        const belowVolume = lowIdx > 0 ? bins[lowIdx - 1].volume : -1;
        const aboveVolume = highIdx < bins.length - 1 ? bins[highIdx + 1].volume : -1;
        if (aboveVolume >= belowVolume) {
            highIdx += 1;
            coveredVolume += bins[highIdx].volume;
        } else {
            lowIdx -= 1;
            coveredVolume += bins[lowIdx].volume;
        }
    }

    return {
        poc: Number((bins[pocIdx].priceLow + bins[pocIdx].priceHigh) / 2),
        vah: Number(bins[highIdx].priceHigh),
        val: Number(bins[lowIdx].priceLow),
        bins,
    };
}

export type FibLevelResult = { ratio: number; price: number };

/**
 * Standard retracement ratios between a caller-supplied swing high/low (config/analyst-ta.json's
 * fibLevels) — never auto-detected swing points.
 */
export function calculateFibRetracement(high: number, low: number): FibLevelResult[] {
    const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const range = high - low;
    return ratios.map((ratio) => ({ ratio, price: Number(high - range * ratio) }));
}

