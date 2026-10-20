// Figures of the course, without a word in them: labels live in the blocks next to them (or over
// them, as component props). The chart figures share their geometry with the 3D chart table
// (objects/chart-table/chart.js): the same coasts, harbours, hidden circle and rhumb lines.
// Colours come from the theme tokens; noise is seeded, so every run writes the same bytes.
import {
  COAST, ISLANDS, PORTS, SHEET, SCALE_BAR, HIDDEN_CIRCLE, MILES_PER_UNIT, ROTATION_DEG, ORIGIN,
  inkLine, islandOutline, port, roseCentres, rhumbs, rng, sheetOutline
} from '../objects/chart-table/chart.js';

export const meta = { description: 'T-O world map in layers, the two leaves of the diptych, the stages of a portolan chart and the whole chart (same geometry as the 3D chart table), a harbour plotted from two others, the 9° tilt against a modern map, dividers on a scale of miles, a 32-point wind rose and the hero rose, without text.' };

// Harbours whose names the pages write over the chart figures (labels of the blocks, in the
// course's words): the figures mark them with their dot only, without strokes of writing.
const LABELLED = ['palma', 'cagliari', 'marseille', 'barcelona', 'genoa', 'venice', 'naples', 'tunis'];

export default async function generate({ tokens, write }) {
  const C = palette(tokens);
  const to = tOLayers(C);
  for (const [name, svg] of Object.entries(to)) write(`images/to-${name}.svg`, svg);
  write('images/leaf-mappa.svg', leafMappa(C));
  write('images/leaf-portolan.svg', leafPortolan(C));
  const stages = workshopLayers(C);
  for (const [name, svg] of Object.entries(stages)) write(`images/${name === 'whole' ? 'chart-whole' : `ws-${name}`}.svg`, svg);
  const tilt = tiltLayers(C);
  for (const [name, svg] of Object.entries(tilt)) write(`images/tilt-${name}.svg`, svg);
  write('images/scale-dividers.svg', scaleDividers(C));
  write('images/wind-rose.svg', windRose(C, { size: 560, rays: false }));
  write('images/hero-rose.svg', windRose(C, { size: 1200, rays: true }));
}

