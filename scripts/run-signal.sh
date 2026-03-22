#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -f "${ENV_FILE:-$ROOT/.env}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE:-$ROOT/.env}"
  set +a
fi
SYMBOL="${1:-${SYMBOL:-BTCUSDT}}"
INTERVAL="${2:-${TIMEFRAME:-5m}}"
exec npx tsx index.ts "$SYMBOL" "$INTERVAL" --once
