/* Local Poker — live-poker chip & pot tracker.
 * One Node process. All state in memory (Map). Clients hold snapshot backups.
 * Runs identically on a phone (LAN) and on Render (set PUBLIC_URL for keep-alive).
 */
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // e.g. https://yourapp.onrender.com
const STREETS = ["preflop", "flop", "turn", "river"];
const STALE_GAME_MS = 2 * 60 * 60 * 1000; // stop keep-alive pings after 2h idle
const SWEEP_GAME_MS = 12 * 60 * 60 * 1000; // delete rooms untouched for 12h
const RESTORE_HOST_WAIT_MS = 60 * 1000; // after this, any player may restore

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => {return res.json({ ok: true, games: games.size })});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** rooms: code -> game. pending: code -> { first: ts, best: {snapshot, seq, savedAt, fromName}, sockets:Set } */
const games = new Map();
const pending = new Map();

/* ---------------------------------------------------------------- utils */
const rid = (n = 12) => {return crypto.randomBytes(n).toString("base64url")};
const roomCode = () => {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no confusable chars
  let c;
  do {
    c = Array.from({ length: 5 }, () => {return A[crypto.randomInt(A.length)]}).join("");
  } while (games.has(c));
  return c;
};
const streetIdx = (s) =>
  {return s === null ? -1 : STREETS.indexOf(s) === -1 ? STREETS.length : STREETS.indexOf(s)};
/** snapshot ordering: (hand, streetIdx, streetLog.length) — action count derived, never stored */
function seqOf(g) {
  return { hand: g.hand, street: streetIdx(g.street), actions: g.streetLog.length };
}
function seqNewer(a, b) {
  if (!b) return true;
  if (a.hand !== b.hand) return a.hand > b.hand;
  if (a.street !== b.street) return a.street > b.street;
  return a.actions > b.actions;
}

