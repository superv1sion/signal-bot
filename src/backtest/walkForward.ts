import type { Candlestick } from '../binanceClient';
import type { MarketBundle } from '../data/marketData';
import {
    mapToHigherInterval,
    mapToLowerInterval,
} from '../data/marketData';
import { readConsolidationStartFromEnv } from '../features/dailyConsolidation';
import { resampleCandles } from './resample';

export type ExpandedHistory = {
    symbol: string;
    primaryInterval: string;
    primary: Candlestick[];
    htf: { interval: string; candles: Candlestick[] };
    ltf: { interval: string; candles: Candlestick[] };
    /** Optional `1d` series for consolidation value area (resampled or fixture `daily`). */
    dailyCandles?: Candlestick[];
    /** True when HTF/LTF were inferred from primary slices (not real multi-TF data). */
    legacySingleTimeframe: boolean;
};

function sortByOpenTime(candles: Candlestick[]): Candlestick[] {
    return [...candles].sort((a, b) => a.openTime - b.openTime);
}

function isCandlestickArray(x: unknown): x is Candlestick[] {
    if (!Array.isArray(x) || x.length === 0) return false;
    const o = x[0];
    return (
        typeof o === 'object' &&
        o !== null &&
        'openTime' in o &&
        'open' in o &&
        'high' in o &&
        'low' in o &&
        'close' in o &&
        'volume' in o &&
        'closeTime' in o
    );
}

function isTfBlock(x: unknown): x is { interval: string; candles: Candlestick[] } {
    return (
        typeof x === 'object' &&
        x !== null &&
        typeof (x as { interval?: unknown }).interval === 'string' &&
        'candles' in x &&
        isCandlestickArray((x as { candles: unknown }).candles)
    );
}

function optionalDailyFromFixture(o: Record<string, unknown>): Candlestick[] | undefined {
    const dailyRaw = o.daily;
    if (!isTfBlock(dailyRaw)) return undefined;
    if (dailyRaw.interval.trim().toLowerCase() !== '1d') return undefined;
    return sortByOpenTime(dailyRaw.candles);
}

/**
 * Parse fixture JSON into aligned primary / HTF / LTF history.
 *
 * - **Explicit**: `{ primary, htf, ltf }` plus optional `{ daily: { interval: "1d", candles } }` for consolidation VA in backtests.
 * - **Resample (B2)**: `{ resampleFrom, baseInterval, primaryInterval }` — finest series is aggregated; also builds internal `1d` for VA when `CONSOLIDATION_START_DATE` is set.
 * - **Legacy**: raw `Candlestick[]` — HTF/LTF reuse primary (misleading; emits a warning).
 */
