import 'dotenv/config';
import { interruptDaemonSleep, isPaused, setPaused } from './execution/executionPause';
import { logError, logInfo } from './logger';
import type {
    PaperClosedStatsAggregate,
    PaperTradeClosedLegSummary,
    PaperTradeOpenRecord,
} from './persistence/paperTrades';
import type { LlmCritique, PipelineResult, TradeProposal } from './types/pipeline';
import { runEvaluation } from './pipeline/runEvaluation';
import {
    type AdminTelegramControlMessage,
    classifyAdminTelegramText,
} from './telegram/adminInbound';

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

const HTML_BOT_PAUSED_CHANNEL =
    '⏸ <b>Bot paused</b> — market signal checks are suspended';
const HTML_BOT_UNPAUSED_CHANNEL =
    '▶️ <b>Bot unpaused</b> — market signal checks resumed';

/** Mutable symbol/interval the daemon scans; admin `/symbol` and `/timeframe` update this in daemon mode. */
export type TradingTargetRef = { symbol: string; interval: string };

export function parseTelegramAdminUserIds(): number[] {
    const raw = (process.env.TELEGRAM_ADMIN_USER_IDS || '').trim();
    if (!raw) {
        return [];
    }
    return raw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
}

/**
 * @returns whether the update was consumed (do not treat text as SYMBOL TIMEFRAME).
 */
