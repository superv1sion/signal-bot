import type { MarketState, SignalBundle, StrategyResult } from '../types/pipeline';

/** Pullback / add-on placeholder — low default score until rules are defined. */
export function addToWinnerStrategy(
    state: MarketState,
    signals: SignalBundle,
): StrategyResult {
    let score = 0;
    if (signals.trendAligned && state.volatility === 'mid') score += 1;
    if (state.indicators.rsi > 40 && state.indicators.rsi < 60) score += 1;
    return {
        name: 'add_to_winner',
        score,
        context: 'continuation',
        invalidation: state.latest.close,
    };
}
