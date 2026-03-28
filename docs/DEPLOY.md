# Deployment notes

## Environment

Required for LLM critique:

- `OPENAI_API_KEY` (or your provider key)
- `OPENAI_BASE_URL`, `OPENAI_MODEL` as needed

Telegram (optional):

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (default outbound chat for daemon / one-shot)

Pipeline tuning:

- `ENTRY_THRESHOLD` — minimum score to send a signal (default `5`; compared to LLM-adjusted score unless `ENTRY_GATE_MODE=best`; see README)
- `ENTRY_GATE_MODE` — `final` (default) or `best` (gate on raw strategy score; LLM adjustment advisory except `veto`)
- `LLM_MIN_SCORE` — call LLM critic only when best strategy score is at least this (default `3`)
- `POLL_MINUTES` — optional; overrides **normal** daemon interval (minutes). If unset, normal cadence = **primary** timeframe (e.g. 15m → 15 min)
- `HIGH_ATTENTION_MIN_SCORE` — when best strategy score ≥ this, daemon uses **lower timeframe** cadence (e.g. 15m chart → 5 min)
- `RUN_ARTIFACT_DIR` — if set, writes per-run JSON and appends `decisions.jsonl`
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
