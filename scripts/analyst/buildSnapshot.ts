/**
 * Orchestrator for the BTC analyst digest: fetches candles + derivatives/on-chain/news, computes
 * exactly the indicators specified in config/analyst-ta.json (no auto-picked anchors/ranges/MAs —
 * see that file's comment), and writes one JSON snapshot to ./data/analyst-snapshot-latest.json.
 *
 * Each moving average carries its own `interval` (e.g. 50 SMA on 4h, 200 EMA on 1d) — MAs are
 * fetched and computed independently per distinct interval, not forced onto one global timeframe.
 * VWAP anchors, volume profile, and the general-context indicators (RSI/ATR/Bollinger) use
 * `primaryInterval`.
 *
 * Also appends a compact {price, levels} entry to ./data/analyst-snapshot-history.jsonl each run
 * (bounded to ANALYST_HISTORY_MAX_ENTRIES) and uses it to compute `proximityWatch`: % distance from
 * price to every level, support/resistance role, and whether price has moved closer to it since the
 * lookback entry (ANALYST_PROXIMITY_LOOKBACK_ENTRIES runs back, default 6) — real elapsed time, not
 * assumed hourly spacing. This is proximity data only, not a trade signal — no entry/stop/target.
 * `price.changeAbs`/`changePercent` compare to the single most recent prior run (not the N-back
 * proximity lookback). Every other displayed value (MAs, BMSB, VWAP, volume-profile POC/VAH/VAL,
 * fib levels, context RSI/ATR/Bollinger, derivatives funding/OI) similarly carries a `previous*`
 * field from that same most-recent prior run, for computing up/down/unchanged arrows.
 *
 * Usage: npm run analyst-snapshot
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import type { KlinesParams } from 'binance/lib/types/shared';
import { fetchOHLCVForwardPages, fetchOHLCVLastN, type Candlestick } from '../../src/binanceClient';
import { intervalToMilliseconds } from '../../src/intervalMs';
import {
    calculateSMA,
    calculateEMA,
    calculateAnchoredVWAP,
    calculateVolumeProfile,
    calculateFibRetracement,
    calculateRSI,
    calculateATR,
    calculateBollingerBands,
} from '../../src/indicators';
import { fetchDerivativesSnapshot } from './fetchDerivatives';
import { fetchOnchainSnapshot } from './fetchOnchain';
import { fetchNewsHeadlines } from './fetchNews';

type TaConfig = {
    symbol: string;
    primaryInterval: string;
    vwapAnchors: Array<{ label: string; anchorTime: string }>;
    movingAverages: Array<{ type: 'SMA' | 'EMA'; period: number; interval: string }>;
    bmsb?: { enabled: boolean; smaPeriod: number; emaPeriod: number; interval: string };
    volumeProfile: { label: string; startTime: string; endTime: string | null };
    fibLevels: Array<{ label: string; high: number; low: number }>;
    keyLevels: Array<{ label: string; price: number }>;
};

const CONFIG_PATH = process.env.ANALYST_CONFIG || './config/analyst-ta.json';
const OUTPUT_PATH = process.env.ANALYST_SNAPSHOT_OUTPUT || './data/analyst-snapshot-latest.json';
const HISTORY_PATH = process.env.ANALYST_SNAPSHOT_HISTORY || './data/analyst-snapshot-history.jsonl';
const HISTORY_MAX_ENTRIES = Number(process.env.ANALYST_HISTORY_MAX_ENTRIES || 500);
const PROXIMITY_LOOKBACK_ENTRIES = Number(process.env.ANALYST_PROXIMITY_LOOKBACK_ENTRIES || 6);
const MA_LOOKBACK_BUFFER_BARS = 20;

type LevelValue = { label: string; value: number };
type HistoryContext = { rsi14: number; atr14: number; bollingerUpper: number; bollingerMiddle: number; bollingerLower: number };
type HistoryDerivatives = { fundingRate: number; openInterest: number };
type HistoryEntry = {
    generatedAt: string;
    price: number;
    levels: LevelValue[];
    context?: HistoryContext;
    derivatives?: HistoryDerivatives;
};

function readHistory(): HistoryEntry[] {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    return fs
        .readFileSync(HISTORY_PATH, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as HistoryEntry);
}

function appendHistory(entry: HistoryEntry): void {
    const dir = path.dirname(HISTORY_PATH);
    if (dir && dir !== '.') {
        fs.mkdirSync(dir, { recursive: true });
    }
    const existing = readHistory();
    const trimmed = [...existing, entry].slice(-HISTORY_MAX_ENTRIES);
    fs.writeFileSync(HISTORY_PATH, trimmed.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/** Flattens every price-comparable level (MAs, BMSB lower/upper, VWAPs, volume-profile POC/VAH/VAL, fib levels, key levels) into one list. */
