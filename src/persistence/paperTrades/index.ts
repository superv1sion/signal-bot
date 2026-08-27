import type { PipelineResult } from '../../types/pipeline';
import {
    paperTradesFirestoreCredentialsConfigured,
    paperTradesFirestoreEnabled,
    paperTradesFirestoreReady,
} from './config';
import { getFirestorePaperTradeRepository } from './paperTradeRepository';
import { processPaperTradesAfterEvaluation as processWithRepo } from './paperTradeService';
import type { PaperTradesNotifyPlan } from './types';

export {
    paperTradesFirestoreCredentialsConfigured,
    paperTradesFirestoreEnabled,
    paperTradesFirestoreReady,
} from './config';

export type {
    PaperClosedStatsAggregate,
    PaperTpLeg,
    PaperTradeClosedEvent,
    PaperTradeClosedLegSummary,
    PaperTradeEvent,
    PaperTradeOpenedEvent,
    PaperTradeOpenRecord,
    PaperTradesNotifyPlan,
    PaperTradeTickEvent,
} from './types';

export { paperTradeFirestoreCollectionNames } from './paperTradeRepository';

/**
 * When `PAPER_TRADES_FIRESTORE=1` and a service account path is set, persists paper trades to Firestore.
 * Otherwise returns `telegram: 'legacy'` (no open-leg dedupe state).
 */
export async function processPaperTradesAfterEvaluation(params: {
    symbol: string;
    interval: string;
    result: PipelineResult;
}): Promise<PaperTradesNotifyPlan> {
    if (!paperTradesFirestoreReady()) {
        return { telegram: 'legacy' };
    }
    const repo = getFirestorePaperTradeRepository();
    return processWithRepo({ repo, ...params });
}
