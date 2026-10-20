// Figures of the course, generated from the same geometry as the 3D lab (objects/planetary-lab/gear.js)
// and from the theme tokens: change a colour in course.json, run `elabora assets`, the figures follow.
// No words inside the figures: numbered markers here, labels in the blocks next to them.
import { gearset, toothOutline, planetPhase, ringPhase, planetAngle, radii, CONFIGS, parseConfig } from '../objects/planetary-lab/gear.js';

export const meta = { description: 'Gearset illustrations, the hoist drive, the bench gauges and the configuration diagrams, without text.' };

export default async function generate({ tokens, write }) {
  const C = palette(tokens);
  write('images/gearset-hero.svg', hero(C));
  write('images/anatomy-planetary.svg', anatomy(C));
  write('images/hoist-drive.svg', hoist(C));
  write('images/bench-ring-held.svg', gauge(C, { rpm: 1450 / 4, lifting: true, good: true }));
  write('images/bench-sun-held.svg', gauge(C, { rpm: (1450 * 72) / 96, lifting: true, good: false }));
  write('images/bench-carrier-held.svg', gauge(C, { rpm: (1450 * 24) / 72, lifting: false, good: false }));
  // One diagram per configuration (held-input), for the options of the configuration question.
  for (const config of CONFIGS) write(`images/config-${config}.svg`, configuration(C, parseConfig(config)));
}

// ── colours from the tokens ──
function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a, b, t) { const x = hex(a), y = hex(b); return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; }
function palette(t) {
  const copper = t['color.copper'] || t['color.accent'];
  const steel = t['color.steel'] || '#A9B6C3';
  const graphite = t['color.graphite'] || '#46525E';
  const carrier = t['color.carrier'] || t['color.primary'];
  const blueprint = t['color.blueprint'] || t['color.primary'];
  return {
    copper, copperLight: mix(copper, '#ffffff', 0.35), copperDark: mix(copper, '#000000', 0.35),
    steel, steelLight: mix(steel, '#ffffff', 0.55), steelDark: mix(steel, '#000000', 0.38),
    graphite, graphiteLight: mix(graphite, '#ffffff', 0.25), graphiteDark: mix(graphite, '#000000', 0.35),
    carrier, carrierLight: mix(carrier, '#ffffff', 0.35), carrierDark: mix(carrier, '#000000', 0.4),
    blueprint, blueprintDeep: mix(blueprint, '#000000', 0.35), line: t['color.blueprint-line'] || '#8FB8E3',
    paper: t['color.paper'] || t['color.surface'], ink: t['color.text'], muted: t['color.muted'],
    success: t['color.success'], error: t['color.error'], focus: t['color.focus']
  };
}

const f = (n) => Math.round(n * 10) / 10;
const poly = (pts, cx, cy) => 'M' + pts.map(([x, y]) => `${f(cx + x)} ${f(cy - y)}`).join('L') + 'Z';
const circle = (cx, cy, r) => `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;

function defs(C) {
  return `<defs>
  <radialGradient id="gCopper" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="${C.copperLight}"/><stop offset=".6" stop-color="${C.copper}"/><stop offset="1" stop-color="${C.copperDark}"/></radialGradient>
  <radialGradient id="gSteel" cx="38%" cy="32%" r="80%"><stop offset="0" stop-color="${C.steelLight}"/><stop offset=".55" stop-color="${C.steel}"/><stop offset="1" stop-color="${C.steelDark}"/></radialGradient>
  <radialGradient id="gRing" cx="45%" cy="40%" r="70%"><stop offset="0" stop-color="${C.graphiteLight}"/><stop offset="1" stop-color="${C.graphiteDark}"/></radialGradient>
  <linearGradient id="gCarrier" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.carrierLight}"/><stop offset="1" stop-color="${C.carrier}"/></linearGradient>
  <marker id="arrowCopper" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.copperLight}"/></marker>
  <marker id="arrowInk" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.ink}"/></marker>
  <marker id="arrowOk" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.success}"/></marker>
