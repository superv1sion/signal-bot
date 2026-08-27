/**
 * Free, no-key on-chain network-health metrics from mempool.space's public API.
 * Scope: network health only (mempool/fees/difficulty/hash rate) — NOT exchange
 * netflow or whale-wallet data, which needs a paid provider (Glassnode/CryptoQuant).
 */
import 'dotenv/config';

const MEMPOOL_BASE_URL = process.env.MEMPOOL_BASE_URL || 'https://mempool.space/api';

export type OnchainSnapshot = {
    mempoolCount: number;
    mempoolVsizeBytes: number;
    recommendedFeeSatPerVb: { fastest: number; halfHour: number; hour: number; economy: number };
    difficultyProgressPercent: number;
    estimatedRetargetChangePercent: number;
    remainingBlocksToRetarget: number;
};

async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${MEMPOOL_BASE_URL}${path}`);
    if (!res.ok) {
        throw new Error(`mempool.space ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
}

export async function fetchOnchainSnapshot(): Promise<OnchainSnapshot> {
    const [mempool, fees, difficulty] = await Promise.all([
        getJson<{ count: number; vsize: number }>('/mempool'),
        getJson<{ fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number }>(
            '/v1/fees/recommended'
        ),
        getJson<{
            progressPercent: number;
            difficultyChange: number;
            remainingBlocks: number;
        }>('/v1/difficulty-adjustment'),
    ]);

    return {
        mempoolCount: mempool.count,
        mempoolVsizeBytes: mempool.vsize,
        recommendedFeeSatPerVb: {
            fastest: fees.fastestFee,
            halfHour: fees.halfHourFee,
            hour: fees.hourFee,
            economy: fees.economyFee,
        },
        difficultyProgressPercent: difficulty.progressPercent,
        estimatedRetargetChangePercent: difficulty.difficultyChange,
        remainingBlocksToRetarget: difficulty.remainingBlocks,
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    fetchOnchainSnapshot()
        .then((snapshot) => console.log(JSON.stringify(snapshot, null, 2)))
        .catch((e) => {
            console.error(e);
            process.exit(1);
        });
}
