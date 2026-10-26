// Every picture of the course, drawn from the theme's colours, without a word in them: labels and
// explanations live in the blocks (markers, captions, steps). Noise is seeded, so every run writes the
// same bytes. Where a block points at a part of a picture (an interactive picture's markers, a quiz's
// zones, a steps block's regions), the coordinates come from the constants exported here.
export const meta = { description: 'A coffee farm on a slope, a cherry in cross-section, the altitude of arabica and robusta, a ripening branch, the five steps from tree to sack, drying beds, beans after each process, a port, a grader\'s tray and defects, green beans, a shipment in pictures, a drum roaster and its diagram, a roast curve in layers, green and roasted beans, roast levels, a roasted bean up close, cups, a pour-over station, four brewers and a producer\'s portrait, without text.' };

// Where the blocks point (0 to 1 of the whole picture).
export const CHERRY = { skin: [0.67, 0.29], pulp: [0.6, 0.7], parchment: [0.21, 0.44], bean: [0.31, 0.6] };
export const TRAY = { black: [0.19, 0.34], broken: [0.71, 0.24], insect: [0.42, 0.72], stone: [0.83, 0.71] };
export const ROASTER = { hopper: { x: 0.27, y: 0.04, w: 0.2, h: 0.2 }, drum: { x: 0.16, y: 0.25, w: 0.42, h: 0.33 }, burner: { x: 0.18, y: 0.6, w: 0.38, h: 0.14 }, cooling: { x: 0.6, y: 0.56, w: 0.37, h: 0.26 } };
export const CLOSEUP = { cut: [0.5, 0.42], chaff: [0.53, 0.66], oil: [0.31, 0.3], colour: [0.76, 0.52] };
export const STATION = { grinder: [0.16, 0.42], dripper: [0.48, 0.3], scale: [0.48, 0.79], kettle: [0.81, 0.47] };

export default async function generate({ tokens, write }) {
  const C = palette(tokens);
  write('images/farm-slope.svg', farmSlope(C));
  write('images/cherry-section.svg', cherrySection(C));
  write('images/altitude.svg', altitude(C));
  write('images/branch.svg', branch(C));
  write('images/step-pick.svg', stepPick(C));
  write('images/step-float.svg', stepFloat(C));
  write('images/step-pulp.svg', stepPulp(C));
  write('images/step-dry.svg', stepDry(C));
  write('images/step-hull.svg', stepHull(C));
  write('images/drying-beds.svg', dryingBeds(C));
  write('images/dry-washed.svg', dryProcess(C, 'washed'));
  write('images/dry-honey.svg', dryProcess(C, 'honey'));
  write('images/dry-natural.svg', dryProcess(C, 'natural'));
  write('images/port-sacks.svg', portSacks(C));
  write('images/grading-tray.svg', gradingTray(C));
  write('images/bean-healthy.svg', singleBean(C, 'healthy'));
  write('images/bean-black.svg', singleBean(C, 'black'));
  write('images/bean-peaberry.svg', singleBean(C, 'peaberry'));
  write('images/green-scoop.svg', greenScoop(C));
  write('images/sacks-stack.svg', sacksStack(C));
  write('images/ship.svg', ship(C));
  write('images/warehouse.svg', warehouse(C));
  write('images/roaster-window.svg', roasterWindow(C));
  write('images/roaster-diagram.svg', roasterDiagram(C));
  for (const [name, svg] of Object.entries(roastCurve(C))) write(`images/curve-${name}.svg`, svg);
  write('images/beans-green.svg', beanHandful(C, C.greenBean, C.greenBeanDark, 0));
  write('images/beans-roasted.svg', beanHandful(C, C.roastMedium, C.roastDark, 0.15));
  write('images/beans-dark.svg', beansDark(C));
  for (const level of ['light', 'medium', 'medium-dark', 'dark']) write(`images/roast-${level}.svg`, roastLevel(C, level));
  write('images/bean-closeup.svg', beanCloseup(C));
  write('images/cups.svg', cups(C));
  write('images/pour-station.svg', pourStation(C));
  write('images/brew-pourover.svg', brewer(C, 'pourover'));
  write('images/brew-press.svg', brewer(C, 'press'));
  write('images/brew-espresso.svg', brewer(C, 'espresso'));
  write('images/brew-moka.svg', brewer(C, 'moka'));
  write('images/producer.svg', producer(C));
}

