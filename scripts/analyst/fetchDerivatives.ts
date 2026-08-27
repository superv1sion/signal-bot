/**
 * Binance USD-M futures public data: latest funding rate + open interest.
 * Public endpoints, no API keys required.
 */
import 'dotenv/config';
import { USDMClient } from 'binance';

const FUTURES_BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';

const client = new USDMClient({ baseUrl: FUTURES_BASE_URL });

export type DerivativesSnapshot = {
    symbol: string;
    /** Fraction, not percent — 0.0001 is 0.01%. Binance USDT-perp only, not a market-wide rate. */
    fundingRate: number;
    fundingTime: number;
    nextFundingTime: number | null;
    /**
     * Denominated in BTC (the contract's base asset), NOT USD — ~107,000 here means ~107,000 BTC,
     * roughly $8B notional. Covers only the Binance USDT-margined perpetual: excludes Binance
     * COIN-M (BTCUSD_PERP) and every other venue (CME, Bybit, OKX, Deribit).
     */
    openInterest: number;
};

export async function fetchDerivativesSnapshot(symbol: string): Promise<DerivativesSnapshot> {
    const [fundingHistory, openInterest] = await Promise.all([
        client.getFundingRateHistory({ symbol, limit: 1 }),
        client.getOpenInterest({ symbol }),
    ]);

    const latestFunding = fundingHistory[fundingHistory.length - 1];
    if (!latestFunding) {
        throw new Error(`No funding rate history returned for ${symbol}`);
    }

    return {
        symbol,
        fundingRate: Number(latestFunding.fundingRate),
        fundingTime: Number(latestFunding.fundingTime),
        nextFundingTime: null,
        openInterest: Number(openInterest.openInterest),
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const symbol = (process.env.FETCH_SYMBOL || 'BTCUSDT').trim().toUpperCase();
    fetchDerivativesSnapshot(symbol)
        .then((snapshot) => console.log(JSON.stringify(snapshot, null, 2)))
        .catch((e) => {
            console.error(e);
            process.exit(1);
        });
}