async function handleAdminControlMessage(input: {
    msg: AdminTelegramControlMessage;
    fromUserId: number | undefined;
    adminUserIds: Set<number>;
    commandChatId: string;
    /** When set (daemon mode), `/symbol` and `/timeframe` update this and wake the daemon sleep. */
    tradingTarget?: TradingTargetRef;
}): Promise<boolean> {
    const { msg, fromUserId, adminUserIds, commandChatId, tradingTarget } = input;
    if (msg.kind === 'not_admin_control') {
        return false;
    }
    if (adminUserIds.size === 0) {
        await sendTelegramMessage({
            chatId: commandChatId,
            text: '⚙️ Remote control is not configured (set <code>TELEGRAM_ADMIN_USER_IDS</code>).',
            parseMode: 'HTML',
        });
        return true;
    }
    if (fromUserId === undefined || !adminUserIds.has(fromUserId)) {
        return true;
    }

    const channelId = TELEGRAM_CHAT_ID;
    const sameAsChannel = channelId !== '' && commandChatId === channelId;

    if (msg.kind === 'pause') {
        if (isPaused()) {
            if (!sameAsChannel) {
                await sendTelegramMessage({
                    chatId: commandChatId,
                    text: '⏸ Already paused.',
                    parseMode: 'HTML',
                });
            }
            return true;
        }
        setPaused(true);
        if (channelId) {
            await sendTelegramMessage({
                chatId: channelId,
                text: HTML_BOT_PAUSED_CHANNEL,
                parseMode: 'HTML',
            });
        }
        if (!sameAsChannel) {
            await sendTelegramMessage({
                chatId: commandChatId,
                text: '⏸ Paused. Market signal checks suspended.',
                parseMode: 'HTML',
            });
        }
        return true;
    }

    if (msg.kind === 'unpause') {
        if (!isPaused()) {
            if (!sameAsChannel) {
                await sendTelegramMessage({
                    chatId: commandChatId,
                    text: '▶️ Already running (not paused).',
                    parseMode: 'HTML',
                });
            }
            return true;
        }
        setPaused(false);
        if (channelId) {
            await sendTelegramMessage({
                chatId: channelId,
                text: HTML_BOT_UNPAUSED_CHANNEL,
                parseMode: 'HTML',
            });
        }
        if (!sameAsChannel) {
            await sendTelegramMessage({
                chatId: commandChatId,
                text: '▶️ Unpaused. Market signal checks resumed.',
                parseMode: 'HTML',
            });
        }
        return true;
    }

    if (msg.kind === 'timeframe') {
        if (!tradingTarget) {
            await sendTelegramMessage({
                chatId: commandChatId,
                text:
                    '⚙️ <code>/timeframe</code> applies in <b>daemon</b> mode only (run with <code>--daemon</code>).',
                parseMode: 'HTML',
            });
            return true;
        }
        if (!msg.raw) {
            await sendTelegramMessage({
                chatId: commandChatId,
                text: 'Usage: <code>/timeframe 15m</code> (examples: <code>5m</code>, <code>1h</code>, <code>4h</code>)',
                parseMode: 'HTML',
            });
            return true;
        }
        const interval = normalizeInterval(msg.raw);
        if (!interval) {
            await sendTelegramMessage({
                chatId: commandChatId,
                text: `❌ Unknown timeframe <code>${escapeHtml(msg.raw)}</code>. Try e.g. <code>15m</code>, <code>1h</code>, <code>4h</code>.`,
                parseMode: 'HTML',
            });
            return true;
        }
        const prev = tradingTarget.interval;
        tradingTarget.interval = interval;
        interruptDaemonSleep();
        logInfo('Admin set daemon timeframe', { interval, symbol: tradingTarget.symbol, was: prev });
        const detail = `📐 <b>Timeframe</b> set to <code>${escapeHtml(interval)}</code> (scanning <b>${escapeHtml(tradingTarget.symbol)}</b>).`;
        if (channelId && !sameAsChannel) {
            await sendTelegramMessage({
                chatId: channelId,
                text: detail,
                parseMode: 'HTML',
            });
        }
        await sendTelegramMessage({
            chatId: commandChatId,
            text: sameAsChannel && channelId ? detail : `✅ ${detail}`,
            parseMode: 'HTML',
        });
        return true;
    }

    if (msg.kind === 'symbol') {
        if (!tradingTarget) {
            await sendTelegramMessage({
                chatId: commandChatId,
                text:
                    '⚙️ <code>/symbol</code> applies in <b>daemon</b> mode only (run with <code>--daemon</code>).',
                parseMode: 'HTML',
            });
            return true;
        }
        if (!msg.raw) {
            await sendTelegramMessage({
                chatId: commandChatId,
                text: 'Usage: <code>/symbol BTCUSDT</code>',
                parseMode: 'HTML',
            });
            return true;
        }
        const symbol = normalizeSymbol(msg.raw);
        if (!symbol || symbol.length < 5) {
            await sendTelegramMessage({
                chatId: commandChatId,
                text: `❌ Invalid symbol. Example: <code>BTCUSDT</code>`,
                parseMode: 'HTML',
            });
            return true;
        }
        const prev = tradingTarget.symbol;
        tradingTarget.symbol = symbol;
        interruptDaemonSleep();
        logInfo('Admin set daemon symbol', { symbol, interval: tradingTarget.interval, was: prev });
        const detail = `📌 <b>Symbol</b> set to <code>${escapeHtml(symbol)}</code> (<code>${escapeHtml(tradingTarget.interval)}</code>).`;
        if (channelId && !sameAsChannel) {
            await sendTelegramMessage({
                chatId: channelId,
                text: detail,
                parseMode: 'HTML',
            });
        }
        await sendTelegramMessage({
            chatId: commandChatId,
            text: sameAsChannel && channelId ? detail : `✅ ${detail}`,
            parseMode: 'HTML',
        });
        return true;
    }

    return true;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Long-poll can block up to `timeout` seconds server-side; allow network slack beyond that. */
const GET_UPDATES_FETCH_OVERHEAD_MS = 15_000;
/** sendMessage and other short calls */
const TELEGRAM_DEFAULT_FETCH_TIMEOUT_MS = 90_000;

async function callTelegram(
    method: string,
    body: Record<string, unknown>,
    options?: { fetchTimeoutMs?: number },
): Promise<any> {
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error('Missing TELEGRAM_BOT_TOKEN');
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    const fetchTimeoutMs = options?.fetchTimeoutMs;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(fetchTimeoutMs !== undefined ? { signal: AbortSignal.timeout(fetchTimeoutMs) } : {}),
    });
    const data = await res.json();
    if (!data.ok) {
        throw new Error(`Telegram API error: ${data.description || 'unknown error'}`);
    }
    return data.result;
}

