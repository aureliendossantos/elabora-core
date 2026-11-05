// Figures of the course, computed with the physics of the 3D lab (objects/phasing-lab/orbit.js) and
// coloured from the theme tokens. No words inside: numbered markers here, labels in the blocks.
import { RE, circularSpeed, period, phasingOrbit, onOrbit } from '../objects/phasing-lab/orbit.js';

export const meta = { description: 'Orbits to scale in layers (the Earth, then each orbit with its craft and its one-hour trail), the phasing burn and the three burn directions of the practice question, without text.' };

export default async function generate({ tokens, write }) {
  const C = palette(tokens);
  const L = orbitLayers(C);
  write('images/orbits-earth.svg', L.earth);
  for (const o of L.orbits) {
    write(`images/orbit-${o.n}-craft.svg`, o.craft);
    write(`images/orbit-${o.n}-trail.svg`, o.trail);
  }
  write('images/burn-phasing.svg', burnPhasing(C));
  for (const dir of ['prograde', 'retrograde', 'radial']) write(`images/burn-${dir}.svg`, burnIcon(C, dir));
}

// ── colours ──
function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a, b, t) { const x = hex(a), y = hex(b); return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; }
function palette(t) {
  return {
    text: t['color.text'], muted: t['color.muted'], surface: t['color.surface'],
    orbit: t['color.orbit'], servicer: t['color.servicer'], client: t['color.client'], accent: t['color.accent'],
    ocean: t['color.ocean'], oceanDeep: t['color.ocean-deep'], land: t['color.land'], atmosphere: t['color.atmosphere'],
    oceanLight: mix(t['color.ocean'], t['color.atmosphere'], 0.45)
  };
}

const f = (n) => Math.round(n * 10) / 10;
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];       // a: radians, counter-clockwise
const tangent = (a) => [-Math.sin(a), -Math.cos(a)];                             // direction of motion (counter-clockwise)
const deg = Math.PI / 180;

function earthDefs(C, id) {
  return `<radialGradient id="${id}-earth" cx="38%" cy="32%" r="78%"><stop offset="0" stop-color="${C.oceanLight}"/><stop offset=".55" stop-color="${C.ocean}"/><stop offset="1" stop-color="${C.oceanDeep}"/></radialGradient>
  <radialGradient id="${id}-night" cx="78%" cy="80%" r="70%"><stop offset="0" stop-color="${C.surface}" stop-opacity=".8"/><stop offset="1" stop-color="${C.surface}" stop-opacity="0"/></radialGradient>
  <filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>`;
}
function earth(C, id, cx, cy, R) {
  return `<circle cx="${cx}" cy="${cy}" r="${f(R + 4)}" fill="none" stroke="${C.atmosphere}" stroke-width="${f(Math.max(4, R * 0.08))}" opacity=".55" filter="url(#${id}-glow)"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#${id}-earth)"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#${id}-night)"/>
  <circle cx="${cx}" cy="${cy}" r="${f(R + 0.8)}" fill="none" stroke="${C.atmosphere}" stroke-width="1.4" opacity=".8"/>`;
}
function arrowMarker(id, color) {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${color}"/></marker>`;
}
function badge(C, x, y, n) {
  return `<g><circle cx="${f(x)}" cy="${f(y)}" r="12" fill="${C.text}"/><text x="${f(x)}" y="${f(y + 4.6)}" text-anchor="middle" font-family="Space Grotesk, Inter, sans-serif" font-weight="700" font-size="13" fill="${C.surface}">${n}</text></g>`;
}
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = pt(cx, cy, r, a0), [x1, y1] = pt(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const sweep = a1 > a0 ? 0 : 1;
  return `M${f(x0)} ${f(y0)}A${f(r)} ${f(r)} 0 ${large} ${sweep} ${f(x1)} ${f(y1)}`;
}