export function expandFixture(raw: unknown, logWarn: (msg: string) => void): ExpandedHistory {
    const symbol =
        typeof raw === 'object' &&
        raw !== null &&
        'symbol' in raw &&
        typeof (raw as { symbol: unknown }).symbol === 'string'
            ? (raw as { symbol: string }).symbol
            : 'BACKTEST';

    if (isCandlestickArray(raw)) {
        logWarn(
            'Fixture is a bare candle array: HTF/LTF are approximated from primary (not exchange-accurate). Prefer `primary`+`htf`+`ltf` or `resampleFrom`.',
        );
        const primary = sortByOpenTime(raw);
        const primaryInterval =
            (typeof process.env.BACKTEST_PRIMARY_INTERVAL === 'string' &&
                process.env.BACKTEST_PRIMARY_INTERVAL.trim()) ||
            '5m';
        return {
            symbol,
            primaryInterval,
            primary,
            htf: { interval: mapToHigherInterval(primaryInterval), candles: primary },
            ltf: { interval: mapToLowerInterval(primaryInterval), candles: primary },
            legacySingleTimeframe: true,
        };
    }

    if (typeof raw !== 'object' || raw === null) {
        throw new Error('Fixture must be a JSON object or Candlestick[]');
    }

    const o = raw as Record<string, unknown>;
    const primaryInterval =
        (typeof o.primaryInterval === 'string' && o.primaryInterval.trim()) ||
        (typeof process.env.BACKTEST_PRIMARY_INTERVAL === 'string' &&
            process.env.BACKTEST_PRIMARY_INTERVAL.trim()) ||
        '5m';

    if (Array.isArray(o.resampleFrom) && isCandlestickArray(o.resampleFrom)) {
        const baseInterval =
            typeof o.baseInterval === 'string' && o.baseInterval.trim()
                ? o.baseInterval.trim()
                : '1m';
        const finest = sortByOpenTime(o.resampleFrom);
        const htfIv = mapToHigherInterval(primaryInterval);
        const ltfIv = mapToLowerInterval(primaryInterval);
        logWarn(
            `Building primary=${primaryInterval}, htf=${htfIv}, ltf=${ltfIv} from resampleFrom (${baseInterval}).`,
        );
        return {
            symbol: typeof o.symbol === 'string' ? o.symbol : symbol,
            primaryInterval,
            primary: resampleCandles(finest, primaryInterval),
            htf: { interval: htfIv, candles: resampleCandles(finest, htfIv) },
            ltf: { interval: ltfIv, candles: resampleCandles(finest, ltfIv) },
            dailyCandles: resampleCandles(finest, '1d'),
            legacySingleTimeframe: false,
        };
    }

    if (!Array.isArray(o.primary) || !isCandlestickArray(o.primary)) {
        throw new Error('Fixture object must include `primary` Candlestick[] or `resampleFrom`');
    }

    const primary = sortByOpenTime(o.primary);
    const htfObj = o.htf;
    const ltfObj = o.ltf;
    if (isTfBlock(htfObj) && isTfBlock(ltfObj)) {
        const dailyCandles = optionalDailyFromFixture(o);
        return {
            symbol: typeof o.symbol === 'string' ? o.symbol : symbol,
            primaryInterval,
            primary,
            htf: {
                interval: htfObj.interval,
                candles: sortByOpenTime(htfObj.candles),
            },
            ltf: {
                interval: ltfObj.interval,
                candles: sortByOpenTime(ltfObj.candles),
            },
            ...(dailyCandles ? { dailyCandles } : {}),
            legacySingleTimeframe: false,
        };
    }

    logWarn(
        'Fixture has `primary` only: HTF/LTF approximated from primary (not exchange-accurate). Add `htf`/`ltf` or `resampleFrom`.',
    );
    return {
        symbol: typeof o.symbol === 'string' ? o.symbol : symbol,
        primaryInterval,
        primary,
        htf: { interval: mapToHigherInterval(primaryInterval), candles: primary },
        ltf: { interval: mapToLowerInterval(primaryInterval), candles: primary },
        legacySingleTimeframe: true,
    };
}

export function sliceBundleAtPrimaryIndex(
    hist: ExpandedHistory,
    i: number,
    limits: { primary: number; htf: number; ltf: number },
): MarketBundle {
    const asOf = hist.primary[i]!.closeTime;
    const pLo = Math.max(0, i - limits.primary + 1);
    const primary = hist.primary.slice(pLo, i + 1);

    const htfClosed = hist.htf.candles.filter((c) => c.closeTime <= asOf);
    const ltfClosed = hist.ltf.candles.filter((c) => c.closeTime <= asOf);

    let dailyConsolidation: MarketBundle['dailyConsolidation'];
    const cons = readConsolidationStartFromEnv();
    if (cons.ok && hist.dailyCandles?.length) {
        const dailies = hist.dailyCandles.filter(
            (c) => c.openTime >= cons.startMs && c.closeTime <= asOf,
        );
        if (dailies.length > 0) {
            dailyConsolidation = { startDate: cons.isoDate, candles: dailies };
        }
    }

    return {
        symbol: hist.symbol,
        primaryInterval: hist.primaryInterval,
        primary,
        htf: {
            interval: hist.htf.interval,
            candles: htfClosed.slice(-limits.htf),
        },
        ltf: {
            interval: hist.ltf.interval,
            candles: ltfClosed.slice(-limits.ltf),
        },
        ...(dailyConsolidation ? { dailyConsolidation } : {}),
    };
}
