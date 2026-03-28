/**
 * Walk-forward backtest: replays historical OHLCV through the deterministic pipeline (no LLM).
 *
 * Env: BACKTEST_FIXTURE (required), BACKTEST_MODE=walk|last, BACKTEST_FORMAT=jsonl|json|csv,
 * BACKTEST_START_BAR (default 59), BACKTEST_PRIMARY_LIMIT / BACKTEST_HTF_LIMIT / BACKTEST_LTF_LIMIT,
 * BACKTEST_OUT (bar-level output file), BACKTEST_REPORT_OUT (optional — same end report JSON as stderr),
 * ENTRY_THRESHOLD, BACKTEST_PNL=1, BACKTEST_ENTRY_MODEL=close|next_open,
 * BACKTEST_FEE_BPS (default 5 per side; 0 emits feeNote warning),
 * BACKTEST_SLIP_ENTRY_BPS / BACKTEST_SLIP_EXIT_BPS / BACKTEST_SLIP_STOP_EXTRA_BPS,
 * BACKTEST_BAR_CONTEST=stop_first|tp_first|split (intra-bar SL vs TP when both touch),
 * BACKTEST_PRIMARY_INTERVAL (legacy array), resampleFrom fixture: baseInterval + primaryInterval.
 * BACKTEST_MFE=1 — track bars where best strategy score matches BACKTEST_MFE_SCORE (default 6); see
 *   src/backtest/scorePathStats.ts. Per-bar tracks: set BACKTEST_MFE_OUT to write full JSON. Summary is in the
 *   end-of-run report (stderr + optional BACKTEST_REPORT_OUT).
 * BACKTEST_PCT_TP / BACKTEST_PCT_SL — e.g. 2 and 1 for +2% TP and −1% SL from signal close (see
 *   src/backtest/fixedPctPath.ts). When set, also sets `TARGET_TP_PCT` / `TARGET_SL_PCT` for the walk-forward
 *   bar stream so `TradeProposal` matches live bot fixed-% mode (unless those env vars are already set).
 *   Bar cohort: BACKTEST_PCT_SCORE / BACKTEST_PCT_MIN_SCORE, or same as MFE when unset.
 *   Optional BACKTEST_PCT_OUT for full track JSON. CLI: `--tp-pct=` / `--sl-pct=` (both required if used).
 * BACKTEST_POSITION_SIZE — notional per trade. When set, report includes `pnlWithPositionSize.byScenario` only
 *   (do not sum scenarios — different exit models). Fixed-% dollars use the same fee/slip as proposal sim.
 *
 * @see src/backtest/walkForward.ts — fixture shapes (explicit HTF/LTF, resampleFrom, or legacy array).
 */
import 'dotenv/config';
import fs from 'node:fs';
import {
    buildSkipReason,
    evaluateDeterministic,
    parseEntryGateMode,
} from '../src/pipeline/evaluateBundle';
import { expandFixture, sliceBundleAtPrimaryIndex } from '../src/backtest/walkForward';
import { simulatePnl, type BarContestMode, type EntryModel } from '../src/backtest/simulatePnl';
import {
    favoredDirectionFromBest,
    traceMfeUntilInvalidation,
    type ScorePathTrackRow,
} from '../src/backtest/scorePathStats';
import {
    summarizeFixedPctTracks,
    traceFixedPctTpSl,
    type FixedPctTrackRow,
} from '../src/backtest/fixedPctPath';
import type { StrategyResult, TradeProposal } from '../src/types/pipeline';

type BarRow = {
    barIndex: number;
    openTime: number;
    closeTime: number;
    strategy: string;
    score: number;
    finalScore: number;
    send: boolean;
    skipReason?: string;
    vetoed: boolean;
    strategies: StrategyResult[];
    proposal?: TradeProposal;
};

function parseEntryModel(v: string | undefined): EntryModel {
    const x = (v ?? 'close').trim().toLowerCase();
    return x === 'next_open' ? 'next_open' : 'close';
}

/** Per-side bps; round-trip in sim is `2 * value / 10000`. Default 5 when env unset. */
function parseFeeBps(): { value: number; warning?: string } {
    const raw = process.env.BACKTEST_FEE_BPS;
    if (raw === undefined || String(raw).trim() === '') {
        return { value: 5 };
    }
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || n < 0) {
        return {
            value: 5,
            warning: 'Invalid BACKTEST_FEE_BPS; using default 5 (basis points per side; see simulatePnl).',
        };
    }
    if (n === 0) {
        return {
            value: 0,
            warning: 'BACKTEST_FEE_BPS=0: no per-side fee drag modeled on simulated returns.',
        };
    }
    return { value: n };
}

