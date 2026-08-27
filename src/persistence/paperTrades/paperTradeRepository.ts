import type { Firestore, DocumentData } from 'firebase-admin/firestore';
import type { PaperTradeClosedEvent, PaperTradeEvent, PaperTradeOpenRecord } from './types';
import { getFirestoreDb } from '../firebase/adminApp';

const FIRESTORE_BATCH_LIMIT = 500;

export interface PaperTradeRepository {
    loadOpenTrades(): Promise<PaperTradeOpenRecord[]>;
    saveOpenTrades(trades: PaperTradeOpenRecord[]): Promise<void>;
    appendEvent(event: PaperTradeEvent): Promise<void>;
    loadClosedEvents(): Promise<PaperTradeClosedEvent[]>;
}

function pruneUndefined(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(pruneUndefined);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        out[k] = pruneUndefined(v);
    }
    return out;
}

function openRecordToDocData(t: PaperTradeOpenRecord): DocumentData {
    const { id: _id, ...rest } = t;
    return pruneUndefined(rest) as DocumentData;
}

/** Collection IDs used for open legs and lifecycle events (same logic as the repository). */
export function paperTradeFirestoreCollectionNames(): { open: string; event: string } {
    const prefix = (process.env.FIRESTORE_COLLECTION_PREFIX || '').trim();
    const baseOpen = 'paper_trade_open';
    const baseEvent = 'paper_trade_event';
    return {
        open: prefix ? `${prefix}${baseOpen}` : baseOpen,
        event: prefix ? `${prefix}${baseEvent}` : baseEvent,
    };
}

export function createFirestorePaperTradeRepository(db: Firestore): PaperTradeRepository {
    const { open: openCollection, event: eventCollection } = paperTradeFirestoreCollectionNames();
    const openCol = db.collection(openCollection);

    return {
        async loadOpenTrades(): Promise<PaperTradeOpenRecord[]> {
            const snap = await openCol.get();
            return snap.docs.map((d) => {
                const data = d.data() as Omit<PaperTradeOpenRecord, 'id'>;
                return { id: d.id, ...data };
            });
        },

        async saveOpenTrades(trades: PaperTradeOpenRecord[]): Promise<void> {
            const desired = new Set(trades.map((t) => t.id));
            const snap = await openCol.get();
            const toDelete: string[] = [];
            snap.forEach((doc) => {
                if (!desired.has(doc.id)) toDelete.push(doc.id);
            });

            let batch = db.batch();
            let opCount = 0;

            const flush = async () => {
                if (opCount === 0) return;
                await batch.commit();
                batch = db.batch();
                opCount = 0;
            };

            const enqueue = async (fn: () => void) => {
                fn();
                opCount++;
                if (opCount >= FIRESTORE_BATCH_LIMIT) await flush();
            };

            for (const id of toDelete) {
                await enqueue(() => batch.delete(openCol.doc(id)));
            }
            for (const t of trades) {
                await enqueue(() => batch.set(openCol.doc(t.id), openRecordToDocData(t)));
            }
            await flush();
        },

        async appendEvent(event: PaperTradeEvent): Promise<void> {
            const data = pruneUndefined(event) as DocumentData;
            await db.collection(eventCollection).add(data);
        },

        async loadClosedEvents(): Promise<PaperTradeClosedEvent[]> {
            const snap = await db.collection(eventCollection).where('kind', '==', 'closed').get();
            return snap.docs.map((d) => d.data() as PaperTradeClosedEvent);
        },
    };
}

let singletonRepo: PaperTradeRepository | undefined;

export function getFirestorePaperTradeRepository(): PaperTradeRepository {
    if (!singletonRepo) {
        singletonRepo = createFirestorePaperTradeRepository(getFirestoreDb());
    }
    return singletonRepo;
}