// ── Colours ──────────────────────────────────────────────────────────
function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a, b, t) { const x = hex(a), y = hex(b); return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; }
function palette(t) {
  return {
    ink: t['color.ink'], inkSoft: t['color.ink-soft'], sepia: t['color.sepia'],
    vellum: t['color.vellum'], vellumLight: t['color.vellum-light'], vellumDeep: t['color.vellum-deep'], edge: t['color.vellum-edge'], shadow: t['color.vellum-shadow'],
    gold: t['color.gold'], goldLight: t['color.gold-light'], vermilion: t['color.vermilion'], verdigris: t['color.verdigris'], lapis: t['color.lapis'],
    wind: t['color.rhumb-wind'], half: t['color.rhumb-half'], quarter: t['color.rhumb-quarter'],
    sea: mix(mix(t['color.lapis'], t['color.verdigris'], 0.35), t['color.vellum'], 0.55), seaDeep: mix(t['color.lapis'], t['color.vellum'], 0.28),
    asia: mix(t['color.gold-light'], t['color.vellum'], 0.35), europe: mix(t['color.verdigris'], t['color.vellum'], 0.72), africa: mix(t['color.vermilion'], t['color.vellum'], 0.74)
  };
}
const f = (n) => Math.round(n * 100) / 100;
const DEG = Math.PI / 180;
const svgOpen = (w, h, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${extra}>`;

// ── T-O world map (Isidore of Seville), in layers ────────────────────
// 600 × 600, centre (300, 300): the Ocean (O) round the world; the waters of the T (the
// Mediterranean as the stem, the Don and the Nile as the arms); Asia above, Europe bottom left,
// Africa bottom right; Jerusalem at the crossing; Paradise in the far east, at the top.
function tOLayers(C) {
  const c = 300, R = 286, r = 238, bar = 13, stem = 15;
  const open = svgOpen(600, 600);
  const random = rng(17);
  // Waves: little arcs along the ocean band.
  let waves = '';
  for (let ring = 0; ring < 3; ring++) {
    const rad = r + 10 + ring * 13;
    const count = 46 + ring * 4;
    for (let k = 0; k < count; k++) {
      const a = (k + (ring % 2) * 0.5) / count * Math.PI * 2 + random() * 0.02;
      const x = c + rad * Math.sin(a), y = c - rad * Math.cos(a);
      const tx = Math.cos(a), ty = Math.sin(a);
      waves += `<path d="M${f(x - tx * 5)} ${f(y - ty * 5)}q${f(tx * 5 - ty * 3)} ${f(ty * 5 + tx * 3)} ${f(tx * 10)} ${f(ty * 10)}"/>`;
    }
  }
  const ocean = `${open}<circle cx="${c}" cy="${c}" r="${(R + r) / 2}" fill="none" stroke="${C.sea}" stroke-width="${R - r}"/>
<g fill="none" stroke="${C.lapis}" stroke-width="1.6" stroke-linecap="round" opacity=".55">${waves}</g>
<circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="${C.ink}" stroke-width="3"/><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${C.ink}" stroke-width="2.2"/></svg>`;
  // Quadrants clipped to the inner disc.
  const disc = `<clipPath id="to-disc"><circle cx="${c}" cy="${c}" r="${r}"/></clipPath>`;
  const asia = `${open}<defs>${disc}</defs><g clip-path="url(#to-disc)"><rect x="0" y="0" width="600" height="${c}" fill="${C.asia}"/></g></svg>`;
  const europe = `${open}<defs>${disc}</defs><g clip-path="url(#to-disc)"><rect x="0" y="${c}" width="${c}" height="${c}" fill="${C.europe}"/></g></svg>`;
  const africa = `${open}<defs>${disc}</defs><g clip-path="url(#to-disc)"><rect x="${c}" y="${c}" width="${c}" height="${c}" fill="${C.africa}"/></g></svg>`;
  const tee = `${open}<defs>${disc}</defs><g clip-path="url(#to-disc)" stroke="${C.ink}" stroke-width="2.2">
<rect x="${c - r - 4}" y="${c - bar}" width="${2 * r + 8}" height="${2 * bar}" fill="${C.seaDeep}"/>
<rect x="${c - stem}" y="${c - bar}" width="${2 * stem}" height="${r + 8}" fill="${C.seaDeep}"/>
<rect x="${c - stem + 2}" y="${c - bar + 2}" width="${2 * stem - 4}" height="${2 * bar}" fill="${C.seaDeep}" stroke="none"/></g></svg>`;
  // Jerusalem: a walled city as a ring with a cross, at the crossing.
  const jerusalem = `${open}<g transform="translate(${c} ${c - 34})"><circle r="17" fill="${C.vellumLight}" stroke="${C.ink}" stroke-width="2.4"/><circle r="11" fill="none" stroke="${C.vermilion}" stroke-width="2"/>
<path d="M0 -8V8M-6 -2H6" stroke="${C.vermilion}" stroke-width="2.6" stroke-linecap="round"/></g></svg>`;
  // Paradise: the garden in the far east, a gilded round island with the four rivers.
  const paradise = `${open}<g transform="translate(${c} ${c - r + 46})"><circle r="25" fill="${C.goldLight}" stroke="${C.gold}" stroke-width="3"/>
<circle r="25" fill="none" stroke="${C.ink}" stroke-width="1.6"/><path d="M0 -6V-24M6 0H24M0 6V24M-6 0H-24" stroke="${C.lapis}" stroke-width="2.6" stroke-linecap="round"/><circle r="6" fill="${C.verdigris}" stroke="${C.ink}" stroke-width="1.4"/></g></svg>`;
  return { ocean, asia, europe, africa, tee, jerusalem, paradise };
}

