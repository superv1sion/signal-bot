# Trading bot (rule-based core + LLM assistant)

CLI tool that pulls multi-timeframe OHLCV from **Binance**, builds a structured **market state**, runs deterministic **signals** and **strategies**, optionally asks an **LLM for a risk critique** (never to invent trades), then **decides** whether to emit a **trade proposal** and notify **Telegram**.

## Requirements

- **Node.js** 18+ (with `npx`)
- A **Binance** API is used for public klines (keys optional for read-only market data; configure in `.env` if your setup requires them)

## Setup

```bash
npm install
```

Create a **`.env`** file in the project root with the variables you need (see below). The app loads it automatically via `dotenv`.

## Quick start

**Single run** (default: one evaluation, then exit):

```bash
npx tsx index.ts ETHUSDT 15m
# or
npm run signal -- BTCUSDT 5m
```

**Explicit one-shot** (same as above, useful in cron so you never accidentally start a daemon):

```bash
npx tsx index.ts BTCUSDT 5m --once
```

**Shell wrapper** (sources `.env` from project root or `ENV_FILE`):

```bash
chmod +x scripts/run-signal.sh
./scripts/run-signal.sh BTCUSDT 5m
```

## Running modes

| Mode | How to enable | Behavior |
|------|----------------|----------|
| **One-shot** | Default, or `--once` | Run pipeline once, log (and optional Telegram / artifacts), exit. |
| **Daemon** | `--daemon` or `DAEMON=1` | Repeats forever: base interval `POLL_MINUTES` (default 5 min); switches to **1 minute** when the best strategy score ≥ `HIGH_ATTENTION_MIN_SCORE`. On failure, waits 60s and retries (use **systemd/PM2** outside the process for crash restarts — see [docs/DEPLOY.md](docs/DEPLOY.md)). |
| **Telegram listener** | `--telegram` or `TELEGRAM_MODE=1` | Long-polls Telegram; users send `SYMBOL TIMEFRAME` (e.g. `BTCUSDT 15m`) and get one reply per request (signal or “no signal” summary). Requires `TELEGRAM_BOT_TOKEN`. |

`--daemon` and `--once` cannot be used together.

## Command-line arguments

**Positional**

1. **Symbol** (default: `SYMBOL` env or `BTCUSDT`)
2. **Timeframe** (default: `TIMEFRAME` env or `5m`) — Binance intervals such as `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, …

**Flags** (values use `name=value` where noted)

| Flag | Purpose |
|------|---------|
| `--once` | Force single run (for cron). |
| `--daemon` | Long-running poll loop. |
| `--telegram` | Telegram listener mode. |
| `--interval-minutes=N` | Base daemon interval (also `POLL_MINUTES`). |
| `--entry-threshold=N` | Min **final** score to send Telegram (also `ENTRY_THRESHOLD`). |
| `--llm-min-score=N` | Call LLM critic only if best strategy score ≥ N (also `LLM_MIN_SCORE`). |
| `--high-attention-min-score=N` | In daemon, use 1m cadence when best score ≥ N (also `HIGH_ATTENTION_MIN_SCORE`). |

## Environment variables

### Binance

| Variable | Description |
|----------|-------------|
| `BINANCE_API_KEY` | Optional for public klines |
| `BINANCE_API_SECRET` | Optional |
| `BINANCE_BASE_URL` | Default public REST base |

### LLM (critique only)

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required **only if** you want LLM critique when the best score reaches `LLM_MIN_SCORE` |
| `OPENAI_BASE_URL` | e.g. Groq/OpenAI-compatible endpoint |
| `OPENAI_MODEL` | Model id |
| `OPENAI_JSON_MODE` | Set to `1` if your provider supports JSON mode |
| `SCORE_ADJUST_MIN` / `SCORE_ADJUST_MAX` | Clamp for LLM `score_adjustment` (defaults `-3` … `1`) |

### Telegram

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Default chat for **outbound** messages (daemon / one-shot). Listener replies in the chat that messaged the bot. |

### Defaults and tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `SYMBOL` | `BTCUSDT` | Default symbol |
| `TIMEFRAME` | `5m` | Default interval |
| `ENTRY_THRESHOLD` | `5` | Final score must be ≥ this to notify |
| `LLM_MIN_SCORE` | `3` | Gate: run LLM only if best strategy score ≥ this |
| `HIGH_ATTENTION_MIN_SCORE` | `4` | Daemon: faster polling when best score is high |
| `POLL_MINUTES` | `5` | Daemon base interval |
| `RUN_ARTIFACT_DIR` | _(empty)_ | If set, writes per-run JSON + appends `decisions.jsonl` |
| `LOG_FORMAT` | _(human)_ | Set to `json` for one JSON object per line (decisions + fatal errors) |

## What gets logged and stored (every run, signal or not)

Each tick produces a **decision record** that includes:

- **Deterministic layer:** all **strategy scores**, **signals** (trend alignment, volume spike, SFP stub), and a **market summary** (trend, structure, volatility, key indicators, latest candle, HTF/LTF trend, swings).
- **LLM layer:** if the best score ≥ `LLM_MIN_SCORE` and `OPENAI_API_KEY` is set, **`llm`** holds `risk_flags`, `score_adjustment`, `comment`, and optional **`veto`**. If the model was not called, **`llmSkippedReason`** is `below_min_score` or `no_api_key`. If the API call failed, **`llmError`** is set.

Where it appears:

- **Console (default):** several `[INFO]` lines per run — summary, strategies/signals, LLM outcome, compact market line.
- **`LOG_FORMAT=json`:** one **JSON object per line** with the full record (best for grep, jq, or log shipping).
- **`RUN_ARTIFACT_DIR`:** same JSON written to a timestamped file under that directory and **appended** to `decisions.jsonl` for a linear history.

Example:

```bash
RUN_ARTIFACT_DIR=./data LOG_FORMAT=json npx tsx index.ts BTCUSDT 5m --once
tail -1 data/decisions.jsonl | jq .
```

## Telegram listener

1. Set `TELEGRAM_BOT_TOKEN` (and optionally a default `TELEGRAM_CHAT_ID` for other modes).
2. Start: `npx tsx index.ts --telegram`
3. In Telegram, send: `BTCUSDT 15m` (symbol + space + timeframe).

You get **one** message back: either a formatted signal card or a short “no signal” explanation.

## Production deployment

Cron, **systemd**, and **PM2** examples live in [docs/DEPLOY.md](docs/DEPLOY.md) and under `deploy/`.

## Backtest stub

Dry-run features/strategies on a local candle JSON file (no live HTTP for that path):

```bash
BACKTEST_FIXTURE=./path/to/candles.json npm run backtest
```

See [scripts/backtest.ts](scripts/backtest.ts) for the expected candle shape.

## Build

```bash
npm run build
```

Compiles TypeScript to `dist/` per `tsconfig.json`.

## Disclaimer

This software is for **education and research**. It is **not** financial advice. Crypto trading involves substantial risk. You are responsible for API keys, rate limits, compliance, and any orders or positions you place outside this repo.
