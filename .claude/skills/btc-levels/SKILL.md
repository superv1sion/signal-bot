---
name: btc-levels
description: On-demand, precise readout of the currently-configured BTC TA levels (MAs, anchored VWAP, volume profile POC/VAH/VAL, fib levels, key levels) from config/analyst-ta.json. Use when the user asks for "the levels", "levels overview", "where are my levels right now", or similar — a fast lookup, not a narrative digest.
---

# BTC levels overview

Give a compact, precise, **no-interpretation** readout of exactly the levels currently configured in `config/analyst-ta.json` — this is a lookup, not analysis. For the narrative "what's happening and why" write-up, that's the hourly analyst digest job instead.

## Steps

1. Run `npm run analyst-snapshot` in the trading-bot repo root (fetches fresh candles/derivatives/on-chain/news and recomputes everything from the current `config/analyst-ta.json`).
2. Read `./data/analyst-snapshot-latest.json`.
3. Color-code every level value: append 🟢 immediately after the value if current price (`price.close`) is ABOVE that level, 🔴 if price is BELOW it. Apply this per individual level value — for BMSB, evaluate `lower` and `upper` independently (price between them naturally shows 🟢 on `lower` and 🔴 on `upper`, i.e. "inside the band"). Do NOT color-code the Context section (RSI/ATR/Bollinger) or Derivatives/On-chain — those aren't price-comparable levels.
4. Sort the Moving averages lines by value (latest price level), highest first — NOT by timeframe/period order. Don't print any note about the sorting in the output, just apply it.

5. Report back in this format, one line per item, values only — no commentary, no trade opinion:

Use the `*Human` fields (e.g. `generatedAtHuman`, `anchorTimeHuman`, `startTimeHuman`) for anything printed — never raw ISO timestamps.

Section headers get a leading emoji (fixed mapping), each level on its own "• " bullet line:

```
BTC {symbol} — levels as of {generatedAtHuman}
💰 Price: {price.close} ({+/-}${price.changeAbs rounded} vs previous run, omit parens if price.previousClose is null)

📊 Moving averages
• {type}{period} ({interval}): {latest} 🟢/🔴
  ...

📐 Anchored VWAP ({primaryInterval} candles)
• {label} (anchored {anchorTimeHuman}): {latest} 🟢/🔴
  ...

📉 Volume profile ({volumeProfile.label}, {primaryInterval} candles)
• POC: {poc} 🟢/🔴
• VAH: {vah} 🟢/🔴
• VAL: {val} 🟢/🔴

🎯 BMSB ({bmsb.smaPeriod}W SMA / {bmsb.emaPeriod}W EMA)
• {lower} 🟢/🔴 – {upper} 🟢/🔴

📏 Fib levels
• {label} ({low}–{high}): 0.382 → {price} 🟢/🔴, 0.5 → {price} 🟢/🔴, 0.618 → {price} 🟢/🔴
  ...

🔑 Key levels
• {label}: {price} 🟢/🔴
  ...
```

- Omit a section entirely if its config array is empty (e.g. no fib levels configured yet), or if `bmsb` is null (disabled in config) — rather than printing an empty header.
- If `npm run analyst-snapshot` throws (e.g. an anchor time predates fetched history), surface the exact error — don't guess a substitute level.
- If the user says a level looks stale or wrong, that almost always means `config/analyst-ta.json` needs updating (wrong anchor time, wrong MA period, etc.) — offer to edit it rather than just re-running the snapshot.
