// Watercolour geometry shared by the backdrop object (object.js) and the figure generator
// (generators/watercolor.mjs): a wash is a pile of thin, irregular layers of one colour, each a
// polygon deformed again and again, as in a glazed watercolour. Units: a wash of radius 1 around 0, 0.

// ── Random ──
// A seeded generator (mulberry32): the same seed gives the same wash, on every machine and in tests.
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rand) {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ── Deformation ──
// Each edge gets a new point near its middle, pushed off the edge by a share of its length. Points
// carry their own roughness (v), so some stretches of the rim stay calm and others fray.
export function deform(points, rand, iterations, amount) {
  let out = points;
  for (let i = 0; i < iterations; i++) {
    const next = [];
    for (let k = 0; k < out.length; k++) {
      const a = out[k];
      const b = out[(k + 1) % out.length];
      next.push(a);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const v = (a.v + b.v) / 2;
      const push = Math.max(-1.4, Math.min(1.4, gauss(rand))) * length * amount * v;
      const angle = Math.atan2(b.y - a.y, b.x - a.x) - Math.PI / 2 + gauss(rand) * 0.3;
      next.push({ x: (a.x + b.x) / 2 + Math.cos(angle) * push, y: (a.y + b.y) / 2 + Math.sin(angle) * push, v: v * (0.8 + rand() * 0.4) });
    }
    out = next;
  }
  return out;
}

// ── A wash ──
// base: the outline the paint spreads to; layers: the glazes laid inside and a little past it;
// pools: smaller outlines where the water pushed the pigment back (lighter centres, darker rims).
export function wash(seed, { layers = 24, detail = 2, outline = 4 } = {}) {
  const rand = seeded(seed);
  const corners = 9 + Math.floor(rand() * 4);
  const start = [];
  for (let i = 0; i < corners; i++) {
    const angle = (i / corners) * Math.PI * 2 + rand() * 0.3;
    const radius = 0.72 + rand() * 0.22;
    start.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * (0.82 + rand() * 0.18), v: 0.6 + rand() * 0.9 });
  }
  const base = deform(start, rand, outline, 0.32);
  const glazes = [];
  for (let i = 0; i < layers; i++) glazes.push(deform(base, rand, detail, 0.22));
  const pools = [];
  const poolCount = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < poolCount; i++) {
    const cx = (rand() - 0.5) * 0.7, cy = (rand() - 0.5) * 0.6, scale = 0.28 + rand() * 0.22;
    const shape = deform(start.map((p) => ({ x: cx + p.x * scale, y: cy + p.y * scale, v: p.v })), rand, 3, 0.3);
    pools.push(shape);
  }
  return { base, glazes, pools };
}

export function extent(points) {
  let max = 0;
  for (const p of points) max = Math.max(max, Math.abs(p.x), Math.abs(p.y));
  return max;
}
