import 'dotenv/config';
import OpenAI from 'openai';
import { z } from 'zod';
import type {
    DailyValueArea,
    LlmCritique,
    MarketState,
    SignalBundle,
    StrategyResult,
} from './types/pipeline';

const CritiqueSchema = z.object({
    risk_flags: z.array(z.string()),
    score_adjustment: z.number(),
    comment: z.string(),
    veto: z.boolean().optional(),
});

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'llama-3.1-70b-versatile').trim();

const openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_BASE_URL });

const ADJ_HARD_MIN = Number(process.env.SCORE_ADJUST_MIN ?? -2);
const ADJ_HARD_MAX = Number(process.env.SCORE_ADJUST_MAX ?? 1);

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
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

function compactMarketState(state: MarketState): Record<string, unknown> {
    const base: Record<string, unknown> = {
        symbol: state.symbol,
        primaryInterval: state.primaryInterval,
        latest: state.latest,
        trend: state.trend,
        structure: state.structure,
        volatility: state.volatility,
        indicators: state.indicators,
        htf: state.htf,
        ltf: state.ltf,
        swings: state.swings,
    };
    if (state.dailyValueArea) {
        base.daily_value_area = dailyValueAreaPayload(state.dailyValueArea);
    }
    return base;
}

function dailyValueAreaPayload(d: DailyValueArea): Record<string, unknown> {
    const o: Record<string, unknown> = {
        consolidation_start_date: d.consolidationStartDate,
        first_bar_time: d.firstBarTime,
        last_bar_time: d.lastBarTime,
        poc: d.poc,
        vah: d.vah,
        val: d.val,
        value_area_pct: d.valueAreaPct,
        bar_count: d.barCount,
    };
    if (d.note) o.note = d.note;
    return o;
}

export async function getLlmCritique(input: {
    market_state: MarketState;
    signals: SignalBundle;
    strategy: StrategyResult;
    /** Operator macro view (e.g. bull/bear); omitted from payload when empty. */
    operator_market_environment?: string;
}): Promise<LlmCritique> {
    if (!OPENAI_API_KEY) {
        throw new Error('Missing OPENAI_API_KEY in environment.');
    }

    const system = `You are a trading risk critic. Output ONLY valid JSON with keys:
- risk_flags: string[] (e.g. "low_volume", "against_htf_trend")
- score_adjustment: number between ${ADJ_HARD_MIN} and ${ADJ_HARD_MAX} (negative = reduce conviction)
- comment: short string
- veto: optional boolean; if true the setup must be skipped

Rules:
- You must NOT propose trades, direction, entries, stop loss, or take profit levels.
- You only critique the given strategy candidate using the structured state.
- If operator_market_environment is present, treat it as the human operator's macro regime view; never mention operator_market_environment in the critique.
- Answer: strongest reasons to avoid this trade, trap vs continuation, HTF conflicts, late vs early setup.`;

    const note = (input.operator_market_environment || '').trim();
    const payload: Record<string, unknown> = {
        market_state: compactMarketState(input.market_state),
        signals: input.signals,
        strategy: {
            name: input.strategy.name,
            score: input.strategy.score,
            context: input.strategy.context,
            invalidation: input.strategy.invalidation,
        },
    };
    if (note) payload.operator_market_environment = note;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: system },
        {
            role: 'user',
            content: `Critique this candidate and return JSON only.\n\n${JSON.stringify(payload)}`,
        },
    ];

    const useJsonMode =
        OPENAI_BASE_URL.includes('openai.com') || process.env.OPENAI_JSON_MODE === '1';
    const req: Parameters<typeof openai.chat.completions.create>[0] = {
        model: OPENAI_MODEL,
        messages,
        temperature: 0.2,
    };
    if (useJsonMode) {
        (req as { response_format?: { type: string } }).response_format = { type: 'json_object' };
    }

    const completion = await openai.chat.completions.create(req as any);
    const content = completion.choices?.[0]?.message?.content || '';
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        const extracted = extractFirstJsonObject(content);
        if (!extracted) {
            throw new Error('Failed to parse JSON from model response');
        }
        parsed = extracted;
    }

    const validated = CritiqueSchema.safeParse(parsed);
    if (!validated.success) {
        throw new Error(`Invalid critique schema: ${validated.error.message}`);
    }

    const lo = Number.isFinite(ADJ_HARD_MIN) ? ADJ_HARD_MIN : -3;
    const hi = Number.isFinite(ADJ_HARD_MAX) ? ADJ_HARD_MAX : 1;
    const score_adjustment = clamp(validated.data.score_adjustment, lo, hi);

    return {
        risk_flags: validated.data.risk_flags,
        score_adjustment,
        comment: validated.data.comment,
        veto: validated.data.veto,
    };
}
