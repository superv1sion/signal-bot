import { randomUUID } from 'node:crypto';
import type { KlinesParams } from 'binance/lib/types/shared';
import { fetchOHLCVForwardPages } from '../../binanceClient';
import { candlestickToCandle } from '../../data/marketData';
import type { Candle, PipelineResult, TradeProposal } from '../../types/pipeline';
import type {
    PaperTradeClosedEvent,
    PaperTradeClosedLegSummary,
    PaperTradeOpenedEvent,
    PaperTradeOpenRecord,
    PaperTradesNotifyPlan,
    PaperTradeTickEvent,
} from './types';
import { aggregateClosedPaperStats } from './aggregateClosedPaperStats';
import type { PaperTradeRepository } from './paperTradeRepository';
import {
    type PaperScalingClosure,
    processPaperTradeBar,
} from './paperTradeScaling';

function dedupeCandlesByTime(candles: Candle[]): Candle[] {
    const m = new Map<number, Candle>();
    for (const c of candles) m.set(c.time, c);
    return [...m.keys()]
        .sort((a, b) => a - b)
        .map((t) => m.get(t)!);
}

/**
 * Candles to apply to this open leg: from signal bar (inclusive) or strictly after
 * `lastEvaluatedBarOpenTime`, through `latest` (inclusive). Fetches older klines via Binance when
 * the in-memory primary window does not reach back far enough.
 */
async function barsToReplayForTrade(params: {
    trade: PaperTradeOpenRecord;
    latest: Candle;
    primaryCandles: Candle[];
    symbol: string;
    interval: string;
}): Promise<Candle[]> {
    const { trade, latest, primaryCandles, symbol, interval } = params;
    const last = trade.lastEvaluatedBarOpenTime;
    /** First bar open time we must see: signal bar if never advanced, else strictly after last eval. */
    const rangeStartExclusiveAfter = last === undefined ? null : last;
    const afterLastOpen =
        last === undefined ? trade.signalBarOpenTime : last + 1;

    const inRange = (c: Candle) => {
        if (c.time > latest.time || c.time < trade.signalBarOpenTime) return false;
        if (rangeStartExclusiveAfter === null) {
            return c.time >= trade.signalBarOpenTime && c.time <= latest.time;
        }
        return c.time > rangeStartExclusiveAfter && c.time <= latest.time;
    };

    if (latest.time < trade.signalBarOpenTime) return [];

    const sortedPrimary = [...primaryCandles].sort((a, b) => a.time - b.time);
    const oldest = sortedPrimary[0];
    const iv = interval as KlinesParams['interval'];

    let extras: Candle[] = [];

    if (!oldest) {
        const stick = await fetchOHLCVForwardPages({
            symbol,
            interval: iv,
            startTime: afterLastOpen,
            endTime: latest.time,
        });
        extras = stick.map(candlestickToCandle);
    } else if (oldest.time > afterLastOpen) {
        const stick = await fetchOHLCVForwardPages({
            symbol,
            interval: iv,
            startTime: afterLastOpen,
            endTime: Math.min(latest.time, oldest.time - 1),
        });
        extras = stick.map(candlestickToCandle);
    }

    const merged = dedupeCandlesByTime([...extras, ...sortedPrimary]);
    return merged.filter(inRange).sort((a, b) => a.time - b.time);
}

function initialSlFor(trade: PaperTradeOpenRecord): number {
    return trade.initialSl ?? trade.sl;
}

function legSummaryFromClosure(params: {
    tradeId: string;
    symbol: string;
    interval: string;
    tradeAtBarOpen: PaperTradeOpenRecord;
    bar: Candle;
    cl: PaperScalingClosure;
    strategy?: string;
}): PaperTradeClosedLegSummary {
    const { tradeId, symbol, interval, tradeAtBarOpen, bar, cl, strategy } = params;
    const initialSl = initialSlFor(tradeAtBarOpen);
    const sl =
        cl.outcome === 'sl'
            ? cl.exitPrice
            : cl.tpLeg === 1
              ? initialSl
              : tradeAtBarOpen.entry;
    const tp = cl.outcome === 'sl' ? cl.activeTpAtEval : cl.exitPrice;
    return {
        tradeId,
        symbol,
        interval,
        direction: tradeAtBarOpen.direction,
        entry: tradeAtBarOpen.entry,
        sl,
        tp,
        ...(strategy !== undefined ? { strategy } : {}),
        outcome: cl.outcome,
        exitPrice: cl.exitPrice,
        exitBarOpenTime: bar.time,
        positionFraction: cl.positionFraction,
        ...(cl.tpLeg !== undefined ? { tpLeg: cl.tpLeg } : {}),
        initialSl,
        terminal: cl.terminal,
    };
}

