import { loadMarketBundle } from '../data/marketData';
import { buildMarketState } from '../features/buildMarketState';
import { buildSignals } from '../signals';
import { runStrategies } from '../strategies/aggregate';
import { getLlmCritique } from '../openaiClient';
import { decide } from '../decision/decide';
import { buildProposalFromStrategy } from '../execution/buildProposal';
import type {
    DecisionRecord,
    LlmSkippedReason,
    PipelineResult,
} from '../types/pipeline';
import { logError } from '../logger';

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

function buildSkipReason(params: {
    signaled: boolean;
    vetoed: boolean;
    bestScore: number;
    finalScore: number;
    entryThreshold: number;
    hadProposal: boolean;
}): string | undefined {
    if (params.signaled) return undefined;
    if (params.vetoed) return 'llm_veto';
    if (params.bestScore <= 0) return 'no_strategy_score';
    if (params.finalScore < params.entryThreshold) return 'below_entry_threshold';
    if (!params.hadProposal) return 'no_actionable_proposal';
    return 'skipped';
}

export async function runEvaluation(params: {
    symbol: string;
    interval: string;
    primaryLimit?: number;
}): Promise<PipelineResult> {
    const { symbol, interval, primaryLimit = 200 } = params;
    const bundle = await loadMarketBundle({ symbol, interval, primaryLimit });
    if (bundle.primary.length < 60) {
        throw new Error('Not enough candles returned to compute indicators (need >= 60).');
    }

    const state = buildMarketState(bundle);
    const volumes = bundle.primary.map((c) => c.volume);
    const signals = buildSignals(state, volumes);
    const { best, all } = runStrategies(state, signals);

    const llmMinScore = Number(process.env.LLM_MIN_SCORE ?? 3);
    const entryThreshold = Number(process.env.ENTRY_THRESHOLD ?? 5);

    let critique = null;
    let llmSkippedReason: LlmSkippedReason | undefined;
    let llmError: string | undefined;
    if (best.score >= llmMinScore && OPENAI_API_KEY) {
        try {
            critique = await getLlmCritique({
                market_state: state,
                signals,
                strategy: best,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            llmError = msg;
            logError('LLM critique failed; proceeding without adjustment', msg);
            critique = null;
        }
    } else if (best.score < llmMinScore) {
        llmSkippedReason = 'below_min_score';
    } else {
        llmSkippedReason = 'no_api_key';
    }

    let decision = decide({ best, critique, entryThreshold });
    let proposal = null;
    if (decision.send) {
        proposal = buildProposalFromStrategy(best, state, signals);
        if (!proposal) {
            decision = { ...decision, send: false };
        }
    }

    const signaled = Boolean(decision.send && proposal);
    const finalScoreForRecord = decision.vetoed ? best.score : decision.finalScore;
    const skipReason = buildSkipReason({
        signaled,
        vetoed: decision.vetoed,
        bestScore: best.score,
        finalScore: finalScoreForRecord,
        entryThreshold,
        hadProposal: proposal != null,
    });

    const marketSummary: DecisionRecord['marketSummary'] = {
        trend: state.trend,
        structure: state.structure,
        volatility: state.volatility,
        latest: state.latest,
        indicators: state.indicators,
        htf: state.htf,
        ltf: state.ltf,
        swings: state.swings,
    };

    const record: DecisionRecord = {
        ts: new Date().toISOString(),
        symbol,
        interval,
        strategy: best.name,
        score: best.score,
        finalScore: finalScoreForRecord,
        strategies: all,
        signals,
        marketSummary,
        llm: critique,
        llmSkippedReason:
            critique != null || llmError ? undefined : llmSkippedReason,
        llmError,
        llmMinScoreGate: llmMinScore,
        decision: signaled ? 'signal_sent' : 'skipped',
        proposal: proposal ?? undefined,
        skipReason,
    };

    return {
        state,
        signals,
        strategies: all,
        best,
        critique,
        decision,
        proposal,
        record,
    };
}
