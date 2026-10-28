// The Organic template's drawings, from the theme's tokens: change a journey colour, run
// `elabora assets`, and the illustration and the grain follow.
export const meta = { description: 'Grain tile of the backdrop and the abstract illustration of the template' };

const round = (n) => Math.round(n * 10) / 10;

// A closed, soft blob: points around a circle with seeded radii, joined by Catmull-Rom curves.
function blob(cx, cy, r, seed, points = 7, wobble = 0.18) {
  let s = seed;
  const random = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const k = r * (1 - wobble + random() * wobble * 2);
    pts.push([cx + Math.cos(a) * k, cy + Math.sin(a) * k]);
  }
  let d = `M${round(pts[0][0])} ${round(pts[0][1])}`;
  for (let i = 0; i < points; i++) {
    const p0 = pts[(i - 1 + points) % points], p1 = pts[i], p2 = pts[(i + 1) % points], p3 = pts[(i + 2) % points];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  return `${d} Z`;
}

const hex = (value, fallback) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback);
const channels = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3));

export default async function ({ tokens, write }) {
  const warm = hex(tokens['color.journey-warm'], '#F4A27E');
  const middle = hex(tokens['color.journey-middle'], '#A9D08E');
  const cool = hex(tokens['color.journey-cool'], '#86B6EC');
  const ink = hex(tokens['color.text'], '#2E2925');
  const accent = hex(tokens['color.accent'], '#B64A2A');
  const card = hex(tokens['color.card'], '#FFFDFA');
  const grain = hex(tokens['color.grain'], '#3B2F27');

  // Grain: fractal noise in the grain colour, its alpha from the noise. Tiled by the stylesheet.
  const [r, g, b] = channels(grain);
  write('images/grain.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<filter id="n" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" seed="7" stitchTiles="stitch"/>
<feColorMatrix values="0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 1.9 0 0 0 -0.72"/>
</filter>
<rect width="256" height="256" filter="url(#n)"/>
</svg>
`);

  // The illustration: three leaning blobs in the journey's colours, a small accent pebble and a
  // thin ink path that ties them, on a transparent ground.
  write('images/organic-shapes.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="560" viewBox="0 0 640 560">
<defs>
<linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${warm}" stop-opacity=".95"/><stop offset="1" stop-color="${warm}" stop-opacity=".7"/></linearGradient>
<linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${middle}"/><stop offset="1" stop-color="${middle}" stop-opacity=".75"/></linearGradient>
<linearGradient id="c" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${cool}"/><stop offset="1" stop-color="${cool}" stop-opacity=".7"/></linearGradient>
</defs>
<path d="${blob(250, 250, 170, 11)}" fill="url(#w)"/>
<path d="${blob(420, 320, 150, 29, 8, 0.16)}" fill="url(#c)" style="mix-blend-mode:multiply"/>
<path d="${blob(330, 160, 105, 53, 6, 0.2)}" fill="url(#m)" style="mix-blend-mode:multiply"/>
<path d="${blob(470, 140, 34, 71, 6, 0.14)}" fill="${accent}"/>
<path d="${blob(170, 430, 46, 97, 6, 0.16)}" fill="${card}" stroke="${ink}" stroke-width="3"/>
<path d="M96 300 C150 210 230 470 330 400 S480 470 560 360" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>
<circle cx="96" cy="300" r="7" fill="${ink}"/>
<circle cx="560" cy="360" r="7" fill="${ink}"/>
</svg>
`);
}
