# Table Stakes

Chip + pot tracker for live poker. The cards stay physical — this app is the money.
One Node process, all state in memory, and every phone holds a **snapshot backup** of the game,
so a server restart is recoverable.

## What's implemented

- Full betting engine: blinds, check/call/bet/raise/fold, all-in
- **Side pots** (layered from hand-total commitments, per-pot eligibility)
- **Incomplete-raise rule**: a short all-in does not reopen betting (house-configurable constant in `server.js`)
- **Straddle** (single UTG straddle, opt-in per hand, config-gated)
- **Run it twice/thrice/quad**: pots split per run at payout; odd chips go to earlier runs
- Showdown payout UI: host taps winners per pot per run (supports split pots)
- Reconnect tokens (localStorage) — lock your phone, come back, you're in your seat
- Host controls: deal, force-fold (current actor only), seat/assign players, ±chips, transfer host, remove player, end game
- Seat takeover: someone cleared their storage → they rejoin by name, host hands them their old seat
- **Snapshot/restore**: every state change is backed up to every client; on server restart the
  newest backup (ordered by hand → street → action count, all derived) restores the game.
  Host restores immediately; after 60s anyone present may restore and claim host.
  Tampered snapshots are rejected by a chip-conservation check.
- Chip conservation assert after every money movement (server logs + warns the table on mismatch)
- Client heartbeat every 2 min (keeps Render's idle timer reset while anyone has the page open)
- Conditional **self-ping**: server pings its own public URL every 10 min _only while a game is
  active and touched within 2h_, so it stays awake through dinner but sleeps when abandoned
- Screen Wake Lock on the host's phone while the tab is visible
- Room sweep: rooms untouched for 12h are deleted

## Run on your laptop / phone-as-server (LAN night)

```bash
npm install
npm start          # http://localhost:3000
```

Everyone on the same wifi/hotspot opens `http://<your-LAN-IP>:3000` and joins with the room code.
(To run the server _on a phone_, use Termux on Android — `pkg install nodejs`, clone, `npm start`.)

No `PUBLIC_URL` set → the self-ping is off (irrelevant on LAN).

## Deploy free on Render

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
   - Build: `npm install` · Start: `npm start` · Instance type: **Free**
3. After the first deploy, add an environment variable:
   - `PUBLIC_URL` = `https://<your-service>.onrender.com`
     (this enables the self-keep-alive; without it the service sleeps after 15 idle minutes)
4. Share `https://<your-service>.onrender.com/?g=CODE`.

Notes for the free tier:

- First visit after sleep takes ~1 min to wake. The page just loads slow once; then it's instant.
- Render may restart free services at any time. If that happens mid-game, everyone reloads,
  the app offers the newest phone backup, host taps **Restore**.
- Deploying new code restarts the server — same restore flow applies. Don't deploy on game night.

## House-rule knobs (top of `server.js` / game config)

- `shortRaiseReopens` — whether an all-in shorter than a full raise reopens action (default: no)
- `straddleAllowed`, `ritAllowed`, blinds, default buy-in — set at table creation
- Odd chips: extra chip to earlier runs; split-pot odd chip to first selected winner

## v2 ideas (deliberately not built)

- Turn timer with auto-fold (host force-fold covers it for now)
- Multiple snapshots per hand ("restart current hand" restore option)
- Persistence to Postgres for multi-session bankrolls
- Mississippi/button straddles, re-straddles
