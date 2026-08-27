/**
 * Deterministic formatter for the BTC analyst digest: turns ./data/analyst-snapshot-latest.json
 * into the exact Telegram HTML text that used to be written by hand each run.
 *
 * Every rule here was previously prose in .claude/skills/analyst-cron/prompt.md — level ordering,
 * 🟢/🔴 vs current price, ⬆️/⬇️/➖ vs the previous run, the BMSB dedupe and proximity-cluster
 * selection for Trade Setup Watch. Encoding them means the hourly digest no longer needs a live
 * Claude session to render, so it can run from launchd on time regardless.
 *
 * Deliberately omitted: the On-chain block (mempool/fees/difficulty — not actionable here) and the
 * trailing "proximity watch, not a trade signal" disclaimer.
 *
 * The one non-deterministic part is the optional 🧠 Bias block: its wording comes from the Claude
 * CLI (see generateBias.ts), but the glyphs, escaping, and window label are still rendered here.
 *
 * Usage:
 *   npx tsx scripts/analyst/formatDigest.ts            # prints digest for the latest snapshot
 *   npx tsx scripts/analyst/formatDigest.ts <path>     # or an explicit snapshot file
 */
import fs from 'node:fs';
import type { BiasResult } from './generateBias';

const DEFAULT_SNAPSHOT_PATH = process.env.ANALYST_SNAPSHOT_OUTPUT || './data/analyst-snapshot-latest.json';

/** Values below this relative change count as unchanged (➖) rather than ⬆️/⬇️. */
const TREND_EPSILON_PCT = 0.01;
/** Trade Setup Watch: stop widening the cluster once consecutive levels differ by more than this. */
const CLUSTER_GAP_PCT_POINTS = 2;
const MAX_WATCH_LEVELS = 3;

type LevelTrend = 'approaching' | 'moving_away' | 'flat' | 'insufficient_history';

type ProximityLevel = {
    label: string;
    value: number;
    distancePercent: number;
    role: 'support' | 'resistance';
    trend: LevelTrend;
};

export type Snapshot = {
    generatedAt: string;
    generatedAtHuman: string;
    price: { close: number; previousClose: number | null; previousGeneratedAt: string | null; changeAbs: number | null };
    keyLevels: Array<{ label: string; price: number }>;
    movingAverages: Array<{ type: string; period: number; interval: string; latest: number; previous: number | null }>;
    bmsb: {
        smaPeriod: number;
        emaPeriod: number;
        lower: number;
        upper: number;
        previousLower: number | null;
        previousUpper: number | null;
    } | null;
    vwaps: Array<{ label: string; anchorTimeHuman: string; interval: string; latest: number; previous: number | null }>;
    volumeProfile: {
        label: string;
        startTimeHuman: string;
        endTimeHuman: string;
        interval: string;
        poc: number;
        vah: number;
        val: number;
        previousPoc: number | null;
        previousVah: number | null;
        previousVal: number | null;
    };
    fibLevels: Array<{ label: string; levels: Array<{ ratio: number; price: number; previous: number | null }> }>;
    proximityWatch: { lookbackGeneratedAt: string | null; lookbackGeneratedAtHuman: string | null; levels: ProximityLevel[] };
    context: {
        interval: string;
        rsi14: number;
        previousRsi14: number | null;
        atr14: number;
        previousAtr14: number | null;
        bollinger20: { upper: number; middle: number; lower: number };
        previousBollinger20: { upper: number; middle: number; lower: number } | null;
    };
    derivatives:
        | { fundingRate: number; openInterest: number; previousFundingRate: number | null; previousOpenInterest: number | null }
        | { error: string };
    news: { headlines: Array<{ title: string; publishedAt: string }> } | { error: string };
};

