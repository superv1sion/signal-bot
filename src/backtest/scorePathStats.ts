import type { Candlestick } from '../binanceClient';
import type { SignalBundle, StrategyResult } from '../types/pipeline';

/**
 * Maps the winning strategy + discrete signals to a directional bias for path statistics.
 * Only defined when the strategy implies a clear long/short idea.
 */
export function favoredDirectionFromBest(
    best: StrategyResult,
    signals: SignalBundle,
): 'long' | 'short' | undefined {
    if (best.name === 'trend_follow') {
        if (best.context === 'trend_long') return 'long';
        if (best.context === 'trend_short') return 'short';
        return undefined;
    }
    if (best.name === 'range_consolidation') {
        if (best.context === 'range_long') return 'long';
        if (best.context === 'range_short') return 'short';
        return undefined;
    }
    if (best.name === 'sfp_reversal') {
        if (!signals.sfp.valid) return undefined;
        if (signals.sfp.type === 'bullish') return 'long';
        if (signals.sfp.type === 'bearish') return 'short';
        return undefined;
    }
    return undefined;
}

/**
 * After the signal bar closes at `refPrice`, walk **forward** on primary candles only.
 *
 * - **Long**: favorable move uses `high - refPrice` (running max). Invalidation when `low <= invalidation`.
 * - **Short**: favorable uses `refPrice - low` (running max). Invalidation when `high >= invalidation`.
 * - Per bar: test invalidation first (conservative), then update MFE with that bar’s extreme.
 *
 * If `invalidation` is missing/NaN, MFE is still computed to the end of the series with outcome
 * `no_invalidation_level`.
 */
export type ScorePathTrackRow = {
    barIndex: number;
    openTime: number;
    closeTime: number;
    strategy: string;
    score: number;
    context: string;
    direction: 'long' | 'short';
    refPrice: number;
    invalidation?: number;
    sfpType?: 'bullish' | 'bearish';
    outcome: 'invalidated' | 'series_end_before_invalidation' | 'no_invalidation_level' | 'no_forward_data';
    invalidatedAtBarIndex?: number;
    barsAfterSignalToInvalidation?: number;
    maxFavorableMove: number;
    maxFavorableMovePct: number;
    maxFavorableAtBarIndex?: number;
};

export function traceMfeUntilInvalidation(params: {
    primary: Candlestick[];
    signalBarIndex: number;
    refPrice: number;
    direction: 'long' | 'short';
    invalidation: number | undefined;
    meta: Pick<ScorePathTrackRow, 'barIndex' | 'openTime' | 'closeTime' | 'strategy' | 'score' | 'context'>;
    sfpType?: 'bullish' | 'bearish';
}): ScorePathTrackRow {
    const { primary, signalBarIndex, refPrice, direction, invalidation, meta, sfpType } = params;
    const hasInv = invalidation !== undefined && Number.isFinite(invalidation);
    const n = primary.length;

    const base = {
        ...meta,
        direction,
        refPrice,
        ...(hasInv ? { invalidation } : {}),
        ...(sfpType ? { sfpType } : {}),
    };

    if (signalBarIndex + 1 >= n) {
        return {
            ...base,
            outcome: 'no_forward_data' as const,
            maxFavorableMove: 0,
            maxFavorableMovePct: 0,
        };
    }

    let maxFav = 0;
    let maxFavAt: number | undefined;

    for (let j = signalBarIndex + 1; j < n; j += 1) {
        const b = primary[j]!;
        if (direction === 'long') {
            if (hasInv && b.low <= invalidation!) {
                const pct = refPrice !== 0 ? (maxFav / refPrice) * 100 : 0;
                return {
                    ...base,
                    outcome: 'invalidated',
                    invalidatedAtBarIndex: j,
                    barsAfterSignalToInvalidation: j - signalBarIndex,
                    maxFavorableMove: maxFav,
                    maxFavorableMovePct: Number(pct.toFixed(4)),
                    ...(maxFavAt !== undefined ? { maxFavorableAtBarIndex: maxFavAt } : {}),
                };
            }
            const m = b.high - refPrice;
            if (m > maxFav) {
                maxFav = m;
                maxFavAt = j;
            }
        } else {
            if (hasInv && b.high >= invalidation!) {
                const pct = refPrice !== 0 ? (maxFav / refPrice) * 100 : 0;
                return {
                    ...base,
                    outcome: 'invalidated',
                    invalidatedAtBarIndex: j,
                    barsAfterSignalToInvalidation: j - signalBarIndex,
                    maxFavorableMove: maxFav,
                    maxFavorableMovePct: Number(pct.toFixed(4)),
                    ...(maxFavAt !== undefined ? { maxFavorableAtBarIndex: maxFavAt } : {}),
                };
            }
            const m = refPrice - b.low;
            if (m > maxFav) {
                maxFav = m;
                maxFavAt = j;
            }
        }
    }

    const pct = refPrice !== 0 ? (maxFav / refPrice) * 100 : 0;
    return {
        ...base,
        outcome: hasInv ? 'series_end_before_invalidation' : 'no_invalidation_level',
        maxFavorableMove: maxFav,
        maxFavorableMovePct: Number(pct.toFixed(4)),
        ...(maxFavAt !== undefined ? { maxFavorableAtBarIndex: maxFavAt } : {}),
    };
}
