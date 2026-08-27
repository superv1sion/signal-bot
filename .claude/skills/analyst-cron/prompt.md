# Superseded — the digest format now lives in code

This file used to hold the verbatim prompt replayed by a `CronCreate` job, which rendered the
hourly digest by hand each run. That design was unreliable: those jobs only fire while a Claude
session is idle, so fires were delayed or skipped whenever the session was busy, and died entirely
when it closed.

Every rule that was prose here is now implemented in **`scripts/analyst/formatDigest.ts`** — level
ordering, 🟢/🔴 vs current price, ⬆️/⬇️/➖ vs the previous run, BMSB dedupe, the approaching-only
proximity cluster for Trade Setup Watch, the omitted On-chain section, and the omitted trailing
disclaimer. That file is the single source of truth; edit it to change the format.

Delivery is a launchd agent — see `SKILL.md`.

Ad-hoc analysis of the same data still happens conversationally in Claude Code (ask about the
snapshot, or use the `btc-levels` skill); only the scheduled digest is deterministic.