</defs>`;
}

// Front view of a planetary gearset (y axis up in gear space).
function gearsetFront(C, { cx, cy, m, set, dark = false, rotation = 0, carrierFront = false }) {
  const r = radii(set, m);
  const g = [];
  const housingR = r.ring + 1.25 * m + 2.6 * m;
  const ring = toothOutline(set.zr, m, { internal: true, phase: ringPhase(set) + rotation });
  g.push(`<path d="${circle(cx, cy, housingR)}${poly(ring, cx, cy)}" fill="url(#gRing)" fill-rule="evenodd" stroke="${C.graphiteDark}" stroke-width="1.5"/>`);
  g.push(`<circle cx="${cx}" cy="${cy}" r="${f(housingR - 0.9 * m)}" fill="none" stroke="${C.graphiteLight}" stroke-opacity=".5" stroke-width="1.2"/>`);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
    g.push(`<circle cx="${f(cx + Math.cos(a) * (housingR - 1.6 * m))}" cy="${f(cy - Math.sin(a) * (housingR - 1.6 * m))}" r="${f(0.42 * m)}" fill="${C.graphiteDark}" stroke="${C.graphiteLight}" stroke-opacity=".6"/>`);
  }
  const arms = [];
  for (let k = 0; k < set.planets; k++) {
    const a = planetAngle(k, set.planets) + rotation;
    const px = Math.cos(a) * r.centre, py = Math.sin(a) * r.centre;
    const nx = -Math.sin(a), ny = Math.cos(a);
    const w = 0.62 * r.planet;
    arms.push(`<path d="M${f(cx + nx * w * 0.8)} ${f(cy - ny * w * 0.8)}L${f(cx + px + nx * w)} ${f(cy - py - ny * w)}A${f(w)} ${f(w)} 0 0 0 ${f(cx + px - nx * w)} ${f(cy - py + ny * w)}L${f(cx - nx * w * 0.8)} ${f(cy + ny * w * 0.8)}Z" fill="url(#gCarrier)" ${carrierFront ? 'fill-opacity=".72" stroke-dasharray="6 4"' : ''} stroke="${C.carrierDark}" stroke-width="1.2"/>`);
  }
  if (!carrierFront) g.push(arms.join(''));
  for (let k = 0; k < set.planets; k++) {
    const a = planetAngle(k, set.planets) + rotation;
    const px = cx + Math.cos(a) * r.centre, py = cy - Math.sin(a) * r.centre;
    const pts = toothOutline(set.zp, m, { phase: planetPhase(k, set) + rotation });
    g.push(`<path d="${poly(pts, px, py)}${circle(px, py, 0.32 * r.planet)}" fill="url(#gSteel)" fill-rule="evenodd" stroke="${C.steelDark}" stroke-width="1.2"/>`);
    g.push(`<circle cx="${f(px)}" cy="${f(py)}" r="${f(0.32 * r.planet)}" fill="url(#gCarrier)" stroke="${C.carrierDark}" stroke-width="1.2"/>`);
    g.push(`<circle cx="${f(px)}" cy="${f(py)}" r="${f(0.1 * r.planet)}" fill="${C.blueprintDeep}"/>`);
  }
  const sun = toothOutline(set.zs, m, { phase: rotation });
  g.push(`<path d="${poly(sun, cx, cy)}${circle(cx, cy, 0.3 * r.sun)}" fill="url(#gCopper)" fill-rule="evenodd" stroke="${C.copperDark}" stroke-width="1.2"/>`);
  g.push(`<circle cx="${cx}" cy="${cy}" r="${f(0.3 * r.sun)}" fill="${dark ? C.blueprintDeep : C.graphiteDark}"/>`);
  g.push(`<rect x="${f(cx - 0.07 * r.sun)}" y="${f(cy - 0.36 * r.sun)}" width="${f(0.14 * r.sun)}" height="${f(0.1 * r.sun)}" fill="${dark ? C.blueprintDeep : C.graphiteDark}"/>`);
  if (carrierFront) {
    g.push(arms.join(''));
    g.push(`<circle cx="${cx}" cy="${cy}" r="${f(0.3 * r.sun)}" fill="url(#gCarrier)" stroke="${C.carrierDark}" stroke-width="1.2"/>`);
    for (let k = 0; k < set.planets; k++) {
      const a = planetAngle(k, set.planets) + rotation;
      g.push(`<circle cx="${f(cx + Math.cos(a) * r.centre)}" cy="${f(cy - Math.sin(a) * r.centre)}" r="${f(0.14 * r.planet)}" fill="${C.blueprintDeep}"/>`);
    }
  }
  return { svg: g.join('\n'), r, housingR };
}

function arcArrow(cx, cy, rad, a0, a1, stroke, marker, width = 3) {
  const p0 = [cx + rad * Math.cos(a0), cy - rad * Math.sin(a0)];
  const p1 = [cx + rad * Math.cos(a1), cy - rad * Math.sin(a1)];
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const sweep = a1 > a0 ? 0 : 1;
  return `<path d="M${f(p0[0])} ${f(p0[1])}A${rad} ${rad} 0 ${large} ${sweep} ${f(p1[0])} ${f(p1[1])}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" marker-end="url(#${marker})"/>`;
}

// Numbered marker: a number is language-neutral; its meaning is in the legend block.
function marker(C, x, y, n, { r = 20 } = {}) {
  return `<g><circle cx="${f(x)}" cy="${f(y)}" r="${r + 3}" fill="${C.paper}"/><circle cx="${f(x)}" cy="${f(y)}" r="${r}" fill="${C.ink}"/><text x="${f(x)}" y="${f(y + r * 0.36)}" text-anchor="middle" font-family="Space Grotesk, Inter, system-ui, sans-serif" font-size="${f(r * 1.05)}" font-weight="700" fill="${C.paper}">${n}</text></g>`;
}

// ── 1. Hero: the gearset, on a transparent background (the layout paints the blueprint) ──
function hero(C) {
  const set = gearset('30-78');
  const W = 720, cx = 360, cy = 360, m = 7.4;
  const gs = gearsetFront(C, { cx, cy, m, set, dark: true, rotation: 0.12 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}">
${defs(C)}
  <circle cx="${cx}" cy="${cy}" r="${f(gs.housingR + 30)}" fill="none" stroke="${C.line}" stroke-opacity=".35" stroke-dasharray="2 9"/>
  <circle cx="${cx}" cy="${cy}" r="${f(gs.housingR + 52)}" fill="none" stroke="${C.line}" stroke-opacity=".15"/>
  ${gs.svg}
  ${arcArrow(cx, cy, gs.housingR + 30, 2.3, 1.2, C.copperLight, 'arrowCopper', 5)}
  ${arcArrow(cx, cy, gs.housingR + 30, -0.85, -1.95, C.copperLight, 'arrowCopper', 5)}
</svg>
`;
}

