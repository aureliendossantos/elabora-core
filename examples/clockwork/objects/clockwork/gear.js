// Gear outlines and the kinematics of the clock's gear train, in plain numbers (no three.js),
// so that the object, its tests and any figure share one geometry.
//
// Units: the module (the size of a tooth) is 1, so a gear of z teeth has a pitch radius of z / 2
// and two meshing gears stand (z1 + z2) / 2 apart. Angles are in radians, counterclockwise seen
// from the dial; a clock's hands therefore turn the negative way.

const PRESSURE = (20 * Math.PI) / 180;
const inv = (a) => Math.tan(a) - a;

// Profile shift for small pinions, so that their teeth keep a full flank (no undercut); the gear
// they mesh with takes the opposite shift, and the pair keeps its centre distance.
export function shiftFor(z) {
  return z < 17 ? Math.min(0.5, (17 - z) / 17) : 0;
}

/**
 * Outline of a gear of z teeth, counterclockwise, tooth 0 centred on angle 0.
 * opts.shift: profile shift (in modules); opts.backlash: thinning of each tooth at the pitch
 * circle; opts.tip / opts.fillet: radii of the rounded tip corners and root corners;
 * opts.steps: points per flank.
 */
export function gearOutline(z, opts = {}) {
  const x = opts.shift ?? 0;
  const backlash = opts.backlash ?? 0.12;
  const steps = opts.steps ?? 7;
  const r = z / 2;
  const rb = r * Math.cos(PRESSURE);
  let ra = r + 1 + x;
  const rf = r - 1.25 + x;
  const s = Math.PI / 2 + 2 * x * Math.tan(PRESSURE) - backlash / 2;
  const psi = s / (2 * r);
  const half = (rho) => {
    const a = Math.acos(Math.min(1, rb / Math.max(rho, rb)));
    return psi + inv(PRESSURE) - inv(a);
  };
  // A tooth must keep some land at its tip: shorten it if the flanks would meet.
  while (half(ra) * ra < 0.18 && ra > r) ra -= 0.02;
  const pitch = (2 * Math.PI) / z;
  const start = Math.max(rb, rf);
  const tipRound = Math.min(opts.tip ?? 0.22, half(ra) * ra * 0.9);
  const gapHalfAtRoot = (pitch / 2 - half(start)) * rf;
  const fillet = Math.max(0.05, Math.min(opts.fillet ?? 0.38, gapHalfAtRoot * 0.92, (ra - rf) * 0.3));

  // One flank from the root to the tip, as (radius, half-angle) pairs.
  const flank = [];
  // Root fillet: a quarter circle between the root circle and the flank's foot.
  const footAngle = half(start);
  const footTop = rf + fillet;
  for (let i = 0; i <= 5; i++) {
    const t = (i / 5) * (Math.PI / 2);
    const u = fillet - fillet * Math.sin(t);           // distance into the gap, along the root
    const v = fillet - fillet * Math.cos(t);           // height above the root
    const rho = rf + v;
    flank.push([rho, footAngle + u / rho]);
  }
  // Radial part below the base circle, then the involute up to where the tip rounding begins.
  const top = ra - tipRound;
  const lowest = Math.max(footTop, start);
  if (lowest > footTop) flank.push([lowest, half(lowest)]);
  for (let i = 1; i <= steps; i++) {
    const rho = lowest + ((top - lowest) * i) / steps;
    flank.push([rho, half(rho)]);
  }
  // Tip rounding: a quarter circle from the flank to the tip circle.
  const edge = half(top);
  for (let i = 1; i <= 4; i++) {
    const t = (i / 4) * (Math.PI / 2);
    const u = tipRound - tipRound * Math.cos(t);       // distance towards the tooth's middle
    const v = tipRound * Math.sin(t);
    const rho = top + v;
    flank.push([rho, edge - u / rho]);
  }

  const points = [];
  for (let k = 0; k < z; k++) {
    const c = k * pitch;
    // Root arc from the middle of the previous gap.
    const rootFrom = c - pitch / 2;
    const rootTo = c - flank[0][1];
    const rootSteps = Math.max(1, Math.round(((rootTo - rootFrom) * rf) / 0.35));
    for (let i = 0; i < rootSteps; i++) {
      const a = rootFrom + ((rootTo - rootFrom) * i) / rootSteps;
      points.push([rf * Math.cos(a), rf * Math.sin(a)]);
    }
    // Right flank up, tip, left flank down.
    for (const [rho, h] of flank) points.push([rho * Math.cos(c - h), rho * Math.sin(c - h)]);
    const tipHalf = flank[flank.length - 1][1];
    const tipSteps = Math.max(1, Math.round((2 * tipHalf * ra) / 0.3));
    for (let i = 1; i < tipSteps; i++) {
      const a = c - tipHalf + (2 * tipHalf * i) / tipSteps;
      points.push([ra * Math.cos(a), ra * Math.sin(a)]);
    }
    for (let i = flank.length - 1; i >= 0; i--) {
      const [rho, h] = flank[i];
      points.push([rho * Math.cos(c + h), rho * Math.sin(c + h)]);
    }
    const back = c + flank[0][1];
    const to = c + pitch / 2;
    const steps2 = Math.max(1, Math.round(((to - back) * rf) / 0.35));
    for (let i = 1; i < steps2; i++) {
      const a = back + ((to - back) * i) / steps2;
      points.push([rf * Math.cos(a), rf * Math.sin(a)]);
    }
  }
  return { points, pitchRadius: r, tipRadius: ra, rootRadius: rf };
}

