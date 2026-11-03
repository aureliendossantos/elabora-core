// Causal rules of the lock, independent of any drawing (and of the motion settings: the same
// rules run whatever the style, the camera or the motion intensity).
//
// Levels are in metres above the lower canal: the lower canal sits at 0, the upper canal at `rise`,
// the chamber at `h`. Water moves through the paddles (Torricelli: the flow grows with the square
// root of the head) and, much faster, through gates that stand open. A pair of gates only starts
// to open when the water is level on both of its sides; the boat floats on the water of the reach
// it is in, and only passes gates that are fully open.

export const EPS = 0.02;          // m: two levels closer than this count as equal
export const GATE_TIME = 2.4;     // s to swing a pair of gates fully open or shut
export const PADDLE_TIME = 0.9;   // s to wind the paddles fully up or down
export const BOAT_TIME = 3.6;     // s for one move of the boat (reach to chamber, or back)
const K_PADDLE = 0.55;            // level speed per √m of head, paddles fully open (~6.5 s for 3 m)
const K_GATE = 14;                // the same through open gates: the levels join almost at once
const SUB = 1 / 240;              // integration step

export const PLACES = ['lower', 'chamber', 'upper'];
const opposite = (side) => (side === 'lower' ? 'upper' : 'lower');

export function createSim(rise, scenario) {
  const sim = {
    rise, scenario,
    h: 0,
    gates: { lower: gate(), upper: gate() },
    paddles: { lower: paddle(), upper: paddle() },
    boat: { at: 'lower', move: null, pending: null },
    pendingGate: { lower: false, upper: false },
    qIn: 0, qOut: 0,            // level speeds through the upper and lower side (m/s, + = into the chamber / out of it)
    equal: { lower: false, upper: false },
    settledTimer: 0, settled: false,
    done: false
  };
  reset(sim, scenario);
  return sim;
}
function gate() { return { target: 'closed', t: 0, strain: 0 }; }
function paddle() { return { target: 'closed', t: 0 }; }

// Starting positions: uphill, the boat waits below with the lower gates open and the chamber low;
// downhill, it floats in the full chamber, both pairs of gates shut.
export function reset(sim, scenario = sim.scenario) {
  sim.scenario = scenario;
  const up = scenario !== 'downhill';
  sim.h = up ? 0 : sim.rise;
  setGate(sim.gates.lower, up ? 'open' : 'closed');
  setGate(sim.gates.upper, 'closed');
  setPaddle(sim.paddles.lower, 'closed');
  setPaddle(sim.paddles.upper, 'closed');
  sim.boat.at = up ? 'lower' : 'chamber';
  sim.boat.move = null; sim.boat.pending = null;
  sim.pendingGate.lower = sim.pendingGate.upper = false;
  sim.qIn = sim.qOut = 0;
  sim.equal.lower = Math.abs(sim.h) <= EPS;
  sim.equal.upper = Math.abs(sim.rise - sim.h) <= EPS;
  sim.settled = false; sim.settledTimer = 0;
  sim.done = false;
}
function setGate(g, target) { g.target = target; g.t = target === 'open' ? 1 : 0; g.strain = 0; }
function setPaddle(p, target) { p.target = target; p.t = target === 'open' ? 1 : 0; }

// Signed difference across a pair of gates (positive: the chamber side is higher for the lower
// gates, the canal side is higher for the upper gates).
export function headAcross(sim, side) { return side === 'lower' ? sim.h : sim.rise - sim.h; }
export function levelsEqual(sim, side) { return Math.abs(headAcross(sim, side)) <= EPS; }
export function gateOpen(sim, side) { return sim.gates[side].t >= 1; }
export function gateShut(sim, side) { return sim.gates[side].t <= 0 && sim.gates[side].target === 'closed'; }
export function goalPlace(sim) { return sim.scenario === 'downhill' ? 'lower' : 'upper'; }
export function forwardDir(sim) { return sim.scenario === 'downhill' ? 'down' : 'up'; }

// ── Operations. Each returns { ok, reason, ...data }: the reason words the reaction. ──