// ── Colours and helpers ──────────────────────────────────────────────
function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a, b, t) { const x = hex(a), y = hex(b); return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; }
function palette(t) {
  const k = (name) => t[`color.${name}`];
  return {
    espresso: k('espresso'), crema: k('crema'), cream: k('cream'), paper: k('paper'), text: k('text'),
    leaf: k('leaf'), leafDark: k('leaf-dark'), hill: k('hill'), sky: k('sky'),
    cherry: k('cherry'), cherryDark: k('cherry-dark'), unripe: k('cherry-unripe'), yellow: k('cherry-yellow'),
    pulp: k('pulp'), parchment: k('parchment'), greenBean: k('green-bean'), greenBeanDark: k('green-bean-dark'),
    roastLight: k('roast-light'), roastMedium: k('roast-medium'), roastMediumDark: k('roast-medium-dark'), roastDark: k('roast-dark'),
    jute: k('jute'), juteDark: k('jute-dark'), steel: k('steel'), steelDark: k('steel-dark'), copper: k('copper'),
    water: k('water'), wood: k('wood'), woodDark: k('wood-dark'), accent: t['color.accent'], primary: t['color.primary']
  };
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const f = (n) => Math.round(n * 10) / 10;
const open = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`;
const close = '</svg>\n';
const rect = (x, y, w, h, fill, extra = '') => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}"${extra}/>`;
const circle = (cx, cy, r, fill, extra = '') => `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${fill}"${extra}/>`;
const ellipse = (cx, cy, rx, ry, fill, extra = '') => `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${fill}"${extra}/>`;
const path = (d, fill, extra = '') => `<path d="${d}" fill="${fill}"${extra}/>`;
const line = (x1, y1, x2, y2, stroke, width, extra = '') => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"${extra}/>`;

// A coffee bean seen from its flat side: an oval and its centre cut, a soft S.
function bean(cx, cy, rx, ry, rot, fill, cut, sheen = 0) {
  const s = `M${f(-rx * 0.08)} ${f(-ry * 0.78)} C${f(rx * 0.34)} ${f(-ry * 0.3)} ${f(-rx * 0.34)} ${f(ry * 0.3)} ${f(rx * 0.08)} ${f(ry * 0.78)}`;
  const glow = sheen ? ellipse(-rx * 0.38, -ry * 0.35, rx * 0.22, ry * 0.28, '#FFFFFF', ` opacity="${sheen}"`) : '';
  return `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${f(rot)})">${ellipse(0, 0, rx, ry, fill)}${path(s, 'none', ` stroke="${cut}" stroke-width="${f(Math.max(1.5, rx * 0.12))}" stroke-linecap="round"`)}${glow}</g>`;
}
// A bean seen from its round back (in a pile): an oval with a light ridge.
function beanBack(cx, cy, rx, ry, rot, fill, shade) {
  return `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${f(rot)})">${ellipse(0, 0, rx, ry, fill)}${ellipse(rx * 0.12, ry * 0.12, rx * 0.8, ry * 0.75, shade, ' opacity=".45"')}</g>`;
}
function cherry(cx, cy, r, fill, dark) {
  return `${circle(cx, cy, r, fill)}${circle(cx + r * 0.18, cy + r * 0.18, r * 0.82, dark, ' opacity=".35"')}${circle(cx - r * 0.35, cy - r * 0.35, r * 0.22, '#FFFFFF', ' opacity=".35"')}${circle(cx + r * 0.05, cy + r * 0.62, r * 0.12, dark)}`;
}
function leafShape(x, y, len, width, angle, fill, vein) {
  const d = `M0 0 C${f(len * 0.3)} ${f(-width)} ${f(len * 0.75)} ${f(-width * 0.9)} ${f(len)} 0 C${f(len * 0.75)} ${f(width * 0.9)} ${f(len * 0.3)} ${f(width)} 0 0Z`;
  return `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(angle)})">${path(d, fill)}${line(len * 0.05, 0, len * 0.92, 0, vein, Math.max(1.5, width * 0.12), ' opacity=".55"')}</g>`;
}
// A pile of beans in an ellipse, back up, seeded.
function pile(random, cx, cy, w, h, n, colours, size = 14) {
  let out = '';
  const items = [];
  for (let i = 0; i < n; i++) {
    const a = random() * Math.PI * 2, d = Math.sqrt(random());
    items.push([cx + Math.cos(a) * d * w, cy + Math.sin(a) * d * h * (0.6 + 0.4 * random()), random()]);
  }
  items.sort((p, q) => p[1] - q[1]);
  for (const [x, y, r] of items) {
    const c = colours[Math.floor(r * colours.length)];
    out += beanBack(x, y, size * (0.9 + r * 0.25), size * 0.68 * (0.9 + r * 0.25), r * 180, c[0], c[1]);
  }
  return out;
}

// ── 1. The farm on a slope (cover, 1600 × 900): hills, shade trees, rows of shrubs; dark at the bottom
// and on the left, where the title sits. ────────────────────────────────
function farmSlope(C) {
  const random = rng(11);
  let s = open(1600, 900);
  s += rect(0, 0, 1600, 900, mix(C.sky, C.crema, 0.35));
  s += circle(1240, 230, 90, mix(C.crema, '#FFFFFF', 0.5), ' opacity=".8"');
  s += path('M0 420 C260 300 520 360 760 300 C1000 240 1260 330 1600 260 L1600 900 L0 900Z', mix(C.hill, C.sky, 0.45));
  s += path('M0 520 C300 420 640 500 900 430 C1160 360 1380 450 1600 400 L1600 900 L0 900Z', mix(C.hill, C.leafDark, 0.2));
  s += path('M0 640 C360 560 700 640 1000 580 C1260 530 1440 600 1600 570 L1600 900 L0 900Z', mix(C.leaf, C.leafDark, 0.35));
  // Shade trees on the middle hill.
  for (const [x, y, r] of [[1040, 400, 70], [1180, 380, 52], [1430, 420, 80], [760, 440, 46]]) {
    s += rect(x - 6, y, 12, 70, C.woodDark);
    s += circle(x, y - r * 0.2, r, mix(C.leafDark, C.hill, 0.25)) + circle(x - r * 0.6, y + r * 0.1, r * 0.7, mix(C.leafDark, C.hill, 0.35)) + circle(x + r * 0.6, y + r * 0.1, r * 0.7, mix(C.leafDark, C.hill, 0.15));
  }
  // Rows of coffee shrubs along the slope, nearer rows larger.
  for (let row = 0; row < 6; row++) {
    const y0 = 600 + row * 52, size = 22 + row * 9, step = size * 1.9;
    for (let x = -20 + (row % 2) * step / 2; x < 1640; x += step) {
      const y = y0 + Math.sin((x + row * 90) / 210) * 14;
      const dark = mix(C.leafDark, '#10190D', 0.15 + row * 0.08);
      s += ellipse(x, y, size, size * 0.8, dark) + ellipse(x - size * 0.3, y - size * 0.3, size * 0.6, size * 0.5, mix(C.leaf, C.leafDark, 0.3 + row * 0.08));
      for (let k = 0; k < 3 + row; k++) if (random() < 0.55) s += circle(x + (random() - 0.5) * size * 1.4, y + (random() - 0.3) * size, 3 + row * 0.9, random() < 0.7 ? C.cherry : C.cherryDark);
    }
  }
  // Shade over the bottom and the left, under the title.
  s += `<defs><linearGradient id="shade-left" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${C.espresso}" stop-opacity=".78"/><stop offset=".5" stop-color="${C.espresso}" stop-opacity=".35"/><stop offset=".75" stop-color="${C.espresso}" stop-opacity="0"/></linearGradient>`;
  s += `<linearGradient id="shade-low" x1="0" x2="0" y1="0" y2="1"><stop offset=".45" stop-color="${C.espresso}" stop-opacity="0"/><stop offset="1" stop-color="${C.espresso}" stop-opacity=".6"/></linearGradient></defs>`;
  s += rect(0, 0, 1600, 900, 'url(#shade-left)') + rect(0, 0, 1600, 900, 'url(#shade-low)');
  return s + close;
}

// ── 2. A cherry in cross-section, a whole one beside it (1000 × 720) ──────
function cherrySection(C) {
  const cx = 400, cy = 370, k = 300 / 330;
  let s = open(1000, 720);
  s += rect(0, 0, 1000, 720, C.paper);
  s += ellipse(cx, cy + 315, 250, 30, C.espresso, ' opacity=".08"') + ellipse(820, 600, 120, 20, C.espresso, ' opacity=".08"');
  // The whole cherry, on its stem.
  s += path('M820 360 C830 300 860 250 900 220', 'none', ` stroke="${C.woodDark}" stroke-width="12" stroke-linecap="round"`);
  s += leafShape(900, 220, 110, 34, -40, C.leaf, C.leafDark);
  s += cherry(820, 470, 130, C.cherry, C.cherryDark);
  // The cherry cut in half: skin, pulp, mucilage, then two seeds facing each other, flat sides together,
  // each in its parchment and silverskin.
  s += circle(cx, cy, 330 * k, C.cherry);
  s += circle(cx, cy, 316 * k, C.cherryDark, ' opacity=".25"');
  s += circle(cx, cy, 300 * k, C.pulp);
  s += circle(cx, cy, 238 * k, mix(C.pulp, C.yellow, 0.35), ' opacity=".9"');
  for (const side of [-1, 1]) {
    const bx = cx + side * 102 * k;
    s += ellipse(bx, cy, 112 * k, 192 * k, C.parchment);
    s += ellipse(bx, cy, 100 * k, 180 * k, mix(C.parchment, '#FFFFFF', 0.25));
    s += ellipse(bx, cy, 92 * k, 170 * k, mix(C.greenBean, C.parchment, 0.25));
    s += ellipse(bx, cy, 86 * k, 164 * k, C.greenBean);
    s += path(`M${f(bx + side * 64 * k)} ${f(cy - 120 * k)} C${f(bx + side * 30 * k)} ${f(cy - 40 * k)} ${f(bx + side * 70 * k)} ${f(cy + 40 * k)} ${f(bx + side * 64 * k)} ${f(cy + 120 * k)}`, 'none', ` stroke="${C.greenBeanDark}" stroke-width="6" stroke-linecap="round"`);
  }
  s += line(cx, cy - 175 * k, cx, cy + 175 * k, C.greenBeanDark, 5);
  s += circle(cx - 150 * k, cy - 220 * k, 34, '#FFFFFF', ' opacity=".2"');
  return s + close;
}

// ── 3. Altitude (1600 × 700): a mountain, arabica shrubs high on it and robusta low, in bands ────
function altitude(C) {
  const random = rng(23);
  const top = [900, 90], left = [0, 640], right = [1600, 600];
  const xLeft = (y) => left[0] + (top[0] - left[0]) * (left[1] - y) / (left[1] - top[1]);
  const xRight = (y) => top[0] + (right[0] - top[0]) * (y - top[1]) / (right[1] - top[1]);
  let s = open(1600, 700);
  s += rect(0, 0, 1600, 700, mix(C.sky, '#FFFFFF', 0.3));
  s += path('M700 700 L1150 210 Q1200 180 1250 210 L1600 470 L1600 700Z', mix(C.hill, C.sky, 0.55));
  s += path(`M0 700 L${left[0]} ${left[1]} L${top[0] - 40} ${top[1] + 20} Q${top[0]} ${top[1] - 10} ${top[0] + 40} ${top[1] + 20} L${right[0]} ${right[1]} L1600 700Z`, mix(C.hill, C.leafDark, 0.2));
  // The two bands of altitude across the mountain: high (arabica, cooler) and low (robusta, warmer).
  const band = (y0, y1, fill) => path(`M${f(xLeft(y0))} ${y0} L${f(xRight(y0))} ${y0} L${f(xRight(y1))} ${y1} L${f(xLeft(y1))} ${y1}Z`, fill);
  s += band(250, 430, mix(C.leafDark, C.hill, 0.35)) + band(480, 640, mix(C.yellow, C.hill, 0.55));
  s += path(`M${top[0] - 60} ${top[1] + 34} Q${top[0]} ${top[1] - 10} ${top[0] + 60} ${top[1] + 34} Q${top[0]} ${top[1] + 50} ${top[0] - 60} ${top[1] + 34}Z`, '#FFFFFF', ' opacity=".75"');
  for (let y = 275; y < 425; y += 34) for (let x = xLeft(y) + 30; x < xRight(y) - 30; x += 52) {
    if (random() < 0.22) continue;
    const jx = x + (random() - 0.5) * 22;
    s += ellipse(jx, y, 15, 20, mix(C.leafDark, '#0E170B', 0.2)) + circle(jx + 4, y - 2, 3.5, C.cherry);
  }
  for (let y = 505; y < 640; y += 32) for (let x = xLeft(y) + 30; x < xRight(y) - 30; x += 60) {
    if (random() < 0.22) continue;
    const jx = x + (random() - 0.5) * 22;
    s += ellipse(jx, y, 24, 15, mix(C.leaf, C.hill, 0.2)) + circle(jx - 6, y, 3.5, C.cherryDark) + circle(jx + 7, y + 3, 3.5, C.cherryDark);
  }
  for (let i = 0; i < 3; i++) { const x = 220 + i * 520 + random() * 80, y = 80 + random() * 50; s += ellipse(x, y, 90, 26, '#FFFFFF', ' opacity=".8"') + ellipse(x + 50, y - 14, 60, 22, '#FFFFFF', ' opacity=".8"'); }
  return s + close;
}

// ── 4. A ripening branch (1000 × 640) ─────────────────────────────────
function branch(C) {
  let s = open(1000, 640);
  s += rect(0, 0, 1000, 640, C.paper);
  s += path('M40 330 C240 300 520 340 960 290', 'none', ` stroke="${C.woodDark}" stroke-width="18" stroke-linecap="round"`);
  const colours = [[C.unripe, mix(C.unripe, C.leafDark, 0.5)], [C.yellow, mix(C.yellow, C.cherryDark, 0.4)], [C.cherry, C.cherryDark], [C.cherryDark, '#3A0E12']];
  const nodes = [130, 300, 470, 640, 810];
  nodes.forEach((x, n) => {
    const y = 330 - (x / 1000) * 30 + Math.sin(x / 120) * 6;
    s += leafShape(x, y - 6, 190, 52, -62 - n * 4, C.leaf, C.leafDark) + leafShape(x, y + 6, 180, 48, 58 + n * 3, mix(C.leaf, C.leafDark, 0.25), C.leafDark);
    // Ripeness grows along the branch, one cherry in three a stage behind its neighbours.
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const c = colours[Math.max(0, Math.min(3, Math.round(n * 0.75) - (k % 3 === 0 ? 1 : 0)))];
      s += cherry(x + Math.cos(a) * 30, y + Math.sin(a) * 22, 22, c[0], c[1]);
    }
  });
  return s + close;
}

