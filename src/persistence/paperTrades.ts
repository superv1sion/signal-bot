import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Candle, LlmCritique, PipelineResult, TradeProposal } from '../types/pipeline';

const OPEN_FILE = 'paper_trades_open.json';
const EVENTS_FILE = 'paper_trade_events.jsonl';

export type PaperTradeOpenRecord = {
    id: string;
    symbol: string;
    interval: string;
    openedAt: string;
    signalBarOpenTime: number;
    direction: 'long' | 'short';
    entry: number;
    sl: number;
    tp: number;
    strategy?: string;
    finalScore?: number;
    /** Last `finalScore` we sent on Telegram for this open leg (full or confidence). */
    lastNotifiedFinalScore?: number;
    llm?: Pick<LlmCritique, 'score_adjustment' | 'veto' | 'comment' | 'risk_flags'>;
};

export type PaperTradesNotifyPlan =
    | { telegram: 'legacy' }
    | { telegram: 'none' }
    | { telegram: 'full' }
    | {
          telegram: 'confidence';
          openTrade: PaperTradeOpenRecord;
          previousNotifiedFinalScore: number;
      };

type PaperEventBase = { ts: string };

export type PaperTradeOpenedEvent = PaperEventBase & {
    kind: 'opened';
    trade: PaperTradeOpenRecord;
};

export type PaperTradeTickEvent = PaperEventBase & {
    kind: 'tick';
    tradeId: string;
    symbol: string;
    interval: string;
    barOpenTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    exitsEvaluated: boolean;
    hitSl: boolean;
    hitTp: boolean;
    stillOpen: boolean;
};

export type PaperTradeClosedEvent = PaperEventBase & {
    kind: 'closed';
    tradeId: string;
    symbol: string;
    interval: string;
    outcome: 'tp' | 'sl';
    exitBarOpenTime: number;
    exitPrice: number;
};

export type PaperTradeEvent = PaperTradeOpenedEvent | PaperTradeTickEvent | PaperTradeClosedEvent;

function openPath(baseDir: string): string {
    return path.join(baseDir.trim(), OPEN_FILE);
}

function eventsPath(baseDir: string): string {
    return path.join(baseDir.trim(), EVENTS_FILE);
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, filePath);
}

async function loadOpenTrades(baseDir: string): Promise<PaperTradeOpenRecord[]> {
    const p = openPath(baseDir);
    try {
        const raw = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed as PaperTradeOpenRecord[];
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return [];
        throw e;
    }
}

async function appendEvent(baseDir: string, event: PaperTradeEvent): Promise<void> {
    const p = eventsPath(baseDir);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, `${JSON.stringify(event)}\n`, 'utf8');
}

function barHitsLong(bar: Candle, sl: number, tp: number): { hitSl: boolean; hitTp: boolean } {
    return { hitSl: bar.low <= sl, hitTp: bar.high >= tp };
}

function barHitsShort(bar: Candle, sl: number, tp: number): { hitSl: boolean; hitTp: boolean } {
    return { hitSl: bar.high >= sl, hitTp: bar.low <= tp };
}

/** stop_first when both SL and TP touch same bar */
function resolveExit(
    direction: 'long' | 'short',
    bar: Candle,
    sl: number,
    tp: number,
): { outcome: 'tp' | 'sl'; exitPrice: number } | null {
    const { hitSl, hitTp } =
        direction === 'long' ? barHitsLong(bar, sl, tp) : barHitsShort(bar, sl, tp);
    if (hitSl && hitTp) {
        return { outcome: 'sl', exitPrice: sl };
    }
    if (hitSl) return { outcome: 'sl', exitPrice: sl };
    if (hitTp) return { outcome: 'tp', exitPrice: tp };
    return null;
}

/**
 * Update open paper trades for this symbol/interval, optionally open a new trade from a signal.
 */
