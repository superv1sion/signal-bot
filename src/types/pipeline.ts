export type Candle = {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

export type Trend = 'up' | 'down' | 'flat';

export type MarketStructureTag = 'HH' | 'HL' | 'LH' | 'LL' | 'unknown';

export type VolatilityRegime = 'low' | 'mid' | 'high';

export type MarketState = {
    symbol: string;
    primaryInterval: string;
    latest: Candle;
    trend: Trend;
    structure: MarketStructureTag;
    indicators: {
        rsi: number;
        ema20: number;
        ema50: number;
        ema200: number;
        atr: number;
        macdLine: number;
        macdSignal: number;
        bbUpper: number;
        bbMiddle: number;
        bbLower: number;
        bbWidth: number;
        obvDelta: number;
    };
    htf: { interval: string; trend: Trend; ema50?: number };
    ltf: { interval: string; trend: Trend; ema20?: number; ema50?: number; ema200?: number };
    swings: { swingHigh: number; swingLow: number; window: number };
    volatility: VolatilityRegime;
};

export type SfpSignal = { type: 'bullish' | 'bearish'; valid: boolean };

export type SignalBundle = {
    trendAligned: boolean;
    volumeSpike: boolean;
    sfp: SfpSignal;
};

export type StrategyResult = {
    name: string;
    score: number;
    context: string;
    invalidation?: number;
};

export type LlmCritique = {
    risk_flags: string[];
    score_adjustment: number;
    comment: string;
    veto?: boolean;
};

export type TradeDirection = 'long' | 'short';

export type TradeProposal = {
    direction: TradeDirection;
    entryZone: [number, number];
    stopLoss: number;
    takeProfits: [number, number, number];
    riskReward: [number, number, number];
    reason: string;
};

export type DecisionKind = 'signal_sent' | 'skipped' | 'error';

/** Snapshot of what the feature engine produced (for logs / run history). */
export type MarketSummary = Pick<
    MarketState,
    'trend' | 'structure' | 'volatility' | 'latest' | 'indicators' | 'htf' | 'ltf' | 'swings'
>;

export type LlmSkippedReason = 'below_min_score' | 'no_api_key';

export type DecisionRecord = {
    ts: string;
    symbol: string;
    interval: string;
    strategy?: string;
    score?: number;
    finalScore?: number;
    /** All strategy scores from this tick (deterministic layer). */
    strategies?: StrategyResult[];
    /** Discrete signals from this tick. */
    signals?: SignalBundle;
    /** Condensed market state from this tick. */
    marketSummary?: MarketSummary;
    /** Present when the LLM critic ran successfully. */
    llm?: LlmCritique | null;
    /** Why the LLM was not called (when `llm` is null and there was no error). */
    llmSkippedReason?: LlmSkippedReason;
    /** Set when an LLM request was attempted but failed. */
    llmError?: string;
    /** Operator-written macro note from `MARKET_ENVIRONMENT.md` (or `MARKET_ENVIRONMENT_FILE`), if any. */
    operatorMarketEnvironment?: string;
    /** `LLM_MIN_SCORE` gate value used for this run (for audit). */
    llmMinScoreGate?: number;
    decision: DecisionKind;
    proposal?: TradeProposal;
    skipReason?: string;
    error?: string;
};

export type PipelineResult = {
    state: MarketState;
    signals: SignalBundle;
    strategies: StrategyResult[];
    best: StrategyResult;
    critique: LlmCritique | null;
    decision: { finalScore: number; send: boolean; vetoed: boolean };
    proposal: TradeProposal | null;
    record: DecisionRecord;
};
