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
| **Daemon** | `--daemon` or `DAEMON=1` | **Normal:** sleep = **primary chart** candle (e.g. `15m` → every **15 minutes**). **High attention:** when best strategy score ≥ `HIGH_ATTENTION_MIN_SCORE` (default 4), sleep = **lower timeframe** candle (e.g. `15m` → **5m**). Override normal cadence only with `POLL_MINUTES` or `--interval-minutes=N`. On tick failure, waits up to 60s before retry. Use **systemd/PM2** for crash restarts — see [docs/DEPLOY.md](docs/DEPLOY.md). |
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
| `--interval-minutes=N` | **Optional** fixed daemon interval in minutes (also `POLL_MINUTES`). If omitted and `POLL_MINUTES` is unset, cadence follows the **lower timeframe** of your chart interval. |
| `--entry-threshold=N` | Min score to send Telegram (also `ENTRY_THRESHOLD`; which score is compared depends on `--entry-gate` / `ENTRY_GATE_MODE`). |
| `--entry-gate=…` | `final` (default): gate on strategy score **plus** LLM `score_adjustment`. `best`: gate on raw best strategy score only; adjustment is still logged. Aliases for `best`: `strategy`, `raw`. |
| `--llm-min-score=N` | Call LLM critic only if best strategy score ≥ N (also `LLM_MIN_SCORE`). |

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
| `ENTRY_THRESHOLD` | `5` | Min score to notify; compared against **adjusted** score when `ENTRY_GATE_MODE=final`, or **raw** best strategy score when `best` |
| `ENTRY_GATE_MODE` | `final` | `final` = require `best.score + score_adjustment` ≥ threshold; `best` = require `best.score` ≥ threshold (LLM adjustment advisory unless `veto`) |
| `LLM_MIN_SCORE` | `3` | Gate: run LLM only if best strategy score ≥ this |
| `HIGH_ATTENTION_MIN_SCORE` | `4` | Daemon: when best score ≥ this, poll every **lower timeframe** tick instead of every primary candle |
| `POLL_MINUTES` | _(unset)_ | If set, **normal** daemon interval in minutes; if **unset**, normal interval = primary chart timeframe (e.g. 15m → 15 min) |
| `RUN_ARTIFACT_DIR` | _(empty)_ | If set, writes per-run JSON + appends `decisions.jsonl`, tracks `paper_trades_open.json` for TP/SL simulation, and **dedupes Telegram**: one full signal per open leg (same symbol/interval/direction); further ticks send short confidence updates only when final score changes |
| `LOG_FORMAT` | _(human)_ | Set to `json` for one JSON object per line (decisions + fatal errors) |
| `SKIP_LLM` | _(unset)_ | Set to `1` / `true` / `yes` to skip the OpenAI critic entirely (rules-only `decide`; `llmSkippedReason` = `llm_disabled`) |

## What gets logged and stored (every run, signal or not)

Each tick produces a **decision record** that includes:

- **Deterministic layer:** all **strategy scores**, **signals** (trend alignment, volume spike, SFP stub), and a **market summary** (trend, structure, volatility, key indicators, latest candle, HTF/LTF trend, swings).
- **LLM layer:** if the best score ≥ `LLM_MIN_SCORE` and `OPENAI_API_KEY` is set, **`llm`** holds `risk_flags`, `score_adjustment`, `comment`, and optional **`veto`**. If the model was not called, **`llmSkippedReason`** is `below_min_score` or `no_api_key`. If the API call failed, **`llmError`** is set.
- **Entry gate audit:** **`entryThreshold`** and **`entryGateMode`** show which bar was used (`final` vs `best`); see `ENTRY_GATE_MODE` above.

Where it appears:

- **Console (default):** several `[INFO]` lines per run — summary, strategies/signals, LLM outcome, compact market line.
- **`LOG_FORMAT=json`:** one **JSON object per line** with the full record (best for grep, jq, or log shipping).
- **`RUN_ARTIFACT_DIR`:** same JSON written to a timestamped file under that directory and **appended** to `decisions.jsonl` for a linear history. With Telegram enabled, this directory is also required so the bot knows when a paper leg is still open and avoids repeating full entry alerts (see env table above).

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