// ── 5. From tree to sack, one picture per step (800 × 600) ────────────
function scene(C, inner) { return open(800, 600) + rect(0, 0, 800, 600, mix(C.paper, C.sky, 0.25)) + rect(0, 470, 800, 130, mix(C.paper, C.wood, 0.18)) + inner + close; }
function stepPick(C) {
  const random = rng(5);
  let s = '';
  s += path('M80 120 C260 100 400 160 560 130', 'none', ` stroke="${C.woodDark}" stroke-width="14" stroke-linecap="round"`);
  for (const x of [140, 300, 460]) s += leafShape(x, 120, 150, 40, -50, C.leaf, C.leafDark) + leafShape(x, 128, 140, 38, 40, mix(C.leaf, C.leafDark, 0.3), C.leafDark) + cherry(x + 20, 160, 18, C.cherry, C.cherryDark) + cherry(x - 14, 168, 18, C.cherry, C.cherryDark) + cherry(x + 4, 192, 18, C.unripe, mix(C.unripe, C.leafDark, 0.5));
  // A hand reaching for a ripe cherry.
  s += path('M600 300 C560 250 520 220 470 205 C455 200 445 214 458 224 L500 250 C470 248 440 254 430 268 C424 280 436 290 450 286 L520 280 L640 360Z', '#C99472');
  // The basket, full of red cherries.
  s += path('M220 360 L580 360 L540 520 L260 520Z', C.jute) + path('M220 360 L580 360 L572 392 L228 392Z', C.juteDark);
  for (let i = 0; i < 26; i++) s += cherry(250 + random() * 300, 330 + random() * 36, 16, random() < 0.85 ? C.cherry : C.cherryDark, C.cherryDark);
  for (let y = 410; y < 520; y += 22) s += line(240 + (y - 400) * 0.25, y, 560 - (y - 400) * 0.25, y, C.juteDark, 3, ' opacity=".6"');
  return scene(C, s);
}
function stepFloat(C) {
  const random = rng(7);
  let s = rect(140, 200, 520, 300, mix(C.steel, C.paper, 0.3)) + rect(160, 240, 480, 245, C.water, ' opacity=".8"');
  s += rect(160, 240, 480, 10, '#FFFFFF', ' opacity=".5"');
  for (let i = 0; i < 9; i++) s += cherry(190 + random() * 420, 246 + random() * 8, 15, random() < 0.5 ? C.yellow : C.unripe, C.leafDark); // light ones float
  for (let i = 0; i < 24; i++) s += cherry(190 + random() * 420, 430 + random() * 40, 15, C.cherry, C.cherryDark); // ripe ones sink
  s += path('M440 140 C480 170 500 200 500 230', 'none', ` stroke="${C.steelDark}" stroke-width="10" stroke-linecap="round"`) + path('M520 230 C510 260 500 290 495 340', 'none', ` stroke="${C.water}" stroke-width="12" stroke-linecap="round" opacity=".7"`);
  return scene(C, s);
}
function stepPulp(C) {
  const random = rng(9);
  let s = path('M180 150 L420 150 L370 250 L230 250Z', C.steel) + rect(210, 250, 180, 160, C.steelDark, ' rx="16"');
  s += circle(300, 330, 60, C.steel) + circle(300, 330, 18, C.steelDark);
  for (let i = 0; i < 14; i++) s += cherry(220 + random() * 160, 130 + random() * 30, 16, C.cherry, C.cherryDark);
  // Skins to the left, seeds in mucilage to the right.
  s += path('M210 400 L120 470 L200 470Z', C.steelDark);
  for (let i = 0; i < 10; i++) s += path(`M${f(110 + random() * 120)} ${f(470 + random() * 30)} q14 -12 28 0 q-14 8 -28 0Z`, C.cherryDark);
  s += path('M390 380 L560 450 L540 470 L380 410Z', C.steelDark);
  for (let i = 0; i < 18; i++) s += bean(520 + random() * 180, 470 + random() * 50, 14, 20, random() * 180, mix(C.parchment, C.yellow, 0.3), mix(C.parchment, C.wood, 0.4), 0.2);
  return scene(C, s);
}
function stepDry(C) {
  const random = rng(13);
  let s = circle(650, 110, 54, C.yellow, ' opacity=".9"');
  for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2; s += line(650 + Math.cos(a) * 70, 110 + Math.sin(a) * 70, 650 + Math.cos(a) * 92, 110 + Math.sin(a) * 92, C.yellow, 6); }
  s += path('M100 300 L700 300 L660 360 L140 360Z', C.jute) + rect(140, 360, 520, 12, C.woodDark);
  for (const x of [160, 400, 640]) s += rect(x - 6, 372, 12, 110, C.woodDark);
  for (let i = 0; i < 70; i++) s += bean(140 + random() * 520, 300 + random() * 56, 9, 13, random() * 180, mix(C.parchment, C.yellow, 0.2), mix(C.parchment, C.wood, 0.4));
  return scene(C, s);
}
function stepHull(C) {
  const random = rng(17);
  let s = '';
  for (let i = 0; i < 22; i++) s += bean(130 + random() * 200, 300 + random() * 160, 18, 26, random() * 180, C.parchment, mix(C.parchment, C.wood, 0.4));
  s += path('M370 380 L450 380 L450 350 L500 400 L450 450 L450 420 L370 420Z', C.primary);
  for (let i = 0; i < 22; i++) s += bean(560 + random() * 180, 300 + random() * 160, 16, 23, random() * 180, C.greenBean, C.greenBeanDark);
  for (let i = 0; i < 12; i++) s += path(`M${f(520 + random() * 240)} ${f(470 + random() * 40)} q10 -8 20 0 q-10 6 -20 0Z`, mix(C.parchment, '#FFFFFF', 0.3));
  return scene(C, s);
}

