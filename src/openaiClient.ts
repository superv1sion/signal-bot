import 'dotenv/config';
import OpenAI from 'openai';
import { z } from 'zod';

export type SignalResponse = {
    signal: 'buy' | 'sell' | 'hold';
    confidence: number; // 0..1
    reason: string;
    takeProfits: number[]; // exactly 3 absolute prices
    stopLoss: number;   // absolute price
    entryType: 'now' | 'limit';
    entryPrice: number; // if entryType=now, this is latest.close; if limit, this is suggested limit price
    riskReward: number[]; // reward/risk per TP: [rr1, rr2, rr3]
};

const SignalSchema = z.object({
    signal: z.enum(['buy', 'sell', 'hold']),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(500),
    takeProfits: z.array(z.number().positive()).length(3),
    stopLoss: z.number().positive(),
    entryType: z.enum(['now', 'limit']),
    entryPrice: z.number().positive(),
    riskReward: z.array(z.number().min(0)).length(3),
});

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'llama-3.1-70b-versatile').trim();

const openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_BASE_URL });

export async function getSignalFromOpenAI(input: {
    symbol: string;
    interval: string;
    candles: Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
    indicators: {
        rsi: number[];
        ema20: number[];
        ema50: number[];
        macd: { line: number[]; signal: number[]; histogram: number[] };
        bollinger: { upper: number[]; middle: number[]; lower: number[] };
        atr: number[];
        obv: number[];
    };
    higherTimeframe: {
        timeframe?: string;
        ema50?: number;
        trend?: 'up' | 'down' | 'flat';
        ema50_H1?: number | undefined; // backward compatibility
    };
    runtimeGuards?: {
        atrLast?: number;
        bbWidth?: number;
        htfTrend?: 'up' | 'down' | 'flat';
        obvDelta?: number;
        swingHigh?: number;
        swingLow?: number;
    };
}): Promise<SignalResponse> {
    if (!OPENAI_API_KEY) {
        throw new Error('Missing OPENAI_API_KEY in environment.');
    }
    const system = `You are a precise trading signal generator. Return ONLY valid JSON with fields:
signal ("buy"|"sell"|"hold"), confidence (0..1), reason,
takeProfits (array of 3 numbers), stopLoss (number),
entryType ("now"|"limit"), entryPrice (number),
riskReward (array of 3 numbers).

Base judgment strictly on provided data (candles, indicators, optionally higherTimeframe).
Use absolute prices only (no %). JSON must contain numeric values (no quotes around numbers, no thousand separators).

Definitions:
- latest = last candle of the working timeframe.
- refPrice = (entryType == "now") ? latest.close : entryPrice.
- ATR = latest value of indicators.atr (working TF).
- HTF = higherTimeframe.* if provided (e.g., EMA50 and/or candles).

Direction filter (multi-timeframe):
- BUY only if HTF EMA50 trend is upward; SELL only if downward; otherwise HOLD.

StopLoss:
- Must be at least 1×ATR away from refPrice.
- Prefer beyond the most recent swing (for BUY: below swing low; for SELL: above swing high).
- Do not exceed 2.5×ATR distance unless the nearest meaningful swing is farther (then use the swing).

TakeProfits (level‑aware and realistic):
1) Always anchor TP1 to the nearest meaningful level in the signal direction:
   - Prefer the first HTF resistance (for BUY) / HTF support (for SELL) derived from recent swing highs/lows
     on higherTimeframe candles if provided; otherwise use prominent LTF levels from the last N candles.
   - Place TP1 just before that level (buffer ≈ 0.2–0.5×ATR toward refPrice) to account for front‑running.
2) TP2 = next level beyond TP1 (next HTF/LTF swing or round/psychological level) OR, if no clear level,
   use ~2×ATR from refPrice (BUY: above, SELL: below).
3) TP3 = extension to the next level beyond TP2 OR ~3×ATR from refPrice.
Constraints for all TPs:
- For BUY: TP1 < TP2 < TP3 and each strictly > refPrice.
- For SELL: TP1 > TP2 > TP3 and each strictly < refPrice.
- Each TP must be ≥ 0.1% away from refPrice.
- “Ceiling/Floor” guard: do not place TP beyond the most recent major HTF extreme (e.g., last 30–60 days high/low)
  unless such extreme is within ≤ 0.5×ATR beyond your planned TP; otherwise clip to just before that extreme.
- Ensure at least one TP has riskReward ≥ 2. If this cannot be satisfied with realistic levels → signal = HOLD.

Entry logic:
- entryType = "now" if a breakout is confirmed (e.g., close above EMA20 for BUY / below EMA20 for SELL) and
  the nearest level is within ~0.4–1.0×ATR; otherwise use "limit" at a reasonable retest price (EMA20 or BB middle).
- entryPrice must be consistent with direction and near the chosen entry rationale.

Volatility/Chop filter:
- Compute BB width = (bollinger.upper_last - bollinger.lower_last)/max(bollinger.middle_last, 1e-9).
- If BB width < 0.01 → HOLD.

Confidence (vary with data; never constant):
- Start from directional confluence of latest values:
  BUY supporting = [ema20_last > ema50_last, latest.close > ema20_last,
                    macd.line_last > macd.signal_last, macd.line_last > 0, rsi_last > 55, obv_trending_up].
  SELL supporting = [ema20_last < ema50_last, latest.close < ema20_last,
                     macd.line_last < macd.signal_last, macd.line_last < 0, rsi_last < 45, obv_trending_down].
  confluence = (#true)/(#considered).
- avgRR = average(riskReward); rrFactor = clamp(avgRR, 0, 3)/3.
- levelFactor = 1 if TP1 is placed at/just before a clear level per rules, else 0.5.
- volNorm = clamp(BB_width/0.02, 0, 1).
- confidence = roundTo2(clamp(0.2 + 0.4*confluence + 0.25*rrFactor + 0.15*levelFactor - 0.1*volNorm, 0.05, 0.98)).
Penalties:
- If stopLoss distance < 1×ATR → reduce confidence by ≥ 0.2.
- If avgRR < 1.5 → reduce by ≥ 0.15.
Caps:
- Cap at 0.85 unless direction aligns with HTF trend AND OBV confirms; then up to 0.98 allowed.
- If signal is HOLD, confidence ≤ 0.4.

Self‑check before responding:
- Validate direction filter, volatility filter, SL distance, TP monotonicity/spacing, RR math, level anchoring,
  HTF ceiling/floor guard, and numeric JSON formatting (no strings). If any rule is violated, adjust values or return HOLD.

On HOLD:
- takeProfits = [latest.close, latest.close, latest.close]
- stopLoss   = latest.close
- entryType  = "now"
- entryPrice = latest.close
- riskReward = [0,0,0]
Return JSON only, with numbers only, and no extra fields.`;

    const payload = {
        symbol: input.symbol,
        interval: input.interval,
        latest: input.candles[input.candles.length - 1],
        candles: input.candles,
        indicators: input.indicators,
        higherTimeframe: input.higherTimeframe?.timeframe || input.higherTimeframe?.ema50 !== undefined
            ? { timeframe: input.higherTimeframe?.timeframe, ema50: input.higherTimeframe?.ema50, trend: (input.higherTimeframe as any)?.trend }
            : { ema50_H1: input.higherTimeframe?.ema50_H1 },
        instructions: 'Analyze RSI, EMA(20/50), MACD, Bollinger, ATR, OBV, and higher timeframe EMA. Output JSON only.'
    };

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: system },
        { role: 'user', content: `Analyze the following market data and return only a JSON object with the specified schema.\n\n${JSON.stringify(payload)}` },
    ];

    try {
        const useJsonMode = OPENAI_BASE_URL.includes('openai.com') || process.env.OPENAI_JSON_MODE === '1';
        const req: Parameters<typeof openai.chat.completions.create>[0] = {
            model: OPENAI_MODEL,
            messages,
            temperature: 0.2,
        };
        if (useJsonMode) {
            // Some providers (OpenAI) support structured JSON mode
            // For others (e.g., Groq), we skip this to avoid 400 errors
            (req as any).response_format = { type: 'json_object' };
        }
        const completion = await openai.chat.completions.create(req as any);

        const content = completion.choices?.[0]?.message?.content || '';
        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch {
            // Fallback: try to extract first JSON object from text
            const extracted = extractFirstJsonObject(content);
            if (!extracted) {
                throw new Error('Failed to parse JSON from model response');
            }
            parsed = extracted;
        }
        const validated = SignalSchema.safeParse(parsed);
        if (!validated.success) {
            throw new Error(`Invalid OpenAI response schema: ${validated.error.message}`);
        }
        // Enforce logical constraints relative to entry and direction to avoid inconsistent outputs
        const latestClose = payload.latest.close;
        return enforceConstraints({
            signal: validated.data,
            latestClose,
            indicators: input.indicators,
            candles: input.candles,
            higherTimeframe: input.higherTimeframe,
            runtimeGuards: input.runtimeGuards,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`OpenAI request failed: ${message}`);
    }
}