// ── 2. Anatomy: front view with numbered markers (legend in the text block) ──
function anatomy(C) {
  const set = gearset('30-78');
  const W = 760, cx = 380, cy = 380, m = 7.6;
  const gs = gearsetFront(C, { cx, cy, m, set, rotation: 0.12, carrierFront: true });
  const r = gs.r;
  const a0 = planetAngle(0, 3) + 0.12;
  const a1 = planetAngle(1, 3) + 0.12;
  const at = (ang, rad) => [cx + Math.cos(ang) * rad, cy - Math.sin(ang) * rad];
  const sun = at(-2.2, r.sun * 0.72);
  const planet = at(a1, r.centre + r.planet * 0.55);
  const carrier = at(a0, r.centre * 0.55);
  const ring = at(-0.62, gs.housingR - 1.4 * m);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}">
${defs(C)}
  <path d="M${f(cx - gs.housingR - 24)} ${cy}H${f(cx + gs.housingR + 24)}M${cx} ${f(cy - gs.housingR - 24)}V${f(cy + gs.housingR + 24)}" stroke="${C.muted}" stroke-opacity=".45" stroke-dasharray="14 5 3 5"/>
  ${gs.svg}
  ${marker(C, sun[0], sun[1], 1)}
  ${marker(C, planet[0], planet[1], 2)}
  ${marker(C, carrier[0], carrier[1], 3)}
  ${marker(C, ring[0], ring[1], 4)}
