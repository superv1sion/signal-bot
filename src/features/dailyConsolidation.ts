import type { Candlestick } from '../binanceClient';
import type { DailyValueArea } from '../types/pipeline';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ParsedConsolidationStart =
    | { ok: true; startMs: number; isoDate: string }
    | { ok: false };

/** First included daily bar: Binance `1d` open at 00:00 UTC on that calendar date. */
export function parseConsolidationStartDate(raw: string): ParsedConsolidationStart {
    const s = raw.trim();
    const m = ISO_DATE.exec(s);
    if (!m) return { ok: false };
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false };
    const startMs = Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
    if (Number.isNaN(startMs)) return { ok: false };
    const utc = new Date(startMs);
    if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) {
        return { ok: false };
    }
    return { ok: true, startMs, isoDate: s };
}

export function readConsolidationStartFromEnv(): ParsedConsolidationStart {
    const raw = (process.env.CONSOLIDATION_START_DATE || '').trim();
    if (!raw) return { ok: false };
    return parseConsolidationStartDate(raw);
}

function isTruthyEnv(v: string | undefined): boolean {
    return /^(1|true|yes)$/i.test((v ?? '').trim());
}

/**
 * Daily candles from consolidation start through `endMs`, optionally excluding the still-forming day.
 */
export function filterDailyProfileCandles(
    candles: ReadonlyArray<Candlestick>,
    startMs: number,
    endMs: number,
    includeFormingDay: boolean,
): Candlestick[] {
    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    let rows = sorted.filter((c) => c.openTime >= startMs);
    if (!includeFormingDay) {
        rows = rows.filter((c) => c.closeTime <= endMs);
    }
    return rows;
}

export type ComputeValueAreaOptions = {
    valueAreaPct: number;
    consolidationStartDate: string;
    binCount?: number;
};

/**
 * Close-anchored volume profile: each bar's volume is placed in the bin containing `close`.
 * Expands from POC until valueAreaPct of total volume is captured (standard adjacent-bin rule).
 */
export function computeValueAreaFromDailyCandles(
    candles: ReadonlyArray<Candlestick>,
    options: ComputeValueAreaOptions,
): DailyValueArea | null {
    if (candles.length === 0) return null;

    const pct = Math.min(100, Math.max(50, options.valueAreaPct));
    const numBins = Math.max(
        8,
        Math.min(256, options.binCount ?? Math.min(128, Math.max(24, candles.length * 2))),
    );

    let minP = Infinity;
    let maxP = -Infinity;
    for (const c of candles) {
        minP = Math.min(minP, c.low, c.high, c.close);
        maxP = Math.max(maxP, c.low, c.high, c.close);
    }
    if (!Number.isFinite(minP) || !Number.isFinite(maxP)) return null;

    const range = maxP - minP;
    const binWidth = range > 0 ? range / numBins : 1;
    const vol = new Array<number>(numBins).fill(0);

    for (const c of candles) {
        let idx: number;
        if (range <= 0) {
            idx = 0;
        } else {
            const x = (c.close - minP) / binWidth;
            idx = Math.floor(x);
            if (idx < 0) idx = 0;
            if (idx >= numBins) idx = numBins - 1;
        }
        vol[idx] += c.volume;
    }

    const totalVol = vol.reduce((a, b) => a + b, 0);
    if (totalVol <= 0) return null;

    /** Bins that actually received volume — expansion only steps here (avoids biasing through empty bins). */
    type Hit = { binIdx: number; volume: number };
    const hits: Hit[] = [];
    for (let i = 0; i < numBins; i += 1) {
        const v = vol[i]!;
        if (v > 0) hits.push({ binIdx: i, volume: v });
    }
    if (hits.length === 0) return null;

    let pocHit = 0;
    for (let k = 1; k < hits.length; k += 1) {
        const v = hits[k]!.volume;
        const bestV = hits[pocHit]!.volume;
        if (v > bestV || (v === bestV && hits[k]!.binIdx < hits[pocHit]!.binIdx)) {
            pocHit = k;
        }
    }
    const pocIdx = hits[pocHit]!.binIdx;

    const targetVol = (totalVol * pct) / 100;
    let loHit = pocHit;
    let hiHit = pocHit;
    let acc = hits[pocHit]!.volume;

    while (acc < targetVol && (loHit > 0 || hiHit < hits.length - 1)) {
        const vBelow = loHit > 0 ? hits[loHit - 1]!.volume : -1;
        const vAbove = hiHit < hits.length - 1 ? hits[hiHit + 1]!.volume : -1;
        if (vBelow < 0 && vAbove < 0) break;

        if (vBelow < 0) {
            hiHit += 1;
            acc += hits[hiHit]!.volume;
        } else if (vAbove < 0) {
            loHit -= 1;
            acc += hits[loHit]!.volume;
        } else if (vAbove > vBelow) {
            hiHit += 1;
            acc += hits[hiHit]!.volume;
        } else if (vBelow > vAbove) {
            loHit -= 1;
            acc += hits[loHit]!.volume;
        } else {
            // Tie: add both adjacent levels so we do not walk through “empty” bin indices on one side only.
            if (loHit > 0) {
                loHit -= 1;
                acc += hits[loHit]!.volume;
            }
            if (acc < targetVol && hiHit < hits.length - 1) {
                hiHit += 1;
                acc += hits[hiHit]!.volume;
            }
        }
    }

    const loBin = hits[loHit]!.binIdx;
    const hiBin = hits[hiHit]!.binIdx;
    const val = minP + loBin * binWidth;
    const vah = minP + (hiBin + 1) * binWidth;
    const poc = minP + (pocIdx + 0.5) * binWidth;

    const first = candles[0]!;
    const last = candles[candles.length - 1]!;

    return {
        consolidationStartDate: options.consolidationStartDate,
        firstBarTime: first.openTime,
        lastBarTime: last.closeTime,
        poc,
        vah,
        val,
        valueAreaPct: pct,
        barCount: candles.length,
        note: 'OHLCV close-anchored volume profile; VA expands across bins with volume only (no empty-bin walk). POC/VAH/VAL are approximations.',
    };
}