// ── 6. Drying beds (band, 2400 × 800) ─────────────────────────────────
function dryingBeds(C) {
  const random = rng(19);
  let s = open(2400, 800) + rect(0, 0, 2400, 800, mix(C.sky, C.crema, 0.3));
  s += path('M0 330 C500 250 900 310 1300 260 C1700 210 2100 290 2400 250 L2400 800 L0 800Z', mix(C.hill, C.sky, 0.35));
  s += path('M0 420 C600 360 1200 420 1800 370 C2050 350 2250 380 2400 370 L2400 800 L0 800Z', mix(C.hill, C.leaf, 0.4));
  // Raised beds in perspective, rows coming closer.
  for (let row = 0; row < 4; row++) {
    const y = 440 + row * 85, h = 26 + row * 14, legs = 30 + row * 12;
    for (let x = -100 + row * 60; x < 2500; x += 520 - row * 40) {
      const w = 400 - row * 20;
      s += rect(x, y, w, h, mix(C.cherryDark, C.wood, 0.3 + row * 0.1));
      for (let k = 0; k < 18 + row * 6; k++) s += circle(x + random() * w, y + random() * h * 0.6, 3 + row * 1.6, random() < 0.6 ? C.cherryDark : mix(C.cherryDark, C.wood, 0.5));
      s += rect(x + 10, y + h, 8 + row * 2, legs, C.woodDark) + rect(x + w - 20, y + h, 8 + row * 2, legs, C.woodDark);
    }
  }
  return s + close;
}

// ── 7. What each process leaves on the bean before hulling (600 × 450) ───
function dryProcess(C, kind) {
  const random = rng(kind === 'washed' ? 29 : kind === 'honey' ? 31 : 37);
  let s = open(600, 450) + rect(0, 0, 600, 450, mix(C.jute, C.paper, 0.55));
  for (let y = 0; y < 450; y += 12) s += line(0, y, 600, y, C.juteDark, 1.5, ' opacity=".25"');
  for (let i = 0; i < 46; i++) {
    const x = 30 + random() * 540, y = 30 + random() * 390, r = random() * 180;
    if (kind === 'washed') s += bean(x, y, 22, 31, r, mix(C.parchment, '#FFFFFF', 0.2), mix(C.parchment, C.wood, 0.35));
    if (kind === 'honey') s += bean(x, y, 22, 31, r, mix(C.yellow, C.cherryDark, 0.25 + random() * 0.2), mix(C.cherryDark, C.wood, 0.3), 0.25);
    if (kind === 'natural') s += `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(r)})">${ellipse(0, 0, 26, 24, mix(C.cherryDark, '#2A0C0E', 0.4))}${path('M-18 -6 q10 6 20 -2 q8 8 14 2', 'none', ` stroke="#1C0709" stroke-width="3" opacity=".7"`)}${circle(-8, -9, 5, '#FFFFFF', ' opacity=".12"')}</g>`;
  }
  return s + close;
}

// ── 8. A port: sacks stacked, a ship behind (band, 1600 × 600), dark for the title ───────────────
function portSacks(C) {
  let s = open(1600, 600) + rect(0, 0, 1600, 600, mix(C.steelDark, C.espresso, 0.5));
  s += rect(0, 300, 1600, 300, mix(C.water, C.steelDark, 0.6));
  s += path('M820 300 L1500 300 L1460 360 L860 360Z', mix(C.accent, C.espresso, 0.45));
  for (let i = 0; i < 6; i++) s += rect(880 + i * 96, 210, 88, 90, [mix(C.copper, C.espresso, 0.3), mix(C.leaf, C.espresso, 0.4), mix(C.water, C.espresso, 0.4)][i % 3]);
  s += rect(1370, 140, 60, 70, mix(C.paper, C.steelDark, 0.4));
  s += line(300, 40, 300, 330, C.steel, 10) + line(300, 60, 760, 60, C.steel, 8) + line(700, 60, 700, 200, C.steel, 3);
  // Sacks in the foreground.
  for (let row = 0; row < 3; row++) for (let i = 0; i < 9; i++) {
    const x = -40 + i * 130 + (row % 2) * 65, y = 600 - (row + 1) * 78;
    s += path(`M${x} ${y + 70} C${x - 6} ${y + 20} ${x + 10} ${y} ${x + 60} ${y} C${x + 110} ${y} ${x + 126} ${y + 20} ${x + 120} ${y + 70}Z`, mix(C.jute, C.espresso, 0.35 + row * 0.08));
    s += line(x + 20, y + 30, x + 100, y + 30, mix(C.juteDark, C.espresso, 0.4), 4, ' opacity=".7"');
  }
  return s + close;
}

// ── 9. A grader's tray (1000 × 700), with four defects ──────────────────
function gradingTray(C) {
  const random = rng(41);
  let s = open(1000, 700) + rect(0, 0, 1000, 700, C.paper);
  s += rect(60, 50, 880, 600, C.steelDark, ' rx="26"') + rect(80, 70, 840, 560, mix(C.steel, '#FFFFFF', 0.55), ' rx="18"');
  const keep = Object.values(TRAY).map(([x, y]) => [x * 1000, y * 700]);
  for (let i = 0; i < 110; i++) {
    const x = 110 + random() * 780, y = 100 + random() * 500;
    if (keep.some(([kx, ky]) => Math.hypot(kx - x, ky - y) < 60)) continue;
    s += bean(x, y, 17, 24, random() * 180, mix(C.greenBean, C.parchment, random() * 0.3), C.greenBeanDark);
  }
  const [bx, by] = [TRAY.black[0] * 1000, TRAY.black[1] * 700];
  s += bean(bx, by, 18, 25, 30, '#1E1A17', '#000000');
  const [kx, ky] = [TRAY.broken[0] * 1000, TRAY.broken[1] * 700];
  s += `<g transform="translate(${kx} ${ky}) rotate(-20)">${path('M-17 -4 C-17 -20 -6 -25 4 -25 C14 -25 17 -12 17 -4 L8 2 L0 -6 L-8 3Z', C.greenBean)}</g>`;
  s += `<g transform="translate(${kx + 22} ${ky + 22}) rotate(-10)">${path('M-15 6 L-6 -2 L2 6 L10 -2 L15 4 C15 18 6 24 -2 24 C-10 24 -15 16 -15 6Z', C.greenBean)}</g>`;
  const [ix, iy] = [TRAY.insect[0] * 1000, TRAY.insect[1] * 700];
  s += bean(ix, iy, 18, 25, -40, C.greenBean, C.greenBeanDark) + circle(ix - 6, iy - 8, 3.5, '#2A2017') + circle(ix + 5, iy + 6, 3, '#2A2017') + circle(ix + 7, iy - 10, 2.5, '#2A2017');
  const [sx, sy] = [TRAY.stone[0] * 1000, TRAY.stone[1] * 700];
  s += path(`M${sx - 22} ${sy + 6} C${sx - 24} ${sy - 14} ${sx - 4} ${sy - 22} ${sx + 12} ${sy - 16} C${sx + 26} ${sy - 10} ${sx + 24} ${sy + 12} ${sx + 8} ${sy + 18} C${sx - 6} ${sy + 22} ${sx - 20} ${sy + 18} ${sx - 22} ${sy + 6}Z`, '#8A8582') + circle(sx - 4, sy - 8, 5, '#FFFFFF', ' opacity=".2"');
  return s + close;
}

