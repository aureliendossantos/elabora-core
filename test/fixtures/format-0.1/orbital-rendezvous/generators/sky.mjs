// Starfield tiles for the animated background of the course (theme/theme.css drifts and twinkles them).
// Seeded, so every run gives the same bytes; colours from the theme tokens. Stars near an edge are
// drawn again on the opposite side, so the tiles repeat without seams.

export const meta = { description: 'Seamless starfield tiles (far, near and glinting layers) for the animated background.' };

export default async function generate({ tokens, write }) {
  const colors = [tokens['color.star'], tokens['color.star-cool'], tokens['color.star-warm']];
  write('images/sky-far.svg', tile({ size: 640, count: 340, seed: 11, colors, r: [0.35, 0.85], o: [0.22, 0.7] }));
  write('images/sky-near.svg', tile({ size: 960, count: 95, seed: 23, colors, r: [0.7, 1.45], o: [0.5, 0.95], halo: 0.16 }));
  write('images/sky-glint-a.svg', tile({ size: 1100, count: 13, seed: 37, colors, r: [1.1, 1.8], o: [0.85, 1], halo: 1, glint: true }));
  write('images/sky-glint-b.svg', tile({ size: 1340, count: 11, seed: 53, colors, r: [1, 1.7], o: [0.85, 1], halo: 1, glint: true }));
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n) => Math.round(n * 100) / 100;

function tile({ size, count, seed, colors, r: [r0, r1], o: [o0, o1], halo = 0, glint = false }) {
  const rand = rng(seed);
  const stars = [];
  for (let i = 0; i < count; i++) {
    // Most stars are white; a few lean blue or warm, as in a real sky.
    const c = rand();
    stars.push({
      x: rand() * size, y: rand() * size,
      r: r0 + (r1 - r0) * rand() ** 2.2,
      o: o0 + (o1 - o0) * rand(),
      color: colors[c < 0.72 ? 0 : c < 0.88 ? 1 : 2],
      halo: rand() < halo, angle: rand() * 30 - 15
    });
  }
  const body = [];
  for (const s of stars) {
    const reach = glint ? 16 : s.halo ? s.r * 5 : s.r + 1;
    for (const dx of [0, -size, size]) for (const dy of [0, -size, size]) {
      const x = s.x + dx, y = s.y + dy;
      if (x < -reach || x > size + reach || y < -reach || y > size + reach) continue;
      body.push(star({ ...s, x, y }, glint));
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs><radialGradient id="h"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".35" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
${body.join('\n')}
</svg>
`;
}

function star(s, glint) {
  const parts = [];
  if (s.halo) parts.push(`<circle cx="${f(s.x)}" cy="${f(s.y)}" r="${f(s.r * (glint ? 7 : 5))}" fill="url(#h)" opacity="${f(s.o * 0.9)}"/>`);
  if (glint) {
    const L = s.r * 9;
    parts.push(`<g transform="translate(${f(s.x)} ${f(s.y)}) rotate(${f(s.angle)})" fill="${s.color}" opacity="${f(s.o * 0.7)}"><ellipse rx="${f(L)}" ry="${f(s.r * 0.22)}"/><ellipse rx="${f(s.r * 0.22)}" ry="${f(L * 0.8)}"/></g>`);
  }
  parts.push(`<circle cx="${f(s.x)}" cy="${f(s.y)}" r="${f(s.r)}" fill="${s.color}" opacity="${f(s.o)}"/>`);
  return parts.join('');
}