export async function sendTelegramMessage(params: {
    chatId?: string;
    text: string;
    parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown';
    disableWebPagePreview?: boolean;
}): Promise<void> {
    const chatId = (params.chatId || TELEGRAM_CHAT_ID).trim();
    if (!TELEGRAM_BOT_TOKEN || !chatId) {
        logInfo('Telegram not configured; skipping message send');
        return;
    }
    try {
        await callTelegram(
            'sendMessage',
            {
                chat_id: chatId,
                text: params.text,
                parse_mode: params.parseMode || 'HTML',
                disable_web_page_preview: params.disableWebPagePreview ?? true,
            },
            { fetchTimeoutMs: TELEGRAM_DEFAULT_FETCH_TIMEOUT_MS },
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('Failed to send Telegram message', message);
    }
}

function formatNumber(n: number) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(n);
}

function formatLlmCritiqueHtml(critique: LlmCritique | null): string {
    if (critique != null) {
        return (
            `🧪 <b>LLM</b>: adj ${critique.score_adjustment} · ${escapeHtml(critique.comment)}` +
            (critique.risk_flags.length
                ? `\n⚠️ <b>Risks</b>: ${escapeHtml(critique.risk_flags.join(', '))}`
                : '')
        );
    }
    return `🧪 <b>LLM</b>: (skipped — below gate or no API key)`;
}

export function formatPipelineResultAsHtml(input: {
    symbol: string;
    interval: string;
    result: PipelineResult;
}): string {
    const { symbol, interval, result } = input;
    const { best, critique, decision, proposal, record } = result;
    const title = `📣 <b>Signal</b> — <b>${escapeHtml(symbol)}</b> (${escapeHtml(interval)})`;
    const strat = `📊 <b>Strategy</b>: ${escapeHtml(best.name)} · score <b>${best.score}</b> → <b>${decision.finalScore}</b>`;
    const llmLine = formatLlmCritiqueHtml(critique);

    if (!proposal) {
        return [title, strat, llmLine, `⏸ <b>No trade</b>: ${escapeHtml(record.skipReason || 'n/a')}`].join('\n');
    }

    const p: TradeProposal = proposal;
    const dirLabel = p.direction === 'long' ? '🟢 Long' : '🔴 Short';
    const levelsNote =
        record.levelsMode === 'fixed_pct' &&
            record.targetTpPct !== undefined &&
            record.targetSlPct !== undefined
            ? `📐 <b>Levels</b>: fixed <b>${formatNumber(record.targetTpPct)}%</b> TP / <b>${formatNumber(record.targetSlPct)}%</b> SL from entry`
            : '';
    const entrySlTp = `💹 <b>entry</b> <b>${formatNumber(p.entry)}</b> · <b>sl</b> <b>${formatNumber(p.sl)}</b> · <b>tp</b> <b>${formatNumber(p.tp)}</b>`;
    const entryZone = `⚡ Zone: <b>${formatNumber(Math.min(p.entryZone[0], p.entryZone[1]))}</b> – <b>${formatNumber(Math.max(p.entryZone[0], p.entryZone[1]))}</b>`;
    const tps = p.takeProfits
        .map((tp, i) => {
            const rr = p.riskReward[i];
            const rrPart = rr !== undefined ? ` (RR ${formatNumber(rr)})` : '';
            return `🎯 TP${i + 1}: <b>${formatNumber(tp)}</b>${rrPart}`;
        })
        .join('\n');
    const sl = `🛑 SL: <b>${formatNumber(p.stopLoss)}</b>`;
    const reason = `📝 <b>Reason</b>: ${escapeHtml(p.reason)}`;
    const blocks = [
        title,
        strat,
        llmLine,
        dirLabel,
        entrySlTp,
        ...(levelsNote ? [levelsNote] : []),
        entryZone,
        tps,
        sl,
        reason,
    ];
    return blocks.join('\n');
}