export function openGates(sim, side, { wait = false } = {}) {
  const g = sim.gates[side];
  if (g.target === 'open') return { ok: true, reason: 'already' };
  const diff = Math.abs(headAcross(sim, side));
  if (diff > EPS) {
    // A screen event may ask for the gates while the water is already on its way to the right
    // level: they open once it gets there (the rule still holds).
    if (wait && converging(sim, side)) { sim.pendingGate[side] = true; return { ok: true, reason: 'waiting-level', diff }; }
    g.strain = 1;
    return { ok: false, reason: 'levels', diff };
  }
  g.target = 'open';
  return { ok: true, reason: 'opening' };
}

export function closeGates(sim, side) {
  const g = sim.gates[side];
  sim.pendingGate[side] = false;
  if (g.target === 'closed') return { ok: true, reason: 'already' };
  if (sim.boat.move && crosses(sim.boat.move, side)) return { ok: false, reason: 'boat-passing' };
  if (sim.boat.pending && needsGate(sim, sim.boat.pending) === side) sim.boat.pending = null;
  g.target = 'closed';
  return { ok: true, reason: 'closing' };
}

export function setPaddles(sim, side, open) {
  const p = sim.paddles[side];
  if (!open) {
    if (p.target === 'closed') return { ok: true, reason: 'already' };
    p.target = 'closed';
    return { ok: true, reason: 'closed' };
  }
  if (p.target === 'open') return { ok: true, reason: 'already' };
  p.target = 'open';
  sim.settled = false; sim.settledTimer = 0;
  const other = opposite(side);
  if (side === 'upper') {
    if (sim.gates.lower.target === 'open' || sim.gates.lower.t > 0) return { ok: true, reason: 'leak' };
    if (sim.gates.upper.t > 0 || sim.rise - sim.h <= EPS) return { ok: true, reason: 'no-flow' };
    if (sim.paddles[other].target === 'open') return { ok: true, reason: 'through' };
    return { ok: true, reason: 'fill' };
  }
  if (sim.gates.upper.target === 'open' || sim.gates.upper.t > 0) return { ok: true, reason: 'leak-down' };
  if (sim.gates.lower.t > 0 || sim.h <= EPS) return { ok: true, reason: 'no-flow' };
  if (sim.paddles[other].target === 'open') return { ok: true, reason: 'through' };
  return { ok: true, reason: 'drain' };
}

// The gate a move in direction dir (up: towards the upper canal) needs, or null at the end.
export function needsGate(sim, dir) {
  const at = sim.boat.at;
  if (dir === 'up') return at === 'lower' ? 'lower' : at === 'chamber' ? 'upper' : null;
  return at === 'upper' ? 'upper' : at === 'chamber' ? 'lower' : null;
}
function nextPlace(at, dir) {
  const i = PLACES.indexOf(at) + (dir === 'up' ? 1 : -1);
  return PLACES[i] || null;
}
function crosses(move, side) {
  const pair = [move.from, move.to].sort().join('-');
  return side === 'lower' ? pair === 'chamber-lower' : pair === 'chamber-upper';
}

export function moveBoat(sim, dir) {
  if (sim.boat.move) return { ok: false, reason: 'moving' };
  const side = needsGate(sim, dir);
  if (!side) return { ok: false, reason: 'end' };
  const g = sim.gates[side];
  if (g.t >= 1) { startMove(sim, dir); return { ok: true, reason: 'sailing', to: nextPlace(sim.boat.at, dir) }; }
  if (g.target === 'open' || sim.pendingGate[side]) { sim.boat.pending = dir; return { ok: true, reason: 'waiting-gate', gate: side }; }
  return { ok: false, reason: 'gate-closed', gate: side };
}
function startMove(sim, dir) {
  sim.boat.move = { from: sim.boat.at, to: nextPlace(sim.boat.at, dir), t: 0, dir };
  sim.boat.pending = null;
}

function converging(sim, side) {
  // The chamber is heading to the level of that side: its paddles are open and the others shut.
  const p = sim.paddles[side];
  const o = sim.paddles[opposite(side)];
  return p.target === 'open' && o.target === 'closed' && sim.gates[opposite(side)].t <= 0;
}

// ── Time ──

