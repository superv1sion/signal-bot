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
| **Daemon** | `--daemon` or `DAEMON=1` | **Normal:** sleep = **primary chart** candle (e.g. `15m` → every **15 minutes**). **High attention:** when best strategy score ≥ `HIGH_ATTENTION_MIN_SCORE` (default 4), sleep = **lower timeframe** candle (e.g. `15m` → **5m**). Override normal cadence only with `POLL_MINUTES` or `--interval-minutes=N`. On tick failure, waits up to 60s before retry. Use **systemd/PM2** for crash restarts — see [docs/DEPLOY.md](docs/DEPLOY.md). With `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_USER_IDS`, a background **getUpdates** loop accepts admin **`/pause`** / **`/unpause`**: paused daemons skip market evaluation until unpaused; **`TELEGRAM_CHAT_ID`** gets a short HTML status when pause state changes. |
| **Telegram listener** | `--telegram` or `TELEGRAM_MODE=1` | Long-polls Telegram; users send `SYMBOL TIMEFRAME` (e.g. `BTCUSDT 15m`) and get one reply per request (signal or “no signal” summary). Requires `TELEGRAM_BOT_TOKEN`. Same admin **`/pause`** / **`/unpause`** as daemon mode; while paused, on-demand analysis requests get a “bot is paused” reply. |

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
| `TELEGRAM_CHAT_ID` | Default chat for **outbound** messages (daemon / one-shot). Defaults to `@ai_trade_signal_btc_bot` if unset. Listener replies in the chat that messaged the bot. Also used for **pause/unpause announcements** when set. |
| `TELEGRAM_ADMIN_USER_IDS` | Comma-separated numeric Telegram user ids allowed to run **`/pause`** and **`/unpause`**. If unset, daemon does not start a control poller; listener still accepts the commands but responds that control is not configured unless you set this. Example: `255450214`. |

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
| `PAPER_TRADES_FIRESTORE` | _(off)_ | Set to `1` / `true` / `yes` to store **paper trades** (open legs, ticks, closes) in **Firestore** and **dedupe Telegram**: one full signal per open leg; later ticks send confidence updates only when the final score changes |
| `GOOGLE_APPLICATION_CREDENTIALS` / `FIREBASE_SERVICE_ACCOUNT_PATH` | _(unset)_ | Path to Firebase **service account JSON**; required when `PAPER_TRADES_FIRESTORE` is on |
| `FIRESTORE_COLLECTION_PREFIX` | _(empty)_ | Optional prefix for collections `paper_trade_open` and `paper_trade_event` |
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
- **Paper trades / Telegram dedupe:** enable `PAPER_TRADES_FIRESTORE` and a service account path so open legs are tracked in Firestore.

Example:

```bash
LOG_FORMAT=json npx tsx index.ts BTCUSDT 5m --once
```

## Telegram listener

1. Set `TELEGRAM_BOT_TOKEN` (optional: `TELEGRAM_CHAT_ID` to override the default outbound channel `@ai_trade_signal_btc_bot`). For **`/pause`** / **`/unpause`**, set **`TELEGRAM_ADMIN_USER_IDS`** to your numeric user id (comma-separated for several admins).
2. Start: `npx tsx index.ts --telegram`
3. In Telegram, send: `BTCUSDT 15m` (symbol + space + timeframe).

You get **one** message back: either a formatted signal card or a short “no signal” explanation.

**Daemon remote control:** run with `--daemon` and the same Telegram env vars. Admins can **`/pause`** to stop scheduled market checks (no `runEvaluation` ticks) and **`/unpause`** to resume. The bot posts a clear **paused** / **unpaused** line to **`TELEGRAM_CHAT_ID`** when the state changes (and confirms in private chat if you issue commands there instead).

## BTC analyst digest (read-only, not a trading signal)

A separate, informational companion to the signal bot above: an hourly BTC context digest (price vs. your configured MAs/anchored VWAP/volume-profile/fib levels, derivatives positioning, on-chain network health, notable headlines) sent to Telegram **and** posted into an open Claude Code session so you can ask follow-up questions right there. It never proposes trades — it reuses this repo's Binance/Telegram plumbing but is otherwise independent of the `decide`/`buildProposal` pipeline above.

### Components

