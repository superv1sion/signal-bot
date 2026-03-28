/**
 * Download Binance spot klines and write a JSON fixture for `npm run backtest` (primary + HTF + LTF).
 *
 * Public klines do not require API keys; optional BINANCE_BASE_URL for testnet.
 *
 * Env:
 *   FETCH_SYMBOL (default BTCUSDT)
 *   FETCH_PRIMARY_INTERVAL (default 5m)
 *   FETCH_OUTPUT (default ./fixtures/backtest-export.json)
 *   FETCH_BARS — primary candles to pull (default 3000, min 60)
 *   FETCH_END_MS — unix ms “as of” end (default now)
 *   FETCH_REQUEST_DELAY_MS — pause between requests (default 120)
 *   FETCH_HTF_LIMIT / FETCH_LTF_LIMIT — lookback used to extend HTF/LTF fetch (defaults 120 / 200)
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import type { KlinesParams } from 'binance/lib/types/shared';
import { fetchOHLCVForwardPages, fetchOHLCVLastN } from '../src/binanceClient';
import { mapToHigherInterval, mapToLowerInterval } from '../src/data/marketData';
import { intervalToMilliseconds } from '../src/intervalMs';

async function main() {
    const symbol = (process.env.FETCH_SYMBOL || 'BTCUSDT').trim().toUpperCase();
    const primaryInterval = (process.env.FETCH_PRIMARY_INTERVAL || '5m').trim();
    const outPath = (process.env.FETCH_OUTPUT || './fixtures/backtest-export.json').trim();
    const bars = Math.max(60, Number(process.env.FETCH_BARS || 3000));
    const endTime = process.env.FETCH_END_MS
        ? Number(process.env.FETCH_END_MS)
        : Date.now();
    const delayMs = Math.max(0, Number(process.env.FETCH_REQUEST_DELAY_MS ?? 120));
    const htfLimit = Number(process.env.FETCH_HTF_LIMIT ?? 120);
    const ltfLimit = Number(process.env.FETCH_LTF_LIMIT ?? 200);

    if (!Number.isFinite(endTime)) {
        throw new Error('FETCH_END_MS must be a number');
    }

    const iv = primaryInterval as KlinesParams['interval'];

    console.log('Fetching primary klines…', { symbol, interval: primaryInterval, bars, endTime });
    const primary = await fetchOHLCVLastN({
        symbol,
        interval: iv,
        count: bars,
        endTime,
        delayMs,
    });

    if (primary.length < 60) {
        throw new Error(`Got only ${primary.length} primary bars (need >= 60).`);
    }

    const tMin = primary[0]!.openTime;
    const tMax = primary[primary.length - 1]!.closeTime;
    const primaryMs = intervalToMilliseconds(primaryInterval);
    const spanMs = tMax - tMin + primaryMs;

    const htfInterval = mapToHigherInterval(primaryInterval);
    const ltfInterval = mapToLowerInterval(primaryInterval);
    const htfMs = intervalToMilliseconds(htfInterval);
    const ltfMs = intervalToMilliseconds(ltfInterval);

    const htfLookbackMs = Math.max(spanMs, htfLimit * 2 * htfMs);
    const ltfLookbackMs = Math.max(spanMs, ltfLimit * 2 * ltfMs);

    const htfStart = Math.max(0, tMin - htfLookbackMs);
    const ltfStart = Math.max(0, tMin - ltfLookbackMs);

    console.log('Fetching HTF…', { interval: htfInterval, from: htfStart, to: tMax });
    const htfCandles = await fetchOHLCVForwardPages({
        symbol,
        interval: htfInterval as KlinesParams['interval'],
        startTime: htfStart,
        endTime: tMax,
        delayMs,
    });

    console.log('Fetching LTF…', { interval: ltfInterval, from: ltfStart, to: tMax });
    const ltfCandles = await fetchOHLCVForwardPages({
        symbol,
        interval: ltfInterval as KlinesParams['interval'],
        startTime: ltfStart,
        endTime: tMax,
        delayMs,
    });

    const fixture = {
        symbol,
        primaryInterval,
        primary,
        htf: { interval: htfInterval, candles: htfCandles },
        ltf: { interval: ltfInterval, candles: ltfCandles },
    };

    const dir = path.dirname(outPath);
    if (dir && dir !== '.') {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);

    console.log('Wrote', outPath, {
        primary: primary.length,
        htf: htfCandles.length,
        ltf: ltfCandles.length,
    });
    console.log('Run: BACKTEST_FIXTURE=' + outPath + ' npm run backtest');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
