import type { MarketState, SignalBundle } from '../types/pipeline';
import { detectSfp, type SfpCandle } from './detectSfp';

function sma(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1] ?? 0;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

export function buildSignals(
    state: MarketState,
    primaryVolumes: number[],
    primaryCandles: ReadonlyArray<SfpCandle>,
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
        sfp: detectSfp(primaryCandles, state),
    };
}
