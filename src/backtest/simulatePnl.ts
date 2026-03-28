import type { Candlestick } from '../binanceClient';
import type { TradeProposal } from '../types/pipeline';

/**
 * Simplified execution model for C2 backtests (documented assumptions):
 *
 * - **One position at a time** — new signals while a trade is open are ignored.
 * - **Entry**: `close` — fill at the primary bar’s close when `send` is true; `next_open` — fill at
 *   the next bar’s open (more conservative; skips if there is no next bar). With `next_open`,
 *   **stop and TP1 are re-anchored** from the signal bar close so risk/reward distances match the
 *   proposal (same absolute risk/reward as if filled at that close, shifted to actual fill).
 * - **Exits** start on bars **after** the entry bar (no same-bar exit).
 * - **Long**: per bar, resolution of stop vs TP1 when both could print depends on `barContest`:
 *   `stop_first` (default), `tp_first`, or `split` (50/50 PnL average on that bar).
 * - **Short**: symmetric.
 * - **TP2/TP3** are ignored; PnL is binary stop vs first target (or dual split).
 * - **Fees**: round-trip `2 * feeBps / 10000` fraction of notional subtracted from return.
 * - **Slippage** (optional bps): adverse entry fill; adverse exit on TP and stop; extra bps on stop only.
 */

export type EntryModel = 'close' | 'next_open';

export type BarContestMode = 'stop_first' | 'tp_first' | 'split';

export type SimulatedTrade = {
    signalBarIndex: number;
    entryBarIndex: number;
    exitBarIndex: number;
    direction: 'long' | 'short';
    entryPrice: number;
    exitPrice: number;
    outcome: 'tp1' | 'stop' | 'open_at_end' | 'dual_split';
    pnlPctApprox: number;
};

export type PnlSimulationSummary = {
    trades: SimulatedTrade[];
    closedTp1: number;
    closedStop: number;
    openAtEnd: number;
    dualSplitTrades: number;
    sumPnlPctApprox: number;
};

function feeFracFromBps(feeBps: number): number {
    return (2 * Math.max(0, feeBps)) / 10000;
}

function slipFrac(bps: number): number {
    return Math.max(0, bps) / 10000;
}

/** Adverse entry: long pays more, short receives less. */
function entryWithSlip(direction: 'long' | 'short', price: number, slipBps: number): number {
    const f = slipFrac(slipBps);
    return direction === 'long' ? price * (1 + f) : price * (1 - f);
}

/** Adverse exit: long sells lower; short covers higher. */
function exitWithSlip(
    direction: 'long' | 'short',
    price: number,
    slipBps: number,
    isStop: boolean,
    stopExtraBps: number,
): number {
    const f = slipFrac(slipBps + (isStop ? stopExtraBps : 0));
    return direction === 'long' ? price * (1 - f) : price * (1 + f);
}

function grossReturnPct(direction: 'long' | 'short', entryPrice: number, exitPrice: number): number {
    if (!Number.isFinite(entryPrice) || entryPrice === 0) return 0;
    const raw =
        direction === 'long'
            ? (exitPrice - entryPrice) / entryPrice
            : (entryPrice - exitPrice) / entryPrice;
    return raw * 100;
}

function netPnlPctFromGross(grossPct: number, feeBps: number): number {
    return grossPct - feeFracFromBps(feeBps) * 100;
}

function pnlPctFromPrices(
    direction: 'long' | 'short',
    entryPrice: number,
    exitPrice: number,
    feeBps: number,
): number {
    return netPnlPctFromGross(grossReturnPct(direction, entryPrice, exitPrice), feeBps);
}

function reanchorLevelsForNextOpen(
    direction: 'long' | 'short',
    signalBarClose: number,
    entryPrice: number,
    proposal: TradeProposal,
): { stop: number; tp1: number } {
    const tp1Raw = proposal.takeProfits[0]!;
    if (direction === 'long') {
        const riskBelow = signalBarClose - proposal.stopLoss;
        const rewardAbove = tp1Raw - signalBarClose;
        return {
            stop: entryPrice - riskBelow,
            tp1: entryPrice + rewardAbove,
        };
    }
    const riskAbove = proposal.stopLoss - signalBarClose;
    const rewardBelow = signalBarClose - tp1Raw;
    return {
        stop: entryPrice + riskAbove,
        tp1: entryPrice - rewardBelow,
    };
}

