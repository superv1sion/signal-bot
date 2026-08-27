import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaperTradeOpenRecord } from './types';
import {
    PAPER_TP_SLICE,
    isScalingPaperTrade,
    processPaperTradeBar,
    resolveExit,
} from './paperTradeScaling';

function candle(
    time: number,
    o: number,
    high: number,
    low: number,
    close: number,
): { time: number; open: number; high: number; low: number; close: number; volume: number } {
    return { time, open: o, high, low, close, volume: 0 };
}

function scalingLong(): PaperTradeOpenRecord {
    return {
        id: 't1',
        symbol: 'BTCUSDT',
        interval: '1h',
        openedAt: 'x',
        signalBarOpenTime: 1000,
        direction: 'long',
        entry: 100,
        sl: 90,
        tp: 110,
        takeProfits: [110, 120, 130],
        remainingFraction: 1,
        activeTpIndex: 0,
        initialSl: 90,
    };
}

test('resolveExit: stop-first when both SL and TP touched', () => {
    const bar = candle(2000, 100, 115, 89, 100);
    const ex = resolveExit('long', bar, 90, 110);
    assert.equal(ex?.outcome, 'sl');
    assert.equal(ex?.exitPrice, 90);
});

test('legacy full exit when takeProfits missing', () => {
    const trade: PaperTradeOpenRecord = {
        id: 'L',
        symbol: 'X',
        interval: '1h',
        openedAt: 'x',
        signalBarOpenTime: 1000,
        direction: 'long',
        entry: 100,
        sl: 90,
        tp: 110,
    };
    assert.equal(isScalingPaperTrade(trade), false);
    const r = processPaperTradeBar(trade, candle(2000, 100, 115, 95, 112), false);
    assert.equal(r.closures.length, 1);
    assert.equal(r.closures[0]!.terminal, true);
    assert.equal(r.closures[0]!.outcome, 'tp');
    assert.equal(r.nextTrade, null);
});

test('scaling: first TP takes one third and moves stop to BE', () => {
    const trade = scalingLong();
    // Low must stay above entry (100) so the post-TP1 BE stop is not hit in the same bar.
    const r = processPaperTradeBar(trade, candle(2000, 100, 115, 100.5, 112), false);
    assert.equal(r.closures.length, 1);
    const c = r.closures[0]!;
    assert.equal(c.outcome, 'tp');
    assert.equal(c.terminal, false);
    assert.equal(c.positionFraction, PAPER_TP_SLICE);
    assert.equal(c.tpLeg, 1);
    assert.notEqual(r.nextTrade, null);
    assert.ok(r.nextTrade!.remainingFraction! - 2 / 3 < 1e-9);
    assert.equal(r.nextTrade!.sl, 100);
    assert.equal(r.nextTrade!.tp, 120);
    assert.equal(r.nextTrade!.activeTpIndex, 1);
});

test('scaling: same bar TP1 then break-even stop on remainder', () => {
    const trade = scalingLong();
    const r = processPaperTradeBar(trade, candle(2000, 100, 115, 100, 112), false);
    assert.equal(r.closures.length, 2);
    assert.equal(r.closures[0]!.outcome, 'tp');
    assert.equal(r.closures[0]!.terminal, false);
    assert.equal(r.closures[1]!.outcome, 'sl');
    assert.equal(r.closures[1]!.terminal, true);
    assert.ok(Math.abs(r.closures[1]!.positionFraction - 2 / 3) < 1e-9);
    assert.equal(r.closures[1]!.exitPrice, 100);
    assert.equal(r.nextTrade, null);
});

test('scaling: TP1 and TP2 same bar when BE not touched', () => {
    const trade = scalingLong();
    const r = processPaperTradeBar(trade, candle(2000, 100, 125, 101, 122), false);
    assert.equal(r.closures.length, 2);
    assert.equal(r.closures[0]!.tpLeg, 1);
    assert.equal(r.closures[1]!.tpLeg, 2);
    assert.equal(r.closures[0]!.terminal, false);
    assert.equal(r.closures[1]!.terminal, false);
    assert.notEqual(r.nextTrade, null);
    assert.ok(r.nextTrade!.remainingFraction! - PAPER_TP_SLICE < 1e-9);
    assert.equal(r.nextTrade!.tp, 130);
});

test('on signal bar: no exits, advances lastEvaluatedBarOpenTime', () => {
    const trade = scalingLong();
    const bar = candle(1000, 100, 105, 99, 104);
    const r = processPaperTradeBar(trade, bar, true);
    assert.equal(r.closures.length, 0);
    assert.equal(r.nextTrade!.lastEvaluatedBarOpenTime, 1000);
});