// Advance by dt seconds; returns the events that happened, in order.
export function step(sim, dt) {
  const events = [];
  dt = Math.min(Math.max(dt, 0), 0.1);
  for (const side of ['lower', 'upper']) {
    const g = sim.gates[side];
    const before = g.t;
    g.t = approach(g.t, g.target === 'open' ? 1 : 0, dt / GATE_TIME);
    g.strain = Math.max(0, g.strain - dt * 1.4);
    if (before < 1 && g.t >= 1) events.push({ type: 'gates-opened', side });
    if (before > 0 && g.t <= 0) events.push({ type: 'gates-closed', side });
    const p = sim.paddles[side];
    p.t = approach(p.t, p.target === 'open' ? 1 : 0, dt / PADDLE_TIME);
  }

  // Water: the chamber exchanges with each canal through its paddles and its gates.
  const cu = K_PADDLE * smooth(sim.paddles.upper.t) + K_GATE * smooth(sim.gates.upper.t);
  const cl = K_PADDLE * smooth(sim.paddles.lower.t) + K_GATE * smooth(sim.gates.lower.t);
  const R = sim.rise;
  let target = sim.h;
  if (cu > 0 || cl > 0) target = (cu * cu * R) / (cu * cu + cl * cl);
  let remaining = dt, qIn = 0, qOut = 0;
  while (remaining > 1e-9) {
    const s = Math.min(SUB, remaining);
    qIn = cu * sqrtSigned(R - sim.h);
    qOut = cl * sqrtSigned(sim.h);
    const next = sim.h + (qIn - qOut) * s;
    // Never step past the level where inflow and outflow balance.
    sim.h = (next - target) * (sim.h - target) < 0 ? target : next;
    remaining -= s;
  }
  sim.h = Math.min(R, Math.max(0, sim.h));
  sim.qIn = qIn; sim.qOut = qOut;

  for (const side of ['lower', 'upper']) {
    const eq = levelsEqual(sim, side);
    if (eq && !sim.equal[side]) {
      sim.equal[side] = true;
      events.push({ type: 'level-equal', side });
      if (sim.pendingGate[side]) {
        sim.pendingGate[side] = false;
        const r = openGates(sim, side);
        events.push({ type: 'gates-auto', side, ok: r.ok });
      }
    } else if (!eq && Math.abs(headAcross(sim, side)) > EPS * 3) sim.equal[side] = false;
  }
  // Water running in at the top and out at the bottom settles halfway.
  const flowing = sim.paddles.upper.t > 0.5 && sim.paddles.lower.t > 0.5 && sim.gates.lower.t <= 0 && sim.gates.upper.t <= 0;
  if (flowing && !sim.settled && Math.abs(qIn - qOut) < 0.01 && !sim.equal.lower && !sim.equal.upper) {
    sim.settledTimer += dt;
    if (sim.settledTimer > 0.4) { sim.settled = true; events.push({ type: 'settled' }); }
  } else if (!flowing) { sim.settled = false; sim.settledTimer = 0; }

  // The boat.
  const b = sim.boat;
  if (!b.move && b.pending) {
    const side = needsGate(sim, b.pending);
    if (!side) b.pending = null;
    else if (sim.gates[side].t >= 1) { startMove(sim, b.pending); events.push({ type: 'boat-sets-off' }); }
    else if (sim.gates[side].target !== 'open' && !sim.pendingGate[side]) b.pending = null;
  }
  if (b.move) {
    b.move.t = Math.min(1, b.move.t + dt / BOAT_TIME);
    if (b.move.t >= 1) {
      b.at = b.move.to; b.move = null;
      events.push({ type: 'boat-arrived', where: b.at });
      if (!sim.done && b.at === goalPlace(sim)) { sim.done = true; events.push({ type: 'done' }); }
    }
  }
  return events;
}

// Where the boat floats: x along the canal (from its places) and the water level under it.
export function boatPlaceT(sim) {
  const b = sim.boat;
  if (!b.move) return { from: b.at, to: b.at, t: 0 };
  return { from: b.move.from, to: b.move.to, t: b.move.t };
}
export function levelAt(sim, place) { return place === 'lower' ? 0 : place === 'upper' ? sim.rise : sim.h; }

