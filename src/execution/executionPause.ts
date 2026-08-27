let paused = false;

/** Clears the current `sleepDaemonTick` timer so the daemon loop wakes immediately. */
let sleepRelease: (() => void) | null = null;

export function isPaused(): boolean {
    return paused;
}

/** Returns whether the paused flag actually changed. Always calls `interruptDaemonSleep` when the value changes. */
export function setPaused(value: boolean): boolean {
    const changed = paused !== value;
    paused = value;
    if (changed) {
        interruptDaemonSleep();
    }
    return changed;
}

export function interruptDaemonSleep(): void {
    sleepRelease?.();
}

/**
 * Sleep after a daemon tick; ends early when `interruptDaemonSleep` runs (pause/unpause or future retarget).
 */
export async function sleepDaemonTick(ms: number): Promise<void> {
    let settled = false;
    await new Promise<void>((resolve) => {
        const finish = () => {
            if (settled) return;
            settled = true;
            sleepRelease = null;
            resolve();
        };
        const t = setTimeout(finish, ms);
        sleepRelease = () => {
            clearTimeout(t);
            finish();
        };
    });
}
