// Two-body physics of a phasing manoeuvre, shared by the 3D lab (object.js) and the course figures
// (generators/figures.mjs), so the figures and the simulation always agree.
// Units: km, s, km/s; burns in m/s (negative = retrograde). Angles in radians, measured along the motion.

export const MU = 398600.4418;   // gravitational parameter of the Earth, km³/s²
export const RE = 6378.137;      // equatorial radius of the Earth, km
export const SIDEREAL_DAY = 86164.1;

export const circularSpeed = (r) => Math.sqrt(MU / r);
export const period = (a) => 2 * Math.PI * Math.sqrt(a ** 3 / MU);
export const meanMotion = (a) => Math.sqrt(MU / a ** 3);

// Orbit after a tangential burn of dv (m/s) from a circular orbit of radius r.
// Retrograde: the burn point becomes the apogee; prograde: the perigee.
export function phasingOrbit(r, dv) {
  const v = circularSpeed(r) + dv / 1000;
  const a = 1 / (2 / r - (v * v) / MU);
  const e = Math.abs(r - a) / a;
  return { r, dv, a, e, T: period(a), n: meanMotion(a), apogeeAtBurn: dv < 0 };
}

// True anomaly continuous with the eccentric anomaly (no wrapping at ±π).
function trueFromEccentric(E, e) {
  const beta = e / (1 + Math.sqrt(1 - e * e));
  return E + 2 * Math.atan2(beta * Math.sin(E), 1 - beta * Math.cos(E));
}

// Radius and angle travelled since the burn point, t seconds after the burn.
export function onOrbit(orbit, t) {
  const { a, e, n, apogeeAtBurn } = orbit;
  if (e < 1e-12) return { r: a, angle: n * t };
  const M0 = apogeeAtBurn ? Math.PI : 0;
  const M = M0 + n * t;
  let E = M;
  for (let i = 0; i < 12; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return { r: a * (1 - e * Math.cos(E)), angle: trueFromEccentric(E, e) - M0 };
}

// A full phasing manoeuvre: burn dv at the burn point, fly `orbits` phasing orbits, burn -dv at the
// same point (back on the circular orbit). gap0 is the along-track distance to the client, in km,
// positive when the client is ahead. Returns a function of time since the first burn.
export function manoeuvre({ altitude = 500, dv = 0, orbits = 1, gap0 = 0 }) {
  const r = RE + altitude;
  const n0 = meanMotion(r);
  const T0 = period(r);
  const ph = phasingOrbit(r, dv);
  const duration = dv === 0 ? orbits * T0 : orbits * ph.T;
  const at = (t) => {
    const tc = Math.max(0, t);
    let servicer;
    if (dv === 0) servicer = { r, angle: n0 * tc };
    else if (tc <= duration) servicer = onOrbit(ph, tc);
    else servicer = { r, angle: 2 * Math.PI * orbits + n0 * (tc - duration) };
    const client = { r, angle: gap0 / r + n0 * tc };
    // Along-track gap measured on the reference circle (positive: client ahead), radial offset of the servicer.
    return { t: tc, servicer, client, gap: r * (client.angle - servicer.angle), radial: servicer.r - r };
  };
  const finalGap = gap0 - 2 * Math.PI * r * orbits * (1 - (dv === 0 ? T0 : ph.T) / T0);
  return { r, T0, phasing: ph, duration, at, finalGap, cost: 2 * Math.abs(dv) };
}

// Rule of thumb of the course: drift per orbit ≈ 3 T Δv (km, positive = moving ahead for a retrograde burn).
export const driftPerOrbit = (altitude, dv) => (3 * period(RE + altitude) * -dv) / 1000;