## Historical backtests (offline)

The backtest replays stored OHLCV through **`buildMarketState` → `buildSignals` → `runStrategies` → `decide` (no LLM) → optional proposal**. It does **not** call Binance or OpenAI. For a **live** snapshot with the LLM disabled, use `SKIP_LLM=1` with the normal `index.ts` / `npm run signal` flow (see [Environment variables](#environment-variables)).

### npm scripts

| Script | Command | Purpose |
|--------|---------|---------|
| **Fetch fixture** | `npm run fetch-backtest-data` | Download primary + HTF + LTF klines from Binance into one JSON file. |
| **Backtest** | `npm run backtest` | Walk-forward (or single-bar) evaluation; set `BACKTEST_FIXTURE`. |

---

### 1. Prepare data (`fetch-backtest-data`)

Calls Binance **public** `GET /api/v3/klines` (paginated, max 1000 bars per request). API keys are optional unless your environment requires them.

**Typical command:**

```bash
FETCH_SYMBOL=BTCUSDT \
FETCH_PRIMARY_INTERVAL=5m \
FETCH_BARS=3000 \
FETCH_OUTPUT=./fixtures/btc_15m.json \
npm run fetch-backtest-data
```

**Environment variables**

| Variable | Default | Description |
|----------|---------|-------------|
| `FETCH_SYMBOL` | `BTCUSDT` | Spot symbol (e.g. `ETHUSDT`). |
| `FETCH_PRIMARY_INTERVAL` | `5m` | Primary timeframe (`1m`, `5m`, `15m`, `1h`, …). |
| `FETCH_OUTPUT` | `./fixtures/backtest-export.json` | Path to the JSON file written (directories are created). |
| `FETCH_BARS` | `3000` | Number of **primary** candles (minimum `60`). |
| `FETCH_END_MS` | _(now)_ | Unix time in ms: fetch history ending at this moment. |
| `FETCH_REQUEST_DELAY_MS` | `120` | Pause between API requests (rate limits). |
| `FETCH_HTF_LIMIT` | `120` | Used to decide how far back to pull **higher** timeframe data vs primary span. |
| `FETCH_LTF_LIMIT` | `200` | Same for **lower** timeframe data. |

Also respects `BINANCE_BASE_URL` if you use a testnet or proxy.

---

### 2. Run the backtest (`backtest`)

**Required:** `BACKTEST_FIXTURE` = path to the JSON file from the fetch step (or any compatible fixture).

**Typical command:**

```bash
BACKTEST_FIXTURE=./fixtures/btc_5m.json npm run backtest
```

Default **stdout** is **JSONL**: one JSON object per primary bar (walk-forward from bar `59` through the end). The **end-of-run report** (summary, MFE / fixed-% TP·SL stats if enabled, PnL summary if enabled) is printed to **stderr** after all bar lines, under a `======== BACKTEST REPORT ========` banner.

**Environment variables**

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKTEST_FIXTURE` | _(required)_ | Path to fixture JSON. |
| `BACKTEST_MODE` | `walk` | `walk` = every bar from `BACKTEST_START_BAR` to end; `last` = only the final bar. |
| `BACKTEST_FORMAT` | `jsonl` | `jsonl` \| `json` (single object with `rows`) \| `csv`. |
| `BACKTEST_OUT` | _(stdout)_ | If set, bar-level output is written to this file instead of stdout. |
| `BACKTEST_REPORT_OUT` | _(unset)_ | Write the same **end report** JSON (see below) to this path. |
| `BACKTEST_START_BAR` | `59` | First bar index in walk mode (0-based; need enough history for indicators). |
| `BACKTEST_PRIMARY_LIMIT` | `200` | Trailing window length for primary series (matches live bundle). |
| `BACKTEST_HTF_LIMIT` | `120` | Trailing HTF candles kept per step. |
| `BACKTEST_LTF_LIMIT` | `200` | Trailing LTF candles kept per step. |
| `ENTRY_THRESHOLD` | `5` | Same gate as production `decide` + proposal. |
| `BACKTEST_PRIMARY_INTERVAL` | `5m` | Only for **legacy** fixtures (bare array / primary-only): label + HTF/LTF mapping. |
| `BACKTEST_POSITION_SIZE` | _(unset)_ | Notional **per trade** in whatever unit you choose (USDT, USD, etc.). When set, reports add **`portfolioChange`** (e.g. `"+408.56$"` / `"-213.00$"`), **`profitable`**, and **`totalPnl`** / **`total`**. The `$` suffix is **display only** — real units match `positionSize` (see **`unitsNote`** in JSON). |

**PnL stub** (`BACKTEST_PNL=1`): simple stop vs **TP1** simulation on bars where a proposal would be sent; see [src/backtest/simulatePnl.ts](src/backtest/simulatePnl.ts).

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKTEST_PNL` | _(off)_ | `1` / `true` / `yes` to enable. |
| `BACKTEST_ENTRY_MODEL` | `close` | `close` = fill at signal bar close; `next_open` = next bar open. |
| `BACKTEST_FEE_BPS` | `5` | Basis points **per side**; round-trip drag is `2 × feeBps / 10000` of notional per trade. Set `0` to disable (report includes `feeNote` / `run.feeNote`). |
| `BACKTEST_SLIP_ENTRY_BPS` | `0` | Adverse entry slippage (bps): long pays more, short receives less. |
| `BACKTEST_SLIP_EXIT_BPS` | `0` | Adverse exit slippage (bps) on TP, stop, and mark-to-market exit. |
| `BACKTEST_SLIP_STOP_EXTRA_BPS` | `0` | Extra adverse bps on **stop** exits only (proposal simulation). |
| `BACKTEST_BAR_CONTEST` | `stop_first` | When SL and TP both touch the same bar: `stop_first`, `tp_first`, or `split` (50/50 gross blend, one round-trip fee). Applies to fixed-% tracks and proposal `simulatePnl`. |

**MFE / invalidation study** (`BACKTEST_MFE=1`): for bars where the **winning** strategy score matches a target, measures max favorable move vs **invalidation** forward; see [src/backtest/scorePathStats.ts](src/backtest/scorePathStats.ts).

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKTEST_MFE` | _(off)_ | `1` / `true` / `yes` to enable. |
| `BACKTEST_MFE_SCORE` | `6` | Target score (exact match unless `BACKTEST_MFE_MIN_SCORE` is set). |
| `BACKTEST_MFE_MIN_SCORE` | _(unset)_ | If `1` / `true` / `yes`, use **≥** `BACKTEST_MFE_SCORE` instead of equality. |
| `BACKTEST_MFE_OUT` | _(unset)_ | If set, writes **full** per-bar **tracks** (+ summary) to this JSON file. |

**Fixed % take-profit / stop-loss** (optional, independent of MFE): set **both** `BACKTEST_PCT_TP` and `BACKTEST_PCT_SL` to positive numbers (percent of entry). Entry = signal bar **close**; direction = same rule as MFE (`trend_long` / `range_short` / valid SFP type, etc.). Forward scan starts on the **next** bar; **stop is checked before take-profit** on each bar if both could hit. See [src/backtest/fixedPctPath.ts](src/backtest/fixedPctPath.ts).

Example: `BACKTEST_PCT_TP=2` `BACKTEST_PCT_SL=1` → long targets +2% above close, stop −1% below close (short inverts).

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKTEST_PCT_TP` | _(unset)_ | Take-profit distance in **percent** (e.g. `2` = 2%). Must set with `BACKTEST_PCT_SL` to enable. |
| `BACKTEST_PCT_SL` | _(unset)_ | Stop-loss distance in **percent** (e.g. `1` = 1%). |
| `BACKTEST_PCT_SCORE` | same as `BACKTEST_MFE_SCORE` | Only bars whose **winning** strategy score matches this (exact or min — see next row). |
| `BACKTEST_PCT_MIN_SCORE` | same as `BACKTEST_MFE_MIN_SCORE` | If set to `1` / `true` / `yes`, use **≥** `BACKTEST_PCT_SCORE` (or `BACKTEST_MFE_SCORE` when `BACKTEST_PCT_SCORE` unset). |
| `BACKTEST_PCT_OUT` | _(unset)_ | Full per-bar **tracks** + summary JSON (like `BACKTEST_MFE_OUT`). |

**End report** (always emitted to **stderr** when the run completes; optional copy to `BACKTEST_REPORT_OUT`) includes:

- `run`: **`primaryInterval`** (bar timeframe for the walk), **`htfInterval`** / **`ltfInterval`**, symbol, bar counts, mode, `signalsSent`, optional **`positionSize`**, etc.
- `mfe`: when MFE is enabled — `trackCount` + **summary** (e.g. `invalidationContest` ratios), not the full track list.
- `fixedPctExits`: when both `BACKTEST_PCT_TP` and `BACKTEST_PCT_SL` are set — `tpPct`, `slPct`, `trackCount`, **summary** (`tpVsSl`, `avgBarsToTp`, …, and with `BACKTEST_POSITION_SIZE`: **`totalPnl`**, `pnlFromTpHits`, `pnlFromSlHits`, `pnlFromSeriesEndMtm`).
- `pnl`: when `BACKTEST_PNL=1` — compact counters plus, with **`BACKTEST_POSITION_SIZE`**, **`totalPnl`** (sum of simulated trades using each trade’s `pnlPctApprox`).
- **`pnlWithPositionSize`**: when `BACKTEST_POSITION_SIZE` is set and at least one dollar scenario applies — **`byScenario`** (`fixedPctExits`, `proposalSimulation`) and cost settings. **Do not sum** `byScenario` values (different exit models on overlapping bars); use each scenario’s own total (`pnl.totalPnl` for proposal sim, `fixedPctExits.summary.totalPnl` for fixed-%). Fixed-% dollars use the same **fee + entry/exit slip** as proposal simulation.

**Examples**

```bash
# CSV to disk + report file + MFE summary in report
BACKTEST_FIXTURE=./fixtures/btc_5m.json \
BACKTEST_FORMAT=csv \
BACKTEST_OUT=./out/bars.csv \
BACKTEST_REPORT_OUT=./out/report.json \
BACKTEST_MFE=1 \
npm run backtest
```

```bash
# Full MFE tracks on disk; bar output stays JSONL on stdout
BACKTEST_FIXTURE=./fixtures/btc_5m.json \
BACKTEST_MFE=1 \
BACKTEST_MFE_OUT=./out/mfe-tracks.json \
npm run backtest 2> report.stderr.txt
```

```bash
# Single-bar snapshot (like an end-of-series dry run)
BACKTEST_FIXTURE=./fixtures/btc_5m.json BACKTEST_MODE=last BACKTEST_FORMAT=json npm run backtest
```

```bash
# Fixed +2% TP / −1% SL from close on the same score cohort as default MFE (exact score 6)
BACKTEST_FIXTURE=./fixtures/btc_5m.json \
BACKTEST_PCT_TP=2 \
BACKTEST_PCT_SL=1 \
BACKTEST_REPORT_OUT=./out/pct-report.json \
npm run backtest
```

---

### 3. Fixture shapes (without the fetch script)

The loader lives in [src/backtest/walkForward.ts](src/backtest/walkForward.ts).

1. **Recommended (matches fetch script):** object with `symbol`, `primaryInterval`, `primary`, `htf: { interval, candles }`, `ltf: { interval, candles }`.
2. **Resample from one series:** `resampleFrom` (candle array), `baseInterval` (e.g. `1m`), `primaryInterval` (e.g. `5m`) — builds primary/HTF/LTF by aggregation.
3. **Legacy:** raw `Candlestick[]` or `{ "primary": [...] }` only — HTF/LTF are approximated from primary (a warning is printed).

Candle fields: `openTime`, `open`, `high`, `low`, `close`, `volume`, `closeTime` (Binance-style).

## Build

```bash
npm run build
```

Compiles TypeScript to `dist/` per `tsconfig.json`.

## Disclaimer

This software is for **education and research**. It is **not** financial advice. Crypto trading involves substantial risk. You are responsible for API keys, rate limits, compliance, and any orders or positions you place outside this repo.
