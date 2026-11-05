// Planetary gearset geometry and kinematics, shared by object.js (3D) and tools/figures.mjs (SVG).
// No dependency: plain numbers and arrays of [x, y] points.

export const MEMBERS = ['sun', 'carrier', 'ring'];
export const CONFIGS = ['ring-sun', 'sun-ring', 'sun-carrier', 'ring-carrier', 'carrier-sun', 'carrier-ring'];
export const GEARSETS = { '30-78': [30, 78], '24-72': [24, 72], '20-52': [20, 52] };

export function gearset(id) {
  const [zs, zr] = GEARSETS[id] || GEARSETS['30-78'];
  return { zs, zr, zp: (zr - zs) / 2, planets: 3 };
}

// "held-input" → { held, input, output }.
export function parseConfig(config) {
  const [held, input] = String(config).split('-');
  const output = MEMBERS.find((m) => m !== held && m !== input);
  return { held, input, output };
}

// Willis equation: zs·ns + zr·nr = (zs + zr)·nc, with the held member at 0.
// Returns the speeds of sun, ring and carrier for an input speed nIn, and the planet spin.
export function speeds({ zs, zr, zp }, held, input, nIn) {
  const n = { sun: 0, ring: 0, carrier: 0 };
  n[input] = nIn;
  const output = MEMBERS.find((m) => m !== held && m !== input);
  if (output === 'carrier') n.carrier = (zs * n.sun + zr * n.ring) / (zs + zr);
  else if (output === 'sun') n.sun = ((zs + zr) * n.carrier - zr * n.ring) / zs;
  else n.ring = ((zs + zr) * n.carrier - zs * n.sun) / zr;
  // Planet spin about its own pin, in the fixed frame.
  const planet = n.carrier - (n.sun - n.carrier) * zs / zp;
  return { ...n, planet, output, ratio: nIn / n[output] };
}

// Tooth outline of a spur gear (simplified involute flank), as a closed list of points.
// internal: teeth point inwards (ring gear). phase: angle of the centre of tooth 0, in radians.
export function toothOutline(z, m, { internal = false, phase = 0, flankSamples = 4, rootSamples = 3 } = {}) {
  const r = (m * z) / 2;
  const rTip = internal ? r - m : r + m;
  const rRoot = internal ? r + 1.25 * m : r - 1.25 * m;
  const pitch = (2 * Math.PI) / z;
  const fRoot = 0.31, fTip = 0.135;
  const pts = [];
  const at = (rad, ang) => [rad * Math.cos(ang), rad * Math.sin(ang)];
  for (let j = 0; j < z; j++) {
    const c = phase + j * pitch;
    for (let k = 0; k <= flankSamples; k++) {
      const t = k / flankSamples;
      const half = fRoot - (fRoot - fTip) * Math.pow(t, 1.35);
      pts.push(at(rRoot + (rTip - rRoot) * t, c - half * pitch));
    }
    for (let k = flankSamples; k >= 0; k--) {
      const t = k / flankSamples;
      const half = fRoot - (fRoot - fTip) * Math.pow(t, 1.35);
      pts.push(at(rRoot + (rTip - rRoot) * t, c + half * pitch));
    }
    for (let k = 1; k <= rootSamples; k++) {
      const a = c + fRoot * pitch + ((1 - 2 * fRoot) * pitch * k) / (rootSamples + 1);
      pts.push(at(rRoot, a));
    }
  }
  return pts;
}

// Phases that make the teeth mesh: planet k sits at angle phi_k = 2πk/N around the sun.
export function planetAngle(k, n) { return (2 * Math.PI * k) / n; }
export function planetPhase(k, { zs, zp, planets }) {
  const phi = planetAngle(k, planets);
  return phi + Math.PI + (phi * zs) / zp - Math.PI / zp;
}
export function ringPhase(set) {
  return (set.zp / set.zr) * planetPhase(0, set) + Math.PI / set.zr;
}

export function radii(set, m) {
  return {
    sun: (m * set.zs) / 2,
    planet: (m * set.zp) / 2,
    ring: (m * set.zr) / 2,
    centre: (m * (set.zs + set.zp)) / 2
  };
}
