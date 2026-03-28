import type { DecisionRecord } from '../types/pipeline';

export type StructuredLogLevel = 'info' | 'error' | 'warn';

export type StructuredLogEvent = {
    level: StructuredLogLevel;
    msg: string;
    [key: string]: unknown;
};

type LogFormat = 'human' | 'json' | 'json-pretty';

function logFormat(): LogFormat {
    const v = (process.env.LOG_FORMAT || '').toLowerCase().trim();
    if (v === 'json-pretty') return 'json-pretty';
    if (v === 'json') return 'json';
    return 'human';
}

function stringifyForConsole(payload: unknown): string {
    return logFormat() === 'json-pretty' ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

export function isJsonLogFormat(): boolean {
    const f = logFormat();
    return f === 'json' || f === 'json-pretty';
}

export function logStructured(event: StructuredLogEvent): void {
    if (isJsonLogFormat()) {
        console.log(stringifyForConsole({ ts: new Date().toISOString(), ...event }));
        return;
    }
    const { level, msg, ...rest } = event;
    const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[INFO]';
    if (Object.keys(rest).length > 0) {
        console.log(`${prefix} ${new Date().toISOString()} - ${msg}`, rest);
    } else {
        console.log(`${prefix} ${new Date().toISOString()} - ${msg}`);
    }
}

export function logDecisionRecord(record: DecisionRecord): void {
    if (isJsonLogFormat()) {
        console.log(stringifyForConsole(record));
        return;
    }
    const stratLine =
        record.strategies?.map((s) => `${s.name}=${s.score}`).join(', ') ?? '';
    const sig = record.signals;
    const sigLine = sig
        ? `signals trendAligned=${sig.trendAligned} volSpike=${sig.volumeSpike} sfp=${sig.sfp.valid ? sig.sfp.type : 'off'}`
        : '';
    let llmLine = '';
    if (record.llm) {
        const c = record.llm;
        llmLine = ` LLM adj=${c.score_adjustment} veto=${Boolean(c.veto)} flags=[${c.risk_flags.join(', ')}] "${c.comment.slice(0, 120)}${c.comment.length > 120 ? '…' : ''}"`;
    } else if (record.llmError) {
        llmLine = ` LLM error=${record.llmError.slice(0, 100)}`;
    } else if (record.llmSkippedReason) {
        llmLine = ` LLM skipped=${record.llmSkippedReason}`;
    }
    console.log(
        `[INFO] ${record.ts} decision=${record.decision} symbol=${record.symbol} ${record.interval} best=${record.strategy ?? '-'} score=${record.score ?? '-'} final=${record.finalScore ?? '-'} skip=${record.skipReason ?? '-'}`,
    );
    if (stratLine || sigLine) {
        console.log(`[INFO] ${record.ts} strategies: ${stratLine} | ${sigLine}`);
    }
    if (llmLine) {
        console.log(`[INFO] ${record.ts}${llmLine}`);
    }
    const m = record.marketSummary;
    if (m) {
        console.log(
            `[INFO] ${record.ts} market trend=${m.trend} structure=${m.structure} vol=${m.volatility} rsi=${m.indicators.rsi.toFixed(1)} close=${m.latest.close} htf=${m.htf.trend}`,
        );
        const dva = m.dailyValueArea;
        if (dva) {
            console.log(
                `[INFO] ${record.ts} dailyVA from=${dva.consolidationStartDate} bars=${dva.barCount} POC=${dva.poc.toFixed(2)} VAH=${dva.vah.toFixed(2)} VAL=${dva.val.toFixed(2)} pct=${dva.valueAreaPct}`,
            );
        }
    }
    const pr = record.proposal;
    if (pr) {
        const pct =
            record.levelsMode === 'fixed_pct' &&
            record.targetTpPct !== undefined &&
            record.targetSlPct !== undefined
                ? ` fixedPct tp=${record.targetTpPct}% sl=${record.targetSlPct}%`
                : '';
        console.log(
            `[INFO] ${record.ts} proposal ${pr.direction} entry=${pr.entry} sl=${pr.sl} tp=${pr.tp}${pct}`,
        );
    }
}