/* ------------------------------------------------------------ game model */
function newGame(hostToken, hostName, cfg) {
  const g = {
    code: roomCode(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    config: {
      smallBlind: cfg.smallBlind || 1,
      bigBlind: cfg.bigBlind || 2,
      defaultBuyIn: cfg.defaultBuyIn || 200,
      straddleAllowed: !!cfg.straddleAllowed,
      ritAllowed: cfg.ritAllowed !== false,
      shortRaiseReopens: false, // house rule: short all-in does NOT reopen action
    },
    state: "idle", // idle | hand | showdown
    hand: 0,
    street: null,
    buttonSeat: -1,
    hostToken,
    totalChips: 0, // conservation invariant
    pot: 0, // swept from completed streets
    players: [], // seated
    unseated: [], // joined, waiting for host to seat/assign
    streetLog: [],
    handLog: {}, // completed streets of current hand
    betting: null, // { currentBet, lastFullRaiseSize, toActSeat }
    pots: null, // showdown: [{amount, eligible:[seat]}]
    ritRuns: 1,
    straddleNextToken: null,
    notice: "",
  };
  seatPlayer(g, hostToken, hostName, g.config.defaultBuyIn);
  return g;
}

function seatPlayer(g, token, name, stack) {
  const seat = g.players.length ? Math.max(...g.players.map((p) => {return p.seat})) + 1 : 0;
  g.players.push({
    token,
    name,
    seat,
    stack,
    committedStreet: 0,
    committedHand: 0,
    folded: false,
    allIn: false,
    acted: false,
    inHand: false,
    connected: false,
    removed: false,
  });
  g.totalChips += stack;
  return seat;
}

const alive = (g) => {return g.players.filter((p) => {return !p.removed})};
const inHand = (g) => {return alive(g).filter((p) => {return p.inHand && !p.folded})};
const canAct = (g) => {return inHand(g).filter((p) => {return !p.allIn})};
const bySeat = (g, s) => {return g.players.find((p) => {return p.seat === s && !p.removed})};
const byToken = (g, t) => {return g.players.find((p) => {return p.token === t && !p.removed})};

function nextSeat(g, from, filter) {
  const seats = alive(g)
    .map((p) => {return p.seat})
    .sort((a, b) => {return a - b});
  if (!seats.length) return -1;
  let i = seats.indexOf(from);
  for (let k = 1; k <= seats.length; k++) {
    const s = seats[(i + k) % seats.length];
    const p = bySeat(g, s);
    if (!filter || filter(p)) return s;
  }
  return -1;
}

function assertConservation(g) {
  const sum =
    alive(g).reduce((a, p) => {return a + p.stack + p.committedStreet}, 0) +
    g.pot +
    (g.pots ? g.pots.reduce((a, q) => {return a + q.remaining}, 0) : 0);
  if (sum !== g.totalChips) {
    console.error(`[${g.code}] CHIP LEAK: have ${sum}, expected ${g.totalChips}`);
    g.notice = `⚠ Chip accounting mismatch (${sum} vs ${g.totalChips}). Host: verify stacks.`;
  }
}

/* ------------------------------------------------------- hand lifecycle */
function startHand(g) {
  const ready = alive(g).filter((p) => {return p.stack > 0});
  if (ready.length < 2) throw "Need 2+ players with chips.";
  g.hand += 1;
  g.state = "hand";
  g.street = "preflop";
  g.pot = 0;
  g.pots = null;
  g.ritRuns = 1;
  g.streetLog = [];
  g.handLog = {};
  g.notice = "";
  for (const p of alive(g)) {
    Object.assign(p, {
      committedStreet: 0,
      committedHand: 0,
      folded: false,
      allIn: false,
      acted: false,
    });
    p.inHand = p.stack > 0;
  }
  g.buttonSeat = g.buttonSeat === -1 ? ready[0].seat : nextSeat(g, g.buttonSeat, (p) => {return p.inHand});

  const headsUp = inHand(g).length === 2;
  const sbSeat = headsUp ? g.buttonSeat : nextSeat(g, g.buttonSeat, (p) => {return p.inHand});
  const bbSeat = nextSeat(g, sbSeat, (p) => {return p.inHand});
  post(g, bySeat(g, sbSeat), g.config.smallBlind, "small blind");
  post(g, bySeat(g, bbSeat), g.config.bigBlind, "big blind");

  let currentBet = g.config.bigBlind;
  let lastFullRaiseSize = g.config.bigBlind;
  let firstToAct = nextSeat(g, bbSeat, (p) => {return p.inHand && !p.allIn});

  // Single UTG straddle (posted blind, straddler acts last preflop)
  const utg = bySeat(
    g,
    nextSeat(g, bbSeat, (p) => {return p.inHand})
  );
  if (
    g.config.straddleAllowed &&
    g.straddleNextToken &&
    utg &&
    utg.token === g.straddleNextToken &&
    utg.stack > 0 &&
    !headsUp
  ) {
    const amt = g.config.bigBlind * 2;
    post(g, utg, amt, "straddle");
    currentBet = utg.committedStreet;
    lastFullRaiseSize = currentBet - g.config.bigBlind || g.config.bigBlind;
    firstToAct = nextSeat(g, utg.seat, (p) => {return p.inHand && !p.allIn});
  }
  g.straddleNextToken = null;
  g.betting = { currentBet, lastFullRaiseSize, toActSeat: firstToAct };
  if (canAct(g).length <= 1) settleStreetIfDone(g, true); // everyone blinded all-in
}

function post(g, p, amt, label) {
  const pay = Math.min(amt, p.stack);
  p.stack -= pay;
  p.committedStreet += pay;
  p.committedHand += pay;
  if (p.stack === 0) p.allIn = true;
  g.streetLog.push({ seat: p.seat, name: p.name, act: label, amt: pay, allIn: p.allIn });
}

/* ------------------------------------------------------ action engine */
/** The only place chips move during a hand. Throws a string on illegal input. */
function applyAction(g, token, action) {
  if (g.state !== "hand") throw "No betting round in progress.";
  const p = byToken(g, token);
  if (!p || !p.inHand || p.folded) throw "You're not in this hand.";
  if (p.seat !== g.betting.toActSeat) throw "Not your turn.";
  const B = g.betting;
  const owe = B.currentBet - p.committedStreet;

  switch (action.type) {
    case "fold": {
      p.folded = true;
      p.acted = true;
      g.streetLog.push({ seat: p.seat, name: p.name, act: "fold" });
      break;
    }
    case "check": {
      if (owe > 0) throw `Can't check — ${owe} to call.`;
      p.acted = true;
      g.streetLog.push({ seat: p.seat, name: p.name, act: "check" });
      break;
    }
    case "call": {
      if (owe <= 0) throw "Nothing to call — check instead.";
      const pay = Math.min(owe, p.stack);
      p.stack -= pay;
      p.committedStreet += pay;
      p.committedHand += pay;
      p.acted = true;
      if (p.stack === 0) p.allIn = true;
      g.streetLog.push({ seat: p.seat, name: p.name, act: "call", amt: pay, allIn: p.allIn });
      break;
    }
    case "raise": {
      // raise.to = total committed this street after raising (also covers opening bet)
      const to = Math.floor(action.to);
      if (!Number.isFinite(to) || to <= B.currentBet) throw "Raise must exceed the current bet.";
      const add = to - p.committedStreet;
      if (add <= 0) throw "Invalid raise amount.";
      if (add > p.stack) throw "That's more than your stack — use all-in.";
      // Incomplete-raise rule: players who already acted since the last FULL raise may not raise again.
      if (p.acted) throw "Betting wasn't reopened to you — call or fold.";
      const raiseSize = to - B.currentBet;
      const minTo = B.currentBet + B.lastFullRaiseSize;
      const isAllIn = add === p.stack;
      if (raiseSize < B.lastFullRaiseSize && !isAllIn) throw `Minimum raise is to ${minTo}.`;
      p.stack -= add;
      p.committedStreet = to;
      p.committedHand += add;
      if (isAllIn) p.allIn = true;
      p.acted = true;
      const full = raiseSize >= B.lastFullRaiseSize;
      if (full) {
        B.lastFullRaiseSize = raiseSize;
        for (const q of inHand(g)) if (q !== p && !q.allIn) q.acted = false; // reopen
      } else if (g.config.shortRaiseReopens) {
        for (const q of inHand(g)) if (q !== p && !q.allIn) q.acted = false;
      }
      B.currentBet = to;
      g.streetLog.push({
        seat: p.seat,
        name: p.name,
        act: B.currentBet === to && raiseSize === to ? "bet" : "raise",
        amt: to,
        allIn: p.allIn,
        short: !full,
      });
      break;
    }
    case "allin": {
      if (p.stack <= 0) throw "No chips behind.";
      const to = p.committedStreet + p.stack;
      if (to > B.currentBet) return applyAction(g, token, { type: "raise", to });
      // all-in call (short of the bet)
      p.committedStreet = to;
      p.committedHand += p.stack;
      p.stack = 0;
      p.allIn = true;
      p.acted = true;
      g.streetLog.push({ seat: p.seat, name: p.name, act: "call", amt: to, allIn: true });
      break;
    }
    default:
      throw "Unknown action.";
  }
  advanceTurn(g);
  assertConservation(g);
}

function advanceTurn(g) {
  // Hand over by folds?
  const live = inHand(g);
  if (live.length === 1) return endByFolds(g, live[0]);
  if (settleStreetIfDone(g)) return;
  g.betting.toActSeat = nextSeat(
    g,
    g.betting.toActSeat,
    (p) =>
      {return p.inHand && !p.folded && !p.allIn && !(p.acted && p.committedStreet === g.betting.currentBet)}
  );
}

function streetDone(g) {
  const actors = canAct(g);
  if (actors.length === 0) return true; // everyone all-in
  return actors.every((p) => {return p.acted && p.committedStreet === g.betting.currentBet});
}

function settleStreetIfDone(g, force = false) {
  if (!force && !streetDone(g)) return false;
  // sweep street commits into the pot
  for (const p of alive(g)) {
    g.pot += p.committedStreet;
    p.committedStreet = 0;
  }
  g.handLog[g.street] = g.streetLog;
  g.streetLog = [];
  const runout = canAct(g).length <= 1; // ≤1 player can still bet → no more betting rounds
  const last = g.street === "river";
  if (last || runout) return void toShowdown(g, runout && !last) || true;
  g.street = STREETS[streetIdx(g.street) + 1];
  for (const p of inHand(g)) p.acted = false;
  g.betting = {
    currentBet: 0,
    lastFullRaiseSize: g.config.bigBlind,
    toActSeat: nextSeat(g, g.buttonSeat, (p) => {return p.inHand && !p.folded && !p.allIn}),
  };
  return true;
}

function endByFolds(g, winner) {
  for (const p of alive(g)) {
    g.pot += p.committedStreet;
    p.committedStreet = 0;
  }
  winner.stack += g.pot; // includes return of winner's own uncalled excess
  g.notice = `${winner.name} wins ${g.pot} — everyone folded.`;
  g.pot = 0;
  endHand(g);
}

function toShowdown(g, earlyRunout) {
  g.state = "showdown";
  g.betting = null;
  g.pots = computePots(g);
  g.notice = earlyRunout
    ? "All-in — deal the remaining board (run it twice if agreed), then the host awards the pots."
    : "Showdown — compare hands, then the host awards the pots.";
}

/** Layered side pots from hand-total commitments. Eligibility = non-folded contributors. */
function computePots(g) {
  const contrib = alive(g)
    .filter((p) => {return p.committedHand > 0})
    .map((p) => {return { seat: p.seat, amt: p.committedHand, eligible: p.inHand && !p.folded }});
  const levels = [...new Set(contrib.filter((c) => {return c.eligible}).map((c) => {return c.amt}))].sort(
    (a, b) => {return a - b}
  );
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contrib) amount += Math.max(0, Math.min(c.amt, level) - prev);
    const eligible = contrib.filter((c) => {return c.eligible && c.amt >= level}).map((c) => {return c.seat});
    if (amount > 0) pots.push({ amount, eligible, remaining: amount });
    prev = level;
  }
  // Folded money above the top eligible level (rare) → top pot
  let residue = 0;
  for (const c of contrib) residue += Math.max(0, c.amt - prev);
  if (residue > 0 && pots.length) {
    pots[pots.length - 1].amount += residue;
    pots[pots.length - 1].remaining += residue;
  }
  g.pot = 0; // pot now lives in `pots`
  return pots;
}

