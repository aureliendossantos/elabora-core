// The backdrop of the course (theme.backdrop, painted by theme/theme.css): the grain of the vellum
// as a seamless tile, and a faint rhumb network that turns a little as the learner scrolls.
// Colours from the theme tokens; seeded, so every run writes the same bytes.
export const meta = { description: 'Seamless vellum grain tile and a faint rhumb network for the backdrop, without text.' };

export default async function generate({ tokens, write }) {
  write('images/bg-grain.svg', grain(tokens['color.vellum-shadow']));
  write('images/bg-network.svg', network(tokens));
}

const f = (n) => Math.round(n * 100) / 100;
const DEG = Math.PI / 180;

function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v / 255)); }

// Fractal noise in the colour of the shadow, at low alpha: the surface of a scraped skin. The
// turbulence stitches its tiles, so the tile repeats without seams.
function grain(color) {
  const [r, g, b] = hex(color);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 360" width="360" height="360"><filter id="g" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".72" numOctaves="3" seed="11" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  0 0 0 .2 -.05"/></filter><rect width="360" height="360" filter="url(#g)"/></svg>`;
}

// Two roses of 32 rays and the chords of a hidden circle, very thin: the backdrop stylesheet sets
// how much shows.
function network(tokens) {
  const W = 2400, H = 1600;
  const colors = [tokens['color.rhumb-wind'], tokens['color.rhumb-quarter'], tokens['color.rhumb-half'], tokens['color.rhumb-quarter']];
  const centre = { x: 1200, y: 800 }, R = 620;
  const roses = [centre];
  for (let k = 0; k < 16; k++) roses.push({ x: centre.x + R * Math.sin(k * 22.5 * DEG), y: centre.y - R * Math.cos(k * 22.5 * DEG) });
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><g stroke-width="1" fill="none">`;
  for (const [index, rose] of roses.entries()) {
    for (let k = 0; k < 32; k++) {
      if (index && k % 2) continue; // rim roses: the eight winds and the half-winds only
      const a = k * 11.25 * DEG, L = 2600;
      out += `<line x1="${f(rose.x)}" y1="${f(rose.y)}" x2="${f(rose.x + L * Math.sin(a))}" y2="${f(rose.y - L * Math.cos(a))}" stroke="${colors[k % 4]}" opacity="${k % 4 === 0 ? 0.9 : 0.6}"/>`;
    }
  }
  out += `<circle cx="${centre.x}" cy="${centre.y}" r="${R}" stroke="${colors[0]}" stroke-dasharray="2 9" opacity=".7"/>`;
  return `${out}</g></svg>`;
}