function resolveBarLong(bar: Candlestick, stop: number, tp1: number): { hitStop: boolean; hitTp: boolean } {
    const hitStop = bar.low <= stop;
    const hitTp = bar.high >= tp1;
    return { hitStop, hitTp };
}

function resolveBarShort(
    bar: Candlestick,
    stop: number,
    tp1: number,
): { hitStop: boolean; hitTp: boolean } {
    const hitStop = bar.high >= stop;
    const hitTp = bar.low <= tp1;
    return { hitStop, hitTp };
}

export function simulatePnl(params: {
    primary: Candlestick[];
    /** Bar index where `send` was true and `proposal` non-null. */
    signals: Array<{ barIndex: number; proposal: TradeProposal }>;
    entryModel: EntryModel;
    feeBps: number;
    /** Adverse slippage on entry (bps). */
    entrySlipBps?: number;
    /** Adverse slippage on every exit (bps). */
    exitSlipBps?: number;
    /** Extra adverse bps on stop exits only. */
    stopExtraSlipBps?: number;
    barContest?: BarContestMode;
}): PnlSimulationSummary {
    const {
        primary,
        signals,
        entryModel,
        feeBps,
        entrySlipBps = 0,
        exitSlipBps = 0,
        stopExtraSlipBps = 0,
        barContest = 'stop_first',
    } = params;

    const trades: SimulatedTrade[] = [];
    let closedTp1 = 0;
    let closedStop = 0;
    let openAtEnd = 0;
    let dualSplitTrades = 0;
    let sumPnlPctApprox = 0;

    let active: {
        direction: 'long' | 'short';
        stop: number;
        tp1: number;
        entryPrice: number;
        entryBarIndex: number;
        signalBarIndex: number;
    } | null = null;

    const signalByIndex = new Map<number, TradeProposal>();
    for (const s of signals) {
        signalByIndex.set(s.barIndex, s.proposal);
    }

    for (let i = 0; i < primary.length; i += 1) {
        const bar = primary[i]!;

        if (active && i > active.entryBarIndex) {
            const { direction, stop, tp1, entryPrice, entryBarIndex, signalBarIndex } = active;
            let outcome: SimulatedTrade['outcome'] | null = null;
            let exitPrice = 0;

            if (direction === 'long') {
                const { hitStop, hitTp } = resolveBarLong(bar, stop, tp1);
                if (hitStop && hitTp && barContest === 'split') {
                    const exStop = exitWithSlip(direction, stop, exitSlipBps, true, stopExtraSlipBps);
                    const exTp = exitWithSlip(direction, tp1, exitSlipBps, false, stopExtraSlipBps);
                    const gAvg =
                        (grossReturnPct(direction, entryPrice, exStop) +
                            grossReturnPct(direction, entryPrice, exTp)) /
                        2;
                    sumPnlPctApprox += netPnlPctFromGross(gAvg, feeBps);
                    dualSplitTrades += 1;
                    exitPrice = (exStop + exTp) / 2;
                    outcome = 'dual_split';
                } else if (hitStop && hitTp && barContest === 'tp_first') {
                    outcome = 'tp1';
                    exitPrice = exitWithSlip(direction, tp1, exitSlipBps, false, stopExtraSlipBps);
                } else if (hitStop && hitTp && barContest === 'stop_first') {
                    outcome = 'stop';
                    exitPrice = exitWithSlip(direction, stop, exitSlipBps, true, stopExtraSlipBps);
                } else if (hitStop) {
                    outcome = 'stop';
                    exitPrice = exitWithSlip(direction, stop, exitSlipBps, true, stopExtraSlipBps);
                } else if (hitTp) {
                    outcome = 'tp1';
                    exitPrice = exitWithSlip(direction, tp1, exitSlipBps, false, stopExtraSlipBps);
                }
            } else {
                const { hitStop, hitTp } = resolveBarShort(bar, stop, tp1);
                if (hitStop && hitTp && barContest === 'split') {
                    const exStop = exitWithSlip(direction, stop, exitSlipBps, true, stopExtraSlipBps);
                    const exTp = exitWithSlip(direction, tp1, exitSlipBps, false, stopExtraSlipBps);
                    const gAvg =
                        (grossReturnPct(direction, entryPrice, exStop) +
                            grossReturnPct(direction, entryPrice, exTp)) /
                        2;
                    sumPnlPctApprox += netPnlPctFromGross(gAvg, feeBps);
                    dualSplitTrades += 1;
                    exitPrice = (exStop + exTp) / 2;
                    outcome = 'dual_split';
                } else if (hitStop && hitTp && barContest === 'tp_first') {
                    outcome = 'tp1';
                    exitPrice = exitWithSlip(direction, tp1, exitSlipBps, false, stopExtraSlipBps);
                } else if (hitStop && hitTp && barContest === 'stop_first') {
                    outcome = 'stop';
                    exitPrice = exitWithSlip(direction, stop, exitSlipBps, true, stopExtraSlipBps);
                } else if (hitStop) {
                    outcome = 'stop';
                    exitPrice = exitWithSlip(direction, stop, exitSlipBps, true, stopExtraSlipBps);
                } else if (hitTp) {
                    outcome = 'tp1';
                    exitPrice = exitWithSlip(direction, tp1, exitSlipBps, false, stopExtraSlipBps);
                }
            }

            if (outcome) {
                if (outcome === 'dual_split') {
                    const exStop = exitWithSlip(direction, stop, exitSlipBps, true, stopExtraSlipBps);
                    const exTp = exitWithSlip(direction, tp1, exitSlipBps, false, stopExtraSlipBps);
                    const gAvg =
                        (grossReturnPct(direction, entryPrice, exStop) +
                            grossReturnPct(direction, entryPrice, exTp)) /
                        2;
                    const pnlPctApprox = netPnlPctFromGross(gAvg, feeBps);
                    trades.push({
                        signalBarIndex,
                        entryBarIndex,
                        exitBarIndex: i,
                        direction,
                        entryPrice,
                        exitPrice: (exStop + exTp) / 2,
                        outcome: 'dual_split',
                        pnlPctApprox,
                    });
                } else {
                    const pnlPctApprox = pnlPctFromPrices(direction, entryPrice, exitPrice, feeBps);
                    sumPnlPctApprox += pnlPctApprox;
                    if (outcome === 'tp1') closedTp1 += 1;
                    else closedStop += 1;
                    trades.push({
                        signalBarIndex,
                        entryBarIndex,
                        exitBarIndex: i,
                        direction,
                        entryPrice,
                        exitPrice,
                        outcome,
                        pnlPctApprox,
                    });
                }
                active = null;
            }
        }

        if (!active) {
            const proposal = signalByIndex.get(i);
            if (proposal) {
                const signalBar = primary[i]!;
                const signalBarClose = signalBar.close;
                let entryBarIndex = i;
                let entryRaw: number;
                if (entryModel === 'close') {
                    entryRaw = signalBar.close;
                } else {
                    const next = primary[i + 1];
                    if (!next) continue;
                    entryBarIndex = i + 1;
                    entryRaw = next.open;
                }
                const entryPrice = entryWithSlip(proposal.direction, entryRaw, entrySlipBps);
                let stop: number;
                let tp1: number;
                if (entryModel === 'next_open') {
                    ({ stop, tp1 } = reanchorLevelsForNextOpen(
                        proposal.direction,
                        signalBarClose,
                        entryPrice,
                        proposal,
                    ));
                } else {
                    stop = proposal.stopLoss;
                    tp1 = proposal.takeProfits[0]!;
                }
                active = {
                    direction: proposal.direction,
                    stop,
                    tp1,
                    entryPrice,
                    entryBarIndex,
                    signalBarIndex: i,
                };
            }
        }
    }

    if (active) {
        const last = primary[primary.length - 1]!;
        const { direction, entryPrice, entryBarIndex, signalBarIndex } = active;
        const exitRaw = last.close;
        const exitPrice = exitWithSlip(direction, exitRaw, exitSlipBps, false, stopExtraSlipBps);
        const pnlPctApprox = pnlPctFromPrices(direction, entryPrice, exitPrice, feeBps);
        sumPnlPctApprox += pnlPctApprox;
        openAtEnd += 1;
        trades.push({
            signalBarIndex,
            entryBarIndex,
            exitBarIndex: primary.length - 1,
            direction,
            entryPrice,
            exitPrice,
            outcome: 'open_at_end',
            pnlPctApprox,
        });
    }

    return {
        trades,
        closedTp1,
        closedStop,
        openAtEnd,
        dualSplitTrades,
        sumPnlPctApprox,
    };
}
