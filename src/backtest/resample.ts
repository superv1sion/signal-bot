import type { Candlestick } from '../binanceClient';
import { intervalToMilliseconds } from '../data/marketData';

/**
 * Aggregate finer OHLCV into target timeframe buckets (open = first open, high/low max/min,
 * close = last close, volume summed). Buckets align to multiples of `intervalMs` from epoch.
 */
export function resampleCandles(
    sortedAsc: Candlestick[],
    targetInterval: string,
): Candlestick[] {
    const trimmed = targetInterval.trim();
    if (trimmed === '1M') {
        throw new Error(
            'Resampling to 1M is not supported in fixtures; supply explicit monthly `htf`/`ltf` arrays.',
        );
    }
    const intervalMs = intervalToMilliseconds(trimmed);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error(`Invalid target interval: ${targetInterval}`);
    }

    const buckets = new Map<
        number,
        {
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
            openTime: number;
            closeTime: number;
        }
    >();

    for (const c of sortedAsc) {
        const bucketStart = Math.floor(c.openTime / intervalMs) * intervalMs;
        const prev = buckets.get(bucketStart);
        if (!prev) {
            buckets.set(bucketStart, {
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
                openTime: bucketStart,
                closeTime: c.closeTime,
            });
        } else {
            prev.high = Math.max(prev.high, c.high);
            prev.low = Math.min(prev.low, c.low);
            prev.close = c.close;
            prev.volume += c.volume;
            prev.closeTime = Math.max(prev.closeTime, c.closeTime);
        }
    }

    return Array.from(buckets.keys())
        .sort((a, b) => a - b)
        .map((k) => {
            const b = buckets.get(k)!;
            return {
                openTime: b.openTime,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                volume: b.volume,
                closeTime: b.closeTime,
            };
        });
}