export function formatPipelineSkipSummary(input: {
    symbol: string;
    interval: string;
    result: PipelineResult;
}): string {
    const { symbol, interval, result } = input;
    const r = result.record;
    return (
        `ℹ️ <b>${escapeHtml(symbol)}</b> (${escapeHtml(interval)}) — no signal. ` +
        `Strategy: ${escapeHtml(result.best.name)} score ${result.best.score} → final ${r.finalScore ?? result.best.score}. ` +
        `${escapeHtml(r.skipReason || '')}`
    );
}

export async function postPipelineToTelegram(input: {
    symbol: string;
    interval: string;
    result: PipelineResult;
    chatIdOverride?: string;
}): Promise<void> {
    const text = formatPipelineResultAsHtml(input);
    await sendTelegramMessage({ chatId: input.chatIdOverride, text, parseMode: 'HTML', disableWebPagePreview: true });
}

function confidenceVsEntryLabel(current: number, entry?: number): string {
    if (entry === undefined || Number.isNaN(entry)) return 'n/a';
    if (current > entry) return 'higher';
    if (current < entry) return 'lower';
    return 'same';
}

export function formatOpenLegConfidenceAsHtml(input: {
    symbol: string;
    interval: string;
    result: PipelineResult;
    openTrade: PaperTradeOpenRecord;
    previousNotifiedFinalScore: number;
}): string {
    const { symbol, interval, result, openTrade, previousNotifiedFinalScore } = input;
    const cur = result.decision.finalScore;
    const entryScore = openTrade.finalScore;
    const vsEntry = confidenceVsEntryLabel(cur, entryScore);
    const dirLabel = openTrade.direction === 'long' ? 'LONG' : 'SHORT';
    const deltaPrev =
        cur > previousNotifiedFinalScore
            ? 'up'
            : cur < previousNotifiedFinalScore
                ? 'down'
                : 'unchanged';
    const { best, critique, decision, state } = result;
    const strat = `📊 <b>Strategy</b>: ${escapeHtml(best.name)} · score <b>${best.score}</b> → <b>${decision.finalScore}</b>`;
    const openedNote =
        openTrade.strategy && openTrade.strategy !== best.name
            ? `📌 <b>Opened with</b>: ${escapeHtml(openTrade.strategy)}`
            : '';
    const priceLevels = `💹 <b>close</b> <b>${formatNumber(state.latest.close)}</b> · <b>entry</b> <b>${formatNumber(openTrade.entry)}</b> · <b>sl</b> <b>${formatNumber(openTrade.sl)}</b> · <b>tp</b> <b>${formatNumber(openTrade.tp)}</b>`;
    return [
        `📎 <b>Open leg</b> — <b>${escapeHtml(symbol)}</b> (${escapeHtml(interval)}) <b>${dirLabel}</b>`,
        `📊 Final score <b>${cur}</b> (last alert <b>${previousNotifiedFinalScore}</b> → <b>${deltaPrev}</b>)`,
        `🎯 vs entry final <b>${entryScore ?? 'n/a'}</b>: <b>${vsEntry}</b> · strategy score <b>${result.best.score}</b>`,
        strat,
        ...(openedNote ? [openedNote] : []),
        formatLlmCritiqueHtml(critique),
        priceLevels,
    ].join('\n');
}