function buildLevelList(
    movingAverages: Array<{ type: string; period: number; interval: string; latest: number }>,
    bmsb: { lower: number; upper: number; smaPeriod: number; emaPeriod: number; interval: string } | null,
    vwaps: Array<{ label: string; latest: number }>,
    volumeProfile: { poc: number; vah: number; val: number },
    fibLevels: Array<{ label: string; levels: Array<{ ratio: number; price: number }> }>,
    keyLevels: Array<{ label: string; price: number }>
): LevelValue[] {
    const levels: LevelValue[] = [];
    for (const ma of movingAverages) {
        levels.push({ label: `${ma.type}${ma.period} (${ma.interval})`, value: ma.latest });
    }
    if (bmsb) {
        levels.push({ label: `BMSB lower (${bmsb.smaPeriod}W SMA/${bmsb.emaPeriod}W EMA)`, value: bmsb.lower });
        levels.push({ label: `BMSB upper (${bmsb.smaPeriod}W SMA/${bmsb.emaPeriod}W EMA)`, value: bmsb.upper });
    }
    for (const vwap of vwaps) {
        levels.push({ label: `VWAP (${vwap.label})`, value: vwap.latest });
    }
    levels.push({ label: 'Volume Profile POC', value: volumeProfile.poc });
    levels.push({ label: 'Volume Profile VAH', value: volumeProfile.vah });
    levels.push({ label: 'Volume Profile VAL', value: volumeProfile.val });
    for (const fib of fibLevels) {
        for (const l of fib.levels) {
            levels.push({ label: `${fib.label} fib ${l.ratio}`, value: l.price });
        }
    }
    for (const key of keyLevels) {
        levels.push({ label: key.label, value: key.price });
    }
    return levels;
}

type ProximityLevel = LevelValue & {
    distancePercent: number;
    role: 'support' | 'resistance';
    trend: 'approaching' | 'moving_away' | 'flat' | 'insufficient_history';
};

/**
 * For each level, computes % distance from current price, whether it acts as support/resistance
 * given price's current side, and whether price has moved closer to it since the lookback entry
 * (real elapsed time — history isn't guaranteed to be exactly hourly).
 */
function computeProximityWatch(
    price: number,
    currentLevels: LevelValue[],
    history: HistoryEntry[]
): { lookbackGeneratedAt: string | null; lookbackGeneratedAtHuman: string | null; levels: ProximityLevel[] } {
    const lookbackEntry =
        history.length >= 1 ? history[Math.max(0, history.length - PROXIMITY_LOOKBACK_ENTRIES)] : null;

    const levels: ProximityLevel[] = currentLevels.map((level) => {
        const distancePercent = ((level.value - price) / price) * 100;
        const role: 'support' | 'resistance' = distancePercent >= 0 ? 'resistance' : 'support';

        let trend: ProximityLevel['trend'] = 'insufficient_history';
        if (lookbackEntry) {
            const priorLevel = lookbackEntry.levels.find((l) => l.label === level.label);
            if (priorLevel) {
                const priorDistancePercent = ((priorLevel.value - lookbackEntry.price) / lookbackEntry.price) * 100;
                const delta = Math.abs(distancePercent) - Math.abs(priorDistancePercent);
                if (delta < -0.05) trend = 'approaching';
                else if (delta > 0.05) trend = 'moving_away';
                else trend = 'flat';
            }
        }

        return { ...level, distancePercent, role, trend };
    });

    return {
        lookbackGeneratedAt: lookbackEntry?.generatedAt ?? null,
        lookbackGeneratedAtHuman: lookbackEntry ? formatHumanDateTime(lookbackEntry.generatedAt) : null,
        levels,
    };
}

function loadConfig(): TaConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`TA config not found at ${CONFIG_PATH}`);
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as TaConfig;
    for (const ma of config.movingAverages) {
        if (!ma.interval) {
            throw new Error(
                `Moving average ${ma.type}${ma.period} in config/analyst-ta.json is missing "interval" ` +
                    `(e.g. "4h", "1d") — every MA must specify which timeframe it's computed on.`
            );
        }
    }
    return config;
}