/** awards: [{pot: idx, runs: [[seat,...winners of run 1],[...run 2]]}] */
function awardPots(g, awards) {
  if (g.state !== "showdown") throw "Not at showdown.";
  const runs = Math.max(1, Math.min(4, Math.floor(g.ritRuns)));
  for (const a of awards) {
    const pot = g.pots[a.pot];
    if (!pot) throw "Unknown pot.";
    if (!Array.isArray(a.runs) || a.runs.length !== runs) throw `Need winners for ${runs} run(s).`;
    for (const winners of a.runs)
      for (const s of winners)
        if (!pot.eligible.includes(s)) throw `Seat ${s} isn't eligible for that pot.`;
  }
  for (const a of awards) {
    const pot = g.pots[a.pot];
    const per = Math.floor(pot.amount / runs);
    let leftover = pot.amount - per * runs; // odd chips → earliest runs
    for (const winners of a.runs) {
      let share = per + (leftover > 0 ? 1 : 0);
      if (leftover > 0) leftover--;
      const each = Math.floor(share / winners.length);
      let odd = share - each * winners.length; // split-pot odd chip → first listed (left of button)
      for (const s of winners) {
        const w = bySeat(g, s);
        w.stack += each + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
      }
    }
    pot.remaining = 0;
  }
  g.pots = null;
  g.notice = "Pots paid.";
  endHand(g);
  assertConservation(g);
}