function parseNonNegBps(env: string | undefined): number {
    const n = Number(String(env ?? '').trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseBarContest(v: string | undefined): BarContestMode {
    const x = (v ?? 'stop_first').trim().toLowerCase().replace(/-/g, '_');
    if (x === 'tp_first') return 'tp_first';
    if (x === 'split') return 'split';
    return 'stop_first';
}

function csvEscape(s: string): string {
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function summarizeMfe(tracks: ScorePathTrackRow[]): {
    count: number;
    byOutcome: Record<string, number>;
    avgMaxFavorablePctWhenInvalidated?: number;
    avgBarsToInvalidationWhenHit?: number;
    /** Bars that had a finite invalidation and either hit it or ran out of history first. */
    invalidationContest?: {
        invalidated: number;
        /** Invalidation never touched before primary series ended. */
        survivedToSeriesEnd: number;
        total: number;
        /** `survivedToSeriesEnd / invalidated` (null if `invalidated === 0`). */
        ratioSurvivedPerInvalidated: number | null;
        /** `100 * survivedToSeriesEnd / total` (share that did not invalidate). */
        survivedPctOfTotal: number;
        /** `100 * invalidated / total`. */
        invalidatedPctOfTotal: number;
    };
    noInvalidationLevel?: number;
    noForwardData?: number;
} {
    const byOutcome: Record<string, number> = {};
    for (const t of tracks) {
        byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
    }
    const invalidated = tracks.filter((t) => t.outcome === 'invalidated');
    const avgMaxFavorablePctWhenInvalidated =
        invalidated.length > 0
            ? Number(
                (
                    invalidated.reduce((s, t) => s + t.maxFavorableMovePct, 0) / invalidated.length
                ).toFixed(4),
            )
            : undefined;
    const avgBarsToInvalidationWhenHit =
        invalidated.length > 0
            ? Number(
                (
                    invalidated.reduce(
                        (s, t) => s + (t.barsAfterSignalToInvalidation ?? 0),
                        0,
                    ) / invalidated.length
                ).toFixed(2),
            )
            : undefined;

    const invInvalidated = invalidated.length;
    const invSurvived = tracks.filter((t) => t.outcome === 'series_end_before_invalidation').length;
    const invTotal = invInvalidated + invSurvived;
    const noInvalidationLevel = tracks.filter((t) => t.outcome === 'no_invalidation_level').length;
    const noForwardData = tracks.filter((t) => t.outcome === 'no_forward_data').length;

    const invalidationContest =
        invTotal > 0
            ? {
                invalidated: invInvalidated,
                survivedToSeriesEnd: invSurvived,
                total: invTotal,
                ratioSurvivedPerInvalidated:
                    invInvalidated > 0
                        ? Number((invSurvived / invInvalidated).toFixed(4))
                        : null,
                survivedPctOfTotal: Number(((100 * invSurvived) / invTotal).toFixed(2)),
                invalidatedPctOfTotal: Number(((100 * invInvalidated) / invTotal).toFixed(2)),
            }
            : undefined;

    return {
        count: tracks.length,
        byOutcome,
        ...(avgMaxFavorablePctWhenInvalidated !== undefined
            ? { avgMaxFavorablePctWhenInvalidated }
            : {}),
        ...(avgBarsToInvalidationWhenHit !== undefined
            ? { avgBarsToInvalidationWhenHit }
            : {}),
        ...(invalidationContest ? { invalidationContest } : {}),
        ...(noInvalidationLevel > 0 ? { noInvalidationLevel } : {}),
        ...(noForwardData > 0 ? { noForwardData } : {}),
    };
}

/** Human-readable signed P&L; `$` is a label only — units match `BACKTEST_POSITION_SIZE`. */
function formatPortfolioChange(amount: number): string {
    const sign = amount >= 0 ? '+' : '-';
    return `${sign}${Math.abs(amount).toFixed(2)}$`;
}

function rowToCsv(r: BarRow): string {
    const stratList = r.strategies.map((x) => `${x.name}:${x.score}`).join(';');
    return [
        r.barIndex,
        r.openTime,
        r.closeTime,
        csvEscape(r.strategy),
        r.score,
        r.finalScore,
        r.send ? 1 : 0,
        csvEscape(r.skipReason ?? ''),
        r.vetoed ? 1 : 0,
        csvEscape(stratList),
    ].join(',');
}

async function main() {
    const path = process.env.BACKTEST_FIXTURE || '';
    if (!path) {
        console.log(
            'Set BACKTEST_FIXTURE to a JSON file. Walk-forward runs by default from bar 60 to end.',
        );
        console.log(
            'Example: BACKTEST_FIXTURE=./fixtures/btc.json BACKTEST_FORMAT=jsonl npx tsx scripts/backtest.ts',
        );
        process.exit(0);
    }

    const raw = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const hist = expandFixture(parsed, (msg) => console.warn(`[backtest] ${msg}`));

    const mode = (process.env.BACKTEST_MODE ?? 'walk').trim().toLowerCase();
    const primaryLimit = Number(process.env.BACKTEST_PRIMARY_LIMIT ?? 200);
    const htfLimit = Number(process.env.BACKTEST_HTF_LIMIT ?? 120);
    const ltfLimit = Number(process.env.BACKTEST_LTF_LIMIT ?? 200);
    const entryThreshold = Number(process.env.ENTRY_THRESHOLD ?? 4.5);
    const startBar = Number(process.env.BACKTEST_START_BAR ?? 59);
    const fmt = (process.env.BACKTEST_FORMAT ?? 'jsonl').trim().toLowerCase();

    const n = hist.primary.length;
    if (n < 60) {
        console.error('Need at least 60 primary bars.');
        process.exit(1);
    }

    const rawPositionSize = (process.env.BACKTEST_POSITION_SIZE ?? '').trim();
    const positionSizeParsed = rawPositionSize === '' ? NaN : Number(rawPositionSize);
    const positionSizeUse =
        Number.isFinite(positionSizeParsed) && positionSizeParsed > 0
            ? positionSizeParsed
            : undefined;

    const feeParsed = parseFeeBps();
    const slipEntryBps = parseNonNegBps(process.env.BACKTEST_SLIP_ENTRY_BPS);
    const slipExitBps = parseNonNegBps(process.env.BACKTEST_SLIP_EXIT_BPS);
    const slipStopExtraBps = parseNonNegBps(process.env.BACKTEST_SLIP_STOP_EXTRA_BPS);
    const barContest = parseBarContest(process.env.BACKTEST_BAR_CONTEST);

    const limits = { primary: primaryLimit, htf: htfLimit, ltf: ltfLimit };
    const rows: BarRow[] = [];
    const pnlSignals: Array<{ barIndex: number; proposal: TradeProposal }> = [];
    const mfeEnabled = /^(1|true|yes)$/i.test((process.env.BACKTEST_MFE ?? '').trim());
    const mfeTargetScore = Number(process.env.BACKTEST_MFE_SCORE ?? 6);
    const mfeMatchMin = /^(1|true|yes)$/i.test((process.env.BACKTEST_MFE_MIN_SCORE ?? '').trim());
    const mfeTracks: ScorePathTrackRow[] = [];

    const rawPctTp = (process.env.BACKTEST_PCT_TP ?? '').trim();
    const rawPctSl = (process.env.BACKTEST_PCT_SL ?? '').trim();
    const pctTp = rawPctTp === '' ? NaN : Number(rawPctTp);
    const pctSl = rawPctSl === '' ? NaN : Number(rawPctSl);
    const pctEnabled =
        Number.isFinite(pctTp) &&
        Number.isFinite(pctSl) &&
        pctTp > 0 &&
        pctSl > 0;
    let pctScoreTarget = mfeTargetScore;
    if (
        process.env.BACKTEST_PCT_SCORE !== undefined &&
        String(process.env.BACKTEST_PCT_SCORE).trim() !== ''
    ) {
        const v = Number(process.env.BACKTEST_PCT_SCORE);
        if (Number.isFinite(v)) pctScoreTarget = v;
    }
    const pctMatchMin =
        process.env.BACKTEST_PCT_MIN_SCORE !== undefined &&
            String(process.env.BACKTEST_PCT_MIN_SCORE).trim() !== ''
            ? /^(1|true|yes)$/i.test(String(process.env.BACKTEST_PCT_MIN_SCORE).trim())
            : mfeMatchMin;
    const pctTracks: FixedPctTrackRow[] = [];

    const getCliPositive = (flagPrefix: string): number | undefined => {
        const arg = process.argv.find((a) => a.startsWith(`${flagPrefix}=`));
        if (!arg) return undefined;
        const v = Number(arg.split('=')[1]);
        return Number.isFinite(v) && v > 0 ? v : undefined;
    };
    const cliTpPct = getCliPositive('--tp-pct');
    const cliSlPct = getCliPositive('--sl-pct');
    const targetTpEnv = (process.env.TARGET_TP_PCT ?? '').trim();
    const targetSlEnv = (process.env.TARGET_SL_PCT ?? '').trim();
    const haveTargetPair =
        targetTpEnv !== '' &&
        targetSlEnv !== '' &&
        Number(targetTpEnv) > 0 &&
        Number(targetSlEnv) > 0;
    if (cliTpPct !== undefined && cliSlPct !== undefined) {
        process.env.TARGET_TP_PCT = String(cliTpPct);
        process.env.TARGET_SL_PCT = String(cliSlPct);
    } else if (cliTpPct !== undefined || cliSlPct !== undefined) {
        console.warn(
            '[backtest] Partial --tp-pct / --sl-pct ignored; provide both to mirror live fixed-% proposals.',
        );
    } else if (!haveTargetPair && pctEnabled) {
        process.env.TARGET_TP_PCT = rawPctTp;
        process.env.TARGET_SL_PCT = rawPctSl;
    }

    const runRange = (from: number, to: number) => {
        for (let i = from; i <= to; i += 1) {
            const bundle = sliceBundleAtPrimaryIndex(hist, i, limits);
            if (bundle.primary.length < 60) continue;

            const ev = evaluateDeterministic(bundle, entryThreshold);
            const bar = hist.primary[i]!;
            const signaled = Boolean(ev.decision.send && ev.proposal);
            const finalScoreForSkip = ev.decision.finalScore;
            const skipReason = buildSkipReason({
                signaled,
                vetoed: ev.decision.vetoed,
                bestScore: ev.best.score,
                finalScore: finalScoreForSkip,
                entryThreshold,
                hadProposal: ev.proposal != null,
                entryGate: parseEntryGateMode(),
            });

            const row: BarRow = {
                barIndex: i,
                openTime: bar.openTime,
                closeTime: bar.closeTime,
                strategy: ev.best.name,
                score: ev.best.score,
                finalScore: ev.decision.finalScore,
                send: signaled,
                skipReason,
                vetoed: ev.decision.vetoed,
                strategies: ev.strategies,
                ...(ev.proposal ? { proposal: ev.proposal } : {}),
            };
            rows.push(row);
            if (signaled && ev.proposal) {
                pnlSignals.push({ barIndex: i, proposal: ev.proposal });
            }

            if (mfeEnabled) {
                const scoreOk = mfeMatchMin
                    ? ev.best.score >= mfeTargetScore
                    : ev.best.score === mfeTargetScore;
                if (scoreOk) {
                    const dir = favoredDirectionFromBest(ev.best, ev.signals);
                    if (dir) {
                        const refPrice = bar.close;
                        mfeTracks.push(
                            traceMfeUntilInvalidation({
                                primary: hist.primary,
                                signalBarIndex: i,
                                refPrice,
                                direction: dir,
                                invalidation: ev.best.invalidation,
                                meta: {
                                    barIndex: i,
                                    openTime: bar.openTime,
                                    closeTime: bar.closeTime,
                                    strategy: ev.best.name,
                                    score: ev.best.score,
                                    context: ev.best.context,
                                },
                                ...(ev.signals.sfp.valid
                                    ? { sfpType: ev.signals.sfp.type }
                                    : {}),
                            }),
                        );
                    }
                }
            }

            if (pctEnabled) {
                const pctScoreOk = pctMatchMin
                    ? ev.best.score >= pctScoreTarget
                    : ev.best.score === pctScoreTarget;
                if (pctScoreOk) {
                    const dir = favoredDirectionFromBest(ev.best, ev.signals);
                    if (dir) {
                        const refPrice = bar.close;
                        pctTracks.push(
                            traceFixedPctTpSl({
                                primary: hist.primary,
                                signalBarIndex: i,
                                refPrice,
                                direction: dir,
                                tpPct: pctTp,
                                slPct: pctSl,
                                barContest,
                                meta: {
                                    barIndex: i,
                                    openTime: bar.openTime,
                                    closeTime: bar.closeTime,
                                    strategy: ev.best.name,
                                    score: ev.best.score,
                                    context: ev.best.context,
                                },
                            }),
                        );
                    }
                }
            }
        }
    };

    if (mode === 'last') {
        runRange(n - 1, n - 1);
    } else {
        const from = Math.min(Math.max(0, startBar), n - 1);
        runRange(from, n - 1);
    }

    const outPath = (process.env.BACKTEST_OUT || '').trim();
    if (outPath) {
        fs.writeFileSync(outPath, '');
    }
    const sink = outPath
        ? (s: string) => fs.appendFileSync(outPath, s)
        : (s: string) => process.stdout.write(s);

    if (fmt === 'csv') {
        sink(
            'barIndex,openTime,closeTime,strategy,score,finalScore,send,skipReason,vetoed,strategies\n',
        );
        for (const r of rows) {
            sink(`${rowToCsv(r)}\n`);
        }
    } else if (fmt === 'json') {
        sink(
            JSON.stringify(
                {
                    symbol: hist.symbol,
                    rows,
                    legacySingleTimeframe: hist.legacySingleTimeframe,
                },
                null,
                2,
            ),
        );
        sink('\n');
    } else {
        for (const r of rows) {
            sink(`${JSON.stringify(r)}\n`);
        }
    }

    const mfeOutPath = (process.env.BACKTEST_MFE_OUT || '').trim();
    if (mfeEnabled && mfeOutPath) {
        const mfeFullPayload = {
            targetScore: mfeTargetScore,
            matchMode: mfeMatchMin ? 'min' : 'exact',
            assumptions: 'see src/backtest/scorePathStats.ts',
            tracks: mfeTracks,
            summary:
                mfeTracks.length > 0
                    ? summarizeMfe(mfeTracks)
                    : { count: 0, byOutcome: {} as Record<string, number> },
        };
        fs.writeFileSync(mfeOutPath, `${JSON.stringify(mfeFullPayload, null, 2)}\n`);
    }

    const pctOutPath = (process.env.BACKTEST_PCT_OUT || '').trim();
    const execCostModel = {
        feeBps: feeParsed.value,
        entrySlipBps: slipEntryBps,
        exitSlipBps: slipExitBps,
    };
    const pctSummaryOpts =
        positionSizeUse !== undefined
            ? { positionSize: positionSizeUse, primary: hist.primary, costs: execCostModel }
            : undefined;

    const pctSummaryRaw = pctEnabled
        ? summarizeFixedPctTracks(pctTracks, pctSummaryOpts)
        : null;
    const pctSummary =
        pctSummaryRaw !== null
            ? (() => {
                const s = pctSummaryRaw;
                if (typeof s.totalPnl === 'number') {
                    return {
                        ...s,
                        portfolioChange: formatPortfolioChange(s.totalPnl),
                        profitable: s.totalPnl >= 0,
                    };
                }
                return s;
            })()
            : false;

    if (pctEnabled && pctOutPath) {
        const pctPayload = {
            tpPct: pctTp,
            slPct: pctSl,
            scoreTarget: pctScoreTarget,
            matchMode: pctMatchMin ? 'min' : 'exact',
            barContest,
            feeBps: feeParsed.value,
            slipEntryBps: slipEntryBps,
            slipExitBps: slipExitBps,
            assumptions: 'see src/backtest/fixedPctPath.ts',
            tracks: pctTracks,
            summary: pctSummary,
        };
        fs.writeFileSync(pctOutPath, `${JSON.stringify(pctPayload, null, 2)}\n`);
    }

    const pnlEnabled = /^(1|true|yes)$/i.test((process.env.BACKTEST_PNL ?? '').trim());
    let pnlReport: Record<string, unknown> | undefined;
    let proposalSimTotalPnl: number | undefined;
    if (pnlEnabled) {
        const entryModel = parseEntryModel(process.env.BACKTEST_ENTRY_MODEL);
        const sim = simulatePnl({
            primary: hist.primary,
            signals: pnlSignals,
            entryModel,
            feeBps: feeParsed.value,
            entrySlipBps: slipEntryBps,
            exitSlipBps: slipExitBps,
            stopExtraSlipBps: slipStopExtraBps,
            barContest,
        });
        if (positionSizeUse !== undefined) {
            proposalSimTotalPnl = Number(
                sim.trades
                    .reduce((s, t) => s + positionSizeUse * (t.pnlPctApprox / 100), 0)
                    .toFixed(2),
            );
        }
        pnlReport = {
            entryModel,
            feeBps: feeParsed.value,
            entrySlipBps: slipEntryBps,
            exitSlipBps: slipExitBps,
            stopExtraSlipBps: slipStopExtraBps,
            barContest,
            assumptions: 'see src/backtest/simulatePnl.ts header',
            closedTp1: sim.closedTp1,
            closedStop: sim.closedStop,
            openAtEnd: sim.openAtEnd,
            dualSplitTrades: sim.dualSplitTrades,
            sumPnlPctApprox: Number(sim.sumPnlPctApprox.toFixed(4)),
            tradeCount: sim.trades.length,
            ...(feeParsed.warning ? { feeNote: feeParsed.warning } : {}),
            ...(positionSizeUse !== undefined
                ? (() => {
                    const tp = proposalSimTotalPnl ?? 0;
                    return {
                        positionSize: positionSizeUse,
                        totalPnl: tp,
                        portfolioChange: formatPortfolioChange(tp),
                        profitable: tp >= 0,
                    };
                })()
                : {}),
        };
    }

    const mfeSummary =
        mfeEnabled &&
        (mfeTracks.length > 0
            ? summarizeMfe(mfeTracks)
            : { count: 0, byOutcome: {} as Record<string, number> });

    const pnlByScenario: Record<string, number> = {};
    if (positionSizeUse !== undefined && pctSummary && typeof pctSummary === 'object') {
        const t = pctSummary as { totalPnl?: number };
        if (typeof t.totalPnl === 'number') {
            pnlByScenario.fixedPctExits = t.totalPnl;
        }
    }
    if (positionSizeUse !== undefined && proposalSimTotalPnl !== undefined) {
        pnlByScenario.proposalSimulation = proposalSimTotalPnl;
    }

    const endReport: Record<string, unknown> = {
        generatedAt: new Date().toISOString(),
        run: {
            symbol: hist.symbol,
            primaryInterval: hist.primaryInterval,
            htfInterval: hist.htf.interval,
            ltfInterval: hist.ltf.interval,
            primaryBars: n,
            mode,
            format: fmt,
            startBar: mode === 'last' ? n - 1 : Math.min(Math.max(0, startBar), n - 1),
            entryThreshold,
            rowCount: rows.length,
            legacySingleTimeframe: hist.legacySingleTimeframe,
            signalsSent: rows.filter((r) => r.send).length,
            ...(positionSizeUse !== undefined ? { positionSize: positionSizeUse } : {}),
            ...(feeParsed.warning ? { feeNote: feeParsed.warning } : {}),
        },
        ...(mfeEnabled
            ? {
                mfe: {
                    targetScore: mfeTargetScore,
                    matchMode: mfeMatchMin ? 'min' : 'exact',
                    trackCount: mfeTracks.length,
                    summary: mfeSummary,
                },
            }
            : {}),
        ...(pnlReport ? { pnl: pnlReport } : {}),
        ...(pctEnabled
            ? {
                fixedPctExits: {
                    tpPct: pctTp,
                    slPct: pctSl,
                    scoreTarget: pctScoreTarget,
                    matchMode: pctMatchMin ? 'min' : 'exact',
                    trackCount: pctTracks.length,
                    barContest,
                    feeBps: feeParsed.value,
                    slipEntryBps: slipEntryBps,
                    slipExitBps: slipExitBps,
                    summary: pctSummary,
                },
            }
            : {}),
        ...(positionSizeUse !== undefined && Object.keys(pnlByScenario).length > 0
            ? {
                pnlWithPositionSize: {
                    positionSize: positionSizeUse,
                    feeBps: feeParsed.value,
                    entrySlipBps: slipEntryBps,
                    exitSlipBps: slipExitBps,
                    stopExtraSlipBps: slipStopExtraBps,
                    barContest,
                    byScenario: pnlByScenario,
                    aggregateNote:
                        'Each scenario is a separate exit model on overlapping signal cohorts — do not sum `byScenario` values as one portfolio path. Use `pnl.totalPnl` for proposal simulation only, or `fixedPctExits.summary.totalPnl` for fixed-% only.',
                    unitsNote:
                        'P&L uses the same units as positionSize (e.g. USDT notional); $ in nested portfolioChange fields is display only.',
                    fixedPctNote:
                        'fixed-% dollars include the same fee and entry/exit slippage bps as proposal sim; `series_end` is MTM at last primary close.',
                },
            }
            : {}),
    };

    const reportText = `${JSON.stringify(endReport, null, 2)}\n`;
    const reportBanner = '\n======== BACKTEST REPORT ========\n';
    process.stderr.write(reportBanner);
    process.stderr.write(reportText);

    const reportOut = (process.env.BACKTEST_REPORT_OUT || '').trim();
    if (reportOut) {
        fs.writeFileSync(reportOut, reportText);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
