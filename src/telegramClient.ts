import 'dotenv/config';
import { logError, logInfo } from './logger';
import { type SignalResponse } from './openaiClient';
import { runBot } from './bot';

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '8288693765:AAGBGdq0jQRUwv66Ryjfj7-c4zqF5CNoFk4').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '-1002987519133').trim();

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function callTelegram(method: string, body: Record<string, unknown>): Promise<any> {
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error('Missing TELEGRAM_BOT_TOKEN');
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        await callTelegram('sendMessage', {
            chat_id: chatId,
            text: params.text,
            parse_mode: params.parseMode || 'HTML',
            disable_web_page_preview: params.disableWebPagePreview ?? true,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('Failed to send Telegram message', message);
    }
}

export function formatSignalAsHtml(input: {
    symbol: string;
    interval: string;
    signal: SignalResponse;
}): string {
    const { symbol, interval, signal } = input;
    const formatNumber = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(n);
    const confidencePct = Math.round(signal.confidence * 100);
    const dirLabel = signal.signal === 'buy' ? '🟢 Long' : signal.signal === 'sell' ? '🔴 Short' : '🟡 Hold';
    const title = `📣 <b>AI Signal</b> — <b>${escapeHtml(symbol)}</b> (${escapeHtml(interval)})`;
    const direction = `📌 <b>${dirLabel}</b> · 📈 Confidence: <b>${confidencePct}%</b>`;
    const entryLabel = signal.entryType === 'now' ? '⚡ Entry Now' : '⏳ Limit Entry';
    const entry = `${entryLabel}: <b>${formatNumber(signal.entryPrice)}</b>`;
    const rr = signal.riskReward || [];
    const tps = signal.takeProfits
        .map((tp, i) => {
            const rrPart = rr[i] !== undefined ? ` (RR ${formatNumber(rr[i])})` : '';
            return `🎯 TP${i + 1}: <b>${formatNumber(tp)}</b>${rrPart}`;
        })
        .join('\n');
    const sl = `🛑 SL: <b>${formatNumber(signal.stopLoss)}</b>`;
    const reason = `🧠 <b>Reason</b>: ${escapeHtml(signal.reason)}`;
    return [title, direction, entry, tps, sl, reason].join('\n');
}

export async function postSignalToTelegram(input: {
    symbol: string;
    interval: string;
    signal: SignalResponse;
    chatIdOverride?: string;
}): Promise<void> {
    const text = formatSignalAsHtml({ symbol: input.symbol, interval: input.interval, signal: input.signal });
    await sendTelegramMessage({ chatId: input.chatIdOverride, text, parseMode: 'HTML', disableWebPagePreview: true });
}


// --- Telegram listener mode ---
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
    '1d', '3d', '1w', '1M'
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
    // Accept formats like: "BTCUSDT 15m" or "ETH/USDT 1h"
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) return { error: 'Please send in format: SYMBOL TIMEFRAME (e.g., BTCUSDT 15m)' };
    const symbol = normalizeSymbol(parts[0]);
    const interval = normalizeInterval(parts[1]);
    if (!symbol || symbol.length < 5) return { error: 'Invalid symbol. Example: BTCUSDT' };
    if (!interval) return { error: 'Invalid timeframe. Examples: 15m, 1h, 4h, 1d' };
    return { symbol, interval };
}

async function getUpdates(offset?: number, timeoutSec = 50): Promise<TelegramUpdate[]> {
    try {
        const res = await callTelegram('getUpdates', {
            offset,
            timeout: timeoutSec,
            allowed_updates: ['message', 'edited_message'],
        } as any);
        return Array.isArray(res) ? res as TelegramUpdate[] : [];
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('Failed to get updates from Telegram', message);
        return [];
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startTelegramListener(options?: { confidenceThreshold?: number }): Promise<void> {
    const threshold = options?.confidenceThreshold ?? (Number(process.env.CONF_THRESHOLD || 0) || 0);
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error('Missing TELEGRAM_BOT_TOKEN');
    }
    logInfo('Starting Telegram listener mode');
    let offset: number | undefined = undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            const updates = await getUpdates(offset, 50);
            for (const u of updates) {
                offset = u.update_id + 1;
                const msg = u.message || u.edited_message;
                if (!msg || !msg.text) continue;
                const chatId = String(msg.chat.id);
                const parsed = parseSymbolAndInterval(msg.text);
                if ('error' in parsed) {
                    await sendTelegramMessage({
                        chatId,
                        text: `❓ ${parsed.error}\nSend messages like: <b>BTCUSDT 15m</b> or <b>ETHUSDT 1h</b>.`,
                        parseMode: 'HTML',
                    });
                    continue;
                }

                const { symbol, interval } = parsed;
                await sendTelegramMessage({ chatId, text: `⏳ Analyzing <b>${symbol}</b> (${interval})...`, parseMode: 'HTML' });
                try {
                    const signal = await runBot({ symbol, interval });
                    if (signal.confidence >= threshold) {
                        await postSignalToTelegram({ symbol, interval, signal, chatIdOverride: chatId });
                    } else {
                        await postSignalToTelegram({ symbol, interval, signal, chatIdOverride: chatId });
                        await sendTelegramMessage({ chatId, text: `ℹ️ Confidence (${Math.round(signal.confidence * 100)}%) is below threshold (${Math.round(threshold * 100)}%).`, parseMode: 'HTML' });
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logError('Failed to generate signal', message);
                    await sendTelegramMessage({ chatId, text: `⚠️ Failed to generate signal: <code>${escapeHtml(message)}</code>`, parseMode: 'HTML' });
                }
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logError('Telegram listener loop error', message);
            await sleep(2000);
        }
    }
}