function endHand(g) {
  g.state = "idle";
  g.street = null;
  g.streetLog = [];
  g.betting = null;
  for (const p of alive(g)) {
    p.inHand = false;
    p.folded = false;
    p.allIn = false;
    p.acted = false;
    p.committedHand = 0;
  }
}

/* --------------------------------------------------- snapshots & wire */
function snapshot(g) {
  const { players, unseated, ...rest } = g;
  return {
    ...rest,
    players: players.map(({ ws, connected, ...p }) => {return p}), // connection state is derived, never persisted
    unseated: unseated.map(({ ws, ...u }) => {return u}),
  };
}
function publicState(g) {
  return {
    ...snapshot(g),
    players: alive(g).map((p) => {return {
      ...p,
      ws: undefined,
      token: undefined,
      connected: p.connected,
    }}),
    unseated: g.unseated.map((u) => {return { id: u.id, name: u.name }}),
    seq: seqOf(g),
  };
}
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(g) {
  g.lastActivity = Date.now();
  const state = publicState(g);
  const snap = snapshot(g);
  for (const p of alive(g)) {
    if (!p.ws) continue;
    send(p.ws, {
      type: "state",
      state,
      snapshot: snap,
      seq: state.seq,
      you: { seat: p.seat, isHost: p.token === g.hostToken },
    });
  }
  for (const u of g.unseated)
    send(u.ws, { type: "state", state, seq: state.seq, you: { seat: -1, isHost: false } });
}