// ── The two leaves of the diptych ────────────────────────────────────
function leafMappa(C) {
  const c = 160, r = 128;
  return `${svgOpen(320, 320)}<circle cx="${c}" cy="${c}" r="${r + 18}" fill="${C.sea}" stroke="${C.ink}" stroke-width="2"/>
<circle cx="${c}" cy="${c}" r="${r}" fill="${C.vellumLight}" stroke="${C.ink}" stroke-width="1.6"/>
<path d="M${c - r} ${c}A${r} ${r} 0 0 1 ${c + r} ${c}Z" fill="${C.asia}"/>
<path d="M${c - r} ${c}H${c}V${c + r}A${r} ${r} 0 0 1 ${c - r} ${c}Z" fill="${C.europe}"/>
<path d="M${c + r} ${c}H${c}V${c + r}A${r} ${r} 0 0 0 ${c + r} ${c}Z" fill="${C.africa}"/>
<path d="M${c - r} ${c}H${c + r}M${c} ${c}V${c + r}" stroke="${C.seaDeep}" stroke-width="12"/>
<path d="M${c - r} ${c}H${c + r}M${c} ${c}V${c + r}" stroke="${C.ink}" stroke-width="1.2" opacity=".6"/>
<circle cx="${c}" cy="${c - 14}" r="8" fill="${C.vellumLight}" stroke="${C.vermilion}" stroke-width="2.2"/>
<circle cx="${c}" cy="${c - r + 26}" r="12" fill="${C.goldLight}" stroke="${C.gold}" stroke-width="2.4"/>
${[0, 1, 2, 3, 4, 5].map((k) => { const a = (k * 60 + 20) * DEG; const x = c + 82 * Math.sin(a), y = c - 82 * Math.cos(a) * 0.9; return `<path d="M${f(x - 7)} ${f(y + 6)}l7 -12l7 12z" fill="none" stroke="${C.inkSoft}" stroke-width="1.6" stroke-linejoin="round"/>`; }).join('')}
</svg>`;
}

function leafPortolan(C) {
  // A corner of the chart: the rose of Majorca's rim point with its rays, Iberia's east coast and
  // the Balearics, cut from the same geometry as the full chart.
  const view = { x: -15.5, y: 3.6, w: 10.5 };
  const S = 320 / view.w;
  const X = (x) => f((x - view.x) * S), Y = (y) => f((view.y - y) * S);
  const inView = (point) => point.x > view.x - 1 && point.x < view.x + view.w + 1 && point.y < view.y + 1 && point.y > view.y - view.w - 1;
  const roses = roseCentres().filter(inView);
  const color = { wind: C.wind, half: C.half, quarter: C.quarter };
  let out = `${svgOpen(320, 320)}<rect width="320" height="320" fill="${C.vellumLight}"/><g stroke-width="1" opacity=".75">`;
  for (const line of rhumbs()) {
    if (!roses.some((rose) => Math.hypot(line.x1 - rose.x, line.y1 - rose.y) < 0.01)) continue;
    out += `<line x1="${X(line.x1)}" y1="${Y(line.y1)}" x2="${X(line.x2)}" y2="${Y(line.y2)}" stroke="${color[line.kind]}"/>`;
  }
  out += '</g>';
  out += `<path d="${pathOf(inkLine(COAST), X, Y)}" fill="none" stroke="${C.ink}" stroke-width="2.2" stroke-linejoin="round"/>`;
  for (const island of ISLANDS) out += `<path d="${pathOf(islandOutline(island), X, Y)}Z" fill="${island.fill ? fillOf(C, island.fill) : 'none'}" stroke="${C.ink}" stroke-width="1.6"/>`;
  out += nameStrokes(C, X, Y, S, ['valencia', 'barcelona', 'palma', 'cartagena', 'marseille', 'almeria', 'algiers', 'oran'], 1.6);
  return `${out}</svg>`;
}

const fillOf = (C, fill) => ({ gold: C.gold, red: C.vermilion, green: C.verdigris, blue: C.lapis })[fill];
const pathOf = (points, X, Y) => `M${points.map(([x, y]) => `${X(x)} ${Y(y)}`).join('L')}`;