export async function postOpenLegConfidenceToTelegram(input: {
    symbol: string;
    interval: string;
    result: PipelineResult;
    openTrade: PaperTradeOpenRecord;
    previousNotifiedFinalScore: number;
    chatIdOverride?: string;
}): Promise<void> {
    const text = formatOpenLegConfidenceAsHtml(input);
    await sendTelegramMessage({ chatId: input.chatIdOverride, text, parseMode: 'HTML', disableWebPagePreview: true });
}

function paperClosePnlPct(summary: PaperTradeClosedLegSummary): number {
    const { direction, entry, exitPrice } = summary;
    if (!Number.isFinite(entry) || entry === 0) return NaN;
    const frac =
        direction === 'long' ? (exitPrice - entry) / entry : (entry - exitPrice) / entry;
    return frac * 100;
}

function paperCloseR(summary: PaperTradeClosedLegSummary): number | null {
    const { direction, entry, sl, exitPrice, initialSl } = summary;
    const stopRef = initialSl !== undefined ? initialSl : sl;
    const risk = direction === 'long' ? entry - stopRef : stopRef - entry;
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const pnl = direction === 'long' ? exitPrice - entry : entry - exitPrice;
    return pnl / risk;
}

function formatClosedPaperStatsBlock(stats: PaperClosedStatsAggregate): string {
    const {
        closedCount,
        wins,
        losses,
        winRatePct,
        sumPnlPct,
        tradesWithPnl,
        sumR,
        tradesWithR,
    } = stats;
    const wr = winRatePct !== null ? `${formatNumber(winRatePct)}%` : 'n/a';
    const pnlLine =
        sumPnlPct !== null
            ? `Σ fill PnL vs entry <b>${formatNumber(sumPnlPct)}%</b> (${tradesWithPnl} fills, position-weighted)`
            : 'Σ fill PnL n/a (older closes lack entry in Firestore)';
    const rLine =
        sumR !== null && tradesWithR > 0
            ? ` · Σ R <b>${formatNumber(sumR)}</b> (${tradesWithR} fills, weighted)`
            : '';
    const legacyHint =
        tradesWithPnl > 0 && tradesWithPnl < closedCount
            ? '\nℹ️ PnL/R include only closes with stored entry; W/L counts terminal exits only.'
            : '';
    return [
        `📊 <b>All closed paper</b>: <b>${closedCount}</b> fills · terminal <b>${wins}</b>W / <b>${losses}</b>L · win rate <b>${wr}</b>`,
        `${pnlLine}${rLine}`,
        legacyHint,
    ]
        .filter(Boolean)
        .join('\n');
}

export function formatPaperTradeCloseAsHtml(
    summary: PaperTradeClosedLegSummary,
    closedStats?: PaperClosedStatsAggregate,
): string {
    const dirLabel = summary.direction === 'long' ? 'LONG' : 'SHORT';
    const frac = summary.positionFraction ?? 1;
    const partial = summary.terminal === false;
    const tpTag =
        summary.tpLeg !== undefined ? ` <b>TP${summary.tpLeg}</b>` : '';
    const exitKind =
        summary.outcome === 'sl'
            ? '🛑 <b>Stop loss</b>'
            : partial
              ? `🎯 <b>Take profit</b>${tpTag} <b>(partial)</b>`
              : `🎯 <b>Take profit</b>${tpTag}`;
    const headline = partial
        ? `📤 <b>Paper trade partial</b> — <b>${escapeHtml(summary.symbol)}</b> (${escapeHtml(summary.interval)}) <b>${dirLabel}</b> · <b>${formatNumber(frac * 100)}%</b> of size`
        : `🏁 <b>Paper trade closed</b> — <b>${escapeHtml(summary.symbol)}</b> (${escapeHtml(summary.interval)}) <b>${dirLabel}</b>`;
    const pct = paperClosePnlPct(summary);
    const r = paperCloseR(summary);
    const pctLine = Number.isFinite(pct)
        ? `📉 PnL ≈ <b>${formatNumber(pct)}%</b> (vs entry, this slice)`
        : '';
    const rLine =
        r !== null ? `⚖️ ≈ <b>${formatNumber(r)}</b> R (vs initial SL distance)` : '';
    const strat =
        summary.strategy !== undefined
            ? `📊 <b>Strategy</b>: ${escapeHtml(summary.strategy)}`
            : '';
    const parts = [
        headline,
        exitKind,
        `💹 <b>Exit</b> <b>${formatNumber(summary.exitPrice)}</b> · <b>entry</b> <b>${formatNumber(summary.entry)}</b> · <b>sl</b> <b>${formatNumber(summary.sl)}</b> · <b>tp</b> <b>${formatNumber(summary.tp)}</b>`,
        ...(strat ? [strat] : []),
        ...(pctLine ? [pctLine] : []),
        ...(rLine ? [rLine] : []),
    ];
    if (closedStats !== undefined && closedStats.closedCount > 0) {
        parts.push('', formatClosedPaperStatsBlock(closedStats));
    }
    return parts.join('\n');
}

