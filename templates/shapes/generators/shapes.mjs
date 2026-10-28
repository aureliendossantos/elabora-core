// The Shapes template's drawings, coloured by the theme tokens:
// - images/paper-grain.svg, a faint print grain tiled over the backdrop (layer « grain »);
// - images/composition.svg, an abstract Bauhaus composition for the « text and illustration » screen.
// No words in them: the screens say what they mean.
export const meta = { description: 'Paper grain of the backdrop and the Bauhaus composition of the illustration screen' };

const pick = (tokens, name, fallback) => String(tokens[name] || fallback);

export default async function ({ tokens, write }) {
  const grain = pick(tokens, 'color.grain', '#1D1D27');
  write('images/paper-grain.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <filter id="g" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.4 -0.62"/>
    <feComposite operator="in" in2="SourceGraphic"/>
  </filter>
  <rect width="240" height="240" fill="${grain}" filter="url(#g)"/>
</svg>
`);

  const c1 = pick(tokens, 'color.shape-1', '#E35D3E');
  const c2 = pick(tokens, 'color.shape-2', '#F3B83A');
  const c3 = pick(tokens, 'color.shape-3', '#3A67B1');
  const c4 = pick(tokens, 'color.shape-4', '#1D1D27');
  const card = pick(tokens, 'color.card', '#FFFBF4');
  // A 600 × 600 grid of four squares: a sun, a quarter, a half disc and bars, as on a poster.
  write('images/composition.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect width="600" height="600" fill="${card}"/>
  <rect x="0" y="0" width="300" height="300" fill="${c3}"/>
  <circle cx="150" cy="150" r="104" fill="${c2}"/>
  <path d="M300 300 L300 0 A300 300 0 0 1 600 300 Z" fill="${c1}"/>
  <path d="M0 600 L0 300 A300 300 0 0 1 300 600 Z" fill="${c2}"/>
  <rect x="300" y="300" width="300" height="300" fill="${c4}"/>
  <path d="M330 600 A120 120 0 0 1 570 600 Z" fill="${c1}"/>
  <rect x="352" y="352" width="196" height="22" fill="${card}"/>
  <rect x="352" y="398" width="120" height="22" fill="${card}"/>
  <circle cx="450" cy="150" r="34" fill="${c4}"/>
  <rect x="60" y="474" width="180" height="16" fill="${c4}"/>
</svg>
`);
}
