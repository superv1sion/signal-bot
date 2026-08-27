/**
 * Parsed admin control tokens from Telegram text.
 */
export type AdminTelegramControlMessage =
    | { kind: 'pause' }
    | { kind: 'unpause' }
    | { kind: 'timeframe'; raw: string }
    | { kind: 'symbol'; raw: string }
    | { kind: 'not_admin_control' };

export function classifyAdminTelegramText(text: string): AdminTelegramControlMessage {
    const trimmed = text.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const first = tokens[0];
    if (!first) {
        return { kind: 'not_admin_control' };
    }
    const cmd = first.split('@')[0]!.toLowerCase();
    const argRest = tokens.slice(1).join(' ').trim();
    if (cmd === '/pause') {
        return { kind: 'pause' };
    }
    if (cmd === '/unpause') {
        return { kind: 'unpause' };
    }
    if (cmd === '/timeframe') {
        return { kind: 'timeframe', raw: argRest };
    }
    if (cmd === '/symbol') {
        return { kind: 'symbol', raw: argRest };
    }
    return { kind: 'not_admin_control' };
}