// ISS, GPS and geostationary orbits to scale, as layers drawn over each other (the "Lower is faster"
// slide reveals them one by one). Each orbit has a craft layer (its ring, the craft and its speed
// vector, length ∝ speed) and a trail layer (the distance flown in one hour: lower orbits sweep a
// much larger angle). The numbered markers are buttons of the slide (hotspot blocks), not drawn here.
// The slide animates one hour of flight: the craft layer turns back by the hour's angle around the
// Earth and the trail is unmasked behind it. ORBITS gives the craft angle (at) and the hour's angle
// (sweep), the values of the orbit-flight blocks; markerAt, the place of the hotspots (% of the figure).
const ORBIT_FIG = { W: 520, c: 260, scale: 226 / (RE + 35786) };
export const ORBITS = [
  { n: 1, h: 420, at: 32, colorKey: 'servicer', markerOut: 30, markerShift: -14 },
  { n: 2, h: 20200, at: 148, colorKey: 'orbit', markerOut: 22, markerShift: 0 },
  { n: 3, h: 35786, at: -52, colorKey: 'client', markerOut: 22, markerShift: 0 }
].map((o) => {
  const r = (RE + o.h) * ORBIT_FIG.scale;
  const sweep = (3600 / period(RE + o.h)) * 360;
  const [mx, my] = pt(ORBIT_FIG.c, ORBIT_FIG.c, r + o.markerOut, (o.at + o.markerShift) * deg);
  return { ...o, r, sweep: f(sweep), markerAt: [f((100 * mx) / ORBIT_FIG.W), f((100 * my) / ORBIT_FIG.W)] };
});

function orbitLayers(C) {
  const { W, c: cx, scale: s } = ORBIT_FIG;
  const cy = cx;
  const earthLayer = svg(W, W, [earthDefs(C, 'oe')], [earth(C, 'oe', cx, cy, f(RE * s))]);
  const orbits = ORBITS.map((o) => {
    const color = C[o.colorKey];
    const v = circularSpeed(RE + o.h);
    const sweep = o.sweep * deg;
    const a = o.at * deg;
    const [x, y] = pt(cx, cy, o.r, a);
    const [tx, ty] = tangent(a);
    const L = v * 8.6;
    const craft = svg(W, W, [arrowMarker(`oc-a${o.n}`, color)], [
      `<circle cx="${cx}" cy="${cy}" r="${f(o.r)}" fill="none" stroke="${color}" stroke-opacity=".35" stroke-width="1.2"${o.n === 3 ? ' stroke-dasharray="2 5"' : ''}/>`,
      `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x + tx * L)}" y2="${f(y + ty * L)}" stroke="${color}" stroke-width="2.6" marker-end="url(#oc-a${o.n})"/>`,
      `<circle cx="${f(x)}" cy="${f(y)}" r="5.5" fill="${color}" stroke="${C.surface}" stroke-width="2"/>`
    ]);
    // Trail: one hour of flight behind the craft (drawn in pieces when longer than half a turn).
    const pieces = [];
    const steps = Math.ceil(sweep / (Math.PI * 0.9));
    for (let i = 0; i < steps; i++) {
      const a0 = a - (sweep * (i + 1)) / steps, a1 = a - (sweep * i) / steps;
      pieces.push(`<path d="${arcPath(cx, cy, o.r, a0, a1)}" fill="none" stroke="${color}" stroke-width="${o.n === 1 ? 4 : 5}" stroke-linecap="round" opacity="${f(0.85 - (0.7 * i) / steps)}"/>`);
    }
    return { n: o.n, craft, trail: svg(W, W, [], pieces) };
  });
  return { earth: earthLayer, orbits };
}

// A retrograde burn at the burn point (1): the far side of the orbit drops (2) and, one orbit later,
// the servicer is back at 1 having gained on the client (3). Radial offsets exaggerated to be seen.
function burnPhasing(C) {
  const W = 560, H = 500, cx = 280, cy = 262, R = 116, ring = 180;
  const ph = phasingOrbit(RE + 500, -3);
  const drop = 2 * (RE + 500 - ph.a);
  const k = 46 / drop;                       // px per km of radial offset
  const top = 90 * deg;
  const path = [];
  for (let i = 0; i <= 180; i++) {
    const p = onOrbit(ph, (ph.T * i) / 180);
    const [x, y] = pt(cx, cy, ring + k * (p.r - (RE + 500)), top + p.angle);
    path.push(`${i ? 'L' : 'M'}${f(x)} ${f(y)}`);
  }
  const [px, py] = pt(cx, cy, ring, top);
  const clientA = top + 26 * deg;
  const [qx, qy] = pt(cx, cy, ring, clientA);
  const defs = [earthDefs(C, 'bp'), arrowMarker('bp-thrust', C.servicer), arrowMarker('bp-vel', C.muted),
    `<filter id="bp-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>`];
  const parts = [
    earth(C, 'bp', cx, cy, R),
    `<circle cx="${cx}" cy="${cy}" r="${ring}" fill="none" stroke="${C.orbit}" stroke-opacity=".55" stroke-width="1.6" stroke-dasharray="6 7"/>`,
    `<path d="${arcPath(cx, cy, ring, top, clientA)}" fill="none" stroke="${C.client}" stroke-width="9" stroke-linecap="round" opacity=".35"/>`,
    `<path d="${path.join('')}" fill="none" stroke="${C.servicer}" stroke-width="7" opacity=".25" filter="url(#bp-soft)"/>`,
    `<path d="${path.join('')}" fill="none" stroke="${C.servicer}" stroke-width="2.6"/>`,
    // Velocity (thin, along the motion: to the left at the top) and retrograde thrust (thick, backwards).
    `<line x1="${f(px - 4)}" y1="${f(py - 18)}" x2="${f(px - 62)}" y2="${f(py - 18)}" stroke="${C.muted}" stroke-width="2" stroke-dasharray="4 4" marker-end="url(#bp-vel)"/>`,
    `<line x1="${f(px + 9)}" y1="${f(py)}" x2="${f(px + 64)}" y2="${f(py)}" stroke="${C.servicer}" stroke-width="5" stroke-linecap="round" marker-end="url(#bp-thrust)"/>`,
    `<circle cx="${f(qx)}" cy="${f(qy)}" r="7" fill="${C.client}" stroke="${C.surface}" stroke-width="2"/>`,
    `<circle cx="${f(px)}" cy="${f(py)}" r="7" fill="${C.servicer}" stroke="${C.surface}" stroke-width="2"/>`,
    badge(C, px + 22, py - 34, 1),
    badge(C, cx, cy + ring + 2 + 26, 2),
    badge(C, qx - 22, qy - 26, 3)
  ];
  return svg(W, H, defs, parts);
}

