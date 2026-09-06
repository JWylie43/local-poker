/* Scripted e2e test against a running server on :3000 */
const WebSocket = require("ws");
const URL = process.env.TEST_URL || `ws://localhost:${process.env.PORT || 3000}/ws`;
let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  cond ? pass++ : (fail++, console.error("FAIL:", label));
  if (cond) console.log("ok:", label);
};

function client(name) {
  const ws = new WebSocket(URL);
  const c = {
    name,
    ws,
    state: null,
    you: null,
    snapshot: null,
    token: null,
    room: null,
    inbox: [],
  };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    c.inbox.push(m);
    if (m.type === "state") {
      c.state = m.state;
      c.you = m.you;
      c.snapshot = m.snapshot || c.snapshot;
    }
    if (m.type === "created") {
      c.room = m.room;
      c.token = m.token;
    }
    if (m.type === "joined_unseated") {
      c.token = m.token;
      c.room = m.room;
    }
  });
  c.send = (m) => {
    return ws.send(JSON.stringify(m));
  };
  c.wait = (pred, ms = 2500) => {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        const hit = c.inbox.find(pred);
        if (hit) return res(hit);
        if (Date.now() - t0 > ms) return rej(new Error(name + " timeout waiting"));
        setTimeout(poll, 25);
      })();
    });
  };
  c.open = new Promise((r) => {
    return ws.on("open", r);
  });
  return c;
}
const sleep = (ms) => {
  return new Promise((r) => {
    return setTimeout(r, ms);
  });
};
const seatOf = (c) => {
  return c.you.seat;
};
const player = (c, seat) => {
  return c.state.players.find((p) => {
    return p.seat === seat;
  });
};
const total = (st) => {
  return (
    st.players.reduce((a, p) => {
      return a + p.stack + p.committedStreet;
    }, 0) +
    st.pot +
    (st.pots
      ? st.pots.reduce((a, q) => {
          return a + q.remaining;
        }, 0)
      : 0)
  );
};