// ── 10. One bean on a card (400 × 400): a healthy flat bean, a black bean, a peaberry ─────────────
function singleBean(C, kind) {
  let s = open(400, 400) + rect(0, 0, 400, 400, C.paper) + ellipse(200, 320, 110, 18, C.espresso, ' opacity=".08"');
  if (kind === 'healthy') s += bean(200, 190, 88, 124, 18, C.greenBean, C.greenBeanDark, 0.12);
  if (kind === 'black') s += bean(200, 190, 84, 118, -14, '#221C18', '#050403', 0.06);
  if (kind === 'peaberry') s += `<g transform="translate(200 190) rotate(10)">${ellipse(0, 0, 92, 112, C.greenBean)}${path('M-8 -88 C30 -40 -30 40 8 88', 'none', ` stroke="${C.greenBeanDark}" stroke-width="10" stroke-linecap="round"`)}${ellipse(-34, -40, 22, 30, '#FFFFFF', ' opacity=".14"')}</g>`;
  return s + close;
}

// ── 11. Green beans in a scoop, over an open sack (900 × 900) ──────────
function greenScoop(C) {
  const random = rng(43);
  let s = open(900, 900) + rect(0, 0, 900, 900, mix(C.jute, C.paper, 0.4));
  for (let y = 0; y < 900; y += 14) s += line(0, y, 900, y, C.juteDark, 2, ' opacity=".22"');
  for (let x = 0; x < 900; x += 14) s += line(x, 0, x, 900, C.juteDark, 2, ' opacity=".14"');
  s += ellipse(450, 640, 380, 200, mix(C.juteDark, C.espresso, 0.2));
  s += pile(random, 450, 620, 330, 150, 260, [[C.greenBean, C.greenBeanDark], [mix(C.greenBean, C.parchment, 0.3), C.greenBeanDark]], 22);
  s += path('M120 300 C120 220 240 160 420 160 C600 160 700 220 700 300 L660 420 C600 470 240 470 160 420Z', C.steel) + path('M700 260 L860 200 L880 240 L712 320Z', C.steelDark);
  s += pile(random, 410, 300, 240, 60, 90, [[C.greenBean, C.greenBeanDark]], 22);
  return s + close;
}

// ── 12. The shipment in pictures: a stack of sacks (600 × 900), a ship (1200 × 600), a warehouse (800 × 800) ─────
function sack(C, x, y, w, h, tone) {
  return path(`M${x} ${y + h} C${x - w * 0.05} ${y + h * 0.3} ${x + w * 0.08} ${y} ${x + w * 0.5} ${y} C${x + w * 0.92} ${y} ${x + w * 1.05} ${y + h * 0.3} ${x + w} ${y + h}Z`, tone) + line(x + w * 0.2, y + h * 0.45, x + w * 0.8, y + h * 0.45, C.juteDark, 4, ' opacity=".6"') + line(x + w * 0.3, y + h * 0.62, x + w * 0.7, y + h * 0.62, C.juteDark, 4, ' opacity=".45"');
}
function sacksStack(C) {
  let s = open(600, 900) + rect(0, 0, 600, 900, mix(C.paper, C.steel, 0.2)) + rect(0, 780, 600, 120, mix(C.wood, C.paper, 0.4));
  for (let row = 0; row < 7; row++) for (let i = 0; i < 3; i++) s += sack(C, 50 + i * 170 + (row % 2) * 20, 700 - row * 100, 160, 110, mix(C.jute, C.juteDark, ((row + i) % 3) * 0.25));
  return s + close;
}
function ship(C) {
  let s = open(1200, 600) + rect(0, 0, 1200, 600, mix(C.sky, '#FFFFFF', 0.2)) + rect(0, 380, 1200, 220, C.water);
  for (let y = 400; y < 600; y += 30) s += path(`M0 ${y} q60 -10 120 0 t120 0 t120 0 t120 0 t120 0 t120 0 t120 0 t120 0 t120 0 t120 0`, 'none', ` stroke="#FFFFFF" stroke-width="3" opacity=".35"`);
  s += path('M120 360 L1080 360 L1010 450 L190 450Z', mix(C.accent, C.espresso, 0.25));
  const tones = [C.copper, C.leaf, C.water, C.yellow, C.primary];
  for (let row = 0; row < 3; row++) for (let i = 0; i < 9; i++) s += rect(200 + i * 82, 300 - row * 56, 78, 54, mix(tones[(i + row * 2) % 5], C.paper, 0.15));
  s += rect(930, 170, 110, 190, C.paper) + rect(950, 190, 70, 20, C.steelDark) + rect(970, 120, 26, 50, mix(C.accent, C.espresso, 0.25));
  return s + close;
}
function warehouse(C) {
  let s = open(800, 800) + rect(0, 0, 800, 800, mix(C.paper, C.steel, 0.25));
  s += path('M0 120 L400 20 L800 120 L800 160 L0 160Z', C.steelDark) + rect(0, 640, 800, 160, mix(C.wood, C.paper, 0.35));
  for (const [x, w] of [[60, 300], [440, 300]]) {
    for (let row = 0; row < 4; row++) for (let i = 0; i < 3; i++) s += sack(C, x + i * 98 + (row % 2) * 10, 560 - row * 80, 92, 88, mix(C.jute, C.juteDark, ((row * 3 + i) % 4) * 0.2));
    s += rect(x - 10, 640, w + 20, 18, C.woodDark);
  }
  for (let x = 40; x < 800; x += 120) s += rect(x, 180, 70, 30, '#FFFFFF', ' opacity=".5"');
  return s + close;
}

// ── 13. A drum roaster's window, beans tumbling (1200 × 900) ────────────
function roasterWindow(C) {
  const random = rng(47);
  let s = open(1200, 900) + rect(0, 0, 1200, 900, mix(C.espresso, C.steelDark, 0.3));
  s += circle(600, 450, 380, C.steelDark) + circle(600, 450, 350, C.steel) + circle(600, 450, 320, '#2A1A12');
  s += circle(600, 450, 300, mix(C.copper, C.espresso, 0.5), ' opacity=".5"');
  s += pile(random, 600, 600, 270, 130, 260, [[C.roastMedium, C.roastDark], [C.roastLight, C.roastMedium], [C.roastMediumDark, C.roastDark]], 20);
  for (let i = 0; i < 40; i++) { const a = -Math.PI * (0.15 + random() * 0.7), d = 120 + random() * 160; s += beanBack(600 + Math.cos(a) * d, 470 + Math.sin(a) * d * 0.9, 18, 12, random() * 180, C.roastMedium, C.roastDark); }
  s += path('M380 260 C460 200 560 180 640 190', 'none', ' stroke="#FFFFFF" stroke-width="18" stroke-linecap="round" opacity=".12"');
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; s += circle(600 + Math.cos(a) * 365, 450 + Math.sin(a) * 365, 9, C.steelDark); }
  return s + close;
}

