// Bauhaus tableau: the backdrop of the Shapes template.
// Seven flat shapes (a large circle, two quarter circles, a bar, a half disc, a small circle and a
// thin bar) compose a tableau around the edges of the window, never in the middle where the text
// is. Each part of the module has its own tableau; within a part, each screen changes one shape:
// it turns, glides along its axis or changes size. When the learner moves on, the shapes glide to
// their new place one after the other; a shape whose new place is across the window fades out
// where it was and fades in where it goes, rather than flying over the text. Under reduced motion,
// and while the first screen settles, each screen shows its tableau at once, as a still image.
// The shapes never touch the text: on the parts' screens, a shape that would reach the content column
// (prop column, plus a margin) is pushed out towards its edge of the window; the opening and closing
// tableaux, behind poster layouts whose text keeps the left, hold the right of the window.

const DEG = Math.PI / 180;
const KINDS = ['circle', 'quarter', 'quarter', 'bar', 'half', 'circle', 'bar'];

// Landscape tableaux. x and y: fractions of the window; s (radius), l and t (bar length and
// thickness): fractions of its height; rot in degrees; c: the colour (0 to 3) of the palette.
// Quarters and half discs turn round their centre: a quarter covers [rot, rot + 90°], a half disc
// [rot, rot + 180°] (0° points right, 90° down).
const TABLEAUX = [
  [ // the opening: the right of the window, the text keeps the left
    { x: 0.86, y: 0.5, s: 0.36, c: 0 },
    { x: 0.7, y: 0.07, s: 0.3, rot: 0, c: 1 },
    { x: 1.0, y: 0.93, s: 0.26, rot: 180, c: 2 },
    { x: 0.675, y: 0.66, l: 0.44, t: 0.035, rot: 90, c: 3 },
    { x: 0.05, y: 0.93, s: 0.13, rot: 180, c: 1 },
    { x: 0.955, y: 0.16, s: 0.045, c: 2 },
    { x: 0.8, y: 0.89, l: 0.3, t: 0.012, rot: 0, c: 3 }
  ],
  [ // part 1: both edges, a yellow sun rising at the left
    { x: -0.02, y: 0.3, s: 0.27, c: 1 },
    { x: 1.0, y: 0.07, s: 0.3, rot: 90, c: 0 },
    { x: 0.0, y: 0.93, s: 0.22, rot: 270, c: 2 },
    { x: 0.94, y: 0.62, l: 0.5, t: 0.04, rot: 90, c: 3 },
    { x: 0.91, y: 0.93, s: 0.12, rot: 180, c: 1 },
    { x: 0.1, y: 0.74, s: 0.05, c: 0 },
    { x: 0.06, y: 0.58, l: 0.14, t: 0.012, rot: 0, c: 3 }
  ],
  [ // part 2: the red circle sets at the right
    { x: 1.05, y: 0.7, s: 0.3, c: 0 },
    { x: 0.0, y: 0.07, s: 0.28, rot: 0, c: 1 },
    { x: 0.88, y: 0.07, s: 0.22, rot: 0, c: 1 },
    { x: 0.07, y: 0.66, l: 0.22, t: 0.04, rot: 0, c: 3 },
    { x: 0.0, y: 0.82, s: 0.13, rot: 270, c: 2 },
    { x: 0.94, y: 0.4, s: 0.04, c: 3 },
    { x: 0.125, y: 0.84, l: 0.16, t: 0.012, rot: 90, c: 3 }
  ],
  [ // part 3: blue at the foot of the left edge, red rising at the right
    { x: -0.04, y: 0.86, s: 0.3, c: 2 },
    { x: 1.0, y: 0.93, s: 0.3, rot: 180, c: 0 },
    { x: 0.0, y: 0.07, s: 0.18, rot: 0, c: 1 },
    { x: 0.93, y: 0.3, l: 0.4, t: 0.04, rot: 90, c: 3 },
    { x: 1.0, y: 0.55, s: 0.1, rot: 90, c: 1 },
    { x: 0.07, y: 0.4, s: 0.05, c: 0 },
    { x: 0.9, y: 0.64, l: 0.14, t: 0.012, rot: 0, c: 3 }
  ],
  [ // closing: the right of the window again, a fuller tableau
    { x: 0.84, y: 0.56, s: 0.32, c: 2 },
    { x: 0.66, y: 0.93, s: 0.34, rot: 270, c: 1 },
    { x: 1.0, y: 0.07, s: 0.24, rot: 90, c: 0 },
    { x: 0.86, y: 0.2, l: 0.4, t: 0.04, rot: 0, c: 3 },
    { x: 0.97, y: 0.93, s: 0.1, rot: 180, c: 0 },
    { x: 0.05, y: 0.15, s: 0.045, c: 0 },
    { x: 0.07, y: 0.89, l: 0.22, t: 0.012, rot: 0, c: 3 }
  ]
];