export async function postPaperTradeClosesToTelegram(input: {
    closures: PaperTradeClosedLegSummary[];
    closedStats?: PaperClosedStatsAggregate;
    chatIdOverride?: string;
}): Promise<void> {
    for (const c of input.closures) {
        await sendTelegramMessage({
            chatId: input.chatIdOverride,
            text: formatPaperTradeCloseAsHtml(c, input.closedStats),
            parseMode: 'HTML',
            disableWebPagePreview: true,
        });
    }
}

type TelegramUpdate = {
    update_id: number;
    message?: {
        message_id: number;
        from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
        chat: { id: number | string; type: string; title?: string; username?: string };
        date?: number;
        text?: string;
    };
    edited_message?: TelegramUpdate['message'];
};

const VALID_INTERVALS = new Set([
    '1m', '3m', '5m', '15m', '30m',
    '1h', '2h', '4h', '6h', '8h', '12h',
    '1d', '3d', '1w', '1M',
]);

function normalizeSymbol(raw: string): string {
    const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '');
    return cleaned.toUpperCase();
}

function normalizeInterval(raw: string): string | null {
    const tf = raw.trim();
    const lower = tf.toLowerCase();
    if (VALID_INTERVALS.has(lower)) return lower;
    return null;
}

function parseSymbolAndInterval(text?: string): { symbol: string; interval: string } | { error: string } {
    if (!text) return { error: 'Empty message' };
    const trimmed = text.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) return { error: 'Please send in format: SYMBOL TIMEFRAME (e.g., BTCUSDT 15m)' };
    const symbol = normalizeSymbol(parts[0]!);
    const interval = normalizeInterval(parts[1]!);
    if (!symbol || symbol.length < 5) return { error: 'Invalid symbol. Example: BTCUSDT' };
    if (!interval) return { error: 'Invalid timeframe. Examples: 15m, 1h, 4h, 1d' };
    return { symbol, interval };
}

const GET_UPDATES_BACKOFF_INITIAL_MS = 2000;
const GET_UPDATES_BACKOFF_MAX_MS = 30_000;

let getUpdatesConsecutiveFailures = 0;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getUpdates(offset?: number, timeoutSec = 50): Promise<TelegramUpdate[]> {
    const fetchTimeoutMs = timeoutSec * 1000 + GET_UPDATES_FETCH_OVERHEAD_MS;
    try {
        const res = await callTelegram(
            'getUpdates',
            {
                offset,
                timeout: timeoutSec,
                allowed_updates: ['message', 'edited_message'],
            } as any,
            { fetchTimeoutMs },
        );
        getUpdatesConsecutiveFailures = 0;
        return Array.isArray(res) ? (res as TelegramUpdate[]) : [];
    } catch (error) {
        getUpdatesConsecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        logError('Failed to get updates from Telegram', message);
        const backoffMs = Math.min(
            GET_UPDATES_BACKOFF_INITIAL_MS * 2 ** (getUpdatesConsecutiveFailures - 1),
            GET_UPDATES_BACKOFF_MAX_MS,
        );
        await sleep(backoffMs);
        return [];
    }
}