</svg>
`;
}

// ── 3. Hoist drive: motor (1) → planetary stage (2) → drum (3) → load (4) ──
function hoist(C) {
  const W = 900, H = 600;
  const set = gearset('24-72');
  const st = gearsetFront(C, { cx: 450, cy: 230, m: 3.1, set, rotation: 0.2 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
${defs(C)}
  <defs>
    <linearGradient id="drum" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.steelLight}"/><stop offset=".5" stop-color="${C.steel}"/><stop offset="1" stop-color="${C.steelDark}"/></linearGradient>
    <linearGradient id="motor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.carrierLight}"/><stop offset="1" stop-color="${C.blueprint}"/></linearGradient>
  </defs>
  <rect x="46" y="156" width="200" height="148" rx="18" fill="url(#motor)"/>
  ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${62 + i * 30}" y="170" width="14" height="120" rx="6" fill="${C.paper}" fill-opacity=".14"/>`).join('')}
  <rect x="246" y="216" width="70" height="28" fill="${C.steelDark}"/>
  ${arcArrow(146, 112, 34, 2.6, 0.5, C.ink, 'arrowInk', 3)}
  ${st.svg}
  <circle cx="450" cy="230" r="${f(st.housingR + 16)}" fill="none" stroke="${C.copper}" stroke-width="3" stroke-dasharray="10 8"/>
  <rect x="${f(450 + st.housingR)}" y="216" width="${f(612 - 450 - st.housingR)}" height="28" fill="${C.steelDark}"/>
  <rect x="612" y="140" width="230" height="180" rx="16" fill="url(#drum)" stroke="${C.steelDark}" stroke-width="2"/>
  ${Array.from({ length: 9 }, (_, i) => `<path d="M${626 + i * 24} 142V318" stroke="${C.steelDark}" stroke-opacity=".55" stroke-width="2"/>`).join('')}
  ${arcArrow(727, 90, 34, 2.6, 0.5, C.success, 'arrowOk', 3)}
  <path d="M800 320V470" stroke="${C.ink}" stroke-width="5"/>
  <path d="M800 470c0 24 30 30 30 54c0 22-22 34-40 26" fill="none" stroke="${C.ink}" stroke-width="7" stroke-linecap="round"/>
  <path d="M752 548h96l14 34h-124z" fill="${C.ink}"/>
  <path d="M870 470V390" stroke="${C.success}" stroke-width="6" marker-end="url(#arrowOk)"/>
  ${marker(C, 146, 230, 1, { r: 22 })}
  ${marker(C, 450, 230 - st.housingR - 46, 2, { r: 22 })}
  ${marker(C, 727, 230, 3, { r: 22 })}
  ${marker(C, 700, 565, 4, { r: 22 })}
</svg>
`;
}

// ── 4. Test bench gauge: drum speed, target band, direction ──
function gauge(C, { rpm, lifting, good }) {
  const W = 800, H = 380, cx = 250, cy = 300, R = 200, max = 1500;
  const ang = (v) => Math.PI - (Math.min(Math.abs(v), max) / max) * Math.PI;
  const pt = (v, rr) => [cx + rr * Math.cos(ang(v)), cy - rr * Math.sin(ang(v))];
  const ticks = [];
  for (let v = 0; v <= max; v += 100) {
    const [x1, y1] = pt(v, R - (v % 500 === 0 ? 30 : 16));
    const [x2, y2] = pt(v, R);
    ticks.push(`<path d="M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}" stroke="${C.paper}" stroke-opacity="${v % 500 === 0 ? 0.9 : 0.45}" stroke-width="${v % 500 === 0 ? 3 : 2}"/>`);
    if (v % 500 === 0) { const [tx, ty] = pt(v, R - 58); ticks.push(`<text x="${f(tx)}" y="${f(ty + 8)}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="21" fill="${C.line}">${v}</text>`); }
  }
  const [b1x, b1y] = pt(340, R + 14), [b2x, b2y] = pt(380, R + 14);
  const [nx, ny] = pt(rpm, R - 26);
  const ok = good ? C.success : C.error;
  const arrow = lifting ? 'M0 22L0 -22M-16 -6L0 -24L16 -6' : 'M0 -22L0 22M-16 6L0 24L16 6';
  const mark = good ? 'M-14 0L-4 11L15 -12' : 'M-12 -12L12 12M12 -12L-12 12';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" rx="18" fill="${C.blueprint}"/>
  <path d="M${cx - R} ${cy}A${R} ${R} 0 0 1 ${cx + R} ${cy}" fill="none" stroke="${C.paper}" stroke-opacity=".16" stroke-width="24"/>
  <path d="M${f(b1x)} ${f(b1y)}A${R + 14} ${R + 14} 0 0 1 ${f(b2x)} ${f(b2y)}" fill="none" stroke="${C.success}" stroke-width="22"/>
  ${ticks.join('')}
  <path d="M${cx} ${cy}L${f(nx)} ${f(ny)}" stroke="${C.copperLight}" stroke-width="8" stroke-linecap="round"/>
  <circle cx="${cx}" cy="${cy}" r="17" fill="${C.copperLight}"/>
  <text x="530" y="182" font-family="Space Grotesk, Inter, system-ui, sans-serif" font-size="92" font-weight="700" fill="${C.paper}">${Math.round(Math.abs(rpm))}</text>
  <g transform="translate(565 262)"><circle r="34" fill="${lifting ? C.success : C.error}"/><path d="${arrow}" fill="none" stroke="${C.paper}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g>
  <g transform="translate(655 262)"><circle r="34" fill="none" stroke="${ok}" stroke-width="5"/><path d="${mark}" fill="none" stroke="${ok}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></g>
