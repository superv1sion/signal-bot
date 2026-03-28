import {
    calculateATR,
    calculateBollingerBands,
    calculateEMA,
    calculateMACD,
    calculateOBV,
    calculateRSI,
} from '../indicators';
import type { MarketBundle } from '../data/marketData';
import { candlestickToCandle } from '../data/marketData';
import type { MarketState, MarketStructureTag, Trend, VolatilityRegime } from '../types/pipeline';
import { computeValueAreaFromDailyCandles } from './dailyConsolidation';

function trendFromEma50Series(ema50: number[]): Trend {
    const last = ema50[ema50.length - 1];
    const prev = ema50[ema50.length - 2];
    if (last === undefined || prev === undefined) return 'flat';
    if (last > prev) return 'up';
    if (last < prev) return 'down';
    return 'flat';
}

function classifyVolatility(bbWidth: number, atrPct: number): VolatilityRegime {
    if (bbWidth > 0.08 || atrPct > 2.5) return 'high';
    if (bbWidth < 0.02 && atrPct < 0.8) return 'low';
    return 'mid';
}

function classifyStructure(
    highs: number[],
    lows: number[],
): MarketStructureTag {
    const len = Math.min(highs.length, lows.length);
    if (len < 30) return 'unknown';
    const h = highs.slice(-30);
    const l = lows.slice(-30);
    let lastHighIdx = 0;
    let lastHigh = -Infinity;
    let prevHigh = -Infinity;
    let lastLowIdx = 0;
    let lastLow = Infinity;
    let prevLow = Infinity;
    for (let i = 2; i < h.length - 2; i += 1) {
        if (h[i]! > h[i - 1]! && h[i]! > h[i - 2]! && h[i]! > h[i + 1]! && h[i]! > h[i + 2]!) {
            prevHigh = lastHigh;
            lastHigh = h[i]!;
            lastHighIdx = i;
        }
        if (l[i]! < l[i - 1]! && l[i]! < l[i - 2]! && l[i]! < l[i + 1]! && l[i]! < l[i + 2]!) {
            prevLow = lastLow;
            lastLow = l[i]!;
            lastLowIdx = i;
        }
    }
    if (!Number.isFinite(lastHigh) || !Number.isFinite(lastLow)) return 'unknown';
    if (prevHigh === -Infinity || prevLow === Infinity) return 'unknown';
    const hh = lastHigh > prevHigh;
    const hl = lastLow > prevLow;
    const lh = lastHigh < prevHigh;
    const ll = lastLow < prevLow;
    if (hh && hl) return 'HH';
    if (!hh && hl) return 'HL';
    if (lh && ll) return 'LL';
    if (lh && !ll) return 'LH';
    if (lastHighIdx > lastLowIdx && hh) return 'HH';
    if (lastLowIdx > lastHighIdx && ll) return 'LL';
    return 'unknown';
}

export function buildMarketState(bundle: MarketBundle): MarketState {
    const candles = bundle.primary;
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const rsiSeries = calculateRSI(closes, 14);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const ema200 = calculateEMA(closes, 200);
    const macd = calculateMACD(closes);
    const bollinger = calculateBollingerBands(closes, 20, 2);
    const atr = calculateATR(highs, lows, closes, 14);
    const obv = calculateOBV(closes, volumes);

    const closesHtf = bundle.htf.candles.map((c) => c.close);
    const ema50HtfSeries = calculateEMA(closesHtf, 50);
    const htfTrend = trendFromEma50Series(ema50HtfSeries);
    const ema50Htf = ema50HtfSeries[ema50HtfSeries.length - 1];

    const closesLtf = bundle.ltf.candles.map((c) => c.close);
    const ema20LtfSeries = calculateEMA(closesLtf, 20);
    const ema50LtfSeries = calculateEMA(closesLtf, 50);
    const ema200LtfSeries = calculateEMA(closesLtf, 200);
    const ltfTrend = trendFromEma50Series(ema50LtfSeries);

    const primaryTrend = trendFromEma50Series(ema50);

    const bbUpperLast = bollinger.upper[bollinger.upper.length - 1] ?? 0;
    const bbLowerLast = bollinger.lower[bollinger.lower.length - 1] ?? 0;
    const bbMiddleLast = bollinger.middle[bollinger.middle.length - 1] || 1e-9;
    const bbWidth = (bbUpperLast - bbLowerLast) / Math.max(bbMiddleLast, 1e-9);

    const swingWindow = 10;
    const recent = candles.slice(-swingWindow);
    const swingHigh = recent.reduce((m, c) => Math.max(m, c.high), -Infinity);
    const swingLow = recent.reduce((m, c) => Math.min(m, c.low), Infinity);

    const lastClose = closes[closes.length - 1] ?? 1;
    const atrLast = atr[atr.length - 1] ?? 0;
    const atrPct = (atrLast / Math.max(lastClose, 1e-9)) * 100;
    const volatility = classifyVolatility(bbWidth, atrPct);
    const structure = classifyStructure(highs, lows);

    const obvDelta =
        obv.length >= 2 ? obv[obv.length - 1]! - obv[obv.length - 2]! : 0;

    const latest = candlestickToCandle(candles[candles.length - 1]!);

    let dailyValueArea: MarketState['dailyValueArea'];
    const dc = bundle.dailyConsolidation;
    if (dc?.candles?.length) {
        const rawPct = Number(process.env.CONSOLIDATION_VALUE_AREA_PCT ?? 70);
        const valueAreaPct = Number.isFinite(rawPct) ? rawPct : 70;
        const va = computeValueAreaFromDailyCandles(dc.candles, {
            valueAreaPct,
            consolidationStartDate: dc.startDate,
        });
        if (va) dailyValueArea = va;
    }

    return {
        symbol: bundle.symbol,
        primaryInterval: bundle.primaryInterval,
        latest,
        trend: primaryTrend,
        structure,
        indicators: {
            rsi: rsiSeries[rsiSeries.length - 1] ?? 50,
            ema20: ema20[ema20.length - 1] ?? lastClose,
            ema50: ema50[ema50.length - 1] ?? lastClose,
            ema200: ema200[ema200.length - 1] ?? lastClose,
            atr: atrLast,
            macdLine: macd.line[macd.line.length - 1] ?? 0,
            macdSignal: macd.signal[macd.signal.length - 1] ?? 0,
            bbUpper: bbUpperLast,
            bbMiddle: bbMiddleLast,
            bbLower: bbLowerLast,
            bbWidth,
            obvDelta,
        },
        htf: { interval: bundle.htf.interval, trend: htfTrend, ema50: ema50Htf },
        ltf: {
            interval: bundle.ltf.interval,
            trend: ltfTrend,
            ema20: ema20LtfSeries[ema20LtfSeries.length - 1],
            ema50: ema50LtfSeries[ema50LtfSeries.length - 1],
            ema200: ema200LtfSeries[ema200LtfSeries.length - 1],
        },
        swings: { swingHigh, swingLow, window: swingWindow },
        volatility,
        ...(dailyValueArea ? { dailyValueArea } : {}),
    };
}
