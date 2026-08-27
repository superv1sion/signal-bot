import type { Candle } from '../../types/pipeline';
import type { PaperTpLeg, PaperTradeOpenRecord } from './types';

/** One third of original notional per TP rung. */
export const PAPER_TP_SLICE = 1 / 3;

const REM_EPS = 1e-9;

export function barHitsLong(bar: Candle, sl: number, tp: number): { hitSl: boolean; hitTp: boolean } {
    return { hitSl: bar.low <= sl, hitTp: bar.high >= tp };
}

export function barHitsShort(bar: Candle, sl: number, tp: number): { hitSl: boolean; hitTp: boolean } {
    return { hitSl: bar.high >= sl, hitTp: bar.low <= tp };
}

/** Stop-first when both SL and TP touch the same bar. */
export function resolveExit(
    direction: 'long' | 'short',
    bar: Candle,
    sl: number,
    tp: number,
): { outcome: 'tp' | 'sl'; exitPrice: number } | null {
    const { hitSl, hitTp } =
        direction === 'long' ? barHitsLong(bar, sl, tp) : barHitsShort(bar, sl, tp);
    if (hitSl && hitTp) {
        return { outcome: 'sl', exitPrice: sl };
    }
    if (hitSl) return { outcome: 'sl', exitPrice: sl };
    if (hitTp) return { outcome: 'tp', exitPrice: tp };
    return null;
}

export function isScalingPaperTrade(trade: PaperTradeOpenRecord): boolean {
    const tps = trade.takeProfits;
    return (
        Array.isArray(tps) &&
        tps.length === 3 &&
        trade.remainingFraction !== undefined &&
        trade.remainingFraction > REM_EPS &&
        trade.activeTpIndex !== undefined &&
        trade.activeTpIndex >= 0 &&
        trade.activeTpIndex < 3
    );
}

export type PaperScalingClosure = {
    terminal: boolean;
    outcome: 'tp' | 'sl';
    exitPrice: number;
    positionFraction: number;
    tpLeg?: PaperTpLeg;
    /** Active TP target at evaluation time (for SL close copy when in-bar state advanced). */
    activeTpAtEval: number;
};

export type PaperTradeBarProcessResult = {
    closures: PaperScalingClosure[];
    tick: { hitSl: boolean; hitTp: boolean; stillOpen: boolean };
    /** null when the leg fully closed this bar */
    nextTrade: PaperTradeOpenRecord | null;
};

function tpLegFromIndex(idxBeforeHit: number): PaperTpLeg {
    return (idxBeforeHit + 1) as PaperTpLeg;
}

/**
 * Pure bar step: legacy full SL/TP or scaling thirds with same-bar BE / next TP re-check.
 * Caller appends Firestore events and sets lastEvaluatedBarOpenTime on nextTrade.
 */
export function processPaperTradeBar(
    trade: PaperTradeOpenRecord,
    bar: Candle,
    onSignalBar: boolean,
): PaperTradeBarProcessResult {
    if (onSignalBar) {
        return {
            closures: [],
            tick: { hitSl: false, hitTp: false, stillOpen: true },
            nextTrade: { ...trade, lastEvaluatedBarOpenTime: bar.time },
        };
    }

    const { direction } = trade;
    const tickHits =
        direction === 'long'
            ? barHitsLong(bar, trade.sl, trade.tp)
            : barHitsShort(bar, trade.sl, trade.tp);

    if (!isScalingPaperTrade(trade)) {
        const exit = resolveExit(direction, bar, trade.sl, trade.tp);
        if (exit) {
            return {
                closures: [
                    {
                        terminal: true,
                        outcome: exit.outcome,
                        exitPrice: exit.exitPrice,
                        positionFraction: 1,
                        activeTpAtEval: trade.tp,
                    },
                ],
                tick: { hitSl: tickHits.hitSl, hitTp: tickHits.hitTp, stillOpen: false },
                nextTrade: null,
            };
        }
        return {
            closures: [],
            tick: { hitSl: tickHits.hitSl, hitTp: tickHits.hitTp, stillOpen: true },
            nextTrade: { ...trade, lastEvaluatedBarOpenTime: bar.time },
        };
    }

    const closures: PaperScalingClosure[] = [];
    let cur: PaperTradeOpenRecord = { ...trade };
    const tps = cur.takeProfits!;

    while (cur.remainingFraction! > REM_EPS) {
        const exit = resolveExit(direction, bar, cur.sl, cur.tp);
        if (!exit) {
            break;
        }
        if (exit.outcome === 'sl') {
            closures.push({
                terminal: true,
                outcome: 'sl',
                exitPrice: exit.exitPrice,
                positionFraction: cur.remainingFraction!,
                activeTpAtEval: cur.tp,
            });
            return {
                closures,
                tick: { hitSl: tickHits.hitSl, hitTp: tickHits.hitTp, stillOpen: false },
                nextTrade: null,
            };
        }

        const idxBefore = cur.activeTpIndex!;
        const tpLeg = tpLegFromIndex(idxBefore);
        const newRem = cur.remainingFraction! - PAPER_TP_SLICE;
        const terminalTp = newRem <= REM_EPS;

        closures.push({
            terminal: terminalTp,
            outcome: 'tp',
            exitPrice: exit.exitPrice,
            positionFraction: PAPER_TP_SLICE,
            tpLeg,
            activeTpAtEval: cur.tp,
        });

        if (terminalTp) {
            return {
                closures,
                tick: { hitSl: tickHits.hitSl, hitTp: tickHits.hitTp, stillOpen: false },
                nextTrade: null,
            };
        }

        let nextRem = newRem;
        let nextIdx = idxBefore + 1;
        let nextSl = cur.sl;
        if (idxBefore === 0) {
            nextSl = cur.entry;
        }
        const nextTp = tps[nextIdx]!;
        cur = {
            ...cur,
            remainingFraction: nextRem,
            activeTpIndex: nextIdx,
            sl: nextSl,
            tp: nextTp,
        };
    }

    return {
        closures,
        tick: {
            hitSl: tickHits.hitSl,
            hitTp: tickHits.hitTp,
            stillOpen: cur.remainingFraction! > REM_EPS,
        },
        nextTrade: cur.remainingFraction! > REM_EPS ? { ...cur, lastEvaluatedBarOpenTime: bar.time } : null,
    };
}
