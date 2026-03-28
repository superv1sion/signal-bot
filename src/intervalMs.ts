/** Kline interval string (Binance-style) → bar length in ms. */
export function intervalToMilliseconds(tf: string): number {
    const s = tf.trim();
    if (s === '1M') return 30 * 24 * 60 * 60 * 1000;
    const lower = s.toLowerCase();
    const m = /^(\d+)(m|h|d|w)$/.exec(lower);
    if (!m) return 5 * 60 * 1000;
    const n = Number(m[1]);
    const u = m[2];
    const minuteMs = 60_000;
    if (u === 'm') return n * minuteMs;
    if (u === 'h') return n * 60 * minuteMs;
    if (u === 'd') return n * 24 * 60 * minuteMs;
    if (u === 'w') return n * 7 * 24 * 60 * minuteMs;
    return 5 * 60 * 1000;
}