function extractFirstJsonObject(text: string): unknown | null {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '{') depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                const candidate = text.slice(start, i + 1);
                try {
                    return JSON.parse(candidate);
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

function enforceConstraints(params: {
    signal: SignalResponse;
    latestClose: number;
    indicators: {
        rsi: number[];
        ema20: number[];
        ema50: number[];
        macd: { line: number[]; signal: number[]; histogram: number[] };
        bollinger: { upper: number[]; middle: number[]; lower: number[] };
        atr: number[];
        obv: number[];
    };
    candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    higherTimeframe?: { timeframe?: string; ema50?: number; trend?: 'up' | 'down' | 'flat'; ema50_H1?: number };
    runtimeGuards?: { atrLast?: number; bbWidth?: number; htfTrend?: 'up' | 'down' | 'flat'; obvDelta?: number; swingHigh?: number; swingLow?: number };
}): SignalResponse {
    const { signal, latestClose, indicators, candles, runtimeGuards, higherTimeframe } = params;
    const minGap = Math.max(latestClose * 0.001, 0.01); // >= 0.1% or 0.01
    const refPrice = signal.entryType === 'now' ? latestClose : signal.entryPrice;
    const clampPositive = (n: number) => (n > 0 ? n : minGap);

    // Compute helpers
    const atrLast = runtimeGuards?.atrLast ?? indicators.atr[indicators.atr.length - 1] ?? 0;
    const bbUpperLast = indicators.bollinger.upper[indicators.bollinger.upper.length - 1] ?? refPrice;
    const bbLowerLast = indicators.bollinger.lower[indicators.bollinger.lower.length - 1] ?? refPrice;
    const bbMiddleLast = indicators.bollinger.middle[indicators.bollinger.middle.length - 1] ?? 1e-9;
    const bbWidth = runtimeGuards?.bbWidth ?? (bbUpperLast - bbLowerLast) / Math.max(bbMiddleLast, 1e-9);
    const obvDelta = runtimeGuards?.obvDelta ?? ((indicators.obv.length >= 2) ? (indicators.obv[indicators.obv.length - 1] - indicators.obv[indicators.obv.length - 2]) : 0);
    const swingWindow = 10;
    const recent = candles.slice(-swingWindow);
    const swingHigh = runtimeGuards?.swingHigh ?? recent.reduce((m, c) => Math.max(m, c.high), -Infinity);
    const swingLow = runtimeGuards?.swingLow ?? recent.reduce((m, c) => Math.min(m, c.low), Infinity);
    const htfTrend = runtimeGuards?.htfTrend ?? higherTimeframe?.trend; // optional external computation

    // // Volatility filter → HOLD
    // if (bbWidth < 0.01) {
    //     return {
    //         ...signal,
    //         signal: 'hold',
    //         confidence: Math.min(signal.confidence, 0.4),
    //         entryType: 'now',
    //         entryPrice: latestClose,
    //         stopLoss: latestClose,
    //         takeProfits: [latestClose, latestClose, latestClose],
    //         riskReward: [0, 0, 0],
    //         reason: `${signal.reason} | Low volatility (BB width < 0.01) → HOLD`,
    //     };
    // }

    // Direction filter based on higher timeframe trend (if provided)
    if (signal.signal === 'buy' && htfTrend && htfTrend !== 'up') {
        return { ...signal, signal: 'hold', confidence: Math.min(signal.confidence, 0.4), entryType: 'now', entryPrice: latestClose, stopLoss: latestClose, takeProfits: [latestClose, latestClose, latestClose], riskReward: [0, 0, 0], reason: `${signal.reason} | HTF trend not up → HOLD` };
    }
    if (signal.signal === 'sell' && htfTrend && htfTrend !== 'down') {
        return { ...signal, signal: 'hold', confidence: Math.min(signal.confidence, 0.4), entryType: 'now', entryPrice: latestClose, stopLoss: latestClose, takeProfits: [latestClose, latestClose, latestClose], riskReward: [0, 0, 0], reason: `${signal.reason} | HTF trend not down → HOLD` };
    }

    if (signal.signal === 'hold') {
        return {
            ...signal,
            entryType: 'now',
            entryPrice: latestClose,
            stopLoss: latestClose,
            takeProfits: [latestClose, latestClose, latestClose],
            riskReward: [0, 0, 0],
        };
    }

    const ensureTpsAndSlForBuy = (): SignalResponse => {
        let stopLoss = Math.min(signal.stopLoss, refPrice - minGap);
        // Enforce at least 1×ATR distance
        stopLoss = Math.min(stopLoss, refPrice - Math.max(atrLast, minGap));
        // Respect swing low if available
        if (Number.isFinite(swingLow)) {
            stopLoss = Math.min(stopLoss, swingLow - minGap);
        }
        stopLoss = clampPositive(stopLoss);

        const sorted = [...signal.takeProfits].sort((a, b) => a - b);
        const tps: number[] = [];
        let last = refPrice;
        for (let i = 0; i < 3; i += 1) {
            const minTp = refPrice * 1.001; // +0.1%
            const candidate = Math.max(sorted[i] ?? refPrice + (i + 1) * minGap, last + minGap, minTp);
            tps.push(candidate);
            last = candidate;
        }
        const risk = Math.max(refPrice - stopLoss, minGap);
        const rr = tps.map((tp) => Number(((tp - refPrice) / risk).toFixed(2)));
        return { ...signal, stopLoss, takeProfits: tps, riskReward: rr };
    };

    const ensureTpsAndSlForSell = (): SignalResponse => {
        let stopLoss = Math.max(signal.stopLoss, refPrice + minGap);
        // Enforce at least 1×ATR distance
        stopLoss = Math.max(stopLoss, refPrice + Math.max(atrLast, minGap));
        // Respect swing high if available
        if (Number.isFinite(swingHigh)) {
            stopLoss = Math.max(stopLoss, swingHigh + minGap);
        }
        stopLoss = clampPositive(stopLoss);

        const sorted = [...signal.takeProfits].sort((a, b) => b - a);
        const tps: number[] = [];
        let last = refPrice;
        for (let i = 0; i < 3; i += 1) {
            const maxTp = refPrice * 0.999; // -0.1%
            const candidate = Math.min(sorted[i] ?? refPrice - (i + 1) * minGap, last - minGap, maxTp);
            tps.push(candidate);
            last = candidate;
        }
        const risk = Math.max(stopLoss - refPrice, minGap);
        const rr = tps.map((tp) => Number(((refPrice - tp) / risk).toFixed(2)));
        return { ...signal, stopLoss, takeProfits: tps, riskReward: rr };
    };

    let adjusted: SignalResponse = signal.signal === 'buy' ? ensureTpsAndSlForBuy() : ensureTpsAndSlForSell();

    // Risk-reward requirements
    const avgRR = adjusted.riskReward.reduce((s, v) => s + v, 0) / adjusted.riskReward.length;
    const hasRR2 = adjusted.riskReward.some((v) => v >= 2);
    const slDistance = Math.abs(adjusted.stopLoss - refPrice);
    const minAtrDistance = Math.max(atrLast, minGap);
    // if (!hasRR2 || slDistance < minAtrDistance) {
    //     adjusted = {
    //         ...adjusted,
    //         signal: 'hold',
    //         confidence: Math.min(adjusted.confidence, 0.4),
    //         entryType: 'now',
    //         entryPrice: latestClose,
    //         stopLoss: latestClose,
    //         takeProfits: [latestClose, latestClose, latestClose],
    //         riskReward: [0, 0, 0],
    //         reason: `${adjusted.reason} | RR/ATR constraints not met → HOLD`,
    //     };
    //     return adjusted;
    // }

    // Confidence adjustments: reduce if SL < 1×ATR or avg RR < 1.5
    let confidence = adjusted.confidence;
    if (slDistance < minAtrDistance) confidence *= 0.8;
    if (avgRR < 1.5) confidence *= 0.85;

    // Cap at 0.85 unless aligned with HTF and OBV confirms
    const obvConfirms = (adjusted.signal === 'buy' && obvDelta > 0) || (adjusted.signal === 'sell' && obvDelta < 0);
    const aligned = (adjusted.signal === 'buy' && htfTrend === 'up') || (adjusted.signal === 'sell' && htfTrend === 'down');
    if (!(aligned && obvConfirms)) confidence = Math.min(confidence, 0.85);
    confidence = Math.max(0.05, Math.min(0.98, Number(confidence.toFixed(2))));

    return { ...adjusted, confidence };
}