// ── 14. A roaster in section (1400 × 1000): hopper, drum, burner, cooling tray ───────────────────
function roasterDiagram(C) {
  const random = rng(53);
  const R = (r) => ({ x: r.x * 1400, y: r.y * 1000, w: r.w * 1400, h: r.h * 1000 });
  const hop = R(ROASTER.hopper), drum = R(ROASTER.drum), burn = R(ROASTER.burner), cool = R(ROASTER.cooling);
  let s = open(1400, 1000) + rect(0, 0, 1400, 1000, C.paper) + rect(0, 900, 1400, 100, mix(C.paper, C.wood, 0.2));
  // Body.
  s += rect(drum.x - 30, drum.y - 20, drum.w + 60, burn.y + burn.h - drum.y + 40, mix(C.accent, C.espresso, 0.15), ' rx="28"');
  s += rect(drum.x + 30, burn.y + burn.h + 20, 40, 900 - burn.y - burn.h - 20, C.steelDark) + rect(drum.x + drum.w - 70, burn.y + burn.h + 20, 40, 900 - burn.y - burn.h - 20, C.steelDark);
  // Hopper.
  s += path(`M${hop.x} ${hop.y} L${hop.x + hop.w} ${hop.y} L${hop.x + hop.w * 0.65} ${hop.y + hop.h} L${hop.x + hop.w * 0.35} ${hop.y + hop.h}Z`, C.steel);
  s += pile(random, hop.x + hop.w / 2, hop.y + hop.h * 0.25, hop.w * 0.36, hop.h * 0.15, 40, [[C.greenBean, C.greenBeanDark]], 10);
  s += rect(hop.x + hop.w * 0.38, hop.y + hop.h, hop.w * 0.24, drum.y - hop.y - hop.h + 10, C.steelDark);
  // Drum in section, beans inside.
  s += rect(drum.x, drum.y, drum.w, drum.h, '#2A1A12', ' rx="20"') + rect(drum.x + 14, drum.y + 14, drum.w - 28, drum.h - 28, mix(C.copper, C.espresso, 0.6), ' rx="14"');
  s += pile(random, drum.x + drum.w / 2, drum.y + drum.h * 0.72, drum.w * 0.4, drum.h * 0.15, 110, [[C.roastLight, C.roastMedium], [C.roastMedium, C.roastDark]], 12);
  for (const k of [0.25, 0.5, 0.75]) s += line(drum.x + drum.w * k, drum.y + 20, drum.x + drum.w * k - 30, drum.y + drum.h * 0.45, C.steel, 6, ' opacity=".7"');
  // Burner and flames.
  s += rect(burn.x, burn.y + burn.h * 0.55, burn.w, burn.h * 0.35, C.steelDark, ' rx="8"');
  for (let i = 0; i < 9; i++) { const x = burn.x + 24 + i * (burn.w - 48) / 8, y = burn.y + burn.h * 0.55; s += path(`M${f(x - 12)} ${f(y)} C${f(x - 12)} ${f(y - 30)} ${f(x)} ${f(y - 46)} ${f(x)} ${f(y - 64)} C${f(x + 6)} ${f(y - 40)} ${f(x + 14)} ${f(y - 28)} ${f(x + 12)} ${f(y)}Z`, i % 2 ? C.yellow : C.accent); }
  // Chimney and chaff cyclone.
  s += rect(drum.x + drum.w - 40, 60, 46, drum.y - 60, C.steelDark) + path(`M${drum.x + drum.w + 40} 60 L${drum.x + drum.w + 200} 60 L${drum.x + drum.w + 150} 260 L${drum.x + drum.w + 90} 260Z`, C.steel) + rect(drum.x + drum.w, 70, 60, 30, C.steelDark);
  // Door, chute and cooling tray with its arm.
  s += path(`M${drum.x + drum.w} ${drum.y + drum.h * 0.6} L${cool.x + 30} ${cool.y + 20} L${cool.x + 60} ${cool.y + 50} L${drum.x + drum.w} ${drum.y + drum.h * 0.85}Z`, C.steelDark);
  s += ellipse(cool.x + cool.w / 2, cool.y + cool.h * 0.55, cool.w / 2, cool.h * 0.36, C.steel) + ellipse(cool.x + cool.w / 2, cool.y + cool.h * 0.5, cool.w / 2 - 18, cool.h * 0.3, mix(C.steel, C.paper, 0.3));
  s += pile(random, cool.x + cool.w / 2, cool.y + cool.h * 0.5, cool.w * 0.4, cool.h * 0.22, 140, [[C.roastMedium, C.roastDark]], 11);
  s += line(cool.x + cool.w / 2, cool.y + cool.h * 0.5, cool.x + cool.w * 0.85, cool.y + cool.h * 0.3, C.steelDark, 10) + circle(cool.x + cool.w / 2, cool.y + cool.h * 0.5, 16, C.steelDark);
  s += rect(cool.x + cool.w * 0.3, cool.y + cool.h * 0.85, 30, 900 - cool.y - cool.h * 0.85, C.steelDark) + rect(cool.x + cool.w * 0.65, cool.y + cool.h * 0.85, 30, 900 - cool.y - cool.h * 0.85, C.steelDark);
  return s + close;
}

// ── 15. A roast curve in layers (1200 × 800): the axes, then each phase's part of the curve ───────
function roastCurve(C) {
  const W = 1200, H = 800, x0 = 120, y0 = 700, x1 = 1140, y1 = 70;
  const X = (t) => x0 + (t / 12) * (x1 - x0); // minutes
  const Y = (c) => y0 - ((c - 20) / 220) * (y0 - y1); // °C
  // Bean temperature: falls after charge, then rises; first crack about 196 °C at 9 min, drop at 11 min.
  const temp = (t) => t < 1.5 ? 200 - (200 - 95) * Math.sin((t / 1.5) * Math.PI / 2) : 95 + (218 - 95) * (1 - Math.exp(-(t - 1.5) / 4.6)) / (1 - Math.exp(-9.5 / 4.6));
  const curve = (a, b) => { let d = ''; for (let t = a; t <= b + 1e-9; t += 0.05) d += `${d ? 'L' : 'M'}${f(X(t))} ${f(Y(temp(t)))}`; return d; };
  const band = (a, b, fill) => rect(X(a), y1, X(b) - X(a), y0 - y1, fill, ' opacity=".55"');
  let axes = open(W, H) + rect(0, 0, W, H, C.paper);
  for (let c = 40; c <= 240; c += 40) axes += line(x0, Y(c), x1, Y(c), C.steel, 1.5, ' opacity=".45"');
  for (let t = 1; t <= 12; t++) axes += line(X(t), y0, X(t), y0 + 12, C.steelDark, 3);
  axes += line(x0, y0, x1 + 20, y0, C.espresso, 4) + line(x0, y0, x0, y1 - 20, C.espresso, 4);
  axes += path(`M${x1 + 30} ${y0} l-18 -10 v20Z`, C.espresso) + path(`M${x0} ${y1 - 30} l-10 18 h20Z`, C.espresso);
  axes += close;
  const stroke = (d, colour) => path(d, 'none', ` stroke="${colour}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"`);
  const layer = (inner) => open(W, H) + inner + close;
  const tCrack = 9, tDrop = 11;
  return {
    axes,
    drying: layer(band(1.5, 4.5, mix(C.yellow, C.paper, 0.55)) + stroke(curve(0, 4.5), C.greenBeanDark) + circle(X(0), Y(temp(0)), 12, C.greenBeanDark)),
    browning: layer(band(4.5, tCrack, mix(C.roastLight, C.paper, 0.6)) + stroke(curve(4.5, tCrack), C.roastLight)),
    crack: layer(stroke(curve(tCrack, 10), C.roastMedium) + (() => { let b = ''; for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; b += line(X(tCrack) + Math.cos(a) * 22, Y(temp(tCrack)) + Math.sin(a) * 22, X(tCrack) + Math.cos(a) * 40, Y(temp(tCrack)) + Math.sin(a) * 40, C.accent, 6); } return b + circle(X(tCrack), Y(temp(tCrack)), 13, C.accent); })()),
    drop: layer(band(tCrack, tDrop, mix(C.roastMedium, C.paper, 0.75)) + stroke(curve(10, tDrop), C.roastDark) + line(X(tDrop), Y(temp(tDrop)) + 20, X(tDrop), y0 - 30, C.roastDark, 6, ' stroke-dasharray="4 14"') + path(`M${f(X(tDrop))} ${y0 - 10} l-16 -26 h32Z`, C.roastDark) + circle(X(tDrop), Y(temp(tDrop)), 13, C.roastDark))
  };
}

