import type {
    MarketState,
    SignalBundle,
    StrategyResult,
    TradeDirection,
    TradeProposal,
} from '../types/pipeline';

function minGapForPrice(close: number): number {
    return Math.max(close * 0.001, 0.01);
}

function rrTriple(
    direction: TradeDirection,
    refEntry: number,
    stopLoss: number,
    takeProfits: [number, number, number],
): [number, number, number] {
    const risk =
        direction === 'long'
            ? Math.max(refEntry - stopLoss, minGapForPrice(refEntry))
            : Math.max(stopLoss - refEntry, minGapForPrice(refEntry));
    return takeProfits.map((tp) =>
        direction === 'long'
            ? Number(((tp - refEntry) / risk).toFixed(2))
            : Number(((refEntry - tp) / risk).toFixed(2)),
    ) as [number, number, number];
}

function proposalForLong(
    state: MarketState,
    reason: string,
): TradeProposal {
    const close = state.latest.close;
    const atr = state.indicators.atr;
    const gap = minGapForPrice(close);
    const swingLow = state.swings.swingLow;
    let stopLoss = close - Math.max(atr, gap);
    if (Number.isFinite(swingLow)) stopLoss = Math.min(stopLoss, swingLow - gap);
    stopLoss = Math.max(stopLoss, gap);

    const refEntry = close;
    const t1 = Math.max(close + Math.max(atr, gap), close * 1.001);
    const t2 = Math.max(t1 + Math.max(atr, gap), close + atr * 2);
    const t3 = Math.max(t2 + Math.max(atr, gap), close + atr * 3);
    const takeProfits: [number, number, number] = [t1, t2, t3];
    const entryZone: [number, number] = [close - atr * 0.1, close + atr * 0.1];
    const riskReward = rrTriple('long', refEntry, stopLoss, takeProfits);
    return {
        direction: 'long',
        entryZone,
        stopLoss,
        takeProfits,
        riskReward,
        reason,
    };
}

function proposalForShort(
    state: MarketState,
    reason: string,
): TradeProposal {
    const close = state.latest.close;
    const atr = state.indicators.atr;
    const gap = minGapForPrice(close);
    const swingHigh = state.swings.swingHigh;
    let stopLoss = close + Math.max(atr, gap);
    if (Number.isFinite(swingHigh)) stopLoss = Math.max(stopLoss, swingHigh + gap);

    const refEntry = close;
    const t1 = Math.min(close - Math.max(atr, gap), close * 0.999);
    const t2 = Math.min(t1 - Math.max(atr, gap), close - atr * 2);
    const t3 = Math.min(t2 - Math.max(atr, gap), close - atr * 3);
    const takeProfits: [number, number, number] = [t1, t2, t3];
    const entryZone: [number, number] = [close - atr * 0.1, close + atr * 0.1];
    const riskReward = rrTriple('short', refEntry, stopLoss, takeProfits);
    return {
        direction: 'short',
        entryZone,
        stopLoss,
        takeProfits,
        riskReward,
        reason,
    };
}

export function buildProposalFromStrategy(
    best: StrategyResult,
    state: MarketState,
    signals: SignalBundle,
): TradeProposal | null {
    console.log(best)
    if (best.score <= 0) return null;

    if (best.name === 'sfp_reversal' && signals.sfp.valid) {
        const reason = `SFP ${signals.sfp.type} — structure ${state.structure}`;
        return signals.sfp.type === 'bullish'
            ? proposalForLong(state, reason)
            : proposalForShort(state, reason);
    }

    if (best.name === 'trend_follow' && best.score >= 3) {
        if (best.context === 'trend_long') {
            return proposalForLong(
                state,
                `Trend follow — HTF/LTF aligned, MACD/EMA confluence`,
            );
        }
        if (best.context === 'trend_short') {
            return proposalForShort(
                state,
                `Trend follow — HTF/LTF aligned, MACD/EMA confluence`,
            );
        }
    }

    if (best.name === 'range_consolidation' && best.score >= 3) {
        if (best.context === 'range_long') {
            return proposalForRangeLong(
                state,
                `Range consolidation — long near range low (mean reversion)`,
            );
        }
        if (best.context === 'range_short') {
            return proposalForRangeShort(
                state,
                `Range consolidation — short near range high (mean reversion)`,
            );
        }
    }

    return null;
}

function proposalForRangeLong(state: MarketState, reason: string): TradeProposal | null {
    const close = state.latest.close;
    const atr = state.indicators.atr;
    const gap = minGapForPrice(close);
    const { swingHigh, swingLow } = state.swings;
    if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow)) return null;
    const range = swingHigh - swingLow;
    if (range <= gap * 2) return null;

    const mid = (swingHigh + swingLow) / 2;
    const stopLoss = Math.max(swingLow - Math.max(atr, gap), gap);
    const refEntry = close;
    const t1 = Math.max(mid, close + gap);
    const t2 = Math.max(swingHigh - gap, t1 + gap);
    const t3 = Math.max(swingHigh + Math.max(atr, gap) * 0.35, t2 + gap);
    const takeProfits: [number, number, number] = [t1, t2, t3];
    const entryZone: [number, number] = [close - atr * 0.12, close + atr * 0.12];
    const riskReward = rrTriple('long', refEntry, stopLoss, takeProfits);
    return {
        direction: 'long',
        entryZone,
        stopLoss,
        takeProfits,
        riskReward,
        reason,
    };
}

function proposalForRangeShort(state: MarketState, reason: string): TradeProposal | null {
    const close = state.latest.close;
    const atr = state.indicators.atr;
    const gap = minGapForPrice(close);
    const { swingHigh, swingLow } = state.swings;
    if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow)) return null;
    const range = swingHigh - swingLow;
    if (range <= gap * 2) return null;

    const mid = (swingHigh + swingLow) / 2;
    const stopLoss = swingHigh + Math.max(atr, gap);
    const refEntry = close;
    const t1 = Math.min(mid, close - gap);
    const t2 = Math.min(swingLow + gap, t1 - gap);
    const t3 = Math.min(swingLow - Math.max(atr, gap) * 0.35, t2 - gap);
    const takeProfits: [number, number, number] = [t1, t2, t3];
    const entryZone: [number, number] = [close - atr * 0.12, close + atr * 0.12];
    const riskReward = rrTriple('short', refEntry, stopLoss, takeProfits);
    return {
        direction: 'short',
        entryZone,
        stopLoss,
        takeProfits,
        riskReward,
        reason,
    };
}
