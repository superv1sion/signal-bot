import type { MarketState, SignalBundle, SfpSignal } from '../types/pipeline';

function sma(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1] ?? 0;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

/** Placeholder: extend with real swing-failure detection. */
function detectSfpPlaceholder(state: MarketState): SfpSignal {
    const { structure, trend } = state;
    const bearishValid =
        (structure === 'LH' || structure === 'LL' || trend === 'down') &&
        state.indicators.rsi > 62;
    const bullishValid =
        (structure === 'HL' || structure === 'HH' || trend === 'up') &&
        state.indicators.rsi < 38;
    if (bearishValid) return { type: 'bearish', valid: true };
    if (bullishValid) return { type: 'bullish', valid: true };
    return { type: 'bearish', valid: false };
}

export function buildSignals(
    state: MarketState,
    primaryVolumes: number[],
): SignalBundle {
    const trendAligned =
        state.trend === state.htf.trend && state.trend !== 'flat';

    let volumeSpike = false;
    if (primaryVolumes.length >= 21) {
        const last = primaryVolumes[primaryVolumes.length - 1] ?? 0;
        const avg = sma(primaryVolumes.slice(0, -1), 20);
        volumeSpike = avg > 0 && last > avg * 1.8;
    }

    return {
        trendAligned,
        volumeSpike,
        sfp: detectSfpPlaceholder(state),
    };
}