// ── 16. Green and roasted beans, the same handful (900 × 600) ───────────
function beanHandful(C, fill, cut, sheen) {
  const random = rng(59); // the same seed: the same beans, in the same places
  let s = open(900, 600) + rect(0, 0, 900, 600, C.paper);
  const scale = fill === C.greenBean ? 1 : 1.12; // roasted beans swell
  for (let i = 0; i < 34; i++) {
    const x = 90 + random() * 720, y = 80 + random() * 440, r = random() * 180, k = 0.85 + random() * 0.3;
    s += bean(x, y, 30 * k * scale, 42 * k * scale, r, fill, cut, sheen);
  }
  return s + close;
}

// ── 17. Dark roasted beans, edge to edge (1600 × 900), for text over them ───────────────────────
function beansDark(C) {
  const random = rng(61);
  let s = open(1600, 900) + rect(0, 0, 1600, 900, '#1E120D');
  for (let i = 0; i < 900; i++) {
    const x = random() * 1640 - 20, y = random() * 940 - 20, r = random() * 180, k = 0.8 + random() * 0.5;
    const tone = [C.roastDark, C.roastMediumDark, mix(C.roastDark, '#000000', 0.3)][Math.floor(random() * 3)];
    s += beanBack(x, y, 34 * k, 23 * k, r, tone, '#000000');
    if (random() < 0.3) s += ellipse(x - 8, y - 6, 8 * k, 4 * k, '#FFFFFF', ' opacity=".12"');
  }
  return s + close;
}

// ── 18. Roast levels (800 × 600): the same pile, roasted further ───────
function roastLevel(C, level) {
  const random = rng(67);
  const tones = { light: [C.roastLight, mix(C.roastLight, C.roastMedium, 0.6)], medium: [C.roastMedium, C.roastMediumDark], 'medium-dark': [C.roastMediumDark, C.roastDark], dark: [C.roastDark, '#120A07'] }[level];
  const sheen = { light: 0, medium: 0.05, 'medium-dark': 0.16, dark: 0.32 }[level];
  let s = open(800, 600) + rect(0, 0, 800, 600, C.paper) + ellipse(400, 470, 330, 70, C.espresso, ' opacity=".08"');
  const items = [];
  for (let i = 0; i < 70; i++) { const a = random() * Math.PI * 2, d = Math.sqrt(random()); items.push([400 + Math.cos(a) * d * 290, 360 + Math.sin(a) * d * 120 - (1 - d) * 90, random()]); }
  items.sort((p, q) => p[1] - q[1]);
  for (const [x, y, r] of items) s += bean(x, y, 26, 36, r * 180, r < 0.5 ? tones[0] : mix(tones[0], tones[1], 0.4), tones[1], sheen);
  return s + close;
}

// ── 19. A roasted bean up close (900 × 700) ───────────────────────────
function beanCloseup(C) {
  const W = 900, H = 700, cx = 450, cy = 350;
  let s = open(W, H) + rect(0, 0, W, H, C.paper) + ellipse(cx + 20, cy + 240, 300, 40, C.espresso, ' opacity=".1"');
  s += `<g transform="translate(${cx} ${cy}) rotate(-12)">`;
  s += ellipse(0, 0, 230, 290, C.roastMedium) + ellipse(30, 30, 200, 250, C.roastMediumDark, ' opacity=".45"');
  s += path('M-10 -230 C90 -90 -90 90 10 230', 'none', ` stroke="${C.roastDark}" stroke-width="30" stroke-linecap="round"`);
  s += path('M-4 -160 C40 -80 -30 50 6 140', 'none', ` stroke="${mix(C.parchment, '#FFFFFF', 0.2)}" stroke-width="9" stroke-linecap="round" stroke-dasharray="26 18"`); // chaff in the cut
  s += `</g>`;
  for (const [x, y, r] of [[CLOSEUP.oil[0] * W, CLOSEUP.oil[1] * H, 16], [CLOSEUP.oil[0] * W + 30, CLOSEUP.oil[1] * H + 40, 10], [CLOSEUP.oil[0] * W - 24, CLOSEUP.oil[1] * H + 56, 8]]) s += ellipse(x, y, r * 1.4, r, '#FFFFFF', ' opacity=".45"');
  return s + close;
}

// ── 20. Three cups on a counter, light to dark (1600 × 900), for text over them ─────────────────
function cups(C) {
  let s = open(1600, 900) + rect(0, 0, 1600, 900, mix(C.espresso, '#000000', 0.25)) + rect(0, 700, 1600, 200, C.woodDark);
  for (let y = 720; y < 900; y += 40) s += line(0, y, 1600, y + 6, '#000000', 3, ' opacity=".2"');
  const brews = [mix(C.roastLight, C.cherryDark, 0.25), C.roastMediumDark, '#1A0D08'];
  [300, 800, 1300].forEach((x, i) => {
    const y = 140; // everything lower by this much than a cup drawn at the counter's edge
    s += ellipse(x, 640 + y, 170, 28, '#000000', ' opacity=".3"') + ellipse(x, 632 + y, 160, 25, C.cream);
    s += path(`M${x - 110} ${480 + y} L${x + 110} ${480 + y} C${x + 106} ${572 + y} ${x + 68} ${614 + y} ${x} ${616 + y} C${x - 68} ${614 + y} ${x - 106} ${572 + y} ${x - 110} ${480 + y}Z`, C.cream);
    s += path(`M${x + 108} ${505 + y} C${x + 160} ${505 + y} ${x + 160} ${572 + y} ${x + 95} ${572 + y}`, 'none', ` stroke="${C.cream}" stroke-width="17"`);
    s += ellipse(x, 482 + y, 108, 22, brews[i]) + ellipse(x - 26, 477 + y, 34, 7, '#FFFFFF', ' opacity=".12"');
  });
  s += rect(0, 0, 1600, 900, '#000000', ' opacity=".2"');
  return s + close;
}