const PHONE_ALPHA = 0.4;

// The tableaux behind poster layouts (the opening and the closing): their text keeps the left half.
const POSTERS = new Set([0, 4]);

// The box a shape covers, in px.
function extent(a) {
  if (a.kind === 'bar') {
    const c = Math.cos(a.rot * DEG), s = Math.sin(a.rot * DEG);
    const hx = a.l / 2, hy = a.t / 2;
    const xs = [], ys = [];
    for (const [px, py] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) { xs.push(a.x + px * c - py * s); ys.push(a.y + px * s + py * c); }
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }
  const sweep = a.kind === 'quarter' ? 90 : a.kind === 'half' ? 180 : 360;
  const xs = [a.x], ys = [a.y];
  const angles = [a.rot, a.rot + sweep];
  for (let k = Math.ceil(a.rot / 90) * 90; k < a.rot + sweep; k += 90) angles.push(k);
  for (const t of angles) { xs.push(a.x + a.s * Math.cos(t * DEG)); ys.push(a.y + a.s * Math.sin(t * DEG)); }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// What a screen changes in the tableau of its part: one shape turns, glides or changes size.
const MOVES = [
  { actor: 0, op: 'scale', by: 1.1 },
  { actor: 0, op: 'scale', by: 0.86 },
  { actor: 4, op: 'turn', by: 90 },
  { actor: 4, op: 'turn', by: -90 },
  { actor: 3, op: 'slide', by: 0.12 },
  { actor: 3, op: 'slide', by: -0.12 },
  { actor: 5, op: 'scale', by: 1.7 },
  { actor: 6, op: 'slide', by: 0.1 }
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rgb(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) h = '808080';
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function mount(container, ctx) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  container.append(canvas);
  const g = canvas.getContext('2d');

  let props = { ...ctx.props };
  let context = ctx.context || null;
  let W = 0, H = 0, ratio = 1;
  let alive = 0;
  let paused = false;
  let from = null, to = null, current = null;
  let progress = 1, duration = 1.4;
  let tableau = 0, moved = '';
  let dirty = true;

  function resize() {
    const w = container.clientWidth || window.innerWidth || 960;
    const h = container.clientHeight || window.innerHeight || 600;
    const r = Math.min(2, window.devicePixelRatio || 1);
    if (w === W && h === H && r === ratio) return;
    W = w; H = h; ratio = r;
    canvas.width = Math.round(W * ratio); canvas.height = Math.round(H * ratio);
    if (to) { to = target(); if (progress >= 1) current = to.map((a) => ({ ...a })); }
    dirty = true;
  }

  const narrow = () => W < 760 || W < H;

  function palette(variant) {
    const keys = variant === 'earth' ? ['earth1', 'earth2', 'earth3', 'earth4']
      : variant === 'mono' ? ['mono1', 'mono2', 'mono3', 'mono4']
      : ['colour1', 'colour2', 'colour3', 'colour4'];
    return keys.map((k) => rgb(props[k]));
  }

  function tableauOf(section) {
    const parts = Array.isArray(props.parts) ? props.parts : [];
    const at = parts.indexOf(section);
    return at >= 0 ? at % TABLEAUX.length : hash(String(section || '')) % TABLEAUX.length;
  }

  // The shapes as they should stand for the current context, in px.
  function target() {
    const section = context?.section ?? null;
    const variant = context?.variant ?? null;
    tableau = tableauOf(section);
    const move = MOVES[(hash(String(context?.screen || '')) + (Number(props.shuffle) || 0)) % MOVES.length];
    moved = `${move.actor}:${move.op}:${move.by}`;
    const colours = palette(variant);
    const calm = variant === 'mono';
    const base = TABLEAUX[tableau].map((a) => ({ ...a, rot: a.rot || 0 }));
    const m = base[move.actor];
    if (move.op === 'scale') { if (m.s) m.s *= move.by; }
    else if (move.op === 'turn') m.rot += move.by;
    else if (move.op === 'slide') {
      if (Math.round(m.rot / 90) % 2 === 0) m.x += (move.by * H) / Math.max(1, W); else m.y += move.by;
    }
    if (narrow()) return phone(base, colours);
    const shapes = base.map((a, i) => {
      const out = calm ? (a.x < 0.5 ? -0.035 : 0.035) : 0;
      const k = calm ? 0.86 : 1;
      return {
        kind: KINDS[i], x: (a.x + out) * W, y: a.y * H,
        s: (a.s || 0) * H * k, l: (a.l || 0) * H * k, t: (a.t || 0) * H * k,
        rot: a.rot, colour: colours[a.c], alpha: 1
      };
    });
    return POSTERS.has(tableau) ? shapes : shapes.map(keepClear);
  }

  // The content column, with a margin, between the bars: a shape that reaches it moves out towards
  // its own edge of the window, as far as needed.
  function keepClear(shape) {
    const rem = 16;
    const column = Math.min(W - 3 * rem, (Number(props.column) || 72.5) * rem);
    const margin = Math.max(40, 0.03 * W);
    const left = (W - column) / 2 - margin;
    const right = (W + column) / 2 + margin;
    const box = extent(shape);
    if (box.y1 < 0.1 * H || box.y0 > 0.9 * H || box.x1 <= left || box.x0 >= right) return shape;
    const dx = shape.x < W / 2 ? left - box.x1 : right - box.x0;
    return { ...shape, x: shape.x + dx };
  }

  // On phones the text takes the whole width and scrolls over the corners: two shapes only, in
  // opposite corners, never blue, as tints (PHONE_ALPHA) that ink text stays readable on.
  function phone(base, colours) {
    const flip = tableau % 2 === 1;
    const top = { x: flip ? 0 : W, y: 56 };
    const foot = { x: flip ? W : 0, y: H - 72 };
    const pick = (c) => (c === 2 ? 1 : c);
    return base.map((a, i) => {
      const shape = { kind: KINDS[i], x: W / 2, y: H / 2, s: 0, l: 0, t: 0, rot: a.rot, colour: colours[pick(a.c)], alpha: 0 };
      if (i === 0) Object.assign(shape, { x: top.x, y: top.y, s: (a.s / 0.32) * 0.3 * W * 0.9, alpha: PHONE_ALPHA });
      if (i === 1) Object.assign(shape, { x: foot.x, y: foot.y, s: 0.36 * W, rot: flip ? 180 : 270, alpha: PHONE_ALPHA });
      if (i === 4) Object.assign(shape, { x: foot.x === 0 ? W : 0, y: foot.y, s: 0.12 * W, rot: a.rot, alpha: PHONE_ALPHA });
      return shape;
    });
  }

  // A shape glides when its new place is near; across the window it fades out and in instead.
  function plan(prev, next) {
    const span = Math.min(W, H) || 1;
    return next.map((n, i) => {
      const p = prev[i];
      const far = Math.hypot(n.x - p.x, n.y - p.y) / span > 0.6 || (p.x - W / 2) * (n.x - W / 2) < 0;
      return { ...n, fade: far || p.alpha === 0 || n.alpha === 0 };
    });
  }

  function settle(instant) {
    const next = target();
    if (instant || !current) {
      current = next.map((a) => ({ ...a }));
      from = null; to = next; progress = 1;
    } else {
      from = current.map((a) => ({ ...a }));
      to = plan(from, next);
      duration = Math.max(0.6, Number(props.transition) || 1.4);
      progress = 0;
    }
    dirty = true;
  }

  function step(dt) {
    progress = Math.min(1, progress + dt / duration);
    const n = to.length;
    const lag = 0.05;
    current = to.map((b, i) => {
      const a = from[i];
      const local = clamp01((progress - i * lag) / (1 - (n - 1) * lag));
      if (b.fade) {
        if (local < 0.45) return { ...a, alpha: a.alpha * (1 - ease(local / 0.45)) };
        return { ...b, alpha: b.alpha * ease(clamp01((local - 0.55) / 0.45)) };
      }
      const k = ease(local);
      let turn = b.rot - a.rot;
      return {
        kind: b.kind, x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), s: lerp(a.s, b.s, k),
        l: lerp(a.l, b.l, k), t: lerp(a.t, b.t, k), rot: a.rot + turn * k,
        colour: a.colour.map((c, j) => Math.round(lerp(c, b.colour[j], k))), alpha: lerp(a.alpha, b.alpha, k)
      };
    });
    if (progress >= 1) { current = to.map((a) => ({ ...a, fade: false })); from = null; }
    dirty = true;
  }

  function draw() {
    dirty = false;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!current) return;
    for (const a of current) {
      if (a.alpha <= 0.002) continue;
      g.globalAlpha = a.alpha;
      g.fillStyle = `rgb(${a.colour[0]},${a.colour[1]},${a.colour[2]})`;
      g.beginPath();
      if (a.kind === 'circle') g.arc(a.x, a.y, Math.max(0, a.s), 0, Math.PI * 2);
      else if (a.kind === 'quarter') { g.moveTo(a.x, a.y); g.arc(a.x, a.y, Math.max(0, a.s), a.rot * DEG, (a.rot + 90) * DEG); g.closePath(); }
      else if (a.kind === 'half') { g.moveTo(a.x, a.y); g.arc(a.x, a.y, Math.max(0, a.s), a.rot * DEG, (a.rot + 180) * DEG); g.closePath(); }
      else if (a.kind === 'bar') {
        const c = Math.cos(a.rot * DEG), s = Math.sin(a.rot * DEG);
        const hx = a.l / 2, hy = a.t / 2;
        const pts = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([px, py]) => [a.x + px * c - py * s, a.y + px * s + py * c]);
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < 4; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
      }
      g.fill();
    }
    g.globalAlpha = 1;
  }

  resize();
  settle(true);
  draw();

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  observer?.observe(container);

  const offFrame = ctx.host.onFrame((dt) => {
    if (paused) return;
    alive += dt;
    if (progress < 1) {
      // A machine that draws slowly may stop the frames at any moment: the tableau lands at once.
      if (dt > 0.09 && !ctx.testMode) { current = to.map((a) => ({ ...a, fade: false })); progress = 1; from = null; dirty = true; }
      else step(dt);
    }
    if (dirty || ctx.testMode) draw();
  });

  const offContext = ctx.host.onContext((next) => {
    const key = (c) => (c ? `${c.screen}|${c.section}|${c.variant}` : '');
    if (key(next) === key(context)) { context = next; return; }
    context = next;
    // Under reduced motion, and while the first screen is still settling (a session resumed, a
    // capture), the new tableau stands at once.
    settle(!!ctx.reducedMotion || alive < 1.2);
  });

  return {
    update(nextProps) {
      props = { ...props, ...nextProps };
      settle(!!ctx.reducedMotion);
    },
    getState() {
      return {
        screen: context?.screen ?? null,
        section: context?.section ?? null,
        variant: context?.variant ?? null,
        tableau,
        moved,
        settled: progress >= 1
      };
    },
    setState() {},
    pause() { paused = true; },
    resume() { paused = false; dirty = true; },
    dispose() { offFrame?.(); offContext?.(); observer?.disconnect(); canvas.remove(); }
  };
}
