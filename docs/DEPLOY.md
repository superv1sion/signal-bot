# Deployment notes

## Environment

Required for LLM critique:

- `OPENAI_API_KEY` (or your provider key)
- `OPENAI_BASE_URL`, `OPENAI_MODEL` as needed

Telegram (optional):

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (optional; default outbound chat is `@ai_trade_signal_btc_bot` for daemon / one-shot; receives **paused** / **unpaused** announcements when admins change run state)
- `TELEGRAM_ADMIN_USER_IDS` (comma-separated numeric user ids) — required for **daemon** remote control: with `TELEGRAM_BOT_TOKEN`, the process long-polls **`/pause`** and **`/unpause`** so scheduled ticks stop or resume without redeploying. Example: `255450214`.

Pipeline tuning:

- `ENTRY_THRESHOLD` — minimum score to send a signal (default `5`; compared to LLM-adjusted score unless `ENTRY_GATE_MODE=best`; see README)
- `ENTRY_GATE_MODE` — `final` (default) or `best` (gate on raw strategy score; LLM adjustment advisory except `veto`)
- `LLM_MIN_SCORE` — call LLM critic only when best strategy score is at least this (default `3`)
- `POLL_MINUTES` — optional; overrides **normal** daemon interval (minutes). If unset, normal cadence = **primary** timeframe (e.g. 15m → 15 min)
- `HIGH_ATTENTION_MIN_SCORE` — when best strategy score ≥ this, daemon uses **lower timeframe** cadence (e.g. 15m chart → 5 min)
- `PAPER_TRADES_FIRESTORE` — set to `1` (or `true`) to persist **paper trades** (open legs + tick/close events) in **Firestore**
- `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_PATH` — path to the Firebase **service account JSON** (required when `PAPER_TRADES_FIRESTORE` is on)
- `FIRESTORE_COLLECTION_PREFIX` — optional string prepended to collection names `paper_trade_open` and `paper_trade_event` (e.g. `prod_` → `prod_paper_trade_open`)
- `LOG_FORMAT=json` — one JSON object per line for decisions and structured errors

## One-shot (cron)

```bash
chmod +x scripts/run-signal.sh
# crontab example: every 5 minutes
# */5 * * * * ENV_FILE=/opt/trading-bot/.env /opt/trading-bot/scripts/run-signal.sh BTCUSDT 5m
```

Or:

```bash
npx tsx index.ts BTCUSDT 5m --once
```

## Supervised daemon

### systemd

Copy `deploy/trading-bot.service` to `/etc/systemd/system/`, fix `WorkingDirectory`, `EnvironmentFile`, and `ExecStart`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now trading-bot
journalctl -u trading-bot -f
```

### PM2

```bash
pm2 start deploy/ecosystem.config.cjs
pm2 save
```

The process should be restarted by the supervisor on crash; use `RestartSec` / `StartLimitBurst` (systemd) or PM2 limits to avoid tight restart loops on misconfiguration.
