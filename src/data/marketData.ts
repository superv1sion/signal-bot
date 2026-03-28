import { fetchOHLCV, fetchOHLCVForwardPages, type Candlestick } from '../binanceClient';
import {
    filterDailyProfileCandles,
    readConsolidationStartFromEnv,
} from '../features/dailyConsolidation';
import { intervalToMilliseconds } from '../intervalMs';
import type { Candle } from '../types/pipeline';
import type { KlinesParams } from 'binance/lib/types/shared';

export { intervalToMilliseconds };

export function mapToHigherInterval(tf: string): string {
    const trimmed = tf.trim();
    if (trimmed === '1M') return '1M';
    const x = trimmed.toLowerCase();
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
    const trimmed = tf.trim();
    // Binance monthly is `1M`; do not lowercase (would collide with 1-minute `1m`).
    if (trimmed === '1M') return '1w';
    const x = trimmed.toLowerCase();
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
        default:
            return '5m';
    }
}

/** One poll per lower-timeframe candle (same LTF mapping as market data). */
export function getDaemonPollMillisecondsFromChart(primaryInterval: string): number {
    const ltf = mapToLowerInterval(primaryInterval);
    return intervalToMilliseconds(ltf);
}

export type MarketBundle = {
    symbol: string;
    primaryInterval: string;
    primary: Candlestick[];
    htf: { interval: string; candles: Candlestick[] };
    ltf: { interval: string; candles: Candlestick[] };
    /** Daily candles for consolidation value area when `CONSOLIDATION_START_DATE` is set. */
    dailyConsolidation?: { startDate: string; candles: Candlestick[] };
};

function isTruthyEnv(v: string | undefined): boolean {
    return /^(1|true|yes)$/i.test((v ?? '').trim());
}

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

    let dailyConsolidation: MarketBundle['dailyConsolidation'];
    const startParsed = readConsolidationStartFromEnv();
    if (startParsed.ok) {
        const endMs = Date.now();
        const rawDaily = await fetchOHLCVForwardPages({
            symbol,
            interval: '1d',
            startTime: startParsed.startMs,
            endTime: endMs,
        });
        const includeForming = isTruthyEnv(process.env.CONSOLIDATION_INCLUDE_FORMING_DAY);
        const candles = filterDailyProfileCandles(
            rawDaily,
            startParsed.startMs,
            endMs,
            includeForming,
        );
        if (candles.length > 0) {
            dailyConsolidation = { startDate: startParsed.isoDate, candles };
        }
    }

    return {
        symbol,
        primaryInterval: interval,
        primary,
        htf: { interval: mapToHigherInterval(interval), candles: htfCandles },
        ltf: { interval: mapToLowerInterval(interval), candles: ltfCandles },
        ...(dailyConsolidation ? { dailyConsolidation } : {}),
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