- `config/analyst-ta.json` — your TA parameters (VWAP anchors, tracked MAs, volume-profile range, fib levels, key levels). **Nothing here is auto-detected.** Each moving average has its own `interval` (e.g. `{ "type": "SMA", "period": 50, "interval": "4h" }`) — MAs are fetched and computed independently per timeframe, not forced onto one global chart interval, since a 50 SMA and a 200 EMA are usually watched on different charts. VWAP anchors and the volume-profile range use `primaryInterval`. A `bmsb` block (`{ "enabled": true, "smaPeriod": 20, "emaPeriod": 21, "interval": "1w" }`) tracks the Bull Market Support Band — the standard 20-week SMA / 21-week EMA pair — as a band (`lower`/`upper`); set `enabled: false` to turn it off. Levels come from your own chart reading and change as market conditions change — update this file (directly, or by asking the agent in-session, e.g. "move the VWAP anchor to yesterday's low," "add a fib from 58k to 72k") whenever your view changes. `npm run analyst-snapshot` fails loudly rather than silently substituting a guessed level if a configured anchor/time falls outside the fetched candle history.
- `npm run analyst-snapshot` — fetches candles + derivatives (funding rate, open interest) + on-chain network-health metrics (mempool.space, free) + news headlines (CryptoPanic, falling back to CoinDesk RSS), computes everything specified in `config/analyst-ta.json`, and writes `./data/analyst-snapshot-latest.json`. Also appends a compact `{price, levels}` entry to `./data/analyst-snapshot-history.jsonl` each run (bounded, `ANALYST_HISTORY_MAX_ENTRIES`, default 500) and uses it to compute `proximityWatch`: % distance from price to every level, support/resistance role, and whether price has moved closer to it since the lookback entry (`ANALYST_PROXIMITY_LOOKBACK_ENTRIES` runs back, default 6 — real elapsed time, not assumed hourly spacing). This feeds the digest's "Trade Setup Watch" section — proximity/reaction info only, never an entry/stop/target trade call.
- `npm run analyst-send -- "<text>"` — sends a message via the same Telegram bot as the signal pipeline. Set `TELEGRAM_ANALYST_CHAT_ID` in `.env` to route the digest to a separate chat/topic from trade-signal messages (recommended — hourly digests otherwise add ~17 msgs/day to that chat); falls back to `TELEGRAM_CHAT_ID` if unset.
- `npm run analyst-digest` — the one-shot the launchd agent calls: refresh snapshot → format → LLM bias read → send. `--dry-run` prints without sending; `--no-bias` skips the bias step.
- **Bias section** (`scripts/analyst/generateBias.ts`) — after the digest is formatted, it is handed to the **locally installed Claude CLI** in headless mode (`claude -p`) along with the last `ANALYST_BIAS_LOOKBACK_ENTRIES` (default 6) history entries, and the model returns a bullish/bearish/neutral call per timeframe plus one overall read. No hosted API key is involved. The model replies with JSON only — all Telegram markup is rendered by `formatDigest.ts`, so model output can never inject HTML into the message. Because the schedule runs 07:11–23:11 local only, the prompt spells out the real timestamps and the largest gap between entries (the overnight break), and the section header shows the true elapsed window (`vs ~13h ago` on the morning run) rather than assuming entries are hourly. **Best-effort:** CLI missing, non-zero exit, timeout, or off-schema JSON all just log to stderr and send the digest without the section. Env: `ANALYST_BIAS_ENABLED` (default true), `ANALYST_BIAS_LOOKBACK_ENTRIES` (6), `ANALYST_BIAS_TIMEOUT_MS` (120000), `ANALYST_BIAS_CLAUDE_MODEL` (optional `--model` passthrough), `ANALYST_BIAS_CLAUDE_BIN` (absolute path to the CLI — **required under launchd**, whose pinned PATH excludes `~/.local/bin`).
- `.claude/skills/btc-levels/` — an on-demand skill (ask "give me the levels overview" in a Claude Code session in this repo) for a fast, no-interpretation readout of current level values — independent of the hourly schedule.

### How to start the hourly digest

Open a Claude Code session in this repo directory and ask it to schedule the job. The exact prompt in use (recreate verbatim when the 7-day expiry hits):

