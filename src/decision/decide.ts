import type { LlmCritique, StrategyResult } from '../types/pipeline';

const ADJ_MIN = Number(process.env.SCORE_ADJUST_MIN ?? -3);
const ADJ_MAX = Number(process.env.SCORE_ADJUST_MAX ?? 1);

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

export type EntryGateMode = 'final' | 'best';

export function decide(input: {
    best: StrategyResult;
    critique: LlmCritique | null;
    entryThreshold: number;
    /** `final` (default): send if best.score + LLM adjustment ≥ threshold. `best`: ignore adjustment for the gate (veto still applies). */
    entryGate?: EntryGateMode;
}): { finalScore: number; send: boolean; vetoed: boolean } {
    const rawAdj = input.critique?.score_adjustment ?? 0;
    const adj = clamp(
        Number.isFinite(rawAdj) ? rawAdj : 0,
        Number.isFinite(ADJ_MIN) ? ADJ_MIN : -3,
        Number.isFinite(ADJ_MAX) ? ADJ_MAX : 1,
    );
    const finalScore = input.best.score + adj;

    if (input.critique?.veto) {
        return { finalScore, send: false, vetoed: true };
    }

    const gateScore = input.entryGate === 'best' ? input.best.score : finalScore;
    const send =
        gateScore >= input.entryThreshold && input.best.score > 0;

    return { finalScore, send, vetoed: false };
}
