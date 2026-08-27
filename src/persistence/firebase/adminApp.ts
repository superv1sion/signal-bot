import admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import path from 'node:path';

let app: admin.app.App | undefined;

/**
 * Lazily initializes the default Firebase Admin app using a service account JSON path.
 * Prefer `GOOGLE_APPLICATION_CREDENTIALS` (Google standard) or `FIREBASE_SERVICE_ACCOUNT_PATH`.
 */
export function getFirebaseAdminApp(): admin.app.App {
    if (app) return app;
    const raw = (
        process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        ''
    ).trim();
    if (!raw) {
        throw new Error(
            'Firebase Admin: set FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS to your service account JSON file.',
        );
    }
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    app = admin.initializeApp({
        credential: admin.credential.cert(resolved),
    });
    return app;
}

export function getFirestoreDb(): Firestore {
    return getFirebaseAdminApp().firestore();
}
