import 'dotenv/config';
import {
    getDaemonPollMillisecondsFromChart,
    intervalToMilliseconds,
    mapToLowerInterval,
} from './src/data/marketData';
import { runEvaluation } from './src/pipeline/runEvaluation';
import { logInfo, logError } from './src/logger';
import { logDecisionRecord, logStructured } from './src/logging/structured';
import { writeRunArtifact, appendDecisionJsonl } from './src/persistence/runArtifact';
import { postPipelineToTelegram, startTelegramListener } from './src/telegramClient';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const rawArgs = process.argv.slice(2);
    const positionalArgs = rawArgs.filter((a) => !a.startsWith('--'));
    const symbolArg = positionalArgs[0];
    const timeframeArg = positionalArgs[1];
    const symbol = (symbolArg || process.env.SYMBOL || 'BTCUSDT').toUpperCase();
    const interval = (timeframeArg || process.env.TIMEFRAME || '5m').toLowerCase();

    const hasFlag = (name: string) => process.argv.some((a) => a === name || a.startsWith(`${name}=`));
    const getFlagNumber = (name: string, fallback: number) => {
        const arg = process.argv.find((a) => a.startsWith(`${name}=`));
        if (!arg) return fallback;
        const v = Number(arg.split('=')[1]);
        return Number.isFinite(v) ? v : fallback;
    };

    const once = hasFlag('--once');
    const daemon = hasFlag('--daemon') || (process.env.DAEMON || '').trim() === '1';
    const telegramMode = hasFlag('--telegram') || (process.env.TELEGRAM_MODE || '').trim() === '1';
    const entryThreshold = getFlagNumber(
        '--entry-threshold',
        Number(process.env.ENTRY_THRESHOLD ?? 5),
    );
    const llmMinScore = getFlagNumber('--llm-min-score', Number(process.env.LLM_MIN_SCORE ?? 3));
    process.env.ENTRY_THRESHOLD = String(entryThreshold);
    process.env.LLM_MIN_SCORE = String(llmMinScore);

    const runArtifactDir = (process.env.RUN_ARTIFACT_DIR || '').trim();

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

    logInfo(`Starting signal bot`, {
        symbol,
        interval,
        once,
        daemon,
        entryThreshold,
        llmMinScore,
        telegramMode,
        runArtifactDir: runArtifactDir || '(stdout only)',
        ...(daemon
            ? {
                  daemonNormalSleepMs,
                  daemonNormalPollSource,
                  daemonHighAttentionSleepMs,
                  highAttentionMinScore,
                  lowerTimeframe: mapToLowerInterval(interval),
              }
            : {}),
    });

    async function persistAndNotify(result: Awaited<ReturnType<typeof runEvaluation>>) {
        logDecisionRecord(result.record);
        if (runArtifactDir) {
            try {
                await writeRunArtifact(runArtifactDir, result.record);
                await appendDecisionJsonl(runArtifactDir, result.record);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                logError('Failed to write run artifact', msg);
            }
        }
        if (result.decision.send && result.proposal) {
            await postPipelineToTelegram({ symbol, interval, result });
        }
    }

    async function runOnce() {
        const result = await runEvaluation({ symbol, interval });
        await persistAndNotify(result);
        return result;
    }

    if (telegramMode) {
        await startTelegramListener();
        return;
    }

    if (daemon) {
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
                const result = await runOnce();
                const nextMs =
                    result.best.score >= highAttentionMinScore
                        ? daemonHighAttentionSleepMs
                        : daemonNormalSleepMs;
                await sleep(nextMs);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logStructured({
                    level: 'error',
                    msg: 'daemon_tick_failed',
                    error: message,
                });
                await sleep(
                    Math.min(
                        Math.min(daemonNormalSleepMs, daemonHighAttentionSleepMs),
                        60_000,
                    ),
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