/* -------------------------------------------------------- ws handling */
wss.on("connection", (ws) => {
  ws.meta = {};
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      handle(ws, m);
    } catch (err) {
      send(ws, { type: "error", message: String(err) });
    }
  });
  ws.on("close", () => {
    const { room, token } = ws.meta;
    const g = games.get(room);
    if (!g) {
      const p = pending.get(room);
      if (p) p.sockets.delete(ws);
      return;
    }
    const pl = token && byToken(g, token);
    if (pl && pl.ws === ws) {
      pl.ws = null;
      pl.connected = false;
      broadcast(g);
    }
    const u = g.unseated.find((x) => {return x.ws === ws});
    if (u) {
      g.unseated = g.unseated.filter((x) => {return x !== u});
      broadcast(g);
    }
  });
});

function requireHost(g, token) {
  if (token !== g.hostToken) throw "Host only.";
}

function handle(ws, m) {
  /* heartbeat — also what keeps Render's idle timer reset */
  if (m.type === "ping") return send(ws, { type: "pong" });

  if (m.type === "create") {
    const token = rid();
    const g = newGame(token, (m.name || "Host").slice(0, 20), m.config || {});
    games.set(g.code, g);
    ws.meta = { room: g.code, token };
    const p = byToken(g, token);
    p.ws = ws;
    p.connected = true;
    send(ws, { type: "created", room: g.code, token });
    return broadcast(g);
  }

  if (m.type === "hello") {
    const room = String(m.room || "").toUpperCase();
    const g = games.get(room);
    if (!g) return handleUnknownRoom(ws, room, m);
    ws.meta = { room, token: m.token };
    const p = m.token && byToken(g, m.token);
    if (p) {
      p.ws = ws;
      p.connected = true;
      return broadcast(g);
    }
    // no matching seat → join queue for the host to seat/assign
    if (!m.name) return send(ws, { type: "need_name", room });
    const token = rid();
    ws.meta.token = token;
    g.unseated.push({ id: rid(4), token, name: String(m.name).slice(0, 20), ws });
    send(ws, { type: "joined_unseated", room, token });
    return broadcast(g);
  }

  const g = games.get(ws.meta.room);
  const token = ws.meta.token;

  /* ---- restore path (room may not exist yet) ---- */
  if (m.type === "offer_snapshot") return offerSnapshot(ws, m);
  if (m.type === "restore") return doRestore(ws, m);

  if (!g) throw "No room. Reload and rejoin.";
  const me = byToken(g, token);

  switch (m.type) {
    /* ---- player actions ---- */
    case "action":
      applyAction(g, token, m.action);
      break;
    case "straddle_next": {
      if (!g.config.straddleAllowed) throw "Straddles are off for this game.";
      if (!me) throw "Take a seat first.";
      g.straddleNextToken = me && g.straddleNextToken === me.token ? null : me.token;
      break;
    }

    /* ---- host controls ---- */
    case "start_hand":
      requireHost(g, token);
      startHand(g);
      break;
    case "set_rit": {
      requireHost(g, token);
      if (g.state !== "showdown") throw "Choose runs at showdown.";
      if (!g.config.ritAllowed && m.runs > 1) throw "Run-it-twice is off.";
      g.ritRuns = Math.max(1, Math.min(4, Math.floor(m.runs || 1)));
      g.notice =
        g.ritRuns > 1
          ? `Running it ${g.ritRuns}× (all all-in players must agree at the table).`
          : "Single run.";
      break;
    }
    case "award":
      requireHost(g, token);
      awardPots(g, m.awards);
      break;
    case "force_fold": {
      requireHost(g, token);
      const p = bySeat(g, m.seat);
      if (!p || g.state !== "hand") throw "No one to fold.";
      if (p.seat !== g.betting.toActSeat) throw "Can only force-fold the player whose turn it is.";
      applyAction(g, p.token, { type: "fold" });
      g.notice = `${p.name} folded by host.`;
      break;
    }
    case "seat_player": {
      // seat someone from the join queue with a buy-in
      requireHost(g, token);
      if (g.state === "hand") throw "Seat players between hands.";
      const u = g.unseated.find((x) => {return x.id === m.uid});
      if (!u) throw "They're gone.";
      const buy = Math.max(0, Math.floor(m.buyIn ?? g.config.defaultBuyIn));
      const seat = seatPlayer(g, u.token, u.name, buy);
      const np = bySeat(g, seat);
      np.ws = u.ws;
      np.connected = true;
      if (np.ws) np.ws.meta = { room: g.code, token: u.token };
      g.unseated = g.unseated.filter((x) => {return x !== u});
      break;
    }
    case "assign_seat": {
      // hand an existing seat (stack and all) to someone in the queue
      requireHost(g, token);
      const u = g.unseated.find((x) => {return x.id === m.uid});
      const p = bySeat(g, m.seat);
      if (!u || !p) throw "Pick a queued player and a seat.";
      if (p.connected) throw "That seat's owner is still connected.";
      if (p.token === g.hostToken) g.hostToken = u.token;
      p.token = u.token;
      p.name = u.name;
      p.ws = u.ws;
      p.connected = true;
      if (p.ws) p.ws.meta = { room: g.code, token: u.token };
      g.unseated = g.unseated.filter((x) => {return x !== u});
      g.notice = `${p.name} took over seat ${p.seat}.`;
      break;
    }
    case "remove_player": {
      requireHost(g, token);
      const p = bySeat(g, m.seat);
      if (!p) throw "No such seat.";
      if (p.token === g.hostToken) throw "Transfer host before removing yourself.";
      if (g.state === "hand" && p.inHand && !p.folded) {
        p.folded = true; // committed chips stay in the pot
        g.streetLog.push({ seat: p.seat, name: p.name, act: "fold" });
        if (g.betting && g.betting.toActSeat === p.seat) advanceTurn(g);
      }
      g.totalChips -= p.stack;
      p.stack = 0;
      p.removed = true;
      p.connected = false;
      p.ws = null;
      g.notice = `${p.name} left the game (stack cashed out).`;
      assertConservation(g);
      break;
    }
    case "add_chips": {
      // rebuy / top-up between hands
      requireHost(g, token);
      if (g.state === "hand") throw "Adjust stacks between hands.";
      const p = bySeat(g, m.seat);
      const amt = Math.floor(m.amount);
      if (!p || !Number.isFinite(amt)) throw "Bad amount.";
      if (p.stack + amt < 0) throw "Stack can't go negative.";
      p.stack += amt;
      g.totalChips += amt;
      g.notice = `${p.name}: ${amt >= 0 ? "+" : ""}${amt} chips.`;
      break;
    }
    case "transfer_host": {
      requireHost(g, token);
      const p = bySeat(g, m.seat);
      if (!p) throw "No such seat.";
      g.hostToken = p.token;
      g.notice = `${p.name} is now the host.`;
      break;
    }
    case "end_game": {
      requireHost(g, token);
      games.delete(g.code);
      for (const p of alive(g)) send(p.ws, { type: "ended", state: publicState(g) });
      for (const u of g.unseated) send(u.ws, { type: "ended" });
      return;
    }
    default:
      throw "Unknown message.";
  }
  broadcast(g);
}

