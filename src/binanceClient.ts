import 'dotenv/config';
import { MainClient } from 'binance';
import { type Kline, type KlinesParams } from 'binance/lib/types/shared';
import { intervalToMilliseconds } from './intervalMs';

export type Candlestick = {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closeTime: number;
};

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const BASE_URL = process.env.BINANCE_BASE_URL || 'https://api.binance.com';

const client = new MainClient({
    api_key: API_KEY,
    api_secret: API_SECRET,
    baseUrl: BASE_URL,
});

function mapKline(k: Kline): Candlestick {
    return {
        openTime: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: k[6],
    };
}

export async function fetchOHLCV(params: {
    symbol: string;
    interval: KlinesParams['interval'];
    limit?: number;
    startTime?: number;
    endTime?: number;
}): Promise<Candlestick[]> {
    const { symbol, interval, limit = 200, startTime, endTime } = params;
    try {
        console.log('Fetching OHLCV', { symbol, interval, limit, startTime, endTime });
        const klines: Kline[] = await client.getKlines({
            symbol,
            interval,
            limit,
            ...(startTime !== undefined ? { startTime } : {}),
            ...(endTime !== undefined ? { endTime } : {}),
        });
        return klines.map(mapKline);
    } catch (error) {
        console.log(error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to fetch klines for ${symbol} ${interval}: ${message}`);
    }
}

const MAX_KLINES_PER_REQUEST = 1000;

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Walk forward in openTime order from `startTime` through `endTime` (inclusive of candles that close by endTime).
 * Respects Binance max 1000 klines per call; optional delay between calls.
 */
export async function fetchOHLCVForwardPages(params: {
    symbol: string;
    interval: KlinesParams['interval'];
    startTime: number;
    endTime: number;
    delayMs?: number;
}): Promise<Candlestick[]> {
    const { symbol, interval, startTime, endTime, delayMs = 0 } = params;
    const out: Candlestick[] = [];
    let cursor = startTime;
    const stepMs = intervalToMilliseconds(interval as string);

    while (cursor <= endTime) {
        const batch = await client.getKlines({
            symbol,
            interval,
            startTime: cursor,
            endTime,
            limit: MAX_KLINES_PER_REQUEST,
        });
        const mapped = (batch as Kline[]).map(mapKline);
        if (mapped.length === 0) break;
        out.push(...mapped);
        const last = mapped[mapped.length - 1]!;
        const next = last.openTime + stepMs;
        if (next <= cursor) break;
        cursor = next;
        if (mapped.length < MAX_KLINES_PER_REQUEST) break;
        if (delayMs > 0) await sleep(delayMs);
    }

    return out;
}

/**
 * Newest candles last. Pages backward using `endTime` until `count` candles are collected or API returns empty.
 */
export async function fetchOHLCVLastN(params: {
    symbol: string;
    interval: KlinesParams['interval'];
    count: number;
    endTime?: number;
    delayMs?: number;
}): Promise<Candlestick[]> {
    const { symbol, interval, count, endTime = Date.now(), delayMs = 0 } = params;
    const chunks: Candlestick[][] = [];
    let remaining = count;
    let cursorEnd = endTime;

    while (remaining > 0) {
        const limit = Math.min(MAX_KLINES_PER_REQUEST, remaining);
        const batch = await client.getKlines({
            symbol,
            interval,
            endTime: cursorEnd,
            limit,
        });
        const mapped = (batch as Kline[]).map(mapKline);
        if (mapped.length === 0) break;
        chunks.unshift(mapped);
        remaining -= mapped.length;
        cursorEnd = mapped[0]!.openTime - 1;
        if (mapped.length < limit) break;
        if (delayMs > 0) await sleep(delayMs);
    }

    const flat = chunks.flat();
    return flat.length > count ? flat.slice(-count) : flat;
}