export async function processPaperTradesAfterEvaluation(params: {
    baseDir: string;
    symbol: string;
    interval: string;
    result: PipelineResult;
}): Promise<PaperTradesNotifyPlan> {
    const { baseDir, symbol, interval, result } = params;
    const dir = baseDir.trim();
    if (!dir) return { telegram: 'legacy' };

    const latest = result.state.latest;
    let openList = await loadOpenTrades(dir);
    const ts = new Date().toISOString();

    const nextOpen: PaperTradeOpenRecord[] = [];

    for (const trade of openList) {
        if (trade.symbol !== symbol || trade.interval !== interval) {
            nextOpen.push(trade);
            continue;
        }

        const onSignalBar = latest.time === trade.signalBarOpenTime;
        const exitsEvaluated = !onSignalBar;
        let hitSl = false;
        let hitTp = false;
        let stillOpen = true;

        if (onSignalBar) {
            hitSl = false;
            hitTp = false;
        } else {
            const { hitSl: hs, hitTp: ht } =
                trade.direction === 'long'
                    ? barHitsLong(latest, trade.sl, trade.tp)
                    : barHitsShort(latest, trade.sl, trade.tp);
            hitSl = hs;
            hitTp = ht;
            const exit = resolveExit(trade.direction, latest, trade.sl, trade.tp);
            if (exit) {
                stillOpen = false;
                const closed: PaperTradeClosedEvent = {
                    ts,
                    kind: 'closed',
                    tradeId: trade.id,
                    symbol,
                    interval,
                    outcome: exit.outcome,
                    exitBarOpenTime: latest.time,
                    exitPrice: exit.exitPrice,
                };
                await appendEvent(dir, closed);
                // logStructured({
                //     level: 'info',
                //     msg: 'paper_trade_closed',
                //     tradeId: trade.id,
                //     symbol,
                //     interval,
                //     outcome: exit.outcome,
                //     exitBarOpenTime: latest.time,
                //     exitPrice: exit.exitPrice,
                // });
                continue;
            }
        }

        const tick: PaperTradeTickEvent = {
            ts,
            kind: 'tick',
            tradeId: trade.id,
            symbol,
            interval,
            barOpenTime: latest.time,
            open: latest.open,
            high: latest.high,
            low: latest.low,
            close: latest.close,
            exitsEvaluated,
            hitSl,
            hitTp,
            stillOpen,
        };
        await appendEvent(dir, tick);
        // logStructured({
        //     level: 'info',
        //     msg: 'paper_trade_tick',
        //     tradeId: trade.id,
        //     symbol,
        //     interval,
        //     barOpenTime: latest.time,
        //     ohlc: {
        //         o: latest.open,
        //         h: latest.high,
        //         l: latest.low,
        //         c: latest.close,
        //     },
        //     exitsEvaluated,
        //     hitSl,
        //     hitTp,
        //     stillOpen,
        // });

        if (stillOpen) nextOpen.push(trade);
    }

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
                await atomicWriteJson(openPath(dir), nextOpen);
                return { telegram: 'none' };
            }
            const updated: PaperTradeOpenRecord = { ...dup, lastNotifiedFinalScore: cur };
            nextOpen[dupIdx] = updated;
            await atomicWriteJson(openPath(dir), nextOpen);
            return {
                telegram: 'confidence',
                openTrade: updated,
                previousNotifiedFinalScore: prev,
            };
        }

        const finalScore = result.decision.finalScore;
        const rec: PaperTradeOpenRecord = {
            id: randomUUID(),
            symbol,
            interval,
            openedAt: ts,
            signalBarOpenTime: latest.time,
            direction: p.direction,
            entry: p.entry,
            sl: p.sl,
            tp: p.tp,
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
        await appendEvent(dir, opened);
        await atomicWriteJson(openPath(dir), nextOpen);
        return { telegram: 'full' };
    }

    await atomicWriteJson(openPath(dir), nextOpen);
    return { telegram: 'none' };
}