function num(n: number): string {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 🟢 when price sits above the level, 🔴 when below — evaluated per value, never per section. */
function dot(price: number, level: number): string {
    return price > level ? '🟢' : '🔴';
}

/** ⬆️/⬇️ past TREND_EPSILON_PCT, ➖ within it, and nothing at all when there's no prior run to compare. */
function trend(latest: number, previous: number | null | undefined): string {
    if (previous === null || previous === undefined || previous === 0) return '';
    const changePct = ((latest - previous) / Math.abs(previous)) * 100;
    if (changePct > TREND_EPSILON_PCT) return ' ⬆️';
    if (changePct < -TREND_EPSILON_PCT) return ' ⬇️';
    return ' ➖';
}

/**
 * Distance from current price, signed the same way proximityWatch does it: positive means the
 * level sits above price. Answers "how far to this level" without cross-referencing the Price line.
 */
function distance(price: number, value: number): string {
    const pct = ((value - price) / price) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/** A level value with all three marks, e.g. "67,556.00 🟢 ⬆️ (-2.14%)". */
function level(price: number, value: number, previous: number | null | undefined): string {
    return `${num(value)} ${dot(price, value)}${trend(value, previous)} (${distance(price, value)})`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** "Aug 22, 2026" from an RSS pubDate; falls back to the raw string if unparseable. */
function newsDate(publishedAt: string): string {
    const d = new Date(publishedAt);
    if (Number.isNaN(d.getTime())) return publishedAt;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const HEADLINE_MAX_CHARS = 110;

/** Drops the trailing ": <roundup>" clause CoinDesk appends, then caps length on a word boundary. */
function trimHeadline(title: string): string {
    const withoutSuffix = title.includes(': ') ? title.slice(0, title.lastIndexOf(': ')) : title;
    if (withoutSuffix.length <= HEADLINE_MAX_CHARS) return withoutSuffix;
    const cut = withoutSuffix.slice(0, HEADLINE_MAX_CHARS);
    return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/**
 * BTC-relevant headlines first — an altcoin rally isn't context for a BTC digest. Requires the
 * mention in the title's first half so BTC reads as the subject: a Zcash story ending "...adds to
 * 'next bitcoin' buzz" name-drops it but isn't about it.
 */
function pickHeadlines(headlines: Array<{ title: string; publishedAt: string }>): Array<{ title: string; publishedAt: string }> {
    const btc = headlines.filter((h) => {
        const match = /bitcoin|btc/i.exec(h.title);
        return match !== null && match.index < h.title.length / 2;
    });
    return (btc.length > 0 ? btc : headlines).slice(0, 2);
}

/** "~3h50m" / "~45m" of real elapsed time between two runs — history isn't reliably hourly. */
export function elapsed(fromIso: string, toIso: string): string {
    const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 'an unknown interval';
    const totalMinutes = Math.round(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `~${minutes}m`;
    if (minutes === 0) return `~${hours}h`;
    return `~${hours}h${String(minutes).padStart(2, '0')}m`;
}

/**
 * Coarse "1h" / "45m" / "9h" for labelling the price-change window. Deliberately rounded — it's
 * context for the delta, not a measurement. Matters after sleep: launchd coalesces every missed
 * fire into one run on wake, so the catch-up digest's change can span a whole night.
 */
function coarseElapsed(fromIso: string, toIso: string): string | null {
    const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.round(minutes / 60)}h`;
}

/**
 * BMSB lower/upper sit within ~0.01% of each other, so they collapse into one logical band entry
 * (ranked by whichever side is closer) rather than burning two of the three watch slots.
 */
function dedupeBmsb(levels: ProximityLevel[]): ProximityLevel[] {
    const bmsb = levels.filter((l) => l.label.startsWith('BMSB '));
    if (bmsb.length === 0) return levels;

    const rest = levels.filter((l) => !l.label.startsWith('BMSB '));
    const nearest = bmsb.reduce((a, b) => (Math.abs(a.distancePercent) <= Math.abs(b.distancePercent) ? a : b));
    const lower = Math.min(...bmsb.map((l) => l.value));
    const upper = Math.max(...bmsb.map((l) => l.value));

    return [...rest, { ...nearest, label: `BMSB band: ${num(lower)}–${num(upper)}` }];
}

/**
 * Picks the tight cluster of levels price is actually moving toward: approaching-only, nearest
 * first, widening outward only while consecutive gaps stay within CLUSTER_GAP_PCT_POINTS. A single
 * large gap ends the walk — a far-off cluster never gets pulled in just to fill the third slot.
 */
export function selectWatchLevels(levels: ProximityLevel[]): ProximityLevel[] {
    const candidates = dedupeBmsb(levels)
        .filter((l) => l.trend === 'approaching')
        .sort((a, b) => Math.abs(a.distancePercent) - Math.abs(b.distancePercent));

    const picked: ProximityLevel[] = [];
    for (const candidate of candidates) {
        if (picked.length === 0) {
            picked.push(candidate);
            continue;
        }
        if (picked.length >= MAX_WATCH_LEVELS) break;
        const previous = picked[picked.length - 1]!;
        const gap = Math.abs(candidate.distancePercent) - Math.abs(previous.distancePercent);
        if (gap > CLUSTER_GAP_PCT_POINTS) break;
        picked.push(candidate);
    }
    return picked;
}

function describeTrend(l: ProximityLevel, watch: Snapshot['proximityWatch'], generatedAt: string): string {
    if (l.trend === 'insufficient_history' || !watch.lookbackGeneratedAt) {
        return 'not enough history yet';
    }
    const window = `${elapsed(watch.lookbackGeneratedAt, generatedAt)} (since ${watch.lookbackGeneratedAtHuman})`;
    if (l.trend === 'approaching') return `approaching over the past ${window}`;
    if (l.trend === 'moving_away') return `moving away over the past ${window}`;
    return `flat over the past ${window}`;
}

function displayName(l: ProximityLevel): string {
    return l.label.startsWith('BMSB band') ? 'the BMSB band' : l.label;
}

function approx(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}

/**
 * Which side a level is being watched from: a reaction at support is the long side, a reaction at
 * resistance the short side. Breaking through flips it, which reactionBullet spells out.
 */
function setupTag(l: ProximityLevel): string {
    return l.role === 'support' ? '📈 LONG' : '📉 SHORT';
}

/**
 * What a reaction implies, pointing only at other levels already listed above — never a made-up
 * number. The onward level must sit on the same side as the break (below for support, above for
 * resistance); a nearer level on the opposite side isn't where price would head next.
 */
function reactionBullet(l: ProximityLevel, others: ProximityLevel[]): string {
    const name = displayName(l);
    const isSupport = l.role === 'support';

    const beyond = others
        .filter((o) => o !== l && (isSupport ? o.value < l.value : o.value > l.value))
        .sort((a, b) => (isSupport ? b.value - a.value : a.value - b.value))[0];

    if (isSupport) {
        const onward = beyond
            ? `a break below opens room toward ${displayName(beyond)} at ~${approx(beyond.value)}`
            : 'a break below leaves price without another nearby approaching level to catch it';
        return `• A reaction at ${name} (~${approx(l.value)}) would confirm it as support — long setup; ${onward}, flipping the bias short`;
    }
    const onward = beyond
        ? `a clean break above opens room toward ${displayName(beyond)} at ~${approx(beyond.value)}`
        : 'a clean break above leaves price without another nearby approaching level to slow it';
    return `• A reaction at ${name} (~${approx(l.value)}) would confirm it as resistance — short setup; ${onward}, flipping the bias long`;
}

/** 🐂/🐻/⚖️ rather than 🟢/🔴 or ⬆️/⬇️ — both of those already mean something else in this digest. */
function biasGlyph(bias: string): string {
    if (bias === 'bullish') return '🐂';
    if (bias === 'bearish') return '🐻';
    return '⚖️';
}

/**
 * The model's read, rendered here rather than by the model: notes are escaped, glyphs and the
 * comparison window are ours. The window is measured from the oldest compared entry, so the 07:11
 * run correctly says ~13h rather than implying the six entries were hourly.
 */
export function renderBiasBlock(bias: BiasResult, generatedAt: string): string {
    const { report } = bias;
    return [
        `🧠 <b>Bias</b> (vs ${elapsed(bias.lookbackGeneratedAt, generatedAt)} ago)`,
        ...report.timeframes.map(
            (t) => `• ${escapeHtml(t.tf)}: ${biasGlyph(t.bias)} ${t.bias} — ${escapeHtml(t.note)}`
        ),
        `• Overall: ${biasGlyph(report.overall.bias)} ${report.overall.bias} — ${escapeHtml(report.overall.note)}`,
    ].join('\n');
}

export function formatDigest(s: Snapshot, bias?: BiasResult | null): string {
    const price = s.price.close;
    const blocks: string[] = [];

    let change = '';
    if (s.price.previousClose !== null && s.price.changeAbs !== null) {
        const rounded = Math.round(s.price.changeAbs);
        // A sub-dollar move rounds to zero; "-$0" would read as a bug, so drop the sign there.
        const delta = rounded === 0 ? '$0' : `${rounded > 0 ? '+' : '-'}$${Math.abs(rounded).toLocaleString('en-US')}`;
        const window = s.price.previousGeneratedAt ? coarseElapsed(s.price.previousGeneratedAt, s.generatedAt) : null;
        change = window ? ` (${delta} vs ${window} ago)` : ` (${delta})`;
    }
    blocks.push(['💰 <b>Price</b>', `• $${num(price)}${change}`].join('\n'));

    const mas = [...s.movingAverages].sort((a, b) => b.latest - a.latest);
    blocks.push(
        [
            '📊 <b>Moving Averages</b>',
            ...mas.map((ma) => `• ${ma.type}${ma.period} (${ma.interval}): ${level(price, ma.latest, ma.previous)}`),
        ].join('\n')
    );

    if (s.bmsb) {
        const { lower, upper, previousLower, previousUpper } = s.bmsb;
        const position = price > upper ? 'above' : price < lower ? 'below' : 'inside';
        blocks.push(
            [
                '🎯 <b>BMSB</b>',
                `• ${level(price, lower, previousLower)} – ${level(price, upper, previousUpper)}`,
                `• Price is currently ${position} the BMSB band`,
            ].join('\n')
        );
    }

    if (s.vwaps.length > 0) {
        blocks.push(
            [
                '📐 <b>Anchored VWAP</b>',
                ...s.vwaps.map((v) => {
                    const placeholder = v.label.toLowerCase().includes('placeholder') ? ' — config label still says "placeholder"' : '';
                    return `• VWAP (${v.interval}, anchor: ${v.anchorTimeHuman}): ${level(price, v.latest, v.previous)}${placeholder}`;
                }),
            ].join('\n')
        );
    }

    const vp = s.volumeProfile;
    const vpPlaceholder = vp.label.toLowerCase().includes('placeholder') ? ' — config label still says "placeholder"' : '';
    blocks.push(
        [
            '📉 <b>Volume Profile</b>',
            `• Range (${vp.interval}): ${vp.startTimeHuman} – ${vp.endTimeHuman}${vpPlaceholder}`,
            `• POC (${vp.interval}): ${level(price, vp.poc, vp.previousPoc)}`,
            `• VAH (${vp.interval}): ${level(price, vp.vah, vp.previousVah)}`,
            `• VAL (${vp.interval}): ${level(price, vp.val, vp.previousVal)}`,
        ].join('\n')
    );

    if (s.fibLevels.length > 0) {
        blocks.push(
            [
                '📏 <b>Fib Levels</b>',
                ...s.fibLevels.flatMap((fib) =>
                    fib.levels.map((l) => `• ${fib.label} ${l.ratio}: ${level(price, l.price, l.previous)}`)
                ),
            ].join('\n')
        );
    }

    if (s.keyLevels.length > 0) {
        // No trend arrow: these are static config values with no prior-run series to compare.
        blocks.push(
            [
                '🔑 <b>Key Levels</b>',
                ...s.keyLevels.map((k) => `• ${k.label}: ${num(k.price)} ${dot(price, k.price)} (${distance(price, k.price)})`),
            ].join('\n')
        );
    }

    const c = s.context;
    const boll = c.bollinger20;
    const prevBoll = c.previousBollinger20;
    blocks.push(
        [
            '🧭 <b>Context</b>',
            `• RSI14 (${c.interval}): ${c.rsi14.toFixed(2)}${trend(c.rsi14, c.previousRsi14)}`,
            `• ATR14 (${c.interval}): ${c.atr14.toFixed(2)}${trend(c.atr14, c.previousAtr14)}`,
            `• Bollinger20 (${c.interval}): upper ${num(boll.upper)}${trend(boll.upper, prevBoll?.upper)} / ` +
                `middle ${num(boll.middle)}${trend(boll.middle, prevBoll?.middle)} / ` +
                `lower ${num(boll.lower)}${trend(boll.lower, prevBoll?.lower)}`,
        ].join('\n')
    );

    if (!('error' in s.derivatives)) {
        const d = s.derivatives;
        blocks.push(
            [
                // Venue on the header: both figures are Binance USDT-perp only, not market-wide.
                '💵 <b>Derivatives</b> — Binance USDT-perp',
                `• Funding rate: ${(d.fundingRate * 100).toFixed(2)}%${trend(d.fundingRate, d.previousFundingRate)}`,
                // Binance returns OI in BTC, not USD — unlabelled it reads like a dollar figure.
                `• Open interest: ${Math.round(d.openInterest).toLocaleString('en-US')} BTC ` +
                    `(~$${((d.openInterest * price) / 1e9).toFixed(2)}B)${trend(d.openInterest, d.previousOpenInterest)}`,
            ].join('\n')
        );
    }

    if (!('error' in s.news) && s.news.headlines.length > 0) {
        blocks.push(
            [
                '📰 <b>News</b>',
                ...pickHeadlines(s.news.headlines).map(
                    (h) => `• ${escapeHtml(trimHeadline(h.title))} (${newsDate(h.publishedAt)})`
                ),
            ].join('\n')
        );
    }

    const picked = selectWatchLevels(s.proximityWatch.levels);
    const watchLines =
        picked.length === 0
            ? ['• no levels currently within notable range']
            : [
                  ...picked.map((l) => {
                      const distance = `${l.distancePercent >= 0 ? '+' : ''}${l.distancePercent.toFixed(2)}% away`;
                      const value = l.label.startsWith('BMSB band') ? '' : `: ${num(l.value)}`;
                      return `• ${setupTag(l)} — ${l.label}${value}, ${distance}, ${l.role}, ${describeTrend(l, s.proximityWatch, s.generatedAt)}`;
                  }),
                  ...picked.map((l) => reactionBullet(l, picked)),
              ];
    blocks.push(['👀 <b>Trade Setup Watch</b>', ...watchLines].join('\n'));

    if (bias) {
        blocks.push(renderBiasBlock(bias, s.generatedAt));
    }

    return blocks.join('\n\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const path = process.argv[2] || DEFAULT_SNAPSHOT_PATH;
    if (!fs.existsSync(path)) {
        console.error(`Snapshot not found at ${path} — run \`npm run analyst-snapshot\` first.`);
        process.exit(1);
    }
    const snapshot = JSON.parse(fs.readFileSync(path, 'utf8')) as Snapshot;
    process.stdout.write(`${formatDigest(snapshot)}\n`);
}