async function applyTradeToBar(params: {
    repo: PaperTradeRepository;
    trade: PaperTradeOpenRecord;
    bar: Candle;
    symbol: string;
    interval: string;
    nowIso: string;
}): Promise<{
    summaries: PaperTradeClosedLegSummary[];
    nextTrade: PaperTradeOpenRecord | null;
}> {
    const { repo, trade, bar, symbol, interval, nowIso } = params;

    const onSignalBar = bar.time === trade.signalBarOpenTime;
    const proc = processPaperTradeBar(trade, bar, onSignalBar);
    const exitsEvaluated = !onSignalBar;
    const summaries: PaperTradeClosedLegSummary[] = [];
    const initialSl = initialSlFor(trade);

    for (const cl of proc.closures) {
        const summary = legSummaryFromClosure({
            tradeId: trade.id,
            symbol,
            interval,
            tradeAtBarOpen: trade,
            bar,
            cl,
            strategy: trade.strategy,
        });
        summaries.push(summary);

        const closed: PaperTradeClosedEvent = {
            ts: nowIso,
            kind: 'closed',
            tradeId: trade.id,
            symbol,
            interval,
            outcome: cl.outcome,
            exitBarOpenTime: bar.time,
            exitPrice: cl.exitPrice,
            direction: trade.direction,
            entry: trade.entry,
            sl: summary.sl,
            tp: summary.tp,
            ...(trade.strategy !== undefined ? { strategy: trade.strategy } : {}),
            positionFraction: cl.positionFraction,
            ...(cl.tpLeg !== undefined ? { tpLeg: cl.tpLeg } : {}),
            terminal: cl.terminal,
            initialSl,
        };
        await repo.appendEvent(closed);
    }

    if (proc.nextTrade !== null) {
        const tick: PaperTradeTickEvent = {
            ts: nowIso,
            kind: 'tick',
            tradeId: trade.id,
            symbol,
            interval,
            barOpenTime: bar.time,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            exitsEvaluated,
            hitSl: proc.tick.hitSl,
            hitTp: proc.tick.hitTp,
            stillOpen: proc.tick.stillOpen,
        };
        await repo.appendEvent(tick);
    }

    return { summaries, nextTrade: proc.nextTrade };
}

/**
 * Update open paper trades for this symbol/interval, optionally open a new trade from a signal.
 * Replays all primary candles since the last stored evaluation (or since the signal bar) through
 * `latest`, fetching history from Binance when the pipeline window is too short.
 */
export async function processPaperTradesAfterEvaluation(params: {
    repo: PaperTradeRepository;
    symbol: string;
    interval: string;
    result: PipelineResult;
}): Promise<PaperTradesNotifyPlan> {
    const { repo, symbol, interval, result } = params;

    const latest = result.state.latest;
    const primaryCandles = result.primaryCandles;
    let openList = await repo.loadOpenTrades();
    const ts = new Date().toISOString();
    const closures: PaperTradeClosedLegSummary[] = [];

    const nextOpen: PaperTradeOpenRecord[] = [];

    for (const trade of openList) {
        if (trade.symbol !== symbol || trade.interval !== interval) {
            nextOpen.push(trade);
            continue;
        }

        const bars = await barsToReplayForTrade({
            trade,
            latest,
            primaryCandles,
            symbol,
            interval,
        });

        let cur = trade;
        let closed = false;
        for (const bar of bars) {
            const step = await applyTradeToBar({
                repo,
                trade: cur,
                bar,
                symbol,
                interval,
                nowIso: ts,
            });
            closures.push(...step.summaries);
            if (step.nextTrade === null) {
                closed = true;
                break;
            }
            cur = step.nextTrade;
        }

        if (!closed) nextOpen.push(cur);
    }

    const closedStats =
        closures.length > 0
            ? aggregateClosedPaperStats(await repo.loadClosedEvents())
            : undefined;

    if (result.decision.send && result.proposal) {
        const p: TradeProposal = result.proposal;
        const dupIdx = nextOpen.findIndex(
            (t) => t.symbol === symbol && t.interval === interval && t.direction === p.direction,
        );

        if (dupIdx >= 0) {
            const dup = nextOpen[dupIdx]!;
            const prev =
                dup.lastNotifiedFinalScore ?? dup.finalScore ?? result.decision.finalScore;
            const cur = result.decision.finalScore;
            if (cur === prev) {
                await repo.saveOpenTrades(nextOpen);
                return { telegram: 'none', closures, closedStats };
            }
            const updated: PaperTradeOpenRecord = { ...dup, lastNotifiedFinalScore: cur };
            nextOpen[dupIdx] = updated;
            await repo.saveOpenTrades(nextOpen);
            return {
                telegram: 'confidence',
                openTrade: updated,
                previousNotifiedFinalScore: prev,
                closures,
                closedStats,
            };
        }

        const finalScore = result.decision.finalScore;
        const rec: PaperTradeOpenRecord = {
            id: randomUUID(),
            symbol,
            interval,
            openedAt: ts,
            signalBarOpenTime: latest.time,
            lastEvaluatedBarOpenTime: latest.time,
            direction: p.direction,
            entry: p.entry,
            sl: p.sl,
            tp: p.takeProfits[0]!,
            takeProfits: p.takeProfits,
            remainingFraction: 1,
            activeTpIndex: 0,
            initialSl: p.sl,
            strategy: result.best.name,
            finalScore,
            lastNotifiedFinalScore: finalScore,
            ...(result.critique
                ? {
                      llm: {
                          score_adjustment: result.critique.score_adjustment,
                          veto: result.critique.veto,
                          comment: result.critique.comment,
                          risk_flags: result.critique.risk_flags,
                      },
                  }
                : {}),
        };
        nextOpen.push(rec);
        const opened: PaperTradeOpenedEvent = { ts, kind: 'opened', trade: rec };
        await repo.appendEvent(opened);
        await repo.saveOpenTrades(nextOpen);
        return { telegram: 'full', closures, closedStats };
    }

    await repo.saveOpenTrades(nextOpen);
    return { telegram: 'none', closures, closedStats };
}