/**
 * Long-polls Telegram in the background for admin /pause, /unpause, /timeframe, /symbol (daemon mode).
 * Ignores non-control messages. Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_USER_IDS`.
 */
export function startTelegramControlLoop(tradingTarget: TradingTargetRef): void {
    const adminUserIds = new Set(parseTelegramAdminUserIds());
    if (!TELEGRAM_BOT_TOKEN || adminUserIds.size === 0) {
        return;
    }
    logInfo('Starting Telegram daemon control (getUpdates)', {
        symbol: tradingTarget.symbol,
        interval: tradingTarget.interval,
    });
    void (async () => {
        let offset: number | undefined = undefined;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                const updates = await getUpdates(offset, 50);
                for (const u of updates) {
                    offset = u.update_id + 1;
                    const msg = u.message || u.edited_message;
                    if (!msg?.text) {
                        continue;
                    }
                    const chatId = String(msg.chat.id);
                    const classified = classifyAdminTelegramText(msg.text);
                    await handleAdminControlMessage({
                        msg: classified,
                        fromUserId: msg.from?.id,
                        adminUserIds,
                        commandChatId: chatId,
                        tradingTarget,
                    });
                }
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logError('Telegram control loop error', message);
                await sleep(2000);
            }
        }
    })();
}

export async function startTelegramListener(): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error('Missing TELEGRAM_BOT_TOKEN');
    }
    logInfo('Starting Telegram listener mode');
    let offset: number | undefined = undefined;
    const adminUserIds = new Set(parseTelegramAdminUserIds());
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            const updates = await getUpdates(offset, 50);
            for (const u of updates) {
                offset = u.update_id + 1;
                const msg = u.message || u.edited_message;
                if (!msg || !msg.text) continue;
                const chatId = String(msg.chat.id);
                const classified = classifyAdminTelegramText(msg.text);
                const consumed = await handleAdminControlMessage({
                    msg: classified,
                    fromUserId: msg.from?.id,
                    adminUserIds,
                    commandChatId: chatId,
                });
                if (consumed) {
                    continue;
                }

                const parsed = parseSymbolAndInterval(msg.text);
                if ('error' in parsed) {
                    await sendTelegramMessage({
                        chatId,
                        text: `❓ ${parsed.error}\nSend messages like: <b>BTCUSDT 15m</b> or <b>ETHUSDT 1h</b>.`,
                        parseMode: 'HTML',
                    });
                    continue;
                }

                if (isPaused()) {
                    await sendTelegramMessage({
                        chatId,
                        text: '⏸ <b>Bot is paused.</b> Send <code>/unpause</code> to resume on-demand analysis.',
                        parseMode: 'HTML',
                    });
                    continue;
                }

                const { symbol, interval } = parsed;
                await sendTelegramMessage({
                    chatId,
                    text: `⏳ Analyzing <b>${symbol}</b> (${interval})...`,
                    parseMode: 'HTML',
                });
                try {
                    const result = await runEvaluation({ symbol, interval });
                    const signaled = Boolean(result.decision.send && result.proposal);
                    if (signaled) {
                        await postPipelineToTelegram({
                            symbol,
                            interval,
                            result,
                            chatIdOverride: chatId,
                        });
                    } else {
                        await sendTelegramMessage({
                            chatId,
                            text: formatPipelineSkipSummary({ symbol, interval, result }),
                            parseMode: 'HTML',
                        });
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logError('Failed to generate signal', message);
                    await sendTelegramMessage({
                        chatId,
                        text: `⚠️ Failed: <code>${escapeHtml(message)}</code>`,
                        parseMode: 'HTML',
                    });
                }
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logError('Telegram listener loop error', message);
            await sleep(2000);
        }
    }
}