/* --------------------------------------------------------- restore flow */
function handleUnknownRoom(ws, room, m) {
  ws.meta = { room, token: m.token };
  send(ws, { type: "unknown_room", room });
  let p = pending.get(room);
  if (!p) {
    p = { first: Date.now(), best: null, sockets: new Set() };
    pending.set(room, p);
  }
  p.sockets.add(ws);
}

function offerSnapshot(ws, m) {
  const room = String(m.room || "").toUpperCase();
  if (games.has(room)) return send(ws, { type: "room_live", room }); // one-shot door: room exists, offers ignored
  let p = pending.get(room);
  if (!p) {
    p = { first: Date.now(), best: null, sockets: new Set() };
    pending.set(room, p);
  }
  p.sockets.add(ws);
  const snap = m.snapshot;
  if (!validSnapshot(snap, room))
    return send(ws, { type: "error", message: "Snapshot rejected (bad shape)." });
  const seq = {
    hand: snap.hand,
    street: streetIdx(snap.street),
    actions: (snap.streetLog || []).length,
  };
  if (!p.best || seqNewer(seq, p.best.seq))
    p.best = { snapshot: snap, seq, savedAt: m.savedAt || Date.now(), fromName: m.fromName || "?" };
  notifyRestorable(room);
}

function notifyRestorable(room) {
  const p = pending.get(room);
  if (!p || !p.best) return;
  const anyoneMayRestore = Date.now() - p.first > RESTORE_HOST_WAIT_MS;
  for (const ws of p.sockets) {
    const isHost = ws.meta.token && ws.meta.token === p.best.snapshot.hostToken;
    send(ws, {
      type: "restore_prompt",
      room,
      seq: p.best.seq,
      savedAt: p.best.savedAt,
      fromName: p.best.fromName,
      canRestore: isHost || anyoneMayRestore,
      youAreHost: isHost,
      waitMs: anyoneMayRestore ? 0 : RESTORE_HOST_WAIT_MS - (Date.now() - p.first),
    });
  }
  if (!anyoneMayRestore)
    setTimeout(() => {return notifyRestorable(room)}, RESTORE_HOST_WAIT_MS - (Date.now() - p.first) + 250);
}

