/**
 * Thin Telegram sender for the BTC analyst digest. Reuses src/telegramClient.ts (already handles
 * missing-config no-op + error swallowing) rather than adding new Telegram plumbing.
 *
 * Usage:
 *   npm run analyst-send -- "<message text>"
 *   echo "<message text>" | npm run analyst-send
 *
 * Sends to TELEGRAM_ANALYST_CHAT_ID if set, else falls back to TELEGRAM_CHAT_ID, so the hourly
 * digest can be routed to a separate chat/topic from trade-signal messages.
 */
import 'dotenv/config';
import { sendTelegramMessage } from '../../src/telegramClient';

async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) return '';
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
    const argText = process.argv.slice(2).join(' ').trim();
    const text = argText || (await readStdin());

    if (!text) {
        throw new Error('No message text provided (pass as an argument or via stdin).');
    }

    const chatId = process.env.TELEGRAM_ANALYST_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

    await sendTelegramMessage({ chatId, text, parseMode: 'HTML' });
    console.log('Sent digest to Telegram', { chatId: chatId || '(default)' });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
