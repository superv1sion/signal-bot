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

