/**
 * Bullish/bearish bias read over the digest, produced by the locally-installed Claude CLI in
 * headless mode (`claude -p`) — no hosted API key, no network client of our own.
 *
 * The model returns JSON, never Telegram markup: rendering stays in formatDigest.ts so the digest's
 * formatting rules live in one place and model output can't inject HTML into the message.
 *
 * Best-effort by construction. Every failure path (CLI missing, non-zero exit, timeout, garbage
 * output, off-schema JSON) resolves to null so the hourly digest still sends without this section.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { elapsed } from './formatDigest';

const execFileAsync = promisify(execFile);

const BiasSchema = z.object({
    timeframes: z
        .array(
            z.object({
                tf: z.string().min(1),
                bias: z.enum(['bullish', 'bearish', 'neutral']),
                note: z.string(),
            })
        )
        .min(1),
    overall: z.object({
        bias: z.enum(['bullish', 'bearish', 'neutral', 'mixed']),
        note: z.string(),
    }),
});

export type BiasReport = z.infer<typeof BiasSchema>;

/** What formatDigest needs: the read itself, plus how far back the compared history actually goes. */
export type BiasResult = { report: BiasReport; lookbackGeneratedAt: string };

/** One line of ./data/analyst-snapshot-history.jsonl — extra keys are passed through to the model. */
export type HistoryEntry = { generatedAt: string; price: number; [key: string]: unknown };

/**
 * Reads ./data/analyst-snapshot-history.jsonl. Bad lines are skipped rather than thrown on — a
 * truncated last line (killed mid-append) must not take the whole digest down.
 */
export function parseHistoryLines(text: string): HistoryEntry[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
            try {
                const parsed = JSON.parse(line) as HistoryEntry;
                return typeof parsed?.generatedAt === 'string' && parsed.generatedAt.length > 0 ? [parsed] : [];
            } catch {
                return [];
            }
        });
}

/**
 * launchd runs with a pinned PATH that does not include ~/.local/bin, where the Claude CLI installs
 * by default — so the scheduled digest needs an absolute path here even though an interactive shell
 * resolves the bare name fine.
 */
export function resolveClaudeBin(): string {
    return (process.env.ANALYST_BIAS_CLAUDE_BIN || '').trim() || 'claude';
}

const DEFAULT_LOOKBACK_ENTRIES = 6;
const DEFAULT_TIMEOUT_MS = 120_000;

function stripCodeFence(text: string): string {
    return text.replace(/```(?:json)?/gi, '');
}

/** Brace-matched so trailing prose after the object doesn't break JSON.parse. */
function firstJsonObject(text: string): unknown | null {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

export function parseBiasResponse(raw: string): BiasReport | null {
    const candidate = firstJsonObject(stripCodeFence(raw));
    if (candidate === null) return null;
    const parsed = BiasSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

/**
 * The digest as sent, plus the raw history entries behind it. Timestamps and the real gaps between
 * them are spelled out because the schedule is 07:11–23:11 local: entries are NOT hourly across the
 * overnight break, and a model assuming they are would read one night's move as one hour of action.
 */
export function buildBiasPrompt(input: {
    digestText: string;
    generatedAt: string;
    history: HistoryEntry[];
}): string {
    const { digestText, generatedAt, history } = input;
    const series = [...history].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
    const stamps = [...series.map((h) => h.generatedAt), generatedAt];

    const gaps = stamps
        .slice(1)
        .map((to, i) => ({ from: stamps[i]!, to, label: elapsed(stamps[i]!, to) }));
    const largest = gaps.reduce((a, b) =>
        new Date(b.to).getTime() - new Date(b.from).getTime() > new Date(a.to).getTime() - new Date(a.from).getTime() ? b : a
    );
    const window = series.length > 0 ? elapsed(series[0]!.generatedAt, generatedAt) : 'an unknown interval';

    return [
        'You are reading a Bitcoin TA digest and its recent history. Judge directional bias per timeframe.',
        '',
        '=== CURRENT DIGEST (as sent to Telegram) ===',
        digestText,
        '',
        '=== PRIOR SNAPSHOTS (oldest first, JSON, one per line) ===',
        ...series.map((h) => JSON.stringify(h)),
        '',
        '=== TIMING (read carefully) ===',
        `Current snapshot: ${generatedAt}`,
        `History spans ${window} back to ${series[0]?.generatedAt ?? 'n/a'}.`,
        `Entries are NOT evenly spaced. Largest gap: ${largest.label} (${largest.from} -> ${largest.to}).`,
        'The schedule runs 07:11-23:11 local time only, so an overnight gap is normal — weigh moves by',
        'the real elapsed time shown above, never by counting entries.',
        '',
        '=== TASK ===',
        'For each timeframe present in the digest (the interval on each moving average, plus the weekly',
        'BMSB if shown), state bullish, bearish, or neutral, with a short evidence-based reason drawn',
        'only from the data above. Then give one overall read (bullish, bearish, neutral, or mixed).',
        'Notes must be under 90 characters, plain text, no markup, no entry/stop/target prices.',
        '',
        'Reply with JSON only, no prose, in exactly this shape:',
        '{"timeframes":[{"tf":"15m","bias":"bearish","note":"..."}],"overall":{"bias":"mixed","note":"..."}}',
    ].join('\n');
}

/**
 * Runs the CLI and returns the validated read, or null if anything at all goes wrong — callers
 * treat a null as "send the digest without a Bias section".
 */
export async function generateBias(input: {
    digestText: string;
    generatedAt: string;
    history: HistoryEntry[];
}): Promise<BiasResult | null> {
    if ((process.env.ANALYST_BIAS_ENABLED || 'true').toLowerCase() === 'false') return null;

    const lookback = Number(process.env.ANALYST_BIAS_LOOKBACK_ENTRIES ?? DEFAULT_LOOKBACK_ENTRIES);
    const timeout = Number(process.env.ANALYST_BIAS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    const history = input.history.slice(-Math.max(1, lookback));
    if (history.length === 0) return null;

    const model = (process.env.ANALYST_BIAS_CLAUDE_MODEL || '').trim();
    const args = ['-p', ...(model ? ['--model', model] : [])];
    const prompt = buildBiasPrompt({ ...input, history });

    try {
        const child = execFileAsync(resolveClaudeBin(), args, { timeout, maxBuffer: 10 * 1024 * 1024 });
        child.child.stdin?.end(prompt);
        const { stdout } = await child;
        const report = parseBiasResponse(stdout);
        if (!report) {
            console.error('[bias] claude returned unusable output; sending digest without bias');
            return null;
        }
        return { report, lookbackGeneratedAt: history[0]!.generatedAt };
    } catch (e) {
        console.error('[bias] claude call failed; sending digest without bias:', (e as Error).message);
        return null;
    }
}