/** e.g. "Oct 6, 2025 UTC" for a midnight timestamp, "Aug 22, 2026, 14:33 UTC" otherwise. */
function formatHumanDateTime(iso: string): string {
    const d = new Date(iso);
    const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    if (hours === 0 && minutes === 0) {
        return `${datePart} UTC`;
    }
    const timePart = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    return `${datePart}, ${timePart} UTC`;
}

/** Index of the last candle whose openTime is <= targetMs. Throws if none exists (anchor predates fetched history). */
function findCandleIndexAtOrBefore(candles: Candlestick[], targetMs: number, label: string): number {
    let idx = -1;
    for (let i = 0; i < candles.length; i += 1) {
        if (candles[i].openTime <= targetMs) idx = i;
        else break;
    }
    if (idx === -1) {
        throw new Error(
            `Anchor "${label}" (${new Date(targetMs).toISOString()}) is before the earliest fetched candle ` +
                `(${new Date(candles[0]?.openTime ?? 0).toISOString()}) — widen the fetch window or fix the config.`
        );
    }
    return idx;
}

async function main() {
    const config = loadConfig();
    const symbol = config.symbol;
    const interval = config.primaryInterval as KlinesParams['interval'];
    const intervalMs = intervalToMilliseconds(config.primaryInterval);

    const anchorTimes = config.vwapAnchors.map((a) => Date.parse(a.anchorTime));
    const volumeProfileStart = Date.parse(config.volumeProfile.startTime);

    const now = Date.now();
    const earliestNeeded = Math.min(volumeProfileStart, ...anchorTimes, now);
    const fetchStart = earliestNeeded - MA_LOOKBACK_BUFFER_BARS * intervalMs;

    console.log('Fetching primary candles…', {
        symbol,
        interval: config.primaryInterval,
        from: new Date(fetchStart).toISOString(),
        to: new Date(now).toISOString(),
    });

    const candles = await fetchOHLCVForwardPages({
        symbol,
        interval,
        startTime: fetchStart,
        endTime: now,
        delayMs: 100,
    });

    if (candles.length === 0) {
        throw new Error(`No candles returned for ${symbol} ${config.primaryInterval}`);
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    // Moving averages — each fetched/computed on its own configured interval, not primaryInterval.
    // Per-interval required bar count, folding in the BMSB interval/periods if enabled so it can
    // reuse the same fetch instead of a separate request.
    const neededPeriodsByInterval = new Map<string, number>();
    for (const ma of config.movingAverages) {
        neededPeriodsByInterval.set(ma.interval, Math.max(neededPeriodsByInterval.get(ma.interval) ?? 0, ma.period));
    }
    if (config.bmsb?.enabled) {
        const bmsbMaxPeriod = Math.max(config.bmsb.smaPeriod, config.bmsb.emaPeriod);
        neededPeriodsByInterval.set(
            config.bmsb.interval,
            Math.max(neededPeriodsByInterval.get(config.bmsb.interval) ?? 0, bmsbMaxPeriod)
        );
    }

    const maCandlesByInterval = new Map<string, Candlestick[]>();
    for (const [maInterval, maxPeriodForInterval] of neededPeriodsByInterval) {
        console.log('Fetching MA candles…', { symbol, interval: maInterval, count: maxPeriodForInterval + MA_LOOKBACK_BUFFER_BARS });
        const maCandles = await fetchOHLCVLastN({
            symbol,
            interval: maInterval as KlinesParams['interval'],
            count: maxPeriodForInterval + MA_LOOKBACK_BUFFER_BARS,
            endTime: now,
            delayMs: 100,
        });
        maCandlesByInterval.set(maInterval, maCandles);
    }

    const movingAverages = config.movingAverages.map((ma) => {
        const maCandles = maCandlesByInterval.get(ma.interval)!;
        const maCloses = maCandles.map((c) => c.close);
        if (maCloses.length < ma.period) {
            throw new Error(
                `Only fetched ${maCloses.length} ${ma.interval} candles but ${ma.type}${ma.period} needs ${ma.period} — widen history.`
            );
        }
        const series = ma.type === 'SMA' ? calculateSMA(maCloses, ma.period) : calculateEMA(maCloses, ma.period);
        return { type: ma.type, period: ma.period, interval: ma.interval, latest: series[series.length - 1] };
    });

    // Bull Market Support Band: 20-week SMA + 21-week EMA (standard definition), plotted as a band.
    let bmsb: { smaPeriod: number; emaPeriod: number; interval: string; smaLatest: number; emaLatest: number; lower: number; upper: number } | null = null;
    if (config.bmsb?.enabled) {
        const bmsbCandles = maCandlesByInterval.get(config.bmsb.interval)!;
        const bmsbCloses = bmsbCandles.map((c) => c.close);
        const smaSeries = calculateSMA(bmsbCloses, config.bmsb.smaPeriod);
        const emaSeries = calculateEMA(bmsbCloses, config.bmsb.emaPeriod);
        const smaLatest = smaSeries[smaSeries.length - 1];
        const emaLatest = emaSeries[emaSeries.length - 1];
        bmsb = {
            smaPeriod: config.bmsb.smaPeriod,
            emaPeriod: config.bmsb.emaPeriod,
            interval: config.bmsb.interval,
            smaLatest,
            emaLatest,
            lower: Math.min(smaLatest, emaLatest),
            upper: Math.max(smaLatest, emaLatest),
        };
    }

    // Anchored VWAPs (on primaryInterval)
    const vwaps = config.vwapAnchors.map((anchor) => {
        const anchorMs = Date.parse(anchor.anchorTime);
        const anchorIndex = findCandleIndexAtOrBefore(candles, anchorMs, anchor.label);
        const series = calculateAnchoredVWAP(candles, anchorIndex);
        return {
            label: anchor.label,
            anchorTime: anchor.anchorTime,
            anchorTimeHuman: formatHumanDateTime(anchor.anchorTime),
            anchorCandleOpenTime: candles[anchorIndex].openTime,
            interval: config.primaryInterval,
            latest: series[series.length - 1],
        };
    });

    // Volume profile (on primaryInterval)
    const vpStartMs = Date.parse(config.volumeProfile.startTime);
    const vpEndMs = config.volumeProfile.endTime ? Date.parse(config.volumeProfile.endTime) : now;
    const vpStartIdx = findCandleIndexAtOrBefore(candles, vpStartMs, config.volumeProfile.label);
    const vpCandles = candles.filter((c) => c.openTime >= candles[vpStartIdx].openTime && c.openTime <= vpEndMs);
    const volumeProfile = {
        label: config.volumeProfile.label,
        startTime: config.volumeProfile.startTime,
        startTimeHuman: formatHumanDateTime(config.volumeProfile.startTime),
        endTime: config.volumeProfile.endTime,
        endTimeHuman: config.volumeProfile.endTime ? formatHumanDateTime(config.volumeProfile.endTime) : 'now',
        interval: config.primaryInterval,
        candleCount: vpCandles.length,
        ...calculateVolumeProfile(vpCandles, 24),
    };

    // Fib levels
    const fibLevels = config.fibLevels.map((fib) => ({
        label: fib.label,
        high: fib.high,
        low: fib.low,
        levels: calculateFibRetracement(fib.high, fib.low),
    }));

    // General-context indicators (not config-driven, just informative) — on primaryInterval
    const rsiSeries = calculateRSI(closes, 14);
    const atrSeries = calculateATR(highs, lows, closes, 14);
    const bollinger = calculateBollingerBands(closes, 20, 2);

    console.log('Fetching derivatives, on-chain, and news…');
    const [derivatives, onchain, news] = await Promise.all([
        fetchDerivativesSnapshot(symbol).catch((e) => ({ error: String(e) })),
        fetchOnchainSnapshot().catch((e) => ({ error: String(e) })),
        fetchNewsHeadlines(5).catch((e) => ({ error: String(e) })),
    ]);

    const latestCandle = candles[candles.length - 1];

    const currentLevels = buildLevelList(movingAverages, bmsb, vwaps, volumeProfile, fibLevels, config.keyLevels);
    const history = readHistory();
    const proximityWatch = computeProximityWatch(latestCandle.close, currentLevels, history);

    // vs the single most recent prior run (not proximityWatch's N-back lookback).
    const previousEntry = history.length > 0 ? history[history.length - 1] : null;
    const previousClose = previousEntry?.price ?? null;
    const changeAbs = previousClose !== null ? latestCandle.close - previousClose : null;
    const changePercent = previousClose !== null ? (changeAbs! / previousClose) * 100 : null;

    // Per-value "previous run" lookups, so the digest can show ↑/↓/= per level (mirrors price.changeAbs above).
    const findPrevLevelValue = (label: string): number | null =>
        previousEntry?.levels.find((l) => l.label === label)?.value ?? null;
    const previousContext = previousEntry?.context ?? null;
    const previousDerivatives = previousEntry?.derivatives ?? null;

    const movingAveragesWithPrev = movingAverages.map((ma) => ({
        ...ma,
        previous: findPrevLevelValue(`${ma.type}${ma.period} (${ma.interval})`),
    }));
    const bmsbWithPrev = bmsb
        ? {
              ...bmsb,
              previousLower: findPrevLevelValue(`BMSB lower (${bmsb.smaPeriod}W SMA/${bmsb.emaPeriod}W EMA)`),
              previousUpper: findPrevLevelValue(`BMSB upper (${bmsb.smaPeriod}W SMA/${bmsb.emaPeriod}W EMA)`),
          }
        : null;
    const vwapsWithPrev = vwaps.map((v) => ({
        ...v,
        previous: findPrevLevelValue(`VWAP (${v.label})`),
    }));
    const volumeProfileWithPrev = {
        ...volumeProfile,
        previousPoc: findPrevLevelValue('Volume Profile POC'),
        previousVah: findPrevLevelValue('Volume Profile VAH'),
        previousVal: findPrevLevelValue('Volume Profile VAL'),
    };
    const fibLevelsWithPrev = fibLevels.map((fib) => ({
        ...fib,
        levels: fib.levels.map((l) => ({
            ...l,
            previous: findPrevLevelValue(`${fib.label} fib ${l.ratio}`),
        })),
    }));

    const contextForHistory: HistoryContext = {
        rsi14: rsiSeries[rsiSeries.length - 1],
        atr14: atrSeries[atrSeries.length - 1],
        bollingerUpper: bollinger.upper[bollinger.upper.length - 1],
        bollingerMiddle: bollinger.middle[bollinger.middle.length - 1],
        bollingerLower: bollinger.lower[bollinger.lower.length - 1],
    };
    const derivativesForHistory: HistoryDerivatives | undefined =
        'fundingRate' in derivatives && 'openInterest' in derivatives
            ? { fundingRate: derivatives.fundingRate, openInterest: derivatives.openInterest }
            : undefined;
    const derivativesWithPrev =
        'fundingRate' in derivatives && 'openInterest' in derivatives
            ? {
                  ...derivatives,
                  previousFundingRate: previousDerivatives?.fundingRate ?? null,
                  previousOpenInterest: previousDerivatives?.openInterest ?? null,
              }
            : derivatives;

    const generatedAtIso = new Date().toISOString();
    const snapshot = {
        generatedAt: generatedAtIso,
        generatedAtHuman: formatHumanDateTime(generatedAtIso),
        symbol,
        primaryInterval: config.primaryInterval,
        price: {
            close: latestCandle.close,
            high24hApprox: Math.max(...candles.slice(-24).map((c) => c.high)),
            low24hApprox: Math.min(...candles.slice(-24).map((c) => c.low)),
            candleOpenTime: latestCandle.openTime,
            previousClose,
            previousGeneratedAt: previousEntry?.generatedAt ?? null,
            previousGeneratedAtHuman: previousEntry ? formatHumanDateTime(previousEntry.generatedAt) : null,
            changeAbs,
            changePercent,
        },
        keyLevels: config.keyLevels,
        movingAverages: movingAveragesWithPrev,
        bmsb: bmsbWithPrev,
        vwaps: vwapsWithPrev,
        volumeProfile: volumeProfileWithPrev,
        fibLevels: fibLevelsWithPrev,
        proximityWatch,
        context: {
            interval: config.primaryInterval,
            rsi14: contextForHistory.rsi14,
            previousRsi14: previousContext?.rsi14 ?? null,
            atr14: contextForHistory.atr14,
            previousAtr14: previousContext?.atr14 ?? null,
            bollinger20: {
                upper: contextForHistory.bollingerUpper,
                middle: contextForHistory.bollingerMiddle,
                lower: contextForHistory.bollingerLower,
            },
            previousBollinger20: previousContext
                ? { upper: previousContext.bollingerUpper, middle: previousContext.bollingerMiddle, lower: previousContext.bollingerLower }
                : null,
        },
        derivatives: derivativesWithPrev,
        onchain,
        news,
    };

    const dir = path.dirname(OUTPUT_PATH);
    if (dir && dir !== '.') {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    appendHistory({
        generatedAt: generatedAtIso,
        price: latestCandle.close,
        levels: currentLevels,
        context: contextForHistory,
        derivatives: derivativesForHistory,
    });

    console.log(JSON.stringify(snapshot, null, 2));
    console.log(`\nWrote snapshot to ${OUTPUT_PATH}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
