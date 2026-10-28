// Abstract figures of the Clear template, drawn on its grid from the theme's tokens: a change of
// accent or ink in course.json redraws them (elabora assets). No words: labels live in blocks.
export const meta = { description: 'Abstract grid figures in the accent colour' };

const pick = (tokens, name, fallback) => String(tokens[name] || fallback);

export default async function ({ tokens, write }) {
  const accent = pick(tokens, 'color.accent', '#1B56D1');
  const ink = pick(tokens, 'color.text', '#15191F');
  const line = pick(tokens, 'color.line', '#DADDE2');
  const paper = pick(tokens, 'color.paper', '#F4F5F7');

  // A 6 × 5 grid of squares; three filled in the accent along a diagonal, one in ink, a few in paper.
  const cols = 6, rows = 5, cell = 80, gap = 8;
  const w = cols * cell + (cols - 1) * gap, h = rows * cell + (rows - 1) * gap;
  const filled = new Map([
    ['1,3', accent], ['2,2', accent], ['3,1', accent],
    ['4,1', ink],
    ['0,4', paper], ['1,4', paper], ['2,3', paper], ['4,0', paper], ['5,0', paper], ['5,2', paper]
  ]);
  let cells = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const fill = filled.get(`${x},${y}`);
      const px = x * (cell + gap), py = y * (cell + gap);
      cells += fill
        ? `<rect x="${px}" y="${py}" width="${cell}" height="${cell}" fill="${fill}"/>`
        : `<rect x="${px + 0.5}" y="${py + 0.5}" width="${cell - 1}" height="${cell - 1}" fill="none" stroke="${line}"/>`;
    }
  }
  // A quarter circle cut from the corner of the accent run: the template's one curve.
  const cx = 3 * (cell + gap), cy = 2 * (cell + gap);
  const arc = `<path d="M ${cx} ${cy - cell - gap} A ${cell + gap} ${cell + gap} 0 0 1 ${cx + cell + gap} ${cy}" fill="none" stroke="${ink}" stroke-width="2"/>`;
  write('images/figure-grid.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${w + 4} ${h + 4}" width="${w + 4}" height="${h + 4}">${cells}${arc}</svg>\n`);
}
