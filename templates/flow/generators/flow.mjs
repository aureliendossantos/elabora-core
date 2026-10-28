// Shapes of the Flow charter, without words and without colours of their own where the theme paints them:
// - flow-haze.svg: a mask (white on transparent) of two soft luminous bands; the stylesheet paints it
//   with the neon tokens (mask-image), so a brand change needs no new file. The tile repeats across:
//   every wave has a whole number of periods over its width.
// - flow-grain.svg: a still film grain, as a mask too.
// - signal.svg: the illustration of the "text and illustration" screen, drawn inline (inline: true) so
//   that the theme colours its classes; the presentation attributes are only its defaults.

export const meta = { description: 'Backdrop masks (luminous haze, grain) and the abstract signal illustration, without text.' };

export default async function generate({ tokens, write }) {
  write('images/flow-haze.svg', haze());
  write('images/flow-grain.svg', grain());
  write('images/signal.svg', signal(tokens));
}

const f = (n) => Math.round(n * 10) / 10;
const W = 1600;
const H = 900;

// y of a wave of k whole periods over the tile, at x
function wave(x, { y, a, k, phase, a2 = 0, k2 = 0, phase2 = 0 }) {
  return y + a * Math.sin((2 * Math.PI * k * x) / W + phase) + a2 * Math.sin((2 * Math.PI * k2 * x) / W + phase2);
}
// Drawn over three tile widths (from -W to 2W): the blur sees the wave go on past both edges, so the
// tile, cut to its viewBox, repeats without a seam.
function path(spec, step = 20) {
  let d = '';
  for (let x = -W; x <= 2 * W; x += step) d += `${x === -W ? 'M' : 'L'}${x} ${f(wave(x, spec))}`;
  return d;
}

function haze() {
  const a = { y: 690, a: 62, k: 1, phase: 0.4, a2: 26, k2: 2, phase2: 1.3 };
  const b = { y: 770, a: 48, k: 1, phase: 2.2, a2: 20, k2: 3, phase2: 0.2 };
  const c = { y: 250, a: 40, k: 1, phase: 4.1, a2: 12, k2: 2, phase2: 2.6 };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
<defs>
<filter id="wide" filterUnits="userSpaceOnUse" x="${-W}" y="0" width="${3 * W}" height="${H}"><feGaussianBlur stdDeviation="46"/></filter>
<filter id="soft" filterUnits="userSpaceOnUse" x="${-W}" y="0" width="${3 * W}" height="${H}"><feGaussianBlur stdDeviation="9"/></filter>
</defs>
<g fill="none" stroke="#fff" stroke-linecap="round">
<path d="${path(a)}" stroke-width="150" opacity=".55" filter="url(#wide)"/>
<path d="${path(b)}" stroke-width="110" opacity=".4" filter="url(#wide)"/>
<path d="${path(c)}" stroke-width="80" opacity=".22" filter="url(#wide)"/>
<path d="${path(a)}" stroke-width="14" opacity=".55" filter="url(#soft)"/>
<path d="${path(b)}" stroke-width="10" opacity=".45" filter="url(#soft)"/>
</g>
</svg>
`;
}

function grain() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
<filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.4 -.55"/></filter>
<rect width="240" height="240" filter="url(#n)"/>
</svg>
`;
}

// Concentric rings crossed by a signal: a wave that enters faint, passes the rings and leaves sharp.
function signal(t) {
  const A = t['color.neon-a'] || '#3DE8FF';
  const B = t['color.neon-b'] || '#FF4FCB';
  const L = t['color.hairline'] || '#2A3050';
  const S = 640;
  const cx = 320;
  const cy = 320;
  let rings = '';
  for (let i = 0; i < 6; i++) {
    const r = 70 + i * 42;
    rings += `<circle class="fl-line" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${L}" stroke-width="1.5"${i % 2 ? ' stroke-dasharray="2 9"' : ''}/>`;
  }
  let ticks = '';
  for (let i = 0; i < 48; i++) {
    const ang = (i / 48) * Math.PI * 2;
    const r0 = 300;
    const r1 = i % 4 === 0 ? 316 : 308;
    ticks += `M${f(cx + r0 * Math.cos(ang))} ${f(cy + r0 * Math.sin(ang))}L${f(cx + r1 * Math.cos(ang))} ${f(cy + r1 * Math.sin(ang))}`;
  }
  const sig = (amp, phase) => {
    let d = '';
    for (let x = 20; x <= 620; x += 6) {
      const env = Math.exp(-((x - cx) ** 2) / (2 * 120 ** 2));
      const y = cy + amp * env * Math.sin(x / 22 + phase);
      d += `${x === 20 ? 'M' : 'L'}${x} ${f(y)}`;
    }
    return d;
  };
  const nodes = [[cx - 112, cy - 14], [cx + 28, cy + 70], [cx + 168, cy - 50]]
    .map(([x, y], i) => `<circle class="${i === 1 ? 'fl-b' : 'fl-a'}" cx="${x}" cy="${y}" r="${i === 1 ? 9 : 6}" fill="${i === 1 ? B : A}"/><circle class="fl-line" cx="${x}" cy="${y}" r="${i === 1 ? 20 : 15}" fill="none" stroke="${L}" stroke-width="1.5"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
<defs>
<linearGradient id="sg" x1="0" x2="1" y1="0" y2="0"><stop class="fl-stop-a" offset="0" stop-color="${A}" stop-opacity="0"/><stop class="fl-stop-a" offset=".35" stop-color="${A}"/><stop class="fl-stop-b" offset=".7" stop-color="${B}"/><stop class="fl-stop-b" offset="1" stop-color="${B}" stop-opacity="0"/></linearGradient>
<filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>
</defs>
${rings}
<path class="fl-line" d="${ticks}" stroke="${L}" stroke-width="2" fill="none"/>
<path class="fl-glow" d="${sig(96, 0.6)}" fill="none" stroke="url(#sg)" stroke-width="10" opacity=".45" filter="url(#glow)"/>
<path class="fl-trace" d="${sig(96, 0.6)}" fill="none" stroke="url(#sg)" stroke-width="3" stroke-linecap="round"/>
<path class="fl-trace-2" d="${sig(54, 2.2)}" fill="none" stroke="url(#sg)" stroke-width="1.5" opacity=".6" stroke-linecap="round"/>
${nodes}
</svg>
`;
}
