// Paper and watercolour washes for the course backdrop, coloured by the theme tokens.
// - paper-grain.svg: a small tile of fibres and grain, laid over the paper colour;
// - wash-*.svg: soft pigment pools with darker rims, like watercolour dried on paper.
// Seeded, so every run draws the same pictures.
export const meta = { description: 'Paper grain and watercolour washes of the backdrop' };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function blob(random, cx, cy, rx, ry, points = 64) {
  const ph = [random() * 6.28, random() * 6.28, random() * 6.28, random() * 6.28];
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const k = 1 + 0.14 * Math.sin(a * 2 + ph[0]) + 0.08 * Math.sin(a * 3 + ph[1]) + 0.05 * Math.sin(a * 5 + ph[2]) + 0.025 * Math.sin(a * 11 + ph[3]);
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  // A closed smooth path through the points (Catmull-Rom as cubic Béziers).
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length], p1 = pts[i], p2 = pts[(i + 1) % pts.length], p3 = pts[(i + 2) % pts.length];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d + 'Z';
}

function wash(seed, colours, w, h) {
  const random = rng(seed);
  let body = '';
  colours.forEach(([col, alpha], i) => {
    const cx = w * (0.35 + random() * 0.3), cy = h * (0.35 + random() * 0.3);
    const rx = w * (0.28 + random() * 0.12), ry = h * (0.26 + random() * 0.12);
    const d = blob(random, cx, cy, rx, ry);
    body += `<path d="${d}" fill="${col}" fill-opacity="${alpha}" stroke="${col}" stroke-opacity="${(alpha * 1.6).toFixed(3)}" stroke-width="2.2" filter="url(#e${i % 2})"/>`;
    // A second, smaller pool inside: pigment that settled.
    const d2 = blob(random, cx + (random() - 0.5) * rx * 0.4, cy + (random() - 0.5) * ry * 0.4, rx * 0.55, ry * 0.5, 48);
    body += `<path d="${d2}" fill="${col}" fill-opacity="${(alpha * 0.7).toFixed(3)}" filter="url(#e${(i + 1) % 2})"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<defs>
<filter id="e0" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="${seed}"/><feDisplacementMap in="SourceGraphic" scale="34"/><feGaussianBlur stdDeviation="1.4"/></filter>
<filter id="e1" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="${seed + 7}"/><feDisplacementMap in="SourceGraphic" scale="22"/><feGaussianBlur stdDeviation="2.4"/></filter>
</defs>
${body}
</svg>
`;
}

export default async function ({ tokens, write }) {
  const t = (k, alt) => tokens[k] || tokens[alt];
  const ink = t('color.ink', 'color.text');
  const sage = t('color.sage', 'color.primary');
  const water = t('color.water', 'color.primary');
  const ochre = t('color.ochre', 'color.accent');
  const moss = t('color.moss', 'color.primary');

  // Paper: fine fibres and grain, very faint, tiled over the paper colour.
  write('images/paper-grain.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" width="320" height="320">
<filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="11" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 0 0.05 0.11"/></feComponentTransfer></filter>
<filter id="f" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.09" numOctaves="2" seed="4" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 0 0.04 0.07"/></feComponentTransfer></filter>
<rect width="320" height="320" fill="${ink}" filter="url(#g)"/>
<rect width="320" height="320" fill="${ink}" filter="url(#f)"/>
</svg>
`);
  // A short wavy rule, like a line of water, for closing thoughts and titles.
  let wave = 'M2,6';
  for (let i = 0; i < 6; i++) wave += ` q6,-5 12,0 t12,0`;
  write('images/rule-wave.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 12" width="150" height="12"><path d="${wave}" fill="none" stroke="${water}" stroke-width="2.4" stroke-linecap="round"/></svg>
`);
  write('images/wash-sage.svg', wash(21, [[sage, 0.16], [moss, 0.08], [sage, 0.1]], 900, 620));
  write('images/wash-water.svg', wash(5, [[water, 0.12], [sage, 0.08], [water, 0.07]], 900, 620));
  write('images/wash-ochre.svg', wash(13, [[ochre, 0.1], [sage, 0.07]], 700, 520));
}
