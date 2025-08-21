export function logInfo(message: string, meta?: unknown) {
    const ts = new Date().toISOString();
    if (meta !== undefined) {
        console.log(`[INFO] ${ts} - ${message}`, meta);
    } else {
        console.log(`[INFO] ${ts} - ${message}`);
    }
}

export function logError(message: string, meta?: unknown) {
    const ts = new Date().toISOString();
    if (meta !== undefined) {
        console.error(`[ERROR] ${ts} - ${message}`, meta);
    } else {
        console.error(`[ERROR] ${ts} - ${message}`);
    }
}


