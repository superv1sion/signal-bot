import type { Candlestick } from '../binanceClient';

/**
 * Fixed **percentage** take-profit and stop-loss from a reference price (e.g. signal bar close).
 *
 * - **Long:** TP = `ref * (1 + tpPct/100)`, SL = `ref * (1 - slPct/100)`.
 * - **Short:** TP = `ref * (1 - tpPct/100)`, SL = `ref * (1 + slPct/100)`.
 *
 * Forward scan starts on the **next** bar. Intra-bar SL vs TP order is controlled by `barContest`
 * (`stop_first` default, `tp_first`, or `split` for 50/50 gross return blend before one round-trip fee).
 */

export type FixedPctBarContest = 'stop_first' | 'tp_first' | 'split';

export type FixedPctOutcome = 'tp_hit' | 'sl_hit' | 'series_end' | 'no_forward_data' | 'dual_split';

export type FixedPctTrackRow = {
    barIndex: number;
    openTime: number;
    closeTime: number;
    strategy: string;
    score: number;
    context: string;
    direction: 'long' | 'short';
    refPrice: number;
    tpPct: number;
    slPct: number;
    tpPrice: number;
    slPrice: number;
    outcome: FixedPctOutcome;
    exitBarIndex?: number;
    barsAfterSignalToExit?: number;
};

function hitLong(b: Candlestick, slPrice: number, tpPrice: number) {
    return { hitSl: b.low <= slPrice, hitTp: b.high >= tpPrice };
}

function hitShort(b: Candlestick, slPrice: number, tpPrice: number) {
    return { hitSl: b.high >= slPrice, hitTp: b.low <= tpPrice };
}

