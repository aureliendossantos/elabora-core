// The Editorial template's drawings, coloured by the theme tokens:
// - images/paper-grain.svg: the grain of the paper, tiled over the backdrop (layer « grain »);
// - images/plate-print.svg: an abstract illustration printed like a two-colour plate (a disc of
//   halftone dots, a field of engraved lines, a block of colour), for the « text and picture » screen.
// No words in them: the screens say what they mean.
export const meta = { description: 'Paper grain of the backdrop and the printed plate of the illustration screen' };

const pick = (tokens, name, fallback) => String(tokens[name] || fallback);

export default async function ({ tokens, write }) {
  const grain = pick(tokens, 'color.grain', '#3A2E1F');
  write('images/paper-grain.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 280 280">
  <filter id="g" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" seed="11" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.6 -0.78"/>
    <feComposite operator="in" in2="SourceGraphic"/>
  </filter>
  <rect width="280" height="280" fill="${grain}" filter="url(#g)"/>
</svg>
`);

  const paper = pick(tokens, 'color.paper', '#F3EDE2');
  const deep = pick(tokens, 'color.paper-deep', '#E7DECF');
  const ink = pick(tokens, 'color.text', '#1C1A17');
  const red = pick(tokens, 'color.plate-1', '#B23A26');
  const blue = pick(tokens, 'color.plate-2', '#1F4A73');
  const ochre = pick(tokens, 'color.plate-4', '#8A5E17');

  // Halftone: dots on a grid whose size grows towards the centre of the disc.
  const dots = [];
  const cx = 300, cy = 330, radius = 210, step = 14;
  for (let y = cy - radius; y <= cy + radius; y += step) {
    for (let x = cx - radius; x <= cx + radius; x += step) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d > 1) continue;
      const r = (1 - d * 0.78) * step * 0.48;
      dots.push(`<circle cx="${x}" cy="${y}" r="${r.toFixed(2)}"/>`);
    }
  }
  // Engraving: horizontal lines, finer towards the top of their field.
  const lines = [];
  for (let i = 0; i < 26; i++) {
    const y = 560 + i * 9.5;
    lines.push(`<rect x="60" y="${y.toFixed(1)}" width="480" height="${(0.8 + i * 0.12).toFixed(2)}"/>`);
  }
  write('images/plate-print.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <rect width="600" height="800" fill="${deep}"/>
  <rect x="36" y="36" width="528" height="728" fill="${paper}"/>
  <rect x="330" y="60" width="210" height="300" fill="${blue}"/>
  <g fill="${red}">${dots.join('')}</g>
  <g fill="${ink}">${lines.join('')}</g>
  <rect x="60" y="500" width="150" height="40" fill="${ochre}"/>
  <rect x="60" y="60" width="2" height="420" fill="${ink}"/>
  <circle cx="470" cy="480" r="40" fill="none" stroke="${ink}" stroke-width="2"/>
</svg>
`);
}