</svg>
`;
}

// ── 5. Configuration diagram: held member hatched, input with a solid arrow, output circled with a
// dashed line (no arrowhead: the diagram must not tell the output's direction or speed). The
// symbols match the legend drawn by the config-quiz component. ──
function configuration(C, { held, input, output }) {
  const set = gearset('30-78');
  const W = 300, cx = 150, cy = 150, m = 2.3;
  const gs = gearsetFront(C, { cx, cy, m, set, rotation: 0.12 });
  const r = gs.r;
  // Where each member is drawn: radius of its band, thickness of the band.
  const band = { sun: [r.sun * 0.55, r.sun * 1.1], carrier: [r.centre, r.planet * 0.9], ring: [(r.ring + 1.25 * m + gs.housingR) / 2, gs.housingR - r.ring - 1.25 * m] };
  const halo = (d, extra = '') => `<path d="${d}" fill="none" stroke="${C.paper}" stroke-width="9" stroke-linecap="round" ${extra}/>`;
  const out = [];
  // Held: hatching over the member.
  const [hr, hw] = band[held];
  out.push(held === 'sun'
    ? `<circle cx="${cx}" cy="${cy}" r="${f(r.sun * 1.08)}" fill="url(#hatch)" stroke="${C.ink}" stroke-width="2.5"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${f(hr)}" fill="none" stroke="url(#hatch)" stroke-width="${f(hw)}"/><circle cx="${cx}" cy="${cy}" r="${f(hr - hw / 2)}" fill="none" stroke="${C.ink}" stroke-width="2"/><circle cx="${cx}" cy="${cy}" r="${f(hr + hw / 2)}" fill="none" stroke="${C.ink}" stroke-width="2"/>`);
  // Input: solid arc arrow on the member (outside the housing for the ring).
  const ir = input === 'ring' ? gs.housingR + 13 : input === 'sun' ? r.sun * 0.78 : r.centre;
  const arc = arcPath(cx, cy, ir, 2.5, 0.65);
  out.push(halo(arc), `<path d="${arc}" fill="none" stroke="${C.ink}" stroke-width="4" stroke-linecap="round" marker-end="url(#arrowInk)"/>`);
  // Output: dashed circle, no arrowhead.
  const or = output === 'ring' ? gs.housingR + 13 : output === 'sun' ? r.sun * 1.18 : r.centre;
  out.push(`<circle cx="${cx}" cy="${cy}" r="${f(or)}" fill="none" stroke="${C.paper}" stroke-width="8"/><circle cx="${cx}" cy="${cy}" r="${f(or)}" fill="none" stroke="${C.ink}" stroke-width="3.5" stroke-dasharray="7 6"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}">
${defs(C)}
  <defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="${C.paper}" fill-opacity=".55"/><path d="M0 0V7" stroke="${C.ink}" stroke-width="2.6"/></pattern></defs>
  <g opacity=".8">${gs.svg}</g>
  ${out.join('\n  ')}
</svg>
`;
}

function arcPath(cx, cy, rad, a0, a1) {
  const p0 = [cx + rad * Math.cos(a0), cy - rad * Math.sin(a0)];
  const p1 = [cx + rad * Math.cos(a1), cy - rad * Math.sin(a1)];
  return `M${f(p0[0])} ${f(p0[1])}A${f(rad)} ${f(rad)} 0 0 1 ${f(p1[0])} ${f(p1[1])}`;
}