// Burn directions for the options of the practice question: the servicer on its orbit (moving to the
// right, client ahead), and the thrust arrow. The option text says the same thing.
function burnIcon(C, dir) {
  const W = 200, H = 120, cx = 100, cy = 640, orbit = 585, limb = 548;
  const craftA = 94 * deg, clientA = 84 * deg;
  const [sx, sy] = pt(cx, cy, orbit, craftA);
  const [qx, qy] = pt(cx, cy, orbit, clientA);
  // Moving clockwise here (to the right): tangent is the opposite of the counter-clockwise one.
  const [tx, ty] = tangent(craftA).map((v) => -v);
  const nx = (sx - cx) / orbit, ny = (sy - cy) / orbit;     // outward normal
  const thrust = dir === 'prograde' ? [tx, ty] : dir === 'retrograde' ? [-tx, -ty] : [-nx, -ny];
  const L = dir === 'radial' ? 30 : 40;
  const defs = [arrowMarker(`bi-${dir}`, C.servicer),
    `<linearGradient id="bi-limb-${dir}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.atmosphere}" stop-opacity=".55"/><stop offset=".2" stop-color="${C.ocean}"/><stop offset="1" stop-color="${C.oceanDeep}"/></linearGradient>`];
  const trail = [1, 2, 3].map((i) => {
    const [ax, ay] = pt(cx, cy, orbit, craftA + (6 + i * 5) * deg * 0.6);
    const [bx, by] = pt(cx, cy, orbit, craftA + (3 + i * 5) * deg * 0.6);
    return `<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(bx)}" y2="${f(by)}" stroke="${C.muted}" stroke-width="2" stroke-linecap="round" opacity="${f(0.75 - i * 0.18)}"/>`;
  });
  const parts = [
    `<circle cx="${cx}" cy="${cy}" r="${limb}" fill="url(#bi-limb-${dir})"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${orbit}" fill="none" stroke="${C.orbit}" stroke-opacity=".5" stroke-width="1.4" stroke-dasharray="4 5"/>`,
    ...trail,
    `<circle cx="${f(qx)}" cy="${f(qy)}" r="6" fill="${C.client}" stroke="${C.surface}" stroke-width="2"/>`,
    `<line x1="${f(sx + thrust[0] * 9)}" y1="${f(sy + thrust[1] * 9)}" x2="${f(sx + thrust[0] * L)}" y2="${f(sy + thrust[1] * L)}" stroke="${C.servicer}" stroke-width="5" stroke-linecap="round" marker-end="url(#bi-${dir})"/>`,
    `<g transform="translate(${f(sx)} ${f(sy)}) rotate(${f(Math.atan2(ty, tx) / deg)})"><rect x="-13" y="-2" width="8" height="4" rx="1" fill="${C.orbit}"/><rect x="5" y="-2" width="8" height="4" rx="1" fill="${C.orbit}"/><rect x="-5" y="-4.5" width="10" height="9" rx="2" fill="${C.text}"/></g>`
  ];
  return svg(W, H, defs, parts);
}

function svg(W, H, defs, parts) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs>
  ${defs.join('\n  ')}
</defs>
${parts.join('\n')}
</svg>
`;
}
