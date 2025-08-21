import 'dotenv/config';
import { runBot } from './src/bot';
import { logInfo, logError } from './src/logger';
import { postSignalToTelegram, startTelegramListener } from './src/telegramClient';

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
        return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    const getFlagFloat = (name: string, fallback: number) => {
        const arg = process.argv.find((a) => a.startsWith(`${name}=`));
        if (!arg) return fallback;
        const v = Number(arg.split('=')[1]);
        return Number.isFinite(v) ? v : fallback;
    };

    const daemon = hasFlag('--daemon') || (process.env.DAEMON || '').trim() === '1';
    const telegramMode = hasFlag('--telegram') || (process.env.TELEGRAM_MODE || '').trim() === '1';
    const pollMinutes = getFlagNumber('--interval-minutes', Number(process.env.POLL_MINUTES || 5)) || 5;
    const confidenceThreshold = getFlagFloat('--threshold', Number(process.env.CONF_THRESHOLD || 0)) || 0;

    logInfo(`Starting signal bot`, { symbol, interval, daemon, pollMinutes, confidenceThreshold, telegramMode });

    const formatNumber = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(n);

    async function runOnce() {
        try {
            const signal = await runBot({ symbol, interval });
            const readable = {
                signal: signal.signal,
                confidence: signal.confidence,
                reason: signal.reason,
                takeProfits: signal.takeProfits?.map((p) => formatNumber(p)),
                stopLoss: formatNumber(signal.stopLoss),
                entryType: signal.entryType,
                entryPrice: formatNumber(signal.entryPrice),
                riskReward: signal.riskReward,
            };
            logInfo('Signal (readable)', readable);
            if (signal.confidence >= confidenceThreshold) {
                // await postSignalToTelegram({ symbol, interval, signal });
            } else {
                logInfo(`Confidence below threshold; skipping Telegram`, { confidence: signal.confidence, threshold: confidenceThreshold });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError('Bot iteration failed', message);
        }
    }

    if (telegramMode) {
        await startTelegramListener({ confidenceThreshold });
        return;
    } else if (daemon) {
        logInfo('Daemon mode enabled');
        // Run immediately, then on an interval
        await runOnce();
        setInterval(() => {
            runOnce().catch((err) => logError('Scheduled run failed', err instanceof Error ? err.message : String(err)));
        }, pollMinutes * 60 * 1000);
    } else {
        await runOnce();
    }
}

main();