// Harbour names as illegible strokes of writing (no words in figures): a wavy line of minims
// written inland, at right angles to the coast, red for the great harbours.
function nameStrokes(C, X, Y, S, ids, width = 1.3, dotsOnly = []) {
  let out = '';
  for (const id of ids || PORTS.map((p) => p.id)) {
    const p = port(id);
    if (dotsOnly.includes(id)) { out += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${f(Math.max(1.6, S * 0.07))}" fill="${p.major ? C.vermilion : C.ink}"/>`; continue; }
    const a = p.inlandSheet * DEG;
    const ux = Math.sin(a), uy = Math.cos(a);
    const vx = -uy, vy = ux;                              // across the writing direction
    const start = 0.28, length = 0.7 + id.length * 0.16;
    const random = rng(id.length * 97 + id.charCodeAt(0));
    let d = '';
    const steps = Math.round(length / 0.07);
    for (let i = 0; i <= steps; i++) {
      const t = start + (i / steps) * length;
      const h = (i % 2 ? 0.09 : -0.02) * (0.8 + random() * 0.4) + (i % 7 === 3 ? 0.08 : 0);
      const x = p.x + ux * t + vx * h, y = p.y + uy * t + vy * h;
      d += `${i ? 'L' : 'M'}${X(x)} ${Y(y)}`;
    }
    out += `<path d="${d}" fill="none" stroke="${p.major ? C.vermilion : C.ink}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
    out += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${f(Math.max(1.6, S * 0.045))}" fill="${p.major ? C.vermilion : C.ink}"/>`;
  }
  return out;
}

// ── The chart in six stages ─────────────────────────────────────────
// Every layer has the same frame (the skin with its neck), so they stack: the skin, the hidden
// circle and its sixteen pinpricks, the rhumb lines, the coasts and islands, the names, then the
// scale, the colours and a wind rose.
function workshopLayers(C) {
  const pad = 0.6;
  const left = -SHEET.width / 2 - SHEET.neck - pad, top = SHEET.height / 2 + pad;
  const S = 26;
  const W = Math.round((SHEET.width + SHEET.neck + 2 * pad) * S), H = Math.round((SHEET.height + 2 * pad) * S);
  const X = (x) => f((x - left) * S), Y = (y) => f((top - y) * S);
  const open = svgOpen(W, H);
  const skinPath = `${pathOf(sheetOutline(), X, Y)}Z`;
  const clip = `<clipPath id="ws-sheet"><path d="${skinPath}"/></clipPath>`;

  // 1. The skin: vellum, darker towards the edges, a few stains, the grain.
  const random = rng(5);
  let stains = '';
  for (let i = 0; i < 9; i++) {
    const x = (random() - 0.5) * SHEET.width * 0.9, y = (random() - 0.5) * SHEET.height * 0.9;
    stains += `<ellipse cx="${X(x)}" cy="${Y(y)}" rx="${f(S * (1 + random() * 3))}" ry="${f(S * (0.8 + random() * 2))}" fill="${C.edge}" opacity="${f(0.05 + random() * 0.08)}"/>`;
  }
  const skin = `${open}<defs>${clip}<radialGradient id="ws-age" cx="50%" cy="50%" r="62%"><stop offset=".55" stop-color="${C.vellumLight}"/><stop offset="1" stop-color="${C.vellumDeep}"/></radialGradient>
<filter id="ws-grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="3" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .35  0 0 0 0 .25  0 0 0 0 .1  0 0 0 .09 0"/><feComposite in2="SourceGraphic" operator="in"/></filter></defs>
<path d="${skinPath}" fill="${C.shadow}" opacity=".18" transform="translate(4 7)"/>
<path d="${skinPath}" fill="url(#ws-age)"/><g clip-path="url(#ws-sheet)">${stains}<path d="${skinPath}" fill="${C.vellum}" filter="url(#ws-grain)"/></g>
<path d="${skinPath}" fill="none" stroke="${C.edge}" stroke-width="2.5"/></svg>`;

  // 2. The hidden circle, in drypoint, and the pinpricks of the dividers.
  const { x: hx, y: hy, r: hr } = HIDDEN_CIRCLE;
  const pricks = roseCentres().map((point) => `<circle cx="${X(point.x)}" cy="${Y(point.y)}" r="3.2" fill="${C.vellumLight}" stroke="${C.ink}" stroke-width="1.6"/><circle cx="${X(point.x)}" cy="${Y(point.y)}" r="1" fill="${C.ink}"/>`).join('');
  const circle = `${open}<circle cx="${X(hx)}" cy="${Y(hy)}" r="${f(hr * S)}" fill="none" stroke="${C.sepia}" stroke-width="1.4" stroke-dasharray="1 5" stroke-linecap="round" opacity=".8"/>${pricks}</svg>`;

  // 3. The rhumb lines: black for the eight winds, green for the half-winds, red for the quarters.
  const color = { wind: C.wind, half: C.half, quarter: C.quarter };
  const widths = { wind: 1.05, half: 0.9, quarter: 0.8 };
  let lines = '';
  for (const kind of ['quarter', 'half', 'wind']) {
    lines += `<g stroke="${color[kind]}" stroke-width="${widths[kind]}" opacity="${kind === 'wind' ? 0.5 : 0.36}">`;
    for (const line of rhumbs()) if (line.kind === kind) lines += `<line x1="${X(line.x1)}" y1="${Y(line.y1)}" x2="${X(line.x2)}" y2="${Y(line.y2)}"/>`;
    lines += '</g>';
  }
  const network = `${open}<defs>${clip}</defs><g clip-path="url(#ws-sheet)">${lines}</g></svg>`;

  // 4. The coasts and the outlines of the islands.
  let coastInk = `<path d="${pathOf(inkLine(COAST), X, Y)}" fill="none" stroke="${C.ink}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round"/>`;
  for (const island of ISLANDS) coastInk += `<path d="${pathOf(islandOutline(island), X, Y)}Z" fill="none" stroke="${C.ink}" stroke-width="1.7" stroke-linejoin="round"/>`;
  const coasts = `${open}<defs>${clip}</defs><g clip-path="url(#ws-sheet)">${coastInk}</g></svg>`;

  // 3b. A harbour plotted from two others: Majorca fixed; Cagliari laid off from it by its bearing
  // and its distance (a line and the arc of the dividers), Marseille the same; then the check from
  // Marseille to Cagliari, in red, closing the triangle.
  const [ma, ca, mr] = ['palma', 'cagliari', 'marseille'].map(port);
  const arc = (from, to, spread = 7) => {
    const r = Math.hypot(to.x - from.x, to.y - from.y), a = Math.atan2(to.x - from.x, to.y - from.y);
    const p = (d) => [from.x + r * Math.sin(a + d * DEG), from.y + r * Math.cos(a + d * DEG)];
    const [x0, y0] = p(-spread), [x1, y1] = p(spread);
    return `M${X(x0)} ${Y(y0)}A${f(r * S)} ${f(r * S)} 0 0 1 ${X(x1)} ${Y(y1)}`;
  };
  const prick = (p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="9" fill="none" stroke="${C.vermilion}" stroke-width="2"/><circle cx="${X(p.x)}" cy="${Y(p.y)}" r="3" fill="${C.ink}"/>`;
  const plot = `${open}<g fill="none" stroke-linecap="round">
<path d="M${X(ma.x)} ${Y(ma.y)}L${X(ca.x)} ${Y(ca.y)}M${X(ma.x)} ${Y(ma.y)}L${X(mr.x)} ${Y(mr.y)}" stroke="${C.ink}" stroke-width="2.4"/>
<path d="${arc(ma, ca)}${arc(ma, mr, 9)}" stroke="${C.sepia}" stroke-width="2" stroke-dasharray="2 5"/>
<path d="M${X(mr.x)} ${Y(mr.y)}L${X(ca.x)} ${Y(ca.y)}" stroke="${C.vermilion}" stroke-width="2.4" stroke-dasharray="9 6"/>
<path d="${arc(mr, ca, 6)}" stroke="${C.vermilion}" stroke-width="2" stroke-dasharray="2 5"/></g>
<circle cx="${X(ma.x)}" cy="${Y(ma.y)}" r="7" fill="${C.vermilion}" stroke="${C.ink}" stroke-width="1.6"/>${prick(ca)}${prick(mr)}</svg>`;

  // 5. The names: strokes of writing across the land, red for the great harbours. The harbours the
  // page names in words keep their dot only.
  const nameInk = nameStrokes(C, X, Y, S, null, 2.6, LABELLED);
  const names = `${open}<defs>${clip}</defs><g clip-path="url(#ws-sheet)">${nameInk}</g></svg>`;

  // 6. The scale of miles, the colours of the islands, a wind rose in the empty land of Africa.
  const { x: sx, y: sy, miles, divisions } = SCALE_BAR;
  const unit = (miles / divisions) / MILES_PER_UNIT;
  let scale = `<g transform="translate(${X(sx)} ${Y(sy)})"><rect x="0" y="-6" width="${f(unit * divisions * S)}" height="12" fill="${C.vellumLight}" stroke="${C.ink}" stroke-width="1.6"/>`;
  for (let k = 0; k < divisions; k++) {
    if (k % 2 === 0) scale += `<rect x="${f(k * unit * S)}" y="-6" width="${f(unit * S)}" height="12" fill="${C.ink}"/>`;
    for (let d = 1; d < 5; d++) scale += `<circle cx="${f((k + d / 5) * unit * S)}" cy="${k % 2 === 0 ? 0 : 0}" r="1.3" fill="${k % 2 === 0 ? C.vellumLight : C.ink}"/>`;
  }
  scale += `<path d="M-10 0l6 -6v12z" fill="${C.vermilion}"/><path d="M${f(unit * divisions * S + 10)} 0l-6 -6v12z" fill="${C.vermilion}"/></g>`;
  let fills = '';
  for (const island of ISLANDS) if (island.fill) fills += `<path d="${pathOf(islandOutline(island), X, Y)}Z" fill="${fillOf(C, island.fill)}" stroke="${C.ink}" stroke-width="1.7"/>`;
  const rose = roseShape(C, X(2.4), Y(-8.6), 2.2 * S, { cross: true });
  const finish = `${open}<defs>${clip}</defs><g clip-path="url(#ws-sheet)">${fills}${scale}${rose}</g></svg>`;

  // The finished chart in one image (the opening of the course and its close), its rhumb lines
  // dimmed so that the coasts, the names and the labels over it read first.
  const inner = (svg) => svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>')).replace(/<defs>[\s\S]*?<\/defs>/, '');
  const whole = `${open}<defs>${clip}<radialGradient id="ws-age" cx="50%" cy="50%" r="62%"><stop offset=".55" stop-color="${C.vellumLight}"/><stop offset="1" stop-color="${C.vellumDeep}"/></radialGradient>
<filter id="ws-grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="3" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .35  0 0 0 0 .25  0 0 0 0 .1  0 0 0 .09 0"/><feComposite in2="SourceGraphic" operator="in"/></filter></defs>
${inner(skin)}${inner(circle)}<g opacity=".5">${inner(network)}</g>${inner(coasts)}${inner(names)}${inner(finish)}</svg>`;

  return { skin, circle, rhumbs: network, plot, coasts, names, finish, whole };
}

// ── The tilt: the chart over a modern map ───────────────────────────
// Both at the same scale and centre: a modern map with true north up (sepia, dashed), and the
// chart drawn with the compass's north up (ink), turned ROTATION_DEG anticlockwise. Then two
// needles: true north, and the compass needle about 9° east of it.
function tiltLayers(C) {
  const w = 1200, h = 600, S = 24, cx = 590, cy = 300;
  const rad = ROTATION_DEG * DEG, cos38 = Math.cos(38 * DEG);
  const flat = (lon, lat) => [(lon - ORIGIN.lon) * cos38, lat - ORIGIN.lat];
  const turn = ([x, y]) => [x * Math.cos(rad) - y * Math.sin(rad), x * Math.sin(rad) + y * Math.cos(rad)];
  const path = (points, rotate, close) => `M${points.map(([lon, lat]) => { const [x, y] = rotate ? turn(flat(lon, lat)) : flat(lon, lat); return `${f(cx + x * S)} ${f(cy - y * S)}`; }).join('L')}${close ? 'Z' : ''}`;
  const islands = ['corsica', 'sardinia', 'sicily', 'crete', 'cyprus', 'majorca'].map((id) => ISLANDS.find((island) => island.id === id));
  const draw = (rotate) => path(COAST, rotate) + islands.map((island) => path(island.points, rotate, true)).join('');
  const open = svgOpen(w, h);
  const modern = `${open}<path d="${draw(false)}" fill="none" stroke="${C.sepia}" stroke-width="2" stroke-dasharray="6 5" stroke-linejoin="round" opacity=".85"/></svg>`;
  const chart = `${open}<path d="${draw(true)}" fill="none" stroke="${C.ink}" stroke-width="2.6" stroke-linejoin="round"/></svg>`;
  // The needles, in the empty desert in the south-east corner.
  const nx = 1110, ny = 565, L = 125;
  const tip = (deg) => [nx + L * Math.sin(deg * DEG), ny - L * Math.cos(deg * DEG)];
  const [tx, ty] = tip(0), [mx, my] = tip(ROTATION_DEG);
  const head = (x, y, deg, colour) => { const a = deg * DEG, s = 14; const l = [x - s * Math.sin(a) - 7 * Math.cos(a), y + s * Math.cos(a) - 7 * Math.sin(a)], r = [x - s * Math.sin(a) + 7 * Math.cos(a), y + s * Math.cos(a) + 7 * Math.sin(a)]; return `<path d="M${f(x)} ${f(y)}L${f(l[0])} ${f(l[1])}L${f(r[0])} ${f(r[1])}Z" fill="${colour}"/>`; };
  const [ax, ay] = [nx, ny - 80], [bx, by] = [nx + 80 * Math.sin(rad), ny - 80 * Math.cos(rad)];
  const needles = `${open}<circle cx="${nx}" cy="${ny}" r="6" fill="${C.ink}"/>
<path d="M${nx} ${ny}L${f(tx)} ${f(ty)}" stroke="${C.sepia}" stroke-width="3" stroke-dasharray="6 5"/>${head(tx, ty, 0, C.sepia)}
<path d="M${nx} ${ny}L${f(mx)} ${f(my)}" stroke="${C.vermilion}" stroke-width="3.4"/>${head(mx, my, ROTATION_DEG, C.vermilion)}
<path d="M${f(ax)} ${f(ay)}A80 80 0 0 1 ${f(bx)} ${f(by)}" fill="none" stroke="${C.ink}" stroke-width="1.6"/></svg>`;
  return { modern, chart, needles };
}

// ── Dividers on the scale of miles ──────────────────────────────────
// The chart's scale bar, six divisions with their dotted tenths, and a pair of dividers opened
// to three and a half divisions from its left end.
function scaleDividers(C) {
  const w = 760, h = 260, x0 = 80, unit = 100, y = 200, n = 6;
  let out = `${svgOpen(w, h)}<rect x="${x0}" y="${y - 9}" width="${unit * n}" height="18" fill="${C.vellumLight}" stroke="${C.ink}" stroke-width="2"/>`;
  for (let k = 0; k < n; k++) {
    if (k % 2 === 0) out += `<rect x="${x0 + k * unit}" y="${y - 9}" width="${unit}" height="18" fill="${C.ink}"/>`;
    for (let d = 1; d < 5; d++) out += `<circle cx="${x0 + (k + d / 5) * unit}" cy="${y}" r="2" fill="${k % 2 === 0 ? C.vellumLight : C.ink}"/>`;
  }
  out += `<path d="M${x0 - 6} ${y}l-14 -9v18z" fill="${C.vermilion}"/><path d="M${x0 + unit * n + 6} ${y}l14 -9v18z" fill="${C.vermilion}"/>`;
  const a = x0, b = x0 + 3.5 * unit, hx = (a + b) / 2, hy = 38;
  const leg = (x) => `<path d="M${hx} ${hy}L${x} ${y - 14}" stroke="${C.gold}" stroke-width="7" stroke-linecap="round"/><path d="M${hx} ${hy}L${x} ${y - 14}" stroke="${C.shadow}" stroke-width="1.2" opacity=".5"/><path d="M${f(x + (hx - x) * 0.09)} ${f(y - 14 + (hy - y + 14) * 0.09)}L${x} ${y - 1}" stroke="${C.inkSoft}" stroke-width="3" stroke-linecap="round"/>`;
  out += `${leg(a)}${leg(b)}<circle cx="${hx}" cy="${hy}" r="12" fill="${C.goldLight}" stroke="${C.gold}" stroke-width="3"/><circle cx="${hx}" cy="${hy}" r="3" fill="${C.shadow}"/>`;
  out += `<path d="M${a} ${y + 26}V${y + 34}H${b}V${y + 26}" fill="none" stroke="${C.vermilion}" stroke-width="2"/>`;
  return `${out}</svg>`;
}

// ── Wind roses ───────────────────────────────────────────────────────
// A 32-point rose: the eight winds as long points (gilded and lapis in turn), half-winds in green,
// quarter-winds in red, a cross on the east point (towards the Holy Land), as on Catalan charts.
function roseShape(C, cx, cy, R, { cross = true } = {}) {
  const point = (deg, length, width, fill) => {
    const a = deg * DEG;
    const tip = [cx + length * Math.sin(a), cy - length * Math.cos(a)];
    const l = [cx + width * Math.sin(a - Math.PI / 2), cy - width * Math.cos(a - Math.PI / 2)];
    const r = [cx + width * Math.sin(a + Math.PI / 2), cy - width * Math.cos(a + Math.PI / 2)];
    return `<path d="M${f(l[0])} ${f(l[1])}L${f(tip[0])} ${f(tip[1])}L${f(r[0])} ${f(r[1])}Z" fill="${fill}" stroke="${C.ink}" stroke-width="${f(Math.max(0.8, R / 140))}" stroke-linejoin="round"/>`;
  };
  let out = `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R * 0.98)}" fill="${C.vellumLight}" fill-opacity=".55" stroke="${C.ink}" stroke-width="${f(Math.max(0.8, R / 160))}"/>`;
  out += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R * 0.9)}" fill="none" stroke="${C.gold}" stroke-width="${f(Math.max(1, R / 70))}"/>`;
  for (let k = 0; k < 32; k++) if (k % 2) out += point(k * 11.25, R * 0.5, R * 0.035, C.quarter);
  for (let k = 0; k < 8; k++) out += point(22.5 + k * 45, R * 0.66, R * 0.06, C.half);
  for (let k = 0; k < 8; k++) out += point(k * 45, R * 0.86, R * 0.095, k % 2 ? C.lapis : C.gold);
  out += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R * 0.09)}" fill="${C.vermilion}" stroke="${C.ink}" stroke-width="${f(Math.max(0.8, R / 140))}"/>`;
  if (cross) {
    const x = cx + R * 0.97, s = R * 0.09;
    out += `<path d="M${f(x - s)} ${f(cy)}H${f(x + s)}M${f(x)} ${f(cy - s)}V${f(cy + s)}" stroke="${C.vermilion}" stroke-width="${f(Math.max(1.6, R / 50))}" stroke-linecap="round"/>`;
  }
  return out;
}

function windRose(C, { size, rays }) {
  const c = size / 2, R = rays ? size * 0.2 : size * 0.46;
  let out = svgOpen(size, size);
  if (rays) {
    const color = { 0: C.wind, 1: C.quarter, 2: C.half, 3: C.quarter };
    out += '<g stroke-linecap="round">';
    for (let k = 0; k < 32; k++) {
      const a = k * 11.25 * DEG;
      out += `<line x1="${f(c + R * 0.95 * Math.sin(a))}" y1="${f(c - R * 0.95 * Math.cos(a))}" x2="${f(c + c * 1.5 * Math.sin(a))}" y2="${f(c - c * 1.5 * Math.cos(a))}" stroke="${color[k % 4]}" stroke-width="${k % 4 === 0 ? 1.6 : 1.1}" opacity="${k % 4 === 0 ? 0.55 : 0.4}"/>`;
    }
    out += '</g>';
  }
  return `${out}${roseShape(C, c, c, R)}</svg>`;
}
