import type { LlmCritique, StrategyResult } from '../types/pipeline';

const ADJ_MIN = Number(process.env.SCORE_ADJUST_MIN ?? -3);
const ADJ_MAX = Number(process.env.SCORE_ADJUST_MAX ?? 1);

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

export function decide(input: {
    best: StrategyResult;
    critique: LlmCritique | null;
    entryThreshold: number;
}): { finalScore: number; send: boolean; vetoed: boolean } {
    if (input.critique?.veto) {
        return {
            finalScore: input.best.score,
            send: false,
            vetoed: true,
        };
    }
    const rawAdj = input.critique?.score_adjustment ?? 0;
    const adj = clamp(
        Number.isFinite(rawAdj) ? rawAdj : 0,
        Number.isFinite(ADJ_MIN) ? ADJ_MIN : -3,
        Number.isFinite(ADJ_MAX) ? ADJ_MAX : 1,
    );
    const finalScore = input.best.score + adj;
    const send =
        finalScore >= input.entryThreshold &&
        input.best.score > 0 &&
        !input.critique?.veto;

    return { finalScore, send, vetoed: false };
}