export function traceFixedPctTpSl(params: {
    primary: Candlestick[];
    signalBarIndex: number;
    refPrice: number;
    direction: 'long' | 'short';
    tpPct: number;
    slPct: number;
    meta: Pick<FixedPctTrackRow, 'barIndex' | 'openTime' | 'closeTime' | 'strategy' | 'score' | 'context'>;
    barContest?: FixedPctBarContest;
}): FixedPctTrackRow {
    const { primary, signalBarIndex, refPrice, direction, tpPct, slPct, meta } = params;
    const barContest = params.barContest ?? 'stop_first';
    const n = primary.length;

    const tpPrice =
        direction === 'long'
            ? refPrice * (1 + tpPct / 100)
            : refPrice * (1 - tpPct / 100);
    const slPrice =
        direction === 'long'
            ? refPrice * (1 - slPct / 100)
            : refPrice * (1 + slPct / 100);

    const base: Omit<FixedPctTrackRow, 'outcome' | 'exitBarIndex' | 'barsAfterSignalToExit'> = {
        ...meta,
        direction,
        refPrice,
        tpPct,
        slPct,
        tpPrice,
        slPrice,
    };

    if (signalBarIndex + 1 >= n) {
        return { ...base, outcome: 'no_forward_data' };
    }

    for (let j = signalBarIndex + 1; j < n; j += 1) {
        const b = primary[j]!;
        if (direction === 'long') {
            const { hitSl, hitTp } = hitLong(b, slPrice, tpPrice);
            if (hitSl && hitTp && barContest === 'split') {
                return {
                    ...base,
                    outcome: 'dual_split',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
            if (hitSl && hitTp && barContest === 'tp_first') {
                return {
                    ...base,
                    outcome: 'tp_hit',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
            if (hitSl && hitTp && barContest === 'stop_first') {
                return {
                    ...base,
                    outcome: 'sl_hit',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
            if (hitSl) {
                return {
                    ...base,
                    outcome: 'sl_hit',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
            if (hitTp) {
                return {
                    ...base,
                    outcome: 'tp_hit',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
        } else {
            const { hitSl, hitTp } = hitShort(b, slPrice, tpPrice);
            if (hitSl && hitTp && barContest === 'split') {
                return {
                    ...base,
                    outcome: 'dual_split',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
            if (hitSl && hitTp && barContest === 'tp_first') {
                return {
                    ...base,
                    outcome: 'tp_hit',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
            if (hitSl && hitTp && barContest === 'stop_first') {
                return {
                    ...base,
                    outcome: 'sl_hit',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
            if (hitSl) {
                return {
                    ...base,
                    outcome: 'sl_hit',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
            if (hitTp) {
                return {
                    ...base,
                    outcome: 'tp_hit',
                    exitBarIndex: j,
                    barsAfterSignalToExit: j - signalBarIndex,
                };
            }
        }
    }

    return { ...base, outcome: 'series_end' };
}

export type FixedPctCostModel = {
    /** Per side; round-trip subtracts `2 * feeBps / 10000` once per completed trade path. */
    feeBps: number;
    /** Adverse entry + exit slippage as fraction of notional (each leg), summed. */
    entrySlipBps?: number;
    exitSlipBps?: number;
};

function feeFrac(feeBps: number): number {
    return (2 * Math.max(0, feeBps)) / 10000;
}

function slipFrac(costs: FixedPctCostModel | undefined): number {
    if (!costs) return 0;
    return (Math.max(0, costs.entrySlipBps ?? 0) + Math.max(0, costs.exitSlipBps ?? 0)) / 10000;
}

/** Gross fraction of notional before fees/slippage (e.g. 0.02 = +2%). */
export function grossPnlFractionForFixedPctTrack(t: FixedPctTrackRow, primary: Candlestick[]): number {
    if (t.outcome === 'tp_hit') return t.tpPct / 100;
    if (t.outcome === 'sl_hit') return -t.slPct / 100;
    if (t.outcome === 'dual_split') {
        return (t.tpPct / 100 - t.slPct / 100) / 2;
    }
    if (t.outcome === 'series_end') {
        const last = primary[primary.length - 1]?.close;
        if (last === undefined || !Number.isFinite(last) || t.refPrice === 0) return 0;
        if (t.direction === 'long') return (last - t.refPrice) / t.refPrice;
        return (t.refPrice - last) / t.refPrice;
    }
    return 0;
}

/**
 * Net fraction after one round-trip fee model and optional entry+exit slippage (same approximation as proposal sim).
 */
export function pnlFractionForFixedPctTrack(
    t: FixedPctTrackRow,
    primary: Candlestick[],
    costs?: FixedPctCostModel,
): number {
    const gross = grossPnlFractionForFixedPctTrack(t, primary);
    if (t.outcome === 'no_forward_data') return 0;
    const f = costs !== undefined ? feeFrac(costs.feeBps) : 0;
    const s = slipFrac(costs);
    if (gross === 0 && t.outcome !== 'series_end') return 0;
    return gross - f - s;
}

export type FixedPctSummaryOptions = {
    /** Notional per trade (same currency units as desired PnL). */
    positionSize?: number;
    /** Required for `series_end` mark-to-market and for dollar totals. */
    primary?: Candlestick[];
    /** When set with `positionSize`, dollar totals include fees and slippage drag. */
    costs?: FixedPctCostModel;
};

export function summarizeFixedPctTracks(
    tracks: FixedPctTrackRow[],
    opts?: FixedPctSummaryOptions,
): {
    count: number;
    byOutcome: Record<string, number>;
    tpVsSl?: {
        tpHits: number;
        slHits: number;
        resolved: number;
        tpShareOfResolvedPct: number;
        slShareOfResolvedPct: number;
        ratioTpPerSl: number | null;
    };
    avgBarsToTp?: number;
    avgBarsToSl?: number;
    positionSize?: number;
    /** Sum of `positionSize * pnlFraction` over all tracks (MTM at last primary close for `series_end`). */
    totalPnl?: number;
    pnlFromTpHits?: number;
    pnlFromSlHits?: number;
    pnlFromSeriesEndMtm?: number;
    pnlFromDualSplit?: number;
} {
    const byOutcome: Record<string, number> = {};
    for (const t of tracks) {
        byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
    }

    const tpHits = tracks.filter((t) => t.outcome === 'tp_hit');
    const slHits = tracks.filter((t) => t.outcome === 'sl_hit');
    const dualSplits = tracks.filter((t) => t.outcome === 'dual_split');
    const resolved = tpHits.length + slHits.length + dualSplits.length;

    const tpVsSl =
        resolved > 0
            ? {
                  tpHits: tpHits.length,
                  slHits: slHits.length,
                  resolved,
                  tpShareOfResolvedPct: Number(((100 * tpHits.length) / resolved).toFixed(2)),
                  slShareOfResolvedPct: Number(((100 * slHits.length) / resolved).toFixed(2)),
                  ratioTpPerSl:
                      slHits.length > 0
                          ? Number((tpHits.length / slHits.length).toFixed(4))
                          : null,
              }
            : undefined;

    const avgBarsToTp =
        tpHits.length > 0
            ? Number(
                  (
                      tpHits.reduce((s, t) => s + (t.barsAfterSignalToExit ?? 0), 0) / tpHits.length
                  ).toFixed(2),
              )
            : undefined;

    const avgBarsToSl =
        slHits.length > 0
            ? Number(
                  (
                      slHits.reduce((s, t) => s + (t.barsAfterSignalToExit ?? 0), 0) / slHits.length
                  ).toFixed(2),
              )
            : undefined;

    const pos =
        opts?.positionSize !== undefined &&
        Number.isFinite(opts.positionSize) &&
        opts.positionSize > 0 &&
        opts.primary &&
        opts.primary.length > 0
            ? opts.positionSize
            : undefined;

    const costs = opts?.costs;

    let totalPnl: number | undefined;
    let pnlFromTpHits: number | undefined;
    let pnlFromSlHits: number | undefined;
    let pnlFromSeriesEndMtm: number | undefined;
    let pnlFromDualSplit: number | undefined;

    if (pos !== undefined && opts?.primary) {
        const primary = opts.primary;
        let sumTp = 0;
        let sumSl = 0;
        let sumEnd = 0;
        let sumDual = 0;
        let sumAll = 0;
        for (const t of tracks) {
            const frac = pnlFractionForFixedPctTrack(t, primary, costs);
            const usd = pos * frac;
            sumAll += usd;
            if (t.outcome === 'tp_hit') sumTp += usd;
            else if (t.outcome === 'sl_hit') sumSl += usd;
            else if (t.outcome === 'series_end') sumEnd += usd;
            else if (t.outcome === 'dual_split') sumDual += usd;
        }
        totalPnl = Number(sumAll.toFixed(2));
        pnlFromTpHits = Number(sumTp.toFixed(2));
        pnlFromSlHits = Number(sumSl.toFixed(2));
        pnlFromSeriesEndMtm = Number(sumEnd.toFixed(2));
        pnlFromDualSplit = dualSplits.length > 0 ? Number(sumDual.toFixed(2)) : undefined;
    }

    return {
        count: tracks.length,
        byOutcome,
        ...(tpVsSl ? { tpVsSl } : {}),
        ...(avgBarsToTp !== undefined ? { avgBarsToTp } : {}),
        ...(avgBarsToSl !== undefined ? { avgBarsToSl } : {}),
        ...(pos !== undefined ? { positionSize: pos } : {}),
        ...(totalPnl !== undefined ? { totalPnl } : {}),
        ...(pnlFromTpHits !== undefined ? { pnlFromTpHits } : {}),
        ...(pnlFromSlHits !== undefined ? { pnlFromSlHits } : {}),
        ...(pnlFromSeriesEndMtm !== undefined ? { pnlFromSeriesEndMtm } : {}),
        ...(pnlFromDualSplit !== undefined ? { pnlFromDualSplit } : {}),
    };
}