/**
 * Holes of a wheel: the hole for its arbor and, on wheels large enough, the windows between
 * its spokes (the "crossings" of clock wheels). Each hole is a clockwise list of points.
 */
export function wheelHoles(z, opts = {}) {
  const r = z / 2;
  const rf = r - 1.25 + (opts.shift ?? 0);
  const bore = opts.bore ?? 1.1;
  const holes = bore > 0.05 ? [circle(bore, 28, true)] : [];
  const spokes = opts.spokes ?? (z >= 24 ? 5 : 0);
  if (!spokes) return holes;
  const rim = Math.max(1.6, rf * 0.16);
  const hub = Math.max(bore + 1.6, r * 0.22);
  const outer = rf - rim;
  const spoke = Math.max(1.1, r * 0.1);
  if (outer - hub < 2.2) return holes;
  for (let k = 0; k < spokes; k++) {
    const a0 = (k / spokes) * Math.PI * 2;
    const a1 = ((k + 1) / spokes) * Math.PI * 2;
    holes.push(windowBetween(a0, a1, hub, outer, spoke));
  }
  return holes;
}

// A window between two spokes: an annular sector whose corners are rounded by corner cutting,
// clockwise. Edges are first cut into short pieces, so the rounding stays near the corners.
function windowBetween(a0, a1, inner, outer, spoke) {
  const step = Math.min(0.9, (outer - inner) / 6);
  const side = (rho, a, sign) => a + sign * (spoke / 2) / rho;
  const pts = [];
  const push = (rho, a) => pts.push([rho * Math.cos(a), rho * Math.sin(a)]);
  const arc = (rho, from, to) => {
    const n = Math.max(2, Math.ceil((Math.abs(to - from) * rho) / step));
    for (let i = 0; i < n; i++) push(rho, from + ((to - from) * i) / n);
  };
  const line = (fromRho, toRho, a, sign) => {
    const n = Math.max(2, Math.ceil(Math.abs(toRho - fromRho) / step));
    for (let i = 0; i < n; i++) { const rho = fromRho + ((toRho - fromRho) * i) / n; push(rho, side(rho, a, sign)); }
  };
  arc(outer, side(outer, a0, 1), side(outer, a1, -1));
  line(outer, inner, a1, -1);
  arc(inner, side(inner, a1, -1), side(inner, a0, 1));
  line(inner, outer, a0, 1);
  let out = pts;
  for (let k = 0; k < 2; k++) out = chaikin(out);
  return out.reverse();
}

function chaikin(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25], [x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
  }
  return out;
}

export function circle(radius, n = 48, clockwise = false) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 * (clockwise ? -1 : 1);
    pts.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return pts;
}

// ── The clock's train ──
// Minute shaft at the centre O with the pinion P1; the minute wheel W1 and its pinion P2 on an
// arbor at A; the hour wheel W2 meshing with P2, either beside it (at angle `orbit` from A) or,
// once rolled back to the centre, on its tube around the minute shaft.

export const TRAIN = { p1: 10, w1: 30, p2: 8, w2: 32 };
export const DIRECTION_A = 0;                    // O → A, along +x

export function centreDistance(z1, z2) { return (z1 + z2) / 2; }

/** Rotation of a gear (zb teeth, centre at angle `dir` from the gear it meshes with) when the driving gear (za teeth) has rotation `ta`. */
export function meshed(ta, za, zb, dir) {
  return dir + Math.PI + Math.PI / zb + (dir - ta) * (za / zb);
}

/**
 * Positions and rotations of every gear for a minute shaft at angle `minute`.
 * cfg: { w1, w2 (teeth), orbit (angle of W2 around A) }.
 */
export function trainPose(minute, cfg = {}) {
  const w1 = cfg.w1 ?? TRAIN.w1;
  const w2 = cfg.w2 ?? TRAIN.w2;
  const p1 = TRAIN.p1, p2 = TRAIN.p2;
  const dA = centreDistance(p1, w1);
  const A = [dA * Math.cos(DIRECTION_A), dA * Math.sin(DIRECTION_A)];
  const tP1 = minute;
  const tW1 = meshed(tP1, p1, w1, DIRECTION_A);
  const tP2 = tW1;                                // fixed on the same arbor
  const orbit = cfg.orbit ?? Math.PI;
  const dB = centreDistance(p2, w2);
  const B = [A[0] + dB * Math.cos(orbit), A[1] + dB * Math.sin(orbit)];
  const tW2 = meshed(tP2, p2, w2, orbit);
  return { O: [0, 0], A, B, angles: { p1: tP1, w1: tW1, p2: tP2, w2: tW2 } };
}

/** Angle of W2 around A where it sits on the minute shaft. */
export function dockedOrbit(w1 = TRAIN.w1) {
  return DIRECTION_A + Math.PI + 0 * w1;
}

/** Slowdown of the whole train (minute shaft turns per turn of W2). */
export function slowdown(w1 = TRAIN.w1, w2 = TRAIN.w2) {
  return (w1 / TRAIN.p1) * (w2 / TRAIN.p2);
}
