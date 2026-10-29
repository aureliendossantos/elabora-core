// The Watercolour template's drawings, from the theme's tokens: change a wash colour, run
// `elabora assets`, and the illustration and the paper follow. The washes share their geometry
// with the backdrop object (objects/bloom/wash.js): glazes of a deformed outline, laid thin.
import { wash } from '../objects/bloom/wash.js';

export const meta = { description: 'Paper texture of the backdrop and the abstract watercolour illustration' };

const hex = (value, fallback) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback);

function glazes(cx, cy, radius, seed, colour, { layers = 12, opacity = 0.075 } = {}) {
  const shape = wash(seed, { layers, detail: 1, outline: 3 });
  const path = (points) => `M${points.map((p) => `${Math.round(cx + p.x * radius)} ${Math.round(cy + p.y * radius)}`).join('L')}Z`;
  const fills = shape.glazes.map((g) => `<path d="${path(g)}"/>`).join('');
  const rims = shape.pools.map((p) => `<path d="${path(p)}"/>`).join('');
  return `<g fill="${colour}" fill-opacity="${opacity}" style="mix-blend-mode:multiply">${fills}</g>`
    + `<g fill="none" stroke="${colour}" stroke-opacity=".35" stroke-width="1.5">${rims}</g>`;
}

export default async function ({ tokens, write }) {
  const lagoon = hex(tokens['color.wash-lagoon'], '#8CCFCB');
  const cerulean = hex(tokens['color.wash-cerulean'], '#9BBFE4');
  const deep = hex(tokens['color.wash-deep'], '#8DAAD3');
  const blush = hex(tokens['color.wash-blush'], '#F0B4A3');
  const sea = hex(tokens['color.wash-sea'], '#A6D6B8');

  // Paper: the relief of cold-pressed paper, lit from the top left, white where it faces the light.
  // The stylesheet lays it over the washes in multiply, so the pigment seems to sit in the grain.
  write('images/paper.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384" viewBox="0 0 384 384">
<filter id="p" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.045 0.05" numOctaves="4" seed="11" stitchTiles="stitch" result="n"/>
<feDiffuseLighting in="n" surfaceScale="1.5" diffuseConstant="1.05" lighting-color="#ffffff"><feDistantLight azimuth="225" elevation="58"/></feDiffuseLighting>
</filter>
<rect width="384" height="384" filter="url(#p)"/>
</svg>
`);

  // The illustration: three washes leaning on one another, and a few drops that ran off the brush.
  const drawing = [
    glazes(330, 300, 210, 41, lagoon, { layers: 14 }),
    glazes(520, 230, 165, 77, cerulean, { layers: 12 }),
    glazes(470, 450, 130, 113, blush, { layers: 12 }),
    glazes(205, 505, 54, 151, deep, { layers: 8, opacity: 0.1 }),
    glazes(655, 470, 38, 173, sea, { layers: 8, opacity: 0.1 }),
    glazes(640, 92, 26, 197, lagoon, { layers: 6, opacity: 0.12 })
  ].join('\n');
  write('images/watercolor-washes.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="640" viewBox="0 0 800 640">
${drawing}
</svg>
`);
}
