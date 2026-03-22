import { fetchOHLCV, type Candlestick } from '../binanceClient';
import type { Candle } from '../types/pipeline';
import type { KlinesParams } from 'binance/lib/types/shared';

export function mapToHigherInterval(tf: string): string {
    const x = tf.toLowerCase();
    switch (x) {
        case '1m':
            return '5m';
        case '3m':
            return '15m';
        case '5m':
        case '15m':
            return '1h';
        case '30m':
            return '2h';
        case '1h':
            return '4h';
        case '2h':
            return '6h';
        case '4h':
        case '6h':
        case '8h':
        case '12h':
            return '1d';
        case '1d':
        case '3d':
            return '1w';
        case '1w':
            return '1M';
        default:
            return '1h';
    }
}

export function mapToLowerInterval(tf: string): string {
    const x = tf.toLowerCase();
    switch (x) {
        case '1m':
            return '1m';
        case '3m':
            return '1m';
        case '5m':
            return '1m';
        case '15m':
            return '5m';
        case '30m':
            return '5m';
        case '1h':
            return '15m';
        case '2h':
            return '30m';
        case '4h':
            return '1h';
        case '6h':
            return '2h';
        case '8h':
            return '2h';
        case '12h':
            return '4h';
        case '1d':
            return '4h';
        case '3d':
            return '12h';
        case '1w':
            return '1d';
        case '1M':
            return '1w';
        default:
            return '5m';
    }
}

export type MarketBundle = {
    symbol: string;
    primaryInterval: string;
    primary: Candlestick[];
    htf: { interval: string; candles: Candlestick[] };
    ltf: { interval: string; candles: Candlestick[] };
};

export async function loadMarketBundle(params: {
    symbol: string;
    interval: string;
    primaryLimit?: number;
    htfLimit?: number;
    ltfLimit?: number;
}): Promise<MarketBundle> {
    const { symbol, interval, primaryLimit = 200, htfLimit = 120, ltfLimit = 200 } = params;
    const iv = interval as KlinesParams['interval'];
    const primary = await fetchOHLCV({ symbol, interval: iv, limit: primaryLimit });
    const htfInterval = mapToHigherInterval(interval) as KlinesParams['interval'];
    const htfCandles = await fetchOHLCV({ symbol, interval: htfInterval, limit: htfLimit });
    const ltfInterval = mapToLowerInterval(interval) as KlinesParams['interval'];
    const ltfCandles = await fetchOHLCV({ symbol, interval: ltfInterval, limit: ltfLimit });
    return {
        symbol,
        primaryInterval: interval,
        primary,
        htf: { interval: mapToHigherInterval(interval), candles: htfCandles },
        ltf: { interval: mapToLowerInterval(interval), candles: ltfCandles },
    };
}

export function candlestickToCandle(c: Candlestick): Candle {
    return {
        time: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
    };
}
