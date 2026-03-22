/**
 * Backtest stub — replays stored OHLCV through the pipeline without live HTTP.
 * Export candles as JSON array of { openTime, open, high, low, close, volume }
 * and set BACKTEST_FIXTURE path to run.
 */
import 'dotenv/config';
import type { Candlestick } from '../src/binanceClient';
import { buildMarketState } from '../src/features/buildMarketState';
import { buildSignals } from '../src/signals';
import { runStrategies } from '../src/strategies/aggregate';
import type { MarketBundle } from '../src/data/marketData';
import fs from 'node:fs';

async function main() {
    const path = process.env.BACKTEST_FIXTURE || '';
    if (!path) {
        console.log(
            'Set BACKTEST_FIXTURE to a JSON file of Candlestick[] to run a dry pipeline slice.',
        );
        console.log(
            'Example: BACKTEST_FIXTURE=./fixtures/btc_5m.json npx tsx scripts/backtest.ts',
        );
        process.exit(0);
    }
    const raw = fs.readFileSync(path, 'utf8');
    const primary = JSON.parse(raw) as Candlestick[];
    if (!Array.isArray(primary) || primary.length < 60) {
        console.error('Fixture must be an array with at least 60 candles.');
        process.exit(1);
    }
    const bundle: MarketBundle = {
        symbol: 'BACKTEST',
        primaryInterval: '5m',
        primary,
        htf: { interval: '1h', candles: primary.slice(-120) },
        ltf: { interval: '1m', candles: primary.slice(-200) },
    };
    const state = buildMarketState(bundle);
    const volumes = bundle.primary.map((c) => c.volume);
    const signals = buildSignals(state, volumes);
    const { best, all } = runStrategies(state, signals);
    console.log(JSON.stringify({ state: { trend: state.trend, structure: state.structure }, signals, best, all }, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