// ── 21. A pour-over station (1400 × 900): grinder, dripper on a carafe on a scale, kettle ───────
function pourStation(C) {
  const W = 1400, H = 900;
  const P = (k) => [STATION[k][0] * W, STATION[k][1] * H];
  let s = open(W, H) + rect(0, 0, W, H, mix(C.paper, C.sky, 0.2)) + rect(0, 740, W, 160, mix(C.wood, C.paper, 0.25));
  const [gx, gy] = P('grinder');
  s += rect(gx - 90, gy + 60, 180, 280, C.steelDark, ' rx="18"') + path(`M${gx - 70} ${gy - 150} L${gx + 70} ${gy - 150} L${gx + 40} ${gy + 60} L${gx - 40} ${gy + 60}Z`, mix(C.steel, '#FFFFFF', 0.3), ' opacity=".9"');
  s += pile(rng(71), gx, gy - 110, 50, 20, 30, [[C.roastMedium, C.roastDark]], 9) + circle(gx + 60, gy + 150, 26, C.steel) + rect(gx - 60, gy + 250, 120, 70, C.roastMediumDark, ' rx="10"');
  const [sx, sy] = P('scale');
  s += rect(sx - 150, sy - 30, 300, 60, C.espresso, ' rx="14"') + rect(sx - 60, sy - 14, 120, 28, mix(C.water, C.espresso, 0.4), ' rx="6"');
  const [dx, dy] = P('dripper');
  s += path(`M${dx - 110} ${sy - 30} L${dx + 110} ${sy - 30} L${dx + 90} ${dy + 150} L${dx - 90} ${dy + 150}Z`, mix(C.water, '#FFFFFF', 0.55), ' opacity=".9"') + rect(dx - 100, sy - 120, 200, 90, C.roastMediumDark, ' opacity=".85"');
  s += path(`M${dx - 130} ${dy - 80} L${dx + 130} ${dy - 80} L${dx + 40} ${dy + 120} L${dx - 40} ${dy + 120}Z`, C.cream) + path(`M${dx - 112} ${dy - 66} L${dx + 112} ${dy - 66} L${dx + 32} ${dy + 104} L${dx - 32} ${dy + 104}Z`, '#FFFFFF') + ellipse(dx, dy - 50, 92, 18, C.roastMedium);
  const [kx, ky] = P('kettle');
  s += path(`M${kx - 110} ${ky + 230} L${kx - 90} ${ky - 40} C${kx - 60} ${ky - 90} ${kx + 60} ${ky - 90} ${kx + 90} ${ky - 40} L${kx + 110} ${ky + 230}Z`, C.steelDark) + rect(kx - 30, ky - 110, 60, 30, C.espresso, ' rx="10"');
  s += path(`M${kx - 96} ${ky + 120} C${kx - 200} ${ky + 80} ${kx - 230} ${ky - 40} ${kx - 290} ${ky - 120}`, 'none', ` stroke="${C.steelDark}" stroke-width="20" stroke-linecap="round"`);
  s += path(`M${kx + 96} ${ky - 20} C${kx + 170} ${ky} ${kx + 170} ${ky + 160} ${kx + 100} ${ky + 180}`, 'none', ` stroke="${C.espresso}" stroke-width="26" stroke-linecap="round"`);
  s += path(`M${kx - 292} ${ky - 118} C${kx - 330} ${ky - 100} ${dx + 40} ${dy - 120} ${dx + 10} ${dy - 56}`, 'none', ` stroke="${C.water}" stroke-width="7" stroke-linecap="round" opacity=".8"`);
  return s + close;
}

// ── 22. Four brewers (800 × 600) ──────────────────────────────────────
function brewer(C, kind) {
  let s = open(800, 600) + rect(0, 0, 800, 600, mix(C.paper, C.sky, 0.2)) + rect(0, 500, 800, 100, mix(C.wood, C.paper, 0.3));
  const glass = mix(C.water, '#FFFFFF', 0.55);
  if (kind === 'pourover') {
    s += path('M250 500 L550 500 L520 300 L280 300Z', glass, ' opacity=".9"') + rect(285, 390, 230, 110, C.roastMediumDark, ' opacity=".85"');
    s += path('M230 150 L570 150 L450 300 L350 300Z', C.cream) + ellipse(400, 160, 150, 22, C.roastMedium);
  }
  if (kind === 'press') {
    s += rect(290, 190, 220, 310, glass, ' rx="12" opacity=".9"') + rect(300, 300, 200, 190, C.roastMediumDark) + rect(300, 290, 200, 14, C.crema);
    s += rect(280, 170, 240, 26, C.steelDark, ' rx="8"') + rect(392, 90, 16, 90, C.steelDark) + circle(400, 86, 20, C.espresso);
    s += path('M510 230 C580 230 580 420 510 420', 'none', ` stroke="${C.espresso}" stroke-width="24"`);
  }
  if (kind === 'espresso') {
    s += rect(170, 90, 460, 190, C.steel, ' rx="20"') + rect(190, 280, 420, 40, C.steelDark) + rect(170, 470, 460, 30, C.steelDark);
    s += rect(330, 320, 140, 40, C.espresso, ' rx="10"') + path('M470 330 L600 300 L600 320 L470 350Z', C.espresso);
    s += line(385, 360, 385, 420, C.roastMediumDark, 6) + line(415, 360, 415, 420, C.roastMediumDark, 6);
    s += path('M345 420 L455 420 L445 470 L355 470Z', C.cream) + ellipse(400, 422, 55, 9, C.crema);
  }
  if (kind === 'moka') {
    s += path('M300 500 L500 500 L470 330 L330 330Z', C.steel) + rect(320, 310, 160, 30, C.steelDark);
    s += path('M330 310 L470 310 L500 150 L300 150Z', mix(C.steel, '#FFFFFF', 0.2)) + path('M300 150 L500 150 L470 120 L330 120Z', C.steelDark) + path('M500 160 L560 150 L540 175 L496 185Z', C.steel);
    s += path('M300 200 C230 210 230 300 320 300', 'none', ` stroke="${C.espresso}" stroke-width="22"`);
    s += ellipse(400, 520, 160, 12, mix(C.accent, C.yellow, 0.4), ' opacity=".6"');
  }
  return s + close;
}

// ── 23. A producer's portrait (900 × 1100), shown beside her words and round with her quotation ──
function producer(C) {
  const skin = '#A8704E', skinShade = '#8E5B3E', hair = '#2A1A14';
  let s = open(900, 1100) + rect(0, 0, 900, 1100, mix(C.hill, C.sky, 0.45));
  s += path('M0 640 C220 560 520 620 900 540 L900 1100 L0 1100Z', mix(C.leaf, C.hill, 0.3));
  for (let x = 40; x < 900; x += 110) s += ellipse(x, 680 + Math.sin(x) * 20, 60, 46, C.leafDark) + circle(x + 18, 668, 7, C.cherry) + circle(x - 10, 690, 7, C.cherry);
  // Bust: shoulders, shirt, a woven strap of a basket.
  s += path('M150 1100 C160 860 300 780 450 780 C600 780 740 860 750 1100Z', mix(C.accent, C.cherryDark, 0.2));
  s += path('M360 790 L450 900 L540 790Z', skin) + line(250, 860, 640, 1100, C.jute, 34) + line(250, 860, 640, 1100, C.juteDark, 6, ' stroke-dasharray="14 12"');
  s += rect(400, 690, 100, 120, skinShade, ' rx="40"');
  s += ellipse(450, 560, 150, 180, skin) + ellipse(300, 580, 26, 42, skinShade) + ellipse(600, 580, 26, 42, skinShade);
  s += path('M300 520 C300 380 600 380 600 520 C560 470 500 450 450 450 C400 450 340 470 300 520Z', hair) + path('M560 620 C640 680 620 800 560 840 C600 760 590 700 560 620Z', hair);
  // A wide straw hat.
  s += ellipse(450, 420, 290, 62, mix(C.yellow, C.jute, 0.6)) + path('M300 420 C300 300 600 300 600 420Z', mix(C.yellow, C.jute, 0.45)) + rect(300, 395, 300, 22, C.cherryDark);
  // Face.
  s += ellipse(395, 570, 13, 15, '#2A1A14') + ellipse(505, 570, 13, 15, '#2A1A14');
  s += path('M368 538 C385 528 405 528 420 536', 'none', ` stroke="${hair}" stroke-width="8" stroke-linecap="round"`) + path('M480 536 C495 528 515 528 532 538', 'none', ` stroke="${hair}" stroke-width="8" stroke-linecap="round"`);
  s += path('M445 590 C440 620 450 632 462 630', 'none', ` stroke="${skinShade}" stroke-width="7" stroke-linecap="round"`);
  s += path('M400 660 C430 685 470 685 500 660', 'none', ` stroke="#6A2E2A" stroke-width="9" stroke-linecap="round"`);
  s += ellipse(370, 630, 26, 16, C.cherry, ' opacity=".18"') + ellipse(530, 630, 26, 16, C.cherry, ' opacity=".18"');
  return s + close;
}
