import { fetchOHLCV } from './binanceClient';
import { calculateEMA, calculateRSI, calculateMACD, calculateBollingerBands, calculateATR, calculateOBV } from './indicators';
import { getSignalFromOpenAI, type SignalResponse } from './openaiClient';
import { logInfo } from './logger';

export async function runBot(params: { symbol: string; interval: string; limit?: number }): Promise<SignalResponse> {
    const { symbol, interval, limit = 200 } = params;
    logInfo(`Fetching OHLCV: symbol=${symbol}, interval=${interval}, limit=${limit}`);
    const candles = await fetchOHLCV({ symbol, interval: interval as any, limit });

    if (candles.length < 60) {
        throw new Error('Not enough candles returned to compute indicators (need >= 60).');
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);
    const rsi = calculateRSI(closes, 14);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const macd = calculateMACD(closes);
    const bollinger = calculateBollingerBands(closes, 20, 2);
    const atr = calculateATR(highs, lows, closes, 14);
    const obv = calculateOBV(closes, volumes);

    // Higher timeframe EMA50 (dynamic)
    const getHigherInterval = (tf: string): string => {
        const x = tf.toLowerCase();
        switch (x) {
            case '1m': return '5m';
            case '3m': return '15m';
            case '5m':
            case '15m': return '1h';
            case '30m': return '2h';
            case '1h': return '4h';
            case '2h': return '6h';
            case '4h':
            case '6h':
            case '8h':
            case '12h': return '1d';
            case '1d':
            case '3d': return '1w';
            case '1w': return '1M';
            default: return '1h';
        }
    };
    const htfInterval = getHigherInterval(interval) as any;
    const htfLimit = 120;
    logInfo(`Fetching higher timeframe OHLCV: symbol=${symbol}, interval=${htfInterval}, limit=${htfLimit}`);
    const candlesH1 = await fetchOHLCV({ symbol, interval: htfInterval, limit: htfLimit });
    const closesH1 = candlesH1.map((c) => c.close);
    const ema50HtfSeries = calculateEMA(closesH1, 50);
    const ema50Htf = ema50HtfSeries[ema50HtfSeries.length - 1];
    const ema50HtfPrev = ema50HtfSeries[ema50HtfSeries.length - 2];
    const htfTrend: 'up' | 'down' | 'flat' =
        ema50Htf !== undefined && ema50HtfPrev !== undefined
            ? (ema50Htf > ema50HtfPrev ? 'up' : ema50Htf < ema50HtfPrev ? 'down' : 'flat')
            : 'flat';

    const trimmedCandles = candles.map((c) => ({
        time: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
    }));

    logInfo('Computed indicators', {
        rsiLast: rsi[rsi.length - 1],
        ema20Last: ema20[ema20.length - 1],
        ema50Last: ema50[ema50.length - 1],
        macdLast: macd.line[macd.line.length - 1],
        macdSignalLast: macd.signal[macd.signal.length - 1],
        bbUpperLast: bollinger.upper[bollinger.upper.length - 1],
        bbMiddleLast: bollinger.middle[bollinger.middle.length - 1],
        bbLowerLast: bollinger.lower[bollinger.lower.length - 1],
        atrLast: atr[atr.length - 1],
        obvLast: obv[obv.length - 1],
        ema50Htf,
        htfInterval,
        htfTrend,
    });

    // Volatility width and swings
    const bbUpperLast = bollinger.upper[bollinger.upper.length - 1];
    const bbLowerLast = bollinger.lower[bollinger.lower.length - 1];
    const bbMiddleLast = bollinger.middle[bollinger.middle.length - 1] || 1e-9;
    const bbWidth = (bbUpperLast - bbLowerLast) / Math.max(bbMiddleLast, 1e-9);
    const swingWindow = 10;
    const recent = candles.slice(-swingWindow);
    const swingHigh = recent.reduce((m, c) => Math.max(m, c.high), -Infinity);
    const swingLow = recent.reduce((m, c) => Math.min(m, c.low), Infinity);

    const signal = await getSignalFromOpenAI({
        symbol,
        interval,
        candles: trimmedCandles,
        indicators: { rsi, ema20, ema50, macd, bollinger, atr, obv },
        higherTimeframe: { timeframe: String(htfInterval), ema50: ema50Htf, trend: htfTrend },
        runtimeGuards: {
            atrLast: atr[atr.length - 1],
            bbWidth,
            htfTrend,
            obvDelta: obv.length >= 2 ? obv[obv.length - 1] - obv[obv.length - 2] : 0,
            swingHigh,
            swingLow,
        },
    });

    return signal;
}


