import type { MarketState, SignalBundle, StrategyResult } from '../types/pipeline';
import { sfpStrategy } from './sfpReversal';
import { trendFollowStrategy } from './trendFollow';
import { consolidationRangeStrategy } from './consolidationRange';

const strategies: Array<
    (state: MarketState, signals: SignalBundle) => StrategyResult
> = [sfpStrategy, trendFollowStrategy, consolidationRangeStrategy];

export function runStrategies(
    state: MarketState,
    signals: SignalBundle,
): { best: StrategyResult; all: StrategyResult[] } {
    const all = strategies.map((fn) => fn(state, signals));
    const sorted = [...all].sort((a, b) => b.score - a.score);
    const best = sorted[0] ?? { name: 'none', score: 0, context: 'none' };
    return { best, all };
}
