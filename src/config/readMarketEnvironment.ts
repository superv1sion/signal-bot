import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FILENAME = 'MARKET_ENVIRONMENT.md';

/**
 * Free-form note from disk for the LLM risk critic (macro regime, bull/bear bias, etc.).
 * Path: `MARKET_ENVIRONMENT_FILE` env (relative to cwd or absolute), else `./MARKET_ENVIRONMENT.md`.
 * Missing/unreadable file → empty string (silent).
 */
export function readMarketEnvironmentNote(): string {
    const custom = (process.env.MARKET_ENVIRONMENT_FILE || '').trim();
    const filePath = custom
        ? path.isAbsolute(custom)
            ? custom
            : path.join(process.cwd(), custom)
        : path.join(process.cwd(), DEFAULT_FILENAME);
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
        return '';
    }
}
