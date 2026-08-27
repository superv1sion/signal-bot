import 'dotenv/config';
import {
    getDaemonPollMillisecondsFromChart,
    intervalToMilliseconds,
    mapToLowerInterval,
} from './src/data/marketData';
import { runEvaluation } from './src/pipeline/runEvaluation';
import { logInfo, logError } from './src/logger';
import { logDecisionRecord, logStructured } from './src/logging/structured';
import { getFirebaseAdminApp } from './src/persistence/firebase/adminApp';
import {
    paperTradesFirestoreCredentialsConfigured,
    paperTradesFirestoreEnabled,
    paperTradesFirestoreReady,
    paperTradeFirestoreCollectionNames,
    processPaperTradesAfterEvaluation,
    type PaperTradesNotifyPlan,
} from './src/persistence/paperTrades';
import { readFixedPctTargetsFromEnv } from './src/execution/buildProposal';
import { isPaused, sleepDaemonTick } from './src/execution/executionPause';
import {
    parseTelegramAdminUserIds,
    postOpenLegConfidenceToTelegram,
    postPaperTradeClosesToTelegram,
    postPipelineToTelegram,
    startTelegramControlLoop,
    startTelegramListener,
    type TradingTargetRef,
} from './src/telegramClient';

async function main() {
    const rawArgs = process.argv.slice(2);
    const positionalArgs = rawArgs.filter((a) => !a.startsWith('--'));
    const symbolArg = positionalArgs[0];
    const timeframeArg = positionalArgs[1];
    const symbol = (symbolArg || process.env.SYMBOL || 'BTCUSDT').toUpperCase();
    const interval = (timeframeArg || process.env.TIMEFRAME || '5m').toLowerCase();
    const tradingTarget: TradingTargetRef = { symbol, interval };

    const hasFlag = (name: string) => process.argv.some((a) => a === name || a.startsWith(`${name}=`));
    const getFlagNumber = (name: string, fallback: number) => {
        const arg = process.argv.find((a) => a.startsWith(`${name}=`));
        if (!arg) return fallback;
        const v = Number(arg.split('=')[1]);
        return Number.isFinite(v) ? v : fallback;
    };
    const getFlagOptionalPositive = (name: string): number | undefined => {
        const arg = process.argv.find((a) => a.startsWith(`${name}=`));
        if (!arg) return undefined;
        const v = Number(arg.split('=')[1]);
        return Number.isFinite(v) && v > 0 ? v : undefined;
    };
    const entryGateFromEnv = (): 'final' | 'best' => {
        const m = (process.env.ENTRY_GATE_MODE ?? 'final').trim().toLowerCase();
        return m === 'best' || m === 'strategy' || m === 'raw' ? 'best' : 'final';
    };
    const getFlagEntryGate = (name: string, fallback: 'final' | 'best') => {
        const arg = process.argv.find((a) => a.startsWith(`${name}=`));
        if (!arg) return fallback;
        const v = arg.split('=')[1]?.trim().toLowerCase();
        if (v === 'best' || v === 'strategy' || v === 'raw') return 'best';
        return 'final';
    };

    const once = hasFlag('--once');
    const daemon = hasFlag('--daemon') || (process.env.DAEMON || '').trim() === '1';
    const telegramMode = hasFlag('--telegram') || (process.env.TELEGRAM_MODE || '').trim() === '1';
    const entryThreshold = getFlagNumber(
        '--entry-threshold',
        Number(process.env.ENTRY_THRESHOLD ?? 4),
    );
    const llmMinScore = getFlagNumber('--llm-min-score', Number(process.env.LLM_MIN_SCORE ?? 4.5));
    const entryGateMode = getFlagEntryGate('--entry-gate', entryGateFromEnv());
    process.env.ENTRY_THRESHOLD = String(entryThreshold);
    process.env.LLM_MIN_SCORE = String(llmMinScore);
    process.env.ENTRY_GATE_MODE = entryGateMode;

    const tpPctCli = getFlagOptionalPositive('--tp-pct');
    const slPctCli = getFlagOptionalPositive('--sl-pct');
    if (tpPctCli !== undefined && slPctCli !== undefined) {
        process.env.TARGET_TP_PCT = String(tpPctCli);
        process.env.TARGET_SL_PCT = String(slPctCli);
    } else if (tpPctCli !== undefined || slPctCli !== undefined) {
        logError(
            'Fixed %% targets require both --tp-pct= and --sl-pct= (or set TARGET_TP_PCT and TARGET_SL_PCT in env).',
            '',
        );
        process.exit(2);
    }

    const fixedPct = readFixedPctTargetsFromEnv();

    const highAttentionMinScore = getFlagNumber(
        '--high-attention-min-score',
        Number(process.env.HIGH_ATTENTION_MIN_SCORE ?? 4),
    );

    const envPollRaw = (process.env.POLL_MINUTES || '').trim();
    const cliPollArg = process.argv.find((a) => a.startsWith('--interval-minutes='));
    const pollOverrideMinutes = cliPollArg
        ? Number(cliPollArg.split('=')[1])
        : envPollRaw !== ''
            ? Number(envPollRaw)
            : NaN;
    /** Normal cadence: one tick per primary chart candle (e.g. 15m chart → every 15 min). */
    const daemonNormalSleepMs =
        Number.isFinite(pollOverrideMinutes) && pollOverrideMinutes > 0
            ? pollOverrideMinutes * 60_000
            : intervalToMilliseconds(interval);
    const daemonNormalPollSource =
        Number.isFinite(pollOverrideMinutes) && pollOverrideMinutes > 0
            ? 'POLL_MINUTES_or_CLI'
            : `primary_${interval}`;
    /** High-attention cadence: one tick per lower-timeframe candle (e.g. 15m chart → 5m). */
    const daemonHighAttentionSleepMs = getDaemonPollMillisecondsFromChart(interval);

    if (daemon && once) {
        logError('Cannot use --daemon and --once together', '');
        process.exit(2);
    }

    const telegramConfigured =
        (process.env.TELEGRAM_BOT_TOKEN || '').trim() !== '' &&
        (process.env.TELEGRAM_CHAT_ID || '').trim() !== '';
    const paperTradesDedupeActive = paperTradesFirestoreReady();
    if (paperTradesFirestoreEnabled() && !paperTradesFirestoreCredentialsConfigured()) {
        logError(
            'PAPER_TRADES_FIRESTORE is set but FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS is missing; paper trades will not run.',
            '',
        );
    }
    if (telegramConfigured && !paperTradesDedupeActive && !telegramMode) {
        logInfo(
            'Paper trades are not persisted (Firestore off or misconfigured): Telegram still sends signals, but nothing is written to Firestore and open-leg dedupe is off. Set PAPER_TRADES_FIRESTORE=1 and GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_PATH to a service account JSON file for the same Firebase project as your database.',
            '',
        );
    }

    if (paperTradesDedupeActive) {
        try {
            const app = getFirebaseAdminApp();
            const cols = paperTradeFirestoreCollectionNames();
            logInfo(
                'Firestore paper trades: Firebase Admin initialized; documents go to Native Firestore (not Realtime Database).',
                {
                    firebaseProjectId: app.options.projectId ?? '(missing in app options)',
                    firestoreOpenCollection: cols.open,
                    firestoreEventCollection: cols.event,
                },
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logError(
                'PAPER_TRADES_FIRESTORE is on and a credentials path is set, but Firebase Admin failed to initialize. Paper trades will not be saved until this is fixed.',
                msg,
            );
        }
    }

    logInfo(`Starting signal bot`, {
        symbol: tradingTarget.symbol,
        interval: tradingTarget.interval,
        once,
        daemon,
        entryThreshold,
        llmMinScore,
        telegramMode,
        paperTradesFirestore: paperTradesDedupeActive ? 'on' : 'off',
        ...(fixedPct
            ? { targetTpPct: fixedPct.targetTpPct, targetSlPct: fixedPct.targetSlPct }
            : {}),
        ...(daemon
            ? {
                daemonNormalSleepMs,
                daemonNormalPollSource,
                daemonHighAttentionSleepMs,
                highAttentionMinScore,
                lowerTimeframe: mapToLowerInterval(tradingTarget.interval),
            }
            : {}),
    });

    async function persistAndNotify(result: Awaited<ReturnType<typeof runEvaluation>>) {
        logDecisionRecord(result.record);
        let paperNotify: PaperTradesNotifyPlan = { telegram: 'legacy' };
        if (paperTradesFirestoreReady()) {
            try {
                paperNotify = await processPaperTradesAfterEvaluation({
                    symbol: tradingTarget.symbol,
                    interval: tradingTarget.interval,
                    result,
                });
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                logError('Failed to persist paper trades to Firestore', msg);
            }
        }
        if (paperNotify.telegram === 'legacy') {
            if (result.decision.send && result.proposal) {
                await postPipelineToTelegram({
                    symbol: tradingTarget.symbol,
                    interval: tradingTarget.interval,
                    result,
                });
            }
        } else {
            if (paperNotify.closures.length > 0) {
                await postPaperTradeClosesToTelegram({
                    closures: paperNotify.closures,
                    closedStats: paperNotify.closedStats,
                });
            }
            if (paperNotify.telegram === 'full') {
                await postPipelineToTelegram({
                    symbol: tradingTarget.symbol,
                    interval: tradingTarget.interval,
                    result,
                });
            } else if (paperNotify.telegram === 'confidence') {
                await postOpenLegConfidenceToTelegram({
                    symbol: tradingTarget.symbol,
                    interval: tradingTarget.interval,
                    result,
                    openTrade: paperNotify.openTrade,
                    previousNotifiedFinalScore: paperNotify.previousNotifiedFinalScore,
                });
            }
        }
    }

    async function runOnce() {
        const result = await runEvaluation({
            symbol: tradingTarget.symbol,
            interval: tradingTarget.interval,
        });
        await persistAndNotify(result);
        return result;
    }

    if (telegramMode) {
        await startTelegramListener();
        return;
    }

    if (daemon) {
        const tokenPresent = (process.env.TELEGRAM_BOT_TOKEN || '').trim() !== '';
        if (tokenPresent && parseTelegramAdminUserIds().length > 0) {
            startTelegramControlLoop(tradingTarget);
        }
        logInfo(
            'Daemon mode — normal = primary timeframe tick; high attention = lower timeframe tick (best score ≥ gate)',
            {
                daemonNormalSleepMs,
                daemonNormalPollSource,
                daemonHighAttentionSleepMs,
                highAttentionMinScore,
            },
        );
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                if (isPaused()) {
                    await sleepDaemonTick(5000);
                    continue;
                }
                const iv = tradingTarget.interval;
                const tickNormalSleepMs =
                    Number.isFinite(pollOverrideMinutes) && pollOverrideMinutes > 0
                        ? pollOverrideMinutes * 60_000
                        : intervalToMilliseconds(iv);
                const tickHighAttentionSleepMs = getDaemonPollMillisecondsFromChart(iv);
                const result = await runOnce();
                const nextMs =
                    result.best.score >= highAttentionMinScore
                        ? tickHighAttentionSleepMs
                        : tickNormalSleepMs;
                await sleepDaemonTick(nextMs);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logStructured({
                    level: 'error',
                    msg: 'daemon_tick_failed',
                    error: message,
                });
                const iv = tradingTarget.interval;
                const tickNormalSleepMs =
                    Number.isFinite(pollOverrideMinutes) && pollOverrideMinutes > 0
                        ? pollOverrideMinutes * 60_000
                        : intervalToMilliseconds(iv);
                const tickHighAttentionSleepMs = getDaemonPollMillisecondsFromChart(iv);
                await sleepDaemonTick(
                    Math.min(Math.min(tickNormalSleepMs, tickHighAttentionSleepMs), 60_000),
                );
            }
        }
    }

    try {
        await runOnce();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError('Run failed', message);
        process.exit(1);
    }
}

process.on('unhandledRejection', (reason) => {
    logStructured({
        level: 'error',
        msg: 'unhandled_rejection',
        error: String(reason),
    });
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    logStructured({
        level: 'error',
        msg: 'uncaught_exception',
        error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
});

main();
