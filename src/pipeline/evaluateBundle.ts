import { buildMarketState } from '../features/buildMarketState';
import { buildSignals } from '../signals';
import { runStrategies } from '../strategies/aggregate';
import { decide, type EntryGateMode } from '../decision/decide';
import {
    applyFixedPctTargetsIfConfigured,
    buildProposalFromStrategy,
} from '../execution/buildProposal';
import type { MarketBundle } from '../data/marketData';
import type {
    LlmCritique,
    MarketState,
    ProposalLevelsMode,
    SignalBundle,
    StrategyResult,
    TradeProposal,
} from '../types/pipeline';

export type ProposalLevelsAudit = {
    levelsMode: ProposalLevelsMode;
    targetTpPct: number;
    targetSlPct: number;
};

export type DeterministicLayerResult = {
    state: MarketState;
    signals: SignalBundle;
    strategies: StrategyResult[];
    best: StrategyResult;
};

export function runDeterministicLayer(bundle: MarketBundle): DeterministicLayerResult {
    const state = buildMarketState(bundle);
    const volumes = bundle.primary.map((c) => c.volume);
    const signals = buildSignals(state, volumes, bundle.primary);
    const { best, all } = runStrategies(state, signals);
    return { state, signals, strategies: all, best };
}

export function parseEntryGateMode(): EntryGateMode {
    const m = (process.env.ENTRY_GATE_MODE ?? 'final').trim().toLowerCase();
    return m === 'best' || m === 'strategy' || m === 'raw' ? 'best' : 'final';
}

export function finalizeWithCritique(
    det: DeterministicLayerResult,
    critique: LlmCritique | null,
    entryThreshold: number,
    entryGate: EntryGateMode = parseEntryGateMode(),
): {
    decision: { finalScore: number; send: boolean; vetoed: boolean };
    proposal: TradeProposal | null;
    proposalLevelsAudit?: ProposalLevelsAudit;
} {
    let decision = decide({ best: det.best, critique, entryThreshold, entryGate });
    let proposal: TradeProposal | null = null;
    let proposalLevelsAudit: ProposalLevelsAudit | undefined;
    if (decision.send) {
        proposal = buildProposalFromStrategy(det.best, det.state, det.signals);
        if (!proposal) {
            decision = { ...decision, send: false };
        } else {
            const { proposal: p, fixedPct } = applyFixedPctTargetsIfConfigured(proposal);
            proposal = p;
            if (fixedPct) {
                proposalLevelsAudit = {
                    levelsMode: 'fixed_pct',
                    targetTpPct: fixedPct.targetTpPct,
                    targetSlPct: fixedPct.targetSlPct,
                };
            }
        }
    }
    return { decision, proposal, proposalLevelsAudit };
}

/** Rules-only path: no LLM adjustment or veto. */
export function evaluateDeterministic(
    bundle: MarketBundle,
    entryThreshold = Number(process.env.ENTRY_THRESHOLD ?? 5),
): DeterministicLayerResult & {
    decision: { finalScore: number; send: boolean; vetoed: boolean };
    proposal: TradeProposal | null;
} {
    const det = runDeterministicLayer(bundle);
    const { decision, proposal } = finalizeWithCritique(det, null, entryThreshold);
    return { ...det, decision, proposal };
}

export function buildSkipReason(params: {
    signaled: boolean;
    vetoed: boolean;
    bestScore: number;
    finalScore: number;
    entryThreshold: number;
    hadProposal: boolean;
    entryGate?: EntryGateMode;
}): string | undefined {
    if (params.signaled) return undefined;
    if (params.vetoed) return 'llm_veto';
    if (params.bestScore <= 0) return 'no_strategy_score';
    const gateScore =
        params.entryGate === 'best' ? params.bestScore : params.finalScore;
    if (gateScore < params.entryThreshold) return 'below_entry_threshold';
    if (!params.hadProposal) return 'no_actionable_proposal';
    return 'skipped';
}
