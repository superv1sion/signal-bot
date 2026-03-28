import { loadMarketBundle } from '../data/marketData';
import { getLlmCritique } from '../openaiClient';
import type {
    DecisionRecord,
    LlmSkippedReason,
    PipelineResult,
} from '../types/pipeline';
import { logError } from '../logger';
import { readMarketEnvironmentNote } from '../config/readMarketEnvironment';
import {
    buildSkipReason,
    finalizeWithCritique,
    parseEntryGateMode,
    runDeterministicLayer,
} from './evaluateBundle';

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

const OPERATOR_ENV_MAX_RECORD_CHARS = 12_000;

function isTruthyEnv(v: string | undefined): boolean {
    return /^(1|true|yes)$/i.test((v ?? '').trim());
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

    const det = runDeterministicLayer(bundle);

    const llmMinScore = Number(process.env.LLM_MIN_SCORE ?? 4.5);
    const entryThreshold = Number(process.env.ENTRY_THRESHOLD ?? 5);
    const entryGate = parseEntryGateMode();
    const skipLlm = isTruthyEnv(process.env.SKIP_LLM);

    const operatorMarketEnvironmentRaw = readMarketEnvironmentNote();
    const operatorMarketEnvironmentForLlm = operatorMarketEnvironmentRaw.slice(0, 16_000);

    let critique = null;
    let llmSkippedReason: LlmSkippedReason | undefined;
    let llmError: string | undefined;
    if (skipLlm) {
        llmSkippedReason = 'llm_disabled';
    } else if (det.best.score >= llmMinScore && OPENAI_API_KEY) {
        try {
            critique = await getLlmCritique({
                market_state: det.state,
                signals: det.signals,
                strategy: det.best,
                ...(operatorMarketEnvironmentForLlm
                    ? { operator_market_environment: operatorMarketEnvironmentForLlm }
                    : {}),
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            llmError = msg;
            logError('LLM critique failed; proceeding without adjustment', msg);
            critique = null;
        }
    } else if (det.best.score < llmMinScore) {
        llmSkippedReason = 'below_min_score';
    } else {
        llmSkippedReason = 'no_api_key';
    }

    const { decision, proposal, proposalLevelsAudit } = finalizeWithCritique(
        det,
        critique,
        entryThreshold,
        entryGate,
    );

    const signaled = Boolean(decision.send && proposal);
    const finalScoreForRecord = decision.finalScore;
    const skipReason = buildSkipReason({
        signaled,
        vetoed: decision.vetoed,
        bestScore: det.best.score,
        finalScore: finalScoreForRecord,
        entryThreshold,
        hadProposal: proposal != null,
        entryGate,
    });

    const marketSummary: DecisionRecord['marketSummary'] = {
        trend: det.state.trend,
        structure: det.state.structure,
        volatility: det.state.volatility,
        latest: det.state.latest,
        indicators: det.state.indicators,
        htf: det.state.htf,
        ltf: det.state.ltf,
        swings: det.state.swings,
        ...(det.state.dailyValueArea ? { dailyValueArea: det.state.dailyValueArea } : {}),
    };

    const record: DecisionRecord = {
        ts: new Date().toISOString(),
        symbol,
        interval,
        strategies: det.strategies,
        signals: det.signals,
        marketSummary,
        llmError,
        ...(operatorMarketEnvironmentRaw
            ? {
                operatorMarketEnvironment: operatorMarketEnvironmentRaw.slice(
                    0,
                    OPERATOR_ENV_MAX_RECORD_CHARS,
                ),
            }
            : {}),
        llmMinScoreGate: llmMinScore,
        entryThreshold,
        entryGateMode: entryGate,
        ...(proposalLevelsAudit ?? {}),
        decision: signaled ? 'signal_sent' : 'skipped',
        proposal: proposal ?? undefined,
        strategy: det.best.name,
        score: det.best.score,
        finalScore: finalScoreForRecord,
        llm: critique,
        llmSkippedReason:
            critique != null || llmError ? undefined : llmSkippedReason,
        skipReason,
    };

    return {
        state: det.state,
        signals: det.signals,
        strategies: det.strategies,
        best: det.best,
        critique,
        decision,
        proposal,
        record,
    };
}
