/**
 * One-shot hourly analyst digest: refresh the snapshot, format it, send it to Telegram.
 *
 * This is the entry point launchd calls — it needs no Claude session, so the digest lands on
 * schedule whether or not anything else is running. Ad-hoc conversational analysis still happens
 * in Claude Code against the same ./data/analyst-snapshot-*.json files this writes.
 *
 * Usage:
 *   npm run analyst-digest
 *   npm run analyst-digest -- --dry-run   # print the digest, don't send
 *   npm run analyst-digest -- --no-bias   # skip the Claude CLI bias read
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { formatDigest } from './formatDigest';
import { generateBias, parseHistoryLines } from './generateBias';
import { sendTelegramMessage } from '../../src/telegramClient';

const SNAPSHOT_PATH = process.env.ANALYST_SNAPSHOT_OUTPUT || './data/analyst-snapshot-latest.json';
const HISTORY_PATH = process.env.ANALYST_SNAPSHOT_HISTORY || './data/analyst-snapshot-history.jsonl';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readHistory() {
    const historyPath = path.resolve(REPO_ROOT, HISTORY_PATH);
    if (!fs.existsSync(historyPath)) return [];
    return parseHistoryLines(fs.readFileSync(historyPath, 'utf8'));
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');

    // Spawned rather than imported: buildSnapshot.ts runs its work in a top-level main() and exits.
    execFileSync('npx', ['tsx', 'scripts/analyst/buildSnapshot.ts'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'ignore', 'inherit'],
    });

    const snapshotPath = path.resolve(REPO_ROOT, SNAPSHOT_PATH);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

    // Bias reads the digest exactly as it will be sent, so format first and re-format with the
    // result. A null bias (disabled, CLI failed, unusable output) leaves the digest untouched.
    const baseText = formatDigest(snapshot);
    const bias = process.argv.includes('--no-bias')
        ? null
        : await generateBias({
              digestText: baseText,
              generatedAt: snapshot.generatedAt,
              history: readHistory(),
          });
    const text = bias ? formatDigest(snapshot, bias) : baseText;

    if (dryRun) {
        process.stdout.write(`${text}\n`);
        console.error('\n[dry run] not sent');
        return;
    }

    const chatId = process.env.TELEGRAM_ANALYST_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    await sendTelegramMessage({ chatId, text, parseMode: 'HTML' });
    console.log(`Sent digest for ${snapshot.generatedAtHuman} to Telegram`, { chatId: chatId || '(default)' });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
