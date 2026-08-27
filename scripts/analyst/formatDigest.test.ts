import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDigest, renderBiasBlock, type Snapshot } from './formatDigest';
import type { BiasResult } from './generateBias';

const NOW = '2026-08-26T07:11:00.000Z';

function bias(overrides: Partial<BiasResult['report']> = {}): BiasResult {
    return {
        lookbackGeneratedAt: '2026-08-25T20:11:00.000Z',
        report: {
            timeframes: [
                { tf: '15m', bias: 'bearish', note: 'rejected SMA50' },
                { tf: '4h', bias: 'bullish', note: 'holding above SMA50' },
                { tf: '1d', bias: 'neutral', note: 'coiling under SMA200' },
            ],
            overall: { bias: 'mixed', note: 'macro intact, short-term rolling over' },
            ...overrides,
        },
    };
}

function snapshot(): Snapshot {
    return {
        generatedAt: NOW,
        generatedAtHuman: 'Aug 26, 2026, 07:11 UTC',
        price: { close: 78338.21, previousClose: 78800, previousGeneratedAt: '2026-08-25T23:11:00.000Z', changeAbs: -461.79 },
        keyLevels: [],
        movingAverages: [{ type: 'SMA', period: 50, interval: '4h', latest: 74408.82, previous: 74300 }],
        bmsb: null,
        vwaps: [],
        volumeProfile: {
            label: 'user range', startTimeHuman: 'Feb 4, 2026', endTimeHuman: 'Aug 26, 2026', interval: '1d',
            poc: 63540.77, vah: 74500.06, val: 61975.15, previousPoc: null, previousVah: null, previousVal: null,
        },
        fibLevels: [],
        proximityWatch: { lookbackGeneratedAt: null, lookbackGeneratedAtHuman: null, levels: [] },
        context: {
            interval: '1h', rsi14: 41.32, previousRsi14: 44.1, atr14: 507.57, previousAtr14: 500,
            bollinger20: { upper: 79491.82, middle: 78853.8, lower: 78215.78 }, previousBollinger20: null,
        },
        derivatives: { error: 'skipped' },
        news: { error: 'skipped' },
    };
}

test('renderBiasBlock marks each timeframe with a bull/bear/neutral glyph', () => {
    const block = renderBiasBlock(bias(), NOW);

    assert.match(block, /• 15m: 🐻 bearish — rejected SMA50/);
    assert.match(block, /• 4h: 🐂 bullish — holding above SMA50/);
    assert.match(block, /• 1d: ⚖️ neutral — coiling under SMA200/);
    assert.match(block, /• Overall: ⚖️ mixed — macro intact, short-term rolling over/);
});

test('renderBiasBlock headers the real elapsed window, not an assumed hourly one', () => {
    // 20:11 previous evening -> 07:11 now is 11h of real time across the overnight break.
    assert.match(renderBiasBlock(bias(), NOW), /🧠 <b>Bias<\/b> \(vs ~11h ago\)/);
});

test('renderBiasBlock escapes HTML in model-supplied notes', () => {
    const withMarkup = bias({
        timeframes: [{ tf: '1h', bias: 'bullish', note: 'watch <b>this</b> & that' }],
    });

    assert.match(renderBiasBlock(withMarkup, NOW), /watch &lt;b&gt;this&lt;\/b&gt; &amp; that/);
    assert.doesNotMatch(renderBiasBlock(withMarkup, NOW), /note: watch <b>this<\/b>/);
});

test('formatDigest omits the Bias section when no bias is supplied', () => {
    assert.doesNotMatch(formatDigest(snapshot()), /Bias/);
});

test('formatDigest appends the Bias section last when a bias is supplied', () => {
    const text = formatDigest(snapshot(), bias());

    assert.match(text, /🧠 <b>Bias<\/b>/);
    assert.ok(text.indexOf('👀 <b>Trade Setup Watch</b>') < text.indexOf('🧠 <b>Bias</b>'));
});
