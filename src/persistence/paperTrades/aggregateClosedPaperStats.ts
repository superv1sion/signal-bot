import type { PaperClosedStatsAggregate, PaperTradeClosedEvent } from './types';

function pnlPctForClose(e: PaperTradeClosedEvent): number | null {
    const { direction, entry, exitPrice } = e;
    if (direction === undefined || entry === undefined) return null;
    if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(exitPrice)) return null;
    const frac =
        direction === 'long' ? (exitPrice - entry) / entry : (entry - exitPrice) / entry;
    return frac * 100;
}

function rForClose(e: PaperTradeClosedEvent): number | null {
    const { direction, entry, sl, exitPrice, initialSl } = e;
    const stopRef = initialSl !== undefined ? initialSl : sl;
    if (direction === undefined || entry === undefined || stopRef === undefined) return null;
    if (!Number.isFinite(exitPrice)) return null;
    const risk = direction === 'long' ? entry - stopRef : stopRef - entry;
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const pnl = direction === 'long' ? exitPrice - entry : entry - exitPrice;
    return pnl / risk;
}

function isTerminalClose(e: PaperTradeClosedEvent): boolean {
    return e.terminal !== false;
}

export function aggregateClosedPaperStats(events: PaperTradeClosedEvent[]): PaperClosedStatsAggregate {
    let wins = 0;
    let losses = 0;
    let sumPnl = 0;
    let tradesWithPnl = 0;
    let sumR = 0;
    let tradesWithR = 0;

    for (const e of events) {
        if (isTerminalClose(e)) {
            if (e.outcome === 'tp') wins += 1;
            else losses += 1;
        }

        const posFrac = e.positionFraction ?? 1;
        const pct = pnlPctForClose(e);
        if (pct !== null) {
            sumPnl += pct * posFrac;
            tradesWithPnl += 1;
        }

        const r = rForClose(e);
        if (r !== null) {
            sumR += r * posFrac;
            tradesWithR += 1;
        }
    }

    const closedCount = events.length;
    const terminalCount = wins + losses;
    return {
        closedCount,
        wins,
        losses,
        winRatePct: terminalCount === 0 ? null : (wins / terminalCount) * 100,
        sumPnlPct: tradesWithPnl === 0 ? null : sumPnl,
        tradesWithPnl,
        sumR: tradesWithR === 0 ? null : sumR,
        tradesWithR,
    };
}
