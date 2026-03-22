import fs from 'node:fs/promises';
import path from 'node:path';
import type { DecisionRecord } from '../types/pipeline';

export async function writeRunArtifact(
    baseDir: string,
    record: DecisionRecord,
): Promise<string | null> {
    const dir = baseDir.trim();
    if (!dir) return null;
    await fs.mkdir(dir, { recursive: true });
    const safeTs = record.ts.replace(/[:.]/g, '-');
    const file = path.join(dir, `${safeTs}_${record.symbol}_${record.interval}.json`);
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    return file;
}

export async function appendDecisionJsonl(
    baseDir: string,
    record: DecisionRecord,
): Promise<void> {
    const dir = baseDir.trim();
    if (!dir) return;
    const file = path.join(dir, 'decisions.jsonl');
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}