// ── Hints: the next useful action from here, as a phase key, the control and a principle. ──
export function nextAction(sim) {
  if (sim.done) return null;
  const up = sim.scenario !== 'downhill';
  const b = sim.boat;
  if (b.move) return { key: 'doWaitBoat', control: null, nudge: 'nudgeWait' };
  const ahead = up ? 'upper' : 'lower';       // gates the boat leaves the chamber by
  const behind = up ? 'lower' : 'upper';      // gates it enters the chamber by
  const start = up ? 'lower' : 'upper';       // the reach it starts from
  if (b.at === start) {
    // Get into the chamber: the gates on this side must open, so the chamber must match this reach.
    if (gateOpen(sim, behind)) return { key: 'doEnter', control: 'boat', nudge: 'nudgeEnter' };
    return toLevel(sim, behind, 'nudgeGates');
  }
  if (b.at === 'chamber') {
    if (sim.gates[behind].target === 'open' || sim.gates[behind].t > 0) return { key: behind === 'lower' ? 'doCloseLowerGates' : 'doCloseUpperGates', control: behind + 'Gates', nudge: 'nudgeSeal' };
    if (gateOpen(sim, ahead)) return { key: 'doExit', control: 'boat', nudge: 'nudgeEnter' };
    return toLevel(sim, ahead, 'nudgeGates');
  }
  // The boat went the wrong way (back past its start): bring it back.
  return { key: 'doTurnBack', control: 'boat', nudge: 'nudgeEnter' };
}
function toLevel(sim, side, nudge) {
  // Bring the chamber to the level of `side`, then open those gates.
  const other = opposite(side);
  if (levelsEqual(sim, side)) return { key: side === 'lower' ? 'doOpenLowerGates' : 'doOpenUpperGates', control: side + 'Gates', nudge };
  if (sim.gates[other].target === 'open' || sim.gates[other].t > 0) return { key: other === 'lower' ? 'doCloseLowerGates' : 'doCloseUpperGates', control: other + 'Gates', nudge: 'nudgeSeal' };
  if (sim.paddles[other].target === 'open') return { key: other === 'lower' ? 'doCloseLowerPaddles' : 'doCloseUpperPaddles', control: other + 'Paddles', nudge: 'nudgeSeal' };
  if (sim.paddles[side].target !== 'open') return { key: side === 'upper' ? 'doFill' : 'doDrain', control: side + 'Paddles', nudge: 'nudgeWater' };
  return { key: side === 'upper' ? 'doWaitFill' : 'doWaitDrain', control: null, nudge: 'nudgeWait' };
}

// ── Helpers ──
function approach(v, to, d) { return v < to ? Math.min(to, v + d) : Math.max(to, v - d); }
function smooth(t) { return t * t * (3 - 2 * t); }
function sqrtSigned(x) { return x >= 0 ? Math.sqrt(x) : -Math.sqrt(-x); }

// A compact snapshot for getState(), and its inverse.
export function snapshot(sim) {
  return {
    scenario: sim.scenario,
    level: Math.round(sim.h * 1000) / 1000,
    lowerGates: sim.gates.lower.target,
    upperGates: sim.gates.upper.target,
    lowerPaddles: sim.paddles.lower.target,
    upperPaddles: sim.paddles.upper.target,
    boat: sim.boat.move ? sim.boat.move.to : sim.boat.at,
    done: sim.done
  };
}
export function restore(sim, s) {
  if (!s || typeof s !== 'object') return;
  if (s.scenario === 'uphill' || s.scenario === 'downhill') sim.scenario = s.scenario;
  if (typeof s.level === 'number') sim.h = Math.min(sim.rise, Math.max(0, s.level));
  for (const side of ['lower', 'upper']) {
    const gs = s[side + 'Gates']; if (gs === 'open' || gs === 'closed') setGate(sim.gates[side], gs);
    const ps = s[side + 'Paddles']; if (ps === 'open' || ps === 'closed') setPaddle(sim.paddles[side], ps);
  }
  if (PLACES.includes(s.boat)) sim.boat.at = s.boat;
  sim.boat.move = null; sim.boat.pending = null;
  sim.done = !!s.done;
  sim.equal.lower = levelsEqual(sim, 'lower');
  sim.equal.upper = levelsEqual(sim, 'upper');
}