(async () => {
  /* ---- setup: host + 2 players, stacks 200 each ---- */
  const A = client("A"),
    B = client("B"),
    C = client("C");
  await Promise.all([A.open, B.open, C.open]);
  A.send({
    type: "create",
    name: "A",
    config: { smallBlind: 1, bigBlind: 2, defaultBuyIn: 200, ritAllowed: true, autoDeal: false },
  });
  await A.wait((m) => {
    return m.type === "created";
  });
  A.send({ type: "hello", room: A.room, token: A.token });
  await A.wait((m) => {
    return m.type === "state";
  });
  const room = A.room;

  for (const c of [B, C]) {
    c.send({ type: "hello", room, name: c.name });
    await c.wait((m) => {
      return m.type === "joined_unseated";
    });
  }
  await sleep(100);
  for (const u of A.state.unseated) A.send({ type: "seat_player", uid: u.id, buyIn: 200 });
  await A.wait((m) => {
    return m.type === "state" && m.state.players.length === 3;
  });
  await sleep(100);
  ok(A.state.totalChips === 600, "600 chips on the table");

  /* ---- hand 1: normal betting, fold ends hand ---- */
  A.send({ type: "start_hand" });
  await A.wait((m) => {
    return m.type === "state" && m.state.state === "hand";
  });
  await sleep(80);
  // 3-handed: button=A(seat0), SB=B(1), BB=C(2), first to act = button A
  ok(A.state.betting.toActSeat === seatOf(A), "UTG is the button 3-handed (A)");
  A.send({ type: "action", action: { type: "raise", to: 6 } });
  await sleep(80);
  ok(B.state.betting.toActSeat === seatOf(B), "action passes to SB");
  B.send({ type: "action", action: { type: "fold" } });
  await sleep(80);
  C.send({ type: "action", action: { type: "call" } });
  await sleep(80);
  ok(A.state.street === "flop" && A.state.pot === 13, `flop, pot 13 (got ${A.state.pot})`);
  C.send({ type: "action", action: { type: "check" } });
  await sleep(60);
  A.send({ type: "action", action: { type: "raise", to: 10 } }); // opening bet
  await sleep(60);
  C.send({ type: "action", action: { type: "fold" } });
  await A.wait((m) => {
    return m.type === "state" && m.state.state === "idle";
  });
  await sleep(80);
  ok(
    player(A, seatOf(A)).stack === 207,
    `A wins net 7 uncontested → 207 (got ${player(A, seatOf(A)).stack})`
  );
  ok(total(A.state) === 600, "conservation after hand 1");

  /* ---- shrink C's stack to force side pots: C to 50 ---- */
  A.send({
    type: "add_chips",
    seat: seatOf(C),
    amount: player(A, seatOf(C)).stack === 194 ? -144 : -(player(A, seatOf(C)).stack - 50),
  });
  await sleep(80);
  ok(player(A, seatOf(C)).stack === 50, "C set to 50");

  /* ---- hand 2: short all-in must NOT reopen; side pots; RIT award ---- */
  A.send({ type: "start_hand" });
  await A.wait((m) => {
    return m.type === "state" && m.state.state === "hand" && m.state.hand === 2;
  });
  await sleep(80);
  // button rotates to B(1): SB=C(2), BB=A(0), UTG=B
  const st = A.state;
  ok(st.buttonSeat === seatOf(B), "button rotated to B");
  // B raises to 40 (full raise)
  B.send({ type: "action", action: { type: "raise", to: 40 } });
  await sleep(80);
  // C all-in for 50 total — raise size 10 < lastFullRaiseSize 38 → short, must NOT reopen B
  C.send({ type: "action", action: { type: "allin" } });
  await sleep(80);
  ok(A.state.betting.currentBet === 50, "current bet 50 after short all-in");
  // A calls 50
  A.send({ type: "action", action: { type: "call" } });
  await sleep(80);
  // B already acted; short raise should NOT let B re-raise
  B.send({ type: "action", action: { type: "raise", to: 120 } });
  const err = await B.wait((m) => {
    return m.type === "error";
  });
  ok(/reopened/.test(err.message), "short all-in did not reopen betting to B");
  B.send({ type: "action", action: { type: "call" } });
  await sleep(100);
  // Preflop done: pot 150. Flop: A and B live, C all-in.
  ok(A.state.street === "flop" && A.state.pot === 150, `flop pot 150 (got ${A.state.pot})`);
  A.send({ type: "action", action: { type: "check" } });
  await sleep(60);
  B.send({ type: "action", action: { type: "allin" } }); // B shoves rest
  await sleep(60);
  A.send({ type: "action", action: { type: "call" } });
  await A.wait((m) => {
    return m.type === "state" && m.state.state === "showdown";
  });
  await sleep(80);
  const pots = A.state.pots;
  ok(pots.length === 2, `two pots (got ${pots.length})`);
  ok(
    pots[0].amount === 150 && pots[0].eligible.length === 3,
    `main pot 150, 3-way (got ${pots[0].amount})`
  );
  ok(pots[1].eligible.length === 2 && !pots[1].eligible.includes(seatOf(C)), "side pot excludes C");
  ok(total(A.state) === 456, "conservation at showdown");

  // Run it twice on both pots: C wins run1 of main, A wins run2 of main; B takes side both runs
  A.send({ type: "set_rit", runs: 2 });
  await sleep(60);
  A.send({
    type: "award",
    awards: [
      { pot: 0, runs: [[seatOf(C)], [seatOf(A)]] },
      { pot: 1, runs: [[seatOf(B)], [seatOf(B)]] },
    ],
  });
  await A.wait((m) => {
    return m.type === "state" && m.state.state === "idle" && m.state.hand === 2;
  });
  await sleep(80);
  ok(player(A, seatOf(C)).stack === 75, `C got 75 (half main) (got ${player(A, seatOf(C)).stack})`);
  ok(total(A.state) === 456, "conservation after RIT payout");

  /* ---- snapshot restore: capture, simulate cold server via bogus room? Use real flow: ----
     We restore against the SAME server by ending the game (room deleted), then offering the snapshot. */
  const snapA = A.snapshot,
    tokA = A.token || A.snapshot.hostToken;
  A.send({ type: "end_game" });
  await sleep(150);
  const D = client("D");
  await D.open;
  D.send({ type: "hello", room, token: snapA.hostToken });
  await D.wait((m) => {
    return m.type === "unknown_room";
  });
  D.send({
    type: "offer_snapshot",
    room,
    snapshot: snapA,
    savedAt: Date.now(),
    fromName: "A-backup",
  });
  const rp = await D.wait((m) => {
    return m.type === "restore_prompt";
  });
  ok(rp.canRestore && rp.youAreHost, "host token gets immediate restore rights");
  D.send({ type: "restore", room });
  const st2 = await D.wait((m) => {
    return m.type === "state";
  });
  ok(st2.state.hand === 2 && total(st2.state) === 456, "restored: hand count + chips intact");
  ok(
    st2.state.players.every((p) => {
      return p.seat === st2.you.seat ? p.connected : !p.connected;
    }),
    "presence recomputed: only restorer connected"
  );

  /* ---- tampered snapshot rejected ---- */
  const bad = JSON.parse(JSON.stringify(snapA));
  bad.players[1].stack += 500;
  const E = client("E");
  await E.open;
  E.send({ type: "hello", room: "ZZZZ9", token: "x" });
  await E.wait((m) => {
    return m.type === "unknown_room";
  });
  bad.code = "ZZZZ9";
  E.send({
    type: "offer_snapshot",
    room: "ZZZZ9",
    snapshot: bad,
    savedAt: Date.now(),
    fromName: "cheater",
  });
  const rej = await E.wait((m) => {
    return m.type === "error";
  });
  ok(/rejected/.test(rej.message), "tampered snapshot fails conservation check");

  /* ---- auto-deal, seat selection, mid-hand seating, pending chips, pause ---- */
  const H = client("H"),
    I = client("I"),
    J = client("J");
  await Promise.all([H.open, I.open, J.open]);
  H.send({
    type: "create",
    name: "H",
    config: { smallBlind: 1, bigBlind: 2, defaultBuyIn: 200, autoDealDelayMs: 200 },
  });
  await H.wait((m) => {
    return m.type === "created";
  });
  H.send({ type: "hello", room: H.room, token: H.token });
  await H.wait((m) => {
    return m.type === "state";
  });
  const room2 = H.room;

  I.send({ type: "hello", room: room2, name: "I", buyIn: 200 }); // player requests their own buy-in
  await I.wait((m) => {
    return m.type === "joined_unseated";
  });
  await sleep(100);
  ok(H.state.unseated[0].buyIn === 200, "requested buy-in visible to the host");
  H.send({ type: "seat_player", uid: H.state.unseated[0].id, seat: 5 }); // host accepts, no amount
  await H.wait((m) => {
    return m.type === "state" && m.state.players.length === 2;
  });
  await sleep(80);
  ok(
    player(H, 5) && player(H, 5).stack === 200,
    "seat selection honored, player's requested buy-in used (I at seat 5)"
  );

  H.send({ type: "start_hand" });
  await H.wait((m) => {
    return m.type === "state" && m.state.state === "hand";
  });
  await sleep(80);
  ok(
    H.state.betting.toActSeat === H.state.buttonSeat,
    "heads-up: button posts SB and acts first preflop"
  );

  // J joins mid-hand: buy-in required, then seated as sitting-out until next hand
  J.send({ type: "hello", room: room2, name: "J" });
  await J.wait((m) => {
    return m.type === "joined_unseated";
  });
  await sleep(100);
  H.send({ type: "seat_player", uid: H.state.unseated[0].id });
  const noBuy = await H.wait((m) => {
    return m.type === "error";
  });
  ok(/buy-in/i.test(noBuy.message), "seating without a buy-in is rejected");
  H.send({ type: "seat_player", uid: H.state.unseated[0].id, buyIn: 150, seat: 2 });
  await H.wait((m) => {
    return m.type === "state" && m.state.players.length === 3;
  });
  await sleep(80);
  ok(
    player(H, 2) && player(H, 2).stack === 150 && !player(H, 2).inHand,
    "mid-hand seat: J at the table but sitting out"
  );
  ok(total(H.state) === 550, "conservation includes mid-hand buy-in");

  // top-up for a player who is in the live hand → queued, applied at hand end
  H.send({ type: "add_chips", seat: seatOf(H), amount: 100 });
  await sleep(80);
  ok(player(H, seatOf(H)).pendingChips === 100, "mid-hand chip add is queued, not applied");

  // heads-up button/SB is H (seat 0) to act: fold ends the hand → auto-deal hand 2
  H.send({ type: "action", action: { type: "fold" } });
  const auto = await H.wait((m) => {
    return m.type === "state" && m.state.hand === 2 && m.state.state === "hand";
  }, 3000);
  ok(true, "next hand auto-dealt without start_hand");
  ok(
    auto.state.players.find((p) => {
      return p.seat === 2;
    }).inHand,
    "J dealt in before the blinds of hand 2"
  );
  const h0 = auto.state.players.find((p) => {
    return p.seat === 0;
  });
  ok(
    h0.stack + h0.committedStreet === 299 && !h0.pendingChips,
    `queued chips applied at hand end (got ${h0.stack + h0.committedStreet})`
  );
  ok(total(auto.state) === 650, "conservation after pending top-up");

  // pause stops the auto-deal chain; resume deals immediately
  H.send({ type: "set_pause", paused: true });
  await sleep(80);
  const seatClient = { 0: H, 5: I, 2: J };
  while (H.state.state === "hand") {
    seatClient[H.state.betting.toActSeat].send({ type: "action", action: { type: "fold" } });
    await sleep(100);
  }
  await sleep(600); // longer than autoDealDelayMs
  ok(H.state.state === "idle" && H.state.hand === 2, "paused: no auto-deal after hand ends");
  H.send({ type: "set_pause", paused: false });
  await H.wait((m) => {
    return m.type === "state" && m.state.hand === 3 && m.state.state === "hand";
  });
  ok(true, "resume deals the next hand immediately");
  H.send({ type: "end_game" });
  await sleep(100);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
