import 'dotenv/config';
import { MainClient } from 'binance';
import { type Kline, type KlinesParams } from 'binance/lib/types/shared';

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

export async function fetchOHLCV(params: { symbol: string; interval: KlinesParams['interval']; limit?: number }): Promise<Candlestick[]> {
    const { symbol, interval, limit = 200 } = params;
    try {
        const klines: Kline[] = await client.getKlines({ symbol, interval, limit });
        return klines.map((k) => ({
            openTime: k[0],
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
            closeTime: k[6],
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to fetch klines for ${symbol} ${interval}: ${message}`);
    }
}


