/** When true with credentials configured, paper trades are persisted to Firestore. */
export function paperTradesFirestoreEnabled(): boolean {
    const v = (process.env.PAPER_TRADES_FIRESTORE || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

export function paperTradesFirestoreCredentialsConfigured(): boolean {
    const p = (
        process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        ''
    ).trim();
    return p.length > 0;
}

export function paperTradesFirestoreReady(): boolean {
    return paperTradesFirestoreEnabled() && paperTradesFirestoreCredentialsConfigured();
}
