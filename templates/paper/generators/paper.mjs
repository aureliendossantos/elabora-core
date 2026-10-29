// The Paper template's drawings, coloured by the theme tokens:
// - images/fibre.svg, the fibres of kraft paper, tiled over the backdrop (layer « grain »);
// - images/collage.svg, a cut-paper collage for the « text and illustration » screen: a sky, a
//   scalloped sun, a cloud and three hills laid on one another, each with the soft shadow of a sheet
//   lifted a little more than the one under it (the light comes from the top left, as on the backdrop).
// No words in them: the screens say what they mean.
export const meta = { description: 'Kraft fibres of the backdrop and the cut-paper collage of the illustration screen' };

const pick = (tokens, name, fallback) => String(tokens[name] || fallback);

// A wavy edge from x0 to x1 around y, closed down to the bottom: a hill cut with scissors.
function hill(y, amplitude, waves, phase, width, height) {
  const steps = 48;
  let d = `M0 ${height} L0 ${y.toFixed(1)}`;
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width;
    const v = y - amplitude * Math.sin((i / steps) * Math.PI * 2 * waves + phase) - amplitude * 0.35 * Math.sin((i / steps) * Math.PI * 2 * waves * 2.3 + phase * 1.7);
    d += ` L${x.toFixed(1)} ${v.toFixed(1)}`;
  }
  return `${d} L${width} ${height} Z`;
}

// A scalloped disc (a paper sun cut with pinking shears).
function scallop(cx, cy, r, bumps) {
  let d = '';
  for (let i = 0; i <= bumps * 8; i++) {
    const a = (i / (bumps * 8)) * Math.PI * 2;
    const rr = r * (1 + 0.07 * Math.cos(a * bumps));
    d += `${i ? 'L' : 'M'}${(cx + rr * Math.cos(a)).toFixed(1)} ${(cy + rr * Math.sin(a)).toFixed(1)} `;
  }
  return `${d}Z`;
}

export default async function ({ tokens, write }) {
  const fibre = pick(tokens, 'color.fibre', '#5A3A16');
  write('images/fibre.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
  <filter id="f" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.05 0.11" numOctaves="3" seed="11" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.6 -0.78"/>
    <feComposite operator="in" in2="SourceGraphic"/>
  </filter>
  <filter id="g" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.2 -0.6"/>
    <feComposite operator="in" in2="SourceGraphic"/>
  </filter>
  <rect width="320" height="320" fill="${fibre}" filter="url(#f)"/>
  <rect width="320" height="320" fill="${fibre}" filter="url(#g)" opacity="0.6"/>
</svg>
`);

  // The shapes a part's number is cut in (masks: their shape only, the colour comes from the theme).
  write('images/scallop.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><path d="${scallop(100, 100, 92, 16)}" fill="#000"/></svg>
`);
  let star = '';
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 50 : 98;
    star += `${i ? 'L' : 'M'}${(100 + r * Math.cos(a)).toFixed(1)} ${(104 + r * Math.sin(a)).toFixed(1)} `;
  }
  write('images/star.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><path d="${star}Z" fill="#000" stroke="#000" stroke-width="14" stroke-linejoin="round"/></svg>
`);

  const paper = pick(tokens, 'color.paper', '#FBF4E6');
  const sky = pick(tokens, 'color.paper-sky', '#79AEDD');
  const mustard = pick(tokens, 'color.paper-mustard', '#F2B632');
  const coral = pick(tokens, 'color.paper-coral', '#E8644B');
  const leaf = pick(tokens, 'color.paper-leaf', '#7DB356');
  const teal = pick(tokens, 'color.paper-teal', '#1B7A72');
  const pink = pick(tokens, 'color.paper-pink', '#F4A3B1');
  const shade = pick(tokens, 'color.fibre', '#5A3A16');
  const W = 640, H = 560;
  // Each layer is a sheet a little higher above the one under it: a larger, softer shadow.
  const lift = (n) => `<filter id="l${n}" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="${1.5 * n}" dy="${2.5 * n}" stdDeviation="${1.5 + 1.6 * n}" flood-color="${shade}" flood-opacity="${0.16 + 0.03 * n}"/></filter>`;
  write('images/collage.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${lift(1)}${lift(2)}${lift(3)}${lift(4)}
    <clipPath id="card"><rect x="0" y="0" width="${W}" height="${H}" rx="10"/></clipPath>
  </defs>
  <g clip-path="url(#card)">
    <rect width="${W}" height="${H}" fill="${sky}"/>
    <path d="${scallop(470, 150, 74, 14)}" fill="${mustard}" filter="url(#l2)"/>
    <g filter="url(#l1)" fill="${paper}">
      <circle cx="150" cy="140" r="34"/><circle cx="190" cy="124" r="44"/><circle cx="236" cy="142" r="32"/>
      <rect x="150" y="140" width="86" height="34" rx="17"/>
    </g>
    <path d="${hill(330, 26, 1.4, 0.6, W, H)}" fill="${teal}" filter="url(#l1)"/>
    <path d="${hill(380, 22, 1.8, 2.4, W, H)}" fill="${leaf}" filter="url(#l2)"/>
    <path d="${hill(430, 18, 2.3, 4.1, W, H)}" fill="${coral}" filter="url(#l3)"/>
    <path d="${hill(486, 12, 3.1, 1.2, W, H)}" fill="${pink}" filter="url(#l4)"/>
    <g filter="url(#l3)" fill="${mustard}">
      <path d="M118 412 C 132 380, 164 372, 178 384 C 166 404, 140 418, 118 412 Z"/>
      <path d="M520 448 C 534 420, 566 414, 578 426 C 566 444, 540 456, 520 448 Z"/>
    </g>
  </g>
</svg>
`);
}