> Run `npm run analyst-snapshot` in ~/PhpstormProjects/trading-bot (writes ./data/analyst-snapshot-latest.json using the current config/analyst-ta.json — do not modify that config yourself). Read the resulting JSON.
>
> Write a digest and post it directly in this chat session, AND send the same text via `npm run analyst-send -- "<digest text>"` so it lands in Telegram. Formatting requirements for the digest text (both copies):
> - Use Telegram HTML formatting: `<b>Header</b>` for each section title, real newline characters between lines/sections (not literal "\n" text, not a single run-on paragraph).
> - Use the snapshot's `*Human` date/time fields (generatedAtHuman, anchorTimeHuman, startTimeHuman/endTimeHuman) wherever a date/time is shown — never raw ISO timestamps like "2026-08-22T14:33:22.878Z".
> - Section headers get a leading emoji (fixed mapping): 💰 Price, 📊 Moving Averages, 🎯 BMSB, 📐 Anchored VWAP, 📉 Volume Profile, 📏 Fib Levels, 🔑 Key Levels, 🧭 Context, 💵 Derivatives, ⛓️ On-chain, 📰 News, 👀 Trade Setup Watch, 🧠 Bias. Format as "<emoji> <b>Header</b>" on its own line.
> - Price line format: "$77,227.90 (-$57)" — price followed by the change vs the previous run in parentheses (snapshot.price.changeAbs, rounded to the nearest whole dollar, explicit + or - sign). If snapshot.price.previousClose is null (no prior run yet), just show the price, no invented diff.
> - Sections, in order: Price, Moving Averages, BMSB (only if snapshot.bmsb is non-null), Anchored VWAP, Volume Profile, Fib/Key levels (only if non-empty), Context, Derivatives, On-chain, News (1-2 notable headlines if relevant), Trade Setup Watch, Bias (only when the CLI bias read succeeded).
> - Within a section, put each distinct fact/level on its OWN line prefixed with "• " (bullet) — never cram multiple facts onto one line with a "·" separator (Context, Derivatives, On-chain each become separate bullet lines, not one packed line).
> - Moving Averages MUST be sorted by their value (latest price level), highest first — NOT by timeframe/period order. Don't print any note about the sorting.
> - Color-code every TA level value (Moving Averages, BMSB lower/upper, VWAP, volume-profile POC/VAH/VAL, fib levels, key levels): append 🟢 right after the value if current price (snapshot.price.close) is ABOVE that level, 🔴 if price is BELOW it. Evaluate each value independently — for BMSB this naturally shows 🟢 on lower + 🔴 on upper when price sits inside the band. Do NOT color-code Context or Derivatives/On-chain — those aren't price-comparable levels.
> - Every moving average line MUST state its interval, e.g. "• SMA50 (4h): 67,556 🟢" — never a bare period with no timeframe.
> - BMSB line format: "• {lower} 🟢/🔴 – {upper} 🟢/🔴" plus a short bullet noting whether price is above, inside, or below the band.
> - Every VWAP/volume-profile line MUST state the interval used and note if the underlying config label still says "placeholder" (i.e. not yet a real user-set level).
> - Keep it factual and data-grounded, no trade opinions.
>
> Trade Setup Watch section (uses snapshot.proximityWatch — this is a PROXIMITY WATCH, not a trade signal):
> - From snapshot.proximityWatch.levels, pick up to 3 levels that are most notable: prioritize any with trend "approaching", then fill remaining slots by smallest abs(distancePercent). If none, one bullet: "no levels currently within notable range."
> - One bullet per picked level: setup side (📈 LONG at support / 📉 SHORT at resistance), label, value, distancePercent, role (support/resistance), and trend in plain English (real elapsed time via lookbackGeneratedAtHuman vs generatedAtHuman, or "not enough history yet" if trend is "insufficient_history").
> - Then one short bullet per notable level on what a reaction there would imply directionally, referencing other listed levels for "next support/resistance" — never invented numbers.
> - No specific entry prices, stop-loss levels, position sizing, or confidence/probability percentages — this is a watch list, not a trade call.

Ask for `recurring: true`, `durable: true`, cron `"11 * * * *"` (hourly, off the top of the hour).

This registers a `CronCreate` job (`recurring: true`, `durable: true`). Because it's a live agent run each time (not a templated script), you can immediately follow up in chat after any digest fires — ask "why," dig into one factor, or ask it to adjust the config.

**Important — this needs an open session to fire:** `CronCreate` jobs only run while a Claude Code session in this repo is open and idle. If you close the session (or your machine is off), the hourly digest simply doesn't fire until you reopen one. This is not a background service.

### How to stop it

Ask the in-session agent to cancel it (it can call `CronDelete` with the job ID returned when the job was created), or just close the session — a durable job with no open session won't fire, but stays registered until explicitly deleted or it expires (see below).

### 7-day lifespan — re-create weekly

`CronCreate` durable recurring jobs **auto-expire after 7 days**: the job fires one final time, then is deleted automatically. There's no "make it permanent" option today. In practice: every ~week, re-ask the agent to schedule it again (same prompt as above). If a week goes by with no digests and no obvious cause, this expiry is the first thing to check.

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
