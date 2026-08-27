---
name: analyst-cron
description: Start, stop, or check status of the recurring hourly BTC analyst digest job (launchd agent running `npm run analyst-digest`). Use when the user asks to "start/stop/pause/resume the analyst cron", "turn off the hourly digest", "is the analyst job running", "restart the digest job", "status", "check status", "is it up", "is it working", or similar.
---

# Analyst digest job control

The hourly digest runs as a **launchd user agent** — `com.grigor.analyst-digest`, defined by
`~/Library/LaunchAgents/com.grigor.analyst-digest.plist`, firing `npm run analyst-digest` in
`~/PhpstormProjects/trading-bot` at :11 past every hour **from 07:11 to 23:11 local time**
(Asia/Yerevan). Nothing fires overnight — 17 runs a day, not 24.

It has no dependency on Claude Code. `npm run analyst-digest` refreshes the snapshot
(`buildSnapshot.ts`), renders the text deterministically (`formatDigest.ts`), and sends it to
Telegram — so the digest lands on time whether or not any session is open.

> Do NOT reintroduce a `CronCreate` job for this. That was the previous design and it was
> unreliable: those jobs only fire while a Claude session is idle, and die when it closes. If a
> `CronList` entry for the analyst digest exists, it's a leftover that will double-post — delete it.

## Status

1. `launchctl print gui/$(id -u)/com.grigor.analyst-digest` — report `state`, `runs`, and
   `last exit code`. Exit code 0 is healthy. "Could not find service" means not installed.
2. Freshness — read `generatedAtHuman` from `./data/analyst-snapshot-latest.json` and report it,
   so the user sees the pipeline is actually producing recent output, not just that an agent is
   registered. A loaded agent with a stale timestamp is worth flagging even though `launchctl`
   alone would call it healthy.
3. Optionally `tail -5 ~/Library/Logs/analyst-digest.log` for the last send confirmation.

Report together, e.g.: "Loaded, hourly at :11, last exit 0, 14 runs. Last snapshot: Aug 23, 2026,
17:42 UTC (8 min ago)." Don't run `npm run analyst-digest` just to answer a status check — that
sends a real Telegram message.

Note: `~/Library/Logs/analyst-digest.err` routinely contains a `CryptoPanic ... 403 Forbidden`
trace. That's a handled fallback to CoinDesk RSS, not a failure — don't report it as broken.

## Stop

`launchctl bootout gui/$(id -u)/com.grigor.analyst-digest`

Unloads the agent; the plist stays on disk so Start can re-load it. To disable across reboots as
well, add `launchctl disable gui/$(id -u)/com.grigor.analyst-digest`.

## Start

`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.grigor.analyst-digest.plist`

If it was previously disabled, `launchctl enable gui/$(id -u)/com.grigor.analyst-digest` first.
Confirm with the Status check afterward. If the plist is missing, recreate it per **Plist notes**.

## Run one now

`launchctl kickstart -p gui/$(id -u)/com.grigor.analyst-digest` — fires the real agent (sends to
Telegram). For a no-send preview instead, use `npm run analyst-digest -- --dry-run`.

## Changing the schedule

Edit `StartCalendarInterval` in the plist, then bootout + bootstrap to reload — launchd does not
pick up plist edits automatically:

```
launchctl bootout gui/$(id -u)/com.grigor.analyst-digest
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.grigor.analyst-digest.plist
```

Verify with `launchctl print gui/$(id -u)/com.grigor.analyst-digest | grep -c Minute` — the count
should equal the number of scheduled hours (currently 17).

**Times are LOCAL wall-clock, not UTC** — launchd differs from cron-style cloud schedulers here, so
write the hours as the user says them. The current shape is an array of one dict per hour (7–23),
each with `Minute` 11. A bare `<key>Minute</key><integer>11</integer>` dict with no `Hour` would
mean all 24 hours; adding both keys pins a single daily run.

Note the waking-hours window interacts with sleep: launchd coalesces missed fires into **one** run
on wake, so closing the laptop overnight yields a single catch-up digest in the morning, not a
backlog. Its Price line self-labels the span (e.g. `(+$412 vs 9h ago)`).

## Plist notes

- `ProgramArguments` hardcodes the nvm node path
  (`/Users/grigor.oganesyan/.nvm/versions/node/v22.22.1/bin/npm`), and `EnvironmentVariables.PATH`
  includes that same bin dir. **An nvm node upgrade breaks the job** — if runs start failing after
  a node version change, update both places in the plist and reload.
- `RunAtLoad` is false, so loading it doesn't immediately fire a digest.
- Logs: `~/Library/Logs/analyst-digest.log` (stdout) and `.err` (stderr).
