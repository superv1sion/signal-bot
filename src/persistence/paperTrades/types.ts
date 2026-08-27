import type { LlmCritique } from '../../types/pipeline';

/** Which rung of the triple TP ladder was hit (scaling legs only). */
export type PaperTpLeg = 1 | 2 | 3;

/** Snapshot for Telegram when a paper leg hits SL/TP (Firestore path). */
export type PaperTradeClosedLegSummary = {
    tradeId: string;
    symbol: string;
    interval: string;
    direction: 'long' | 'short';
    entry: number;
    sl: number;
    tp: number;
    strategy?: string;
    outcome: 'tp' | 'sl';
    exitPrice: number;
    exitBarOpenTime: number;
    /** Fraction of original notional closed (default 1). */
    positionFraction?: number;
    tpLeg?: PaperTpLeg;
    /** Original stop; use for R when live SL is break-even. */
    initialSl?: number;
    /** If false, partial fill — excluded from terminal W/L in aggregates. */
    terminal?: boolean;
};

export type PaperTradeOpenRecord = {
    id: string;
    symbol: string;
    interval: string;
    openedAt: string;
    signalBarOpenTime: number;
    direction: 'long' | 'short';
    entry: number;
    sl: number;
    tp: number;
    strategy?: string;
    finalScore?: number;
    /** Last `finalScore` we sent on Telegram for this open leg (full or confidence). */
    lastNotifiedFinalScore?: number;
    /** Open time of the last primary candle applied to this leg (ticks / exit checks). Used to replay missed bars after downtime. */
    lastEvaluatedBarOpenTime?: number;
    /** Triple TP ladder; when set with `remainingFraction`, position scales out in thirds. */
    takeProfits?: [number, number, number];
    /** Remaining fraction of original notional (1 → 2/3 → 1/3 → 0). */
    remainingFraction?: number;
    /** Index into `takeProfits` for the active target (`tp` matches this level). */
    activeTpIndex?: number;
    /** Stop at open; for R on closes after SL moves to break-even. */
    initialSl?: number;
    llm?: Pick<LlmCritique, 'score_adjustment' | 'veto' | 'comment' | 'risk_flags'>;
};

/** Roll-up over all `closed` paper trade events (see aggregateClosedPaperStats). */
export type PaperClosedStatsAggregate = {
    closedCount: number;
    /** Terminal closes only (full exit or last partial). */
    wins: number;
    losses: number;
    /** 0–100, or null if no closes */
    winRatePct: number | null;
    /** Sum of per-trade % return vs entry (simple), only trades with full price fields */
    sumPnlPct: number | null;
    tradesWithPnl: number;
    /** Sum of R multiples where risk distance is valid */
    sumR: number | null;
    tradesWithR: number;
};

export type PaperTradesNotifyPlan =
    | { telegram: 'legacy' }
    | { telegram: 'none'; closures: PaperTradeClosedLegSummary[]; closedStats?: PaperClosedStatsAggregate }
    | { telegram: 'full'; closures: PaperTradeClosedLegSummary[]; closedStats?: PaperClosedStatsAggregate }
    | {
          telegram: 'confidence';
          openTrade: PaperTradeOpenRecord;
          previousNotifiedFinalScore: number;
          closures: PaperTradeClosedLegSummary[];
          closedStats?: PaperClosedStatsAggregate;
      };

type PaperEventBase = { ts: string };

export type PaperTradeOpenedEvent = PaperEventBase & {
    kind: 'opened';
    trade: PaperTradeOpenRecord;
};

export type PaperTradeTickEvent = PaperEventBase & {
    kind: 'tick';
    tradeId: string;
    symbol: string;
    interval: string;
    barOpenTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    exitsEvaluated: boolean;
    hitSl: boolean;
    hitTp: boolean;
    stillOpen: boolean;
};

export type PaperTradeClosedEvent = PaperEventBase & {
    kind: 'closed';
    tradeId: string;
    symbol: string;
    interval: string;
    outcome: 'tp' | 'sl';
    exitBarOpenTime: number;
    exitPrice: number;
    /** Present for closes after stats support; older events may omit (win rate still works). */
    direction?: 'long' | 'short';
    entry?: number;
    sl?: number;
    tp?: number;
    strategy?: string;
    /** Fraction of original notional (default 1). */
    positionFraction?: number;
    tpLeg?: PaperTpLeg;
    /** When false, partial TP slice; omitted/true = terminal (legacy). */
    terminal?: boolean;
    initialSl?: number;
};

export type PaperTradeEvent = PaperTradeOpenedEvent | PaperTradeTickEvent | PaperTradeClosedEvent;