function doRestore(ws, m) {
  const room = String(m.room || "").toUpperCase();
  if (games.has(room)) throw "Room is already live — just rejoin.";
  const p = pending.get(room);
  if (!p || !p.best) throw "No snapshot to restore from.";
  const isHost = ws.meta.token === p.best.snapshot.hostToken;
  if (!isHost && Date.now() - p.first <= RESTORE_HOST_WAIT_MS)
    throw "Waiting for the host to restore.";
  const g = reviveSnapshot(p.best.snapshot, room);
  if (!isHost && ws.meta.token) g.hostToken = ws.meta.token; // claimed host after timeout
  games.set(room, g);
  pending.delete(room);
  g.notice = `Game restored from ${p.best.fromName}'s snapshot (hand ${g.hand}${g.street ? ", " + g.street : ""}).`;
  // reattach every waiting socket through the normal hello path
  for (const s of p.sockets) {
    const pl = s.meta.token && byToken(g, s.meta.token);
    if (pl) {
      pl.ws = s;
      pl.connected = true;
    } else send(s, { type: "need_name", room });
  }
  assertConservation(g);
  broadcast(g);
}

function validSnapshot(s, room) {
  if (!s || s.code !== room || !Array.isArray(s.players)) return false;
  if (!Number.isInteger(s.totalChips) || s.totalChips < 0) return false;
  for (const p of s.players) {
    if (typeof p.token !== "string" || typeof p.name !== "string") return false;
    for (const k of ["stack", "committedStreet", "committedHand"])
      if (!Number.isInteger(p[k]) || p[k] < 0) return false;
  }
  if (!Number.isInteger(s.pot) || s.pot < 0) return false;
  const sum =
    s.players.filter((p) => {return !p.removed}).reduce((a, q) => {return a + q.stack + q.committedStreet}, 0) +
    s.pot +
    (s.pots ? s.pots.reduce((a, q) => {return a + (q.remaining ?? q.amount)}, 0) : 0);
  return sum === s.totalChips; // tampered chip counts fail conservation
}

function reviveSnapshot(s, room) {
  const g = { ...s, code: room, lastActivity: Date.now(), unseated: [] };
  g.players = s.players.map((p) => {return { ...p, ws: null, connected: false }}); // presence recomputed from live sockets
  g.streetLog = s.streetLog || [];
  g.handLog = s.handLog || {};
  return g;
}

/* ---------------------------------------------- keep-alive + housekeeping */
setInterval(
  () => {
    const now = Date.now();
    for (const [code, g] of games) if (now - g.lastActivity > SWEEP_GAME_MS) games.delete(code);
    for (const [code, p] of pending) if (now - p.first > SWEEP_GAME_MS) pending.delete(code);

    if (!PUBLIC_URL) return;
    const active = [...games.values()].some(
      (g) =>
        {return (g.state !== "idle" || alive(g).some((p) => {return p.connected})) &&
        now - g.lastActivity < STALE_GAME_MS}
    );
    if (active) fetch(`${PUBLIC_URL.replace(/\/$/, "")}/health`).catch(() => {});
  },
  10 * 60 * 1000
);

server.listen(PORT, () => {
  console.log(
    `Local Poker on :${PORT}${PUBLIC_URL ? ` (keep-alive → ${PUBLIC_URL})` : " (no PUBLIC_URL: keep-alive off)"}`
  );
});
