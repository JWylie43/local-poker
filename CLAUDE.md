# Table Stakes — project memory

Chip + pot tracker for live poker with physical cards. The app is the money, never the cards:
no deck, no shuffling, no hand evaluation — humans compare hands and the host awards pots.

## Architecture (decided, don't relitigate without asking)

- **One Node process, all game state in memory** (`games` Map). No Redis, no database.
  Single-instance deployment (Render free tier or a phone on LAN) — there is nothing to share
  state *with*. Redis/Postgres are explicitly v2+ if ever.
- **Same codebase runs both modes**: LAN (phone/laptop server, no `PUBLIC_URL`) and cloud
  (Render, `PUBLIC_URL` set). Never add a dependency that breaks the LAN mode.
- **Clients are backup, never authority.** Server broadcasts full state + a snapshot on every
  change; each phone stores the snapshot in localStorage. On server restart, clients offer
  snapshots; the newest is restored with host approval (host immediately, anyone after 60s).
- **Derive, don't store**: connection status is recomputed from live sockets (never persisted
  in snapshots); "whose turn" logic and the snapshot ordering's action count come from
  `streetLog.length`. Do not add stored copies of derivable values.
- Snapshot ordering: tuple compare `(hand, streetIdx, streetLog.length)` — never a decimal or
  string compare.
- **Chip conservation invariant**: `sum(stacks) + sum(committedStreet) + pot + pots.remaining
  === totalChips`, asserted after every money movement (`assertConservation`). Any change to
  money flow must keep this passing. Restore rejects snapshots that fail it (tamper check).
- `applyAction(game, token, action)` is the only place chips move during a hand. Keep it that
  way — sockets/UI/host controls call it, never mutate chips directly.

## Poker rules (house rules, chosen deliberately)

- Short all-in (raise smaller than last full raise) does **not** reopen betting
  (`config.shortRaiseReopens = false`). Players who acted may only call or fold.
- Side pots: layered from **hand-total** commitments; folded money stays in its layers;
  residue above the top eligible level joins the top pot.
- Straddle: single UTG straddle only, 2× BB, opt-in per hand, config-gated. Straddler acts
  last preflop.
- Run it twice/thrice/quad: host selects runs at showdown; pots split per run; odd chips to
  earlier runs; split-pot odd chip to first selected winner. Table agreement is human-verified.
- Fold-out win: winner takes pot + all street commitments (own uncalled excess returns
  automatically inside that).
- Host is a transferable role in game state (token), never tied to a device or socket.

## Operational behavior

- Client heartbeat every 2 min (`{type:"ping"}`) — required: Render's 15-min idle timer only
  resets on inbound *messages*, not open sockets.
- Conditional self-ping: every 10 min the server fetches `PUBLIC_URL/health` only if a game is
  active and touched within 2h. Off when `PUBLIC_URL` unset (LAN). Never make it unconditional.
- Rooms untouched 12h are swept. Free-tier filesystem is ephemeral — never write state to disk.
- Restore is a one-shot door: offers are ignored once the room exists.

## Testing

- `test.js` is an e2e script against a running server (`node server.js` then `node test.js`).
  It covers: 3-handed blinds/order, fold-out win, short all-in no-reopen, side-pot layering &
  eligibility, RIT split payout, conservation at every stage, restore flow, presence
  recomputation, tampered-snapshot rejection. Keep all of these green; prefer adding cases for:
  heads-up blind order, min-raise validation, multiple short all-ins, split pots, straddle pots.

## Known gaps (intentional v1 scope)

- No turn timer / auto-fold (host force-fold covers it).
- Single snapshot retained (no "restart current hand" restore).
- UI tested for syntax only, not on real devices yet — expect mobile layout fixes.
- No accounts/auth: room code + localStorage token + host judgment is the trust model
  (friends, in person). Do not add login without being asked.
