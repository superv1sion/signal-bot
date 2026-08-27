import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBiasPrompt, parseBiasResponse, parseHistoryLines, resolveClaudeBin } from './generateBias';

const VALID = {
    timeframes: [
        { tf: '15m', bias: 'bearish', note: 'rejected SMA50' },
        { tf: '1w', bias: 'bullish', note: 'above the band' },
    ],
    overall: { bias: 'mixed', note: 'macro intact, short-term rolling over' },
};

test('parseBiasResponse reads a clean JSON object', () => {
    const report = parseBiasResponse(JSON.stringify(VALID));
    assert.equal(report?.timeframes.length, 2);
    assert.equal(report?.timeframes[0]?.tf, '15m');
    assert.equal(report?.overall.bias, 'mixed');
});

test('parseBiasResponse unwraps a fenced code block', () => {
    const report = parseBiasResponse('Here you go:\n```json\n' + JSON.stringify(VALID) + '\n```\n');
    assert.equal(report?.overall.bias, 'mixed');
});

test('parseBiasResponse returns null for non-JSON output', () => {
    assert.equal(parseBiasResponse('I cannot help with that.'), null);
});

test('parseBiasResponse returns null when a bias value is off-schema', () => {
    const offSchema = { ...VALID, timeframes: [{ tf: '1h', bias: 'very bullish', note: 'x' }] };
    assert.equal(parseBiasResponse(JSON.stringify(offSchema)), null);
});

test('parseBiasResponse returns null when timeframes is empty', () => {
    assert.equal(parseBiasResponse(JSON.stringify({ ...VALID, timeframes: [] })), null);
});

test('buildBiasPrompt states the real elapsed window, not an assumed hourly one', () => {
    // The overnight gap: last evening run at 23:11, first morning run at 07:11.
    const prompt = buildBiasPrompt({
        digestText: '💰 <b>Price</b>\n• $78,338.21',
        generatedAt: '2026-08-26T07:11:00.000Z',
        history: [
            { generatedAt: '2026-08-25T20:11:00.000Z', price: 79000 },
            { generatedAt: '2026-08-25T23:11:00.000Z', price: 78800 },
        ],
    });

    assert.match(prompt, /~11h/);
    assert.match(prompt, /2026-08-25T20:11:00\.000Z/);
    assert.ok(prompt.includes('78,338.21') || prompt.includes('$78,338.21'));
});

test('buildBiasPrompt flags the largest gap between consecutive history entries', () => {
    const prompt = buildBiasPrompt({
        digestText: 'x',
        generatedAt: '2026-08-26T07:11:00.000Z',
        history: [
            { generatedAt: '2026-08-25T22:11:00.000Z', price: 79000 },
            { generatedAt: '2026-08-25T23:11:00.000Z', price: 78800 },
        ],
    });

    // 23:11 -> 07:11 is the overnight dead zone; the model must not read it as one hour.
    assert.match(prompt, /~8h/);
});

test('parseHistoryLines skips blank and malformed lines', () => {
    const text = [
        JSON.stringify({ generatedAt: '2026-08-25T20:11:00.000Z', price: 79000 }),
        '',
        '{ not json',
        JSON.stringify({ generatedAt: '2026-08-25T23:11:00.000Z', price: 78800 }),
    ].join('\n');

    const entries = parseHistoryLines(text);

    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.price, 78800);
});

test('parseHistoryLines drops entries with no usable timestamp', () => {
    const text = JSON.stringify({ price: 79000 }) + '\n' + JSON.stringify({ generatedAt: '', price: 1 });
    assert.deepEqual(parseHistoryLines(text), []);
});

test('resolveClaudeBin defaults to the bare command name', () => {
    delete process.env.ANALYST_BIAS_CLAUDE_BIN;
    assert.equal(resolveClaudeBin(), 'claude');
});

test('resolveClaudeBin honours an explicit path for PATH-less launchd runs', () => {
    process.env.ANALYST_BIAS_CLAUDE_BIN = '/Users/someone/.local/bin/claude';
    assert.equal(resolveClaudeBin(), '/Users/someone/.local/bin/claude');
    delete process.env.ANALYST_BIAS_CLAUDE_BIN;
});
