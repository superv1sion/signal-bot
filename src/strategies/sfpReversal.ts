import type { MarketState, SignalBundle, StrategyResult } from '../types/pipeline';

export function sfpStrategy(
    state: MarketState,
    signals: SignalBundle,
): StrategyResult {
    let score = 0;
    if (signals.sfp.valid) score += 3;
    if (signals.sfp.type === 'bearish' && state.trend === 'down') score += 2;
    if (signals.sfp.type === 'bullish' && state.trend === 'up') score += 2;
    if (signals.volumeSpike) score += 1;
    const invalidation =
        signals.sfp.valid && signals.sfp.sweptLevel != null
            ? signals.sfp.sweptLevel
            : signals.sfp.type === 'bearish'
              ? state.swings.swingHigh
              : state.swings.swingLow;
    return {
        name: 'sfp_reversal',
        score,
        context: 'reversal',
        invalidation: Number.isFinite(invalidation) ? invalidation : undefined,
    };
}
