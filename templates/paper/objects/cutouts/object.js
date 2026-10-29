// Decoration "cutouts" behind the course — Elabora free-object contract 0.1, section 4c.
//
// A paper theatre: hills cut from coloured paper, laid on one another along the bottom of the window,
// a sun, a cloud and a few leaves above them. Every piece casts the soft shadow of a sheet lifted a
// little above the one under it (the light comes from the top left): the higher the layer, the longer
// and softer its shadow. A shadow never changes on its own: it goes where its paper goes.
//
// How it follows the course (host.onContext):
// - at each screen, the hills slide sideways as the scenery of a toy theatre would, the near ones
//   further than the far ones (forward: to the left; back: to the right). The sun does not move: it is
//   far away;
// - at each part, the scene is changed by hand: the pieces of the last part are pulled out (the hills
//   down, the sky up), the near ones first, then the new part's pieces are slid in, the far ones first;
// - the variants « calm » (the hills lowered, the sky cleared) and « night » (deep blue paper, a moon
//   and stars) change the scene the same way.
// Every move is drawn in stop motion: 12 poses a second by default, each piece trembling a little as if
// moved by hand between two poses, then still. At rest nothing is drawn.
//
// It keeps out of the player's bars (ctx.safeArea, host.onSafeArea) and lands at once when frames are
// still (reduced motion, a slow machine: host.still, host.onStill) or on the first screen shown.

const TAU = Math.PI * 2;

// The scenes, one per part (repeated past the fifth), as pieces of paper. y and the hills' tops are
// shares of the room between the bars; x of the width; sizes of the shorter side. depth 1 is the
// sheet laid on the table, 4 the highest.
const SCENES = [
  [ // opening: a bright morning
    { id: 'sun', kind: 'disc', paper: 'mustard', x: 0.87, y: 0.2, r: 0.075, scallop: 14, depth: 1, far: true },
    { id: 'cloud', kind: 'cloud', paper: 'paper', x: 0.08, y: 0.17, r: 0.05, depth: 1, far: true },
    { id: 'h1', kind: 'hill', paper: 'teal', top: 0.8, amp: 0.035, waves: 1.3, phase: 0.6, depth: 1 },
    { id: 'h2', kind: 'hill', paper: 'leaf', top: 0.85, amp: 0.03, waves: 1.7, phase: 2.4, depth: 2 },
    { id: 'h3', kind: 'hill', paper: 'coral', top: 0.9, amp: 0.025, waves: 2.2, phase: 4.1, depth: 3 },
    { id: 'h4', kind: 'hill', paper: 'pink', top: 0.95, amp: 0.018, waves: 3, phase: 1.2, depth: 4 },
    { id: 'l1', kind: 'leaf', paper: 'mustard', x: 0.06, y: 0.86, r: 0.04, turn: -0.5, depth: 3 },
    { id: 'l2', kind: 'leaf', paper: 'mustard', x: 0.93, y: 0.9, r: 0.035, turn: 0.4, depth: 4 }
  ],
  [ // part 1: fields
    { id: 'sun', kind: 'disc', paper: 'coral', x: 0.88, y: 0.18, r: 0.065, depth: 1, far: true },
    { id: 'cloud', kind: 'cloud', paper: 'paper', x: 0.1, y: 0.2, r: 0.045, depth: 1, far: true },
    { id: 'h1', kind: 'hill', paper: 'leaf', top: 0.81, amp: 0.04, waves: 1.1, phase: 1.6, depth: 1 },
    { id: 'h2', kind: 'hill', paper: 'teal', top: 0.86, amp: 0.028, waves: 1.6, phase: 0.3, depth: 2 },
    { id: 'h3', kind: 'hill', paper: 'mustard', top: 0.9, amp: 0.022, waves: 2.4, phase: 3.3, depth: 3 },
    { id: 'h4', kind: 'hill', paper: 'leaf', top: 0.95, amp: 0.016, waves: 3.2, phase: 5.1, depth: 4 },
    { id: 'l1', kind: 'leaf', paper: 'teal', x: 0.07, y: 0.84, r: 0.042, turn: -0.7, depth: 3 },
    { id: 'l2', kind: 'leaf', paper: 'coral', x: 0.94, y: 0.89, r: 0.036, turn: 0.6, depth: 4 }
  ],
  [ // part 2: the sea
    { id: 'sun', kind: 'disc', paper: 'mustard', x: 0.86, y: 0.22, r: 0.07, depth: 1, far: true },
    { id: 'cloud', kind: 'cloud', paper: 'paper', x: 0.12, y: 0.15, r: 0.05, depth: 1, far: true },
    { id: 'h1', kind: 'hill', paper: 'teal', top: 0.82, amp: 0.02, waves: 3.4, phase: 0.2, depth: 1 },
    { id: 'h2', kind: 'hill', paper: 'sky', top: 0.86, amp: 0.02, waves: 4, phase: 1.9, depth: 2 },
    { id: 'h3', kind: 'hill', paper: 'paper', top: 0.9, amp: 0.016, waves: 4.6, phase: 3.6, depth: 3 },
    { id: 'h4', kind: 'hill', paper: 'teal', top: 0.94, amp: 0.016, waves: 5, phase: 0.9, depth: 4 },
    { id: 'l1', kind: 'leaf', paper: 'coral', x: 0.05, y: 0.88, r: 0.04, turn: 1.2, depth: 3 },
    { id: 'l2', kind: 'leaf', paper: 'pink', x: 0.95, y: 0.86, r: 0.034, turn: -1.1, depth: 4 }
  ],
  [ // part 3: autumn
    { id: 'sun', kind: 'disc', paper: 'coral', x: 0.88, y: 0.2, r: 0.07, scallop: 11, depth: 1, far: true },
    { id: 'cloud', kind: 'cloud', paper: 'paper', x: 0.08, y: 0.19, r: 0.046, depth: 1, far: true },
    { id: 'h1', kind: 'hill', paper: 'mustard', top: 0.8, amp: 0.035, waves: 1.4, phase: 2.8, depth: 1 },
    { id: 'h2', kind: 'hill', paper: 'coral', top: 0.85, amp: 0.03, waves: 1.9, phase: 4.6, depth: 2 },
    { id: 'h3', kind: 'hill', paper: 'teal', top: 0.9, amp: 0.024, waves: 2.6, phase: 1.1, depth: 3 },
    { id: 'h4', kind: 'hill', paper: 'mustard', top: 0.95, amp: 0.016, waves: 3.3, phase: 2.2, depth: 4 },
    { id: 'l1', kind: 'leaf', paper: 'coral', x: 0.06, y: 0.85, r: 0.044, turn: 0.8, depth: 3 },
    { id: 'l2', kind: 'leaf', paper: 'leaf', x: 0.93, y: 0.88, r: 0.038, turn: -0.3, depth: 4 }
  ],
  [ // closing: a party
    { id: 'sun', kind: 'disc', paper: 'pink', x: 0.87, y: 0.2, r: 0.075, scallop: 16, depth: 1, far: true },
    { id: 'cloud', kind: 'cloud', paper: 'paper', x: 0.09, y: 0.18, r: 0.05, depth: 1, far: true },
    { id: 'h1', kind: 'hill', paper: 'sky', top: 0.81, amp: 0.034, waves: 1.5, phase: 3.9, depth: 1 },
    { id: 'h2', kind: 'hill', paper: 'mustard', top: 0.85, amp: 0.03, waves: 2, phase: 0.8, depth: 2 },
    { id: 'h3', kind: 'hill', paper: 'teal', top: 0.9, amp: 0.024, waves: 2.5, phase: 2.7, depth: 3 },
    { id: 'h4', kind: 'hill', paper: 'coral', top: 0.95, amp: 0.018, waves: 3.1, phase: 4.4, depth: 4 },
    { id: 'l1', kind: 'leaf', paper: 'pink', x: 0.05, y: 0.87, r: 0.04, turn: -0.9, depth: 3 },
    { id: 'l2', kind: 'leaf', paper: 'coral', x: 0.94, y: 0.86, r: 0.04, turn: 0.9, depth: 4 }
  ]
];

const NIGHT = [
  { id: 'moon', kind: 'disc', paper: 'paper', x: 0.87, y: 0.2, r: 0.06, depth: 1, far: true },
  { id: 'st1', kind: 'star', paper: 'mustard', x: 0.07, y: 0.16, r: 0.022, turn: 0.2, depth: 1, far: true },
  { id: 'st2', kind: 'star', paper: 'mustard', x: 0.12, y: 0.3, r: 0.014, turn: 0.7, depth: 1, far: true },
  { id: 'st3', kind: 'star', paper: 'paper', x: 0.78, y: 0.12, r: 0.012, turn: 0.4, depth: 1, far: true },
  { id: 'n1', kind: 'hill', paper: 'nightPaper', top: 0.82, amp: 0.035, waves: 1.3, phase: 0.6, depth: 1 },
  { id: 'n2', kind: 'hill', paper: 'teal', top: 0.87, amp: 0.028, waves: 1.8, phase: 2.6, depth: 2 },
  { id: 'n3', kind: 'hill', paper: 'nightPaper', top: 0.92, amp: 0.02, waves: 2.6, phase: 4.3, depth: 3 }
];

// A deterministic tremble for each piece at each pose (the same in every run).
function noise(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000 - 0.5;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

export function mount(container, ctx) {
  const { host } = ctx;
  let props = { ...ctx.props };
  let where = ctx.context;
  let area = { ...ctx.safeArea };
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);
  const paint = canvas.getContext('2d');

  let width = container.clientWidth, height = container.clientHeight;

  // The part's scene; a part not found (an index below 0) takes the first one.
  const part = (c) => Math.max(0, c?.sectionIndex ?? 0) % SCENES.length;
  const sceneName = (c) => (c?.variant === 'night' ? 'night' : `part-${part(c)}${c?.variant === 'calm' ? '-calm' : ''}`);

  // The pieces a context asks for, placed: the hills' sideways offset follows the screen's rank.
  function layout(c) {
    const night = c?.variant === 'night';
    const calm = c?.variant === 'calm';
    const pieces = night ? NIGHT : SCENES[part(c)];
    const pan = Math.max(0, c?.screenIndex ?? 0) * props.pan * 140;
    const placed = new Map();
    for (const p of pieces) {
      if (calm && p.kind !== 'hill') continue;
      const q = { ...p, shift: p.far ? 0 : pan * (p.depth / 4) };
      if (p.kind === 'hill' && calm) { q.top = p.top + (1 - p.top) * 0.45; q.amp = p.amp * 0.6; }
      placed.set(p.id, q);
    }
    return { name: sceneName(c), pieces: placed };
  }

  let to = layout(where);
  let from = to;
  let elapsed = 0, duration = 0, pose = -1;

  // The frame's size, read again before every drawing that follows a change: a resize observer only
  // reports on rendered frames, and still frames may have none.
  const measure = () => {
    const w = container.clientWidth || window.innerWidth, h = container.clientHeight || window.innerHeight;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (w === width && h === height && canvas.width === Math.round(w * ratio)) return;
    width = w; height = h;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const resize = () => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    width = container.clientWidth || window.innerWidth; height = container.clientHeight || window.innerHeight;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    pose = -1;
    draw(duration ? elapsed / duration : 1);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  // The bars' room, as the safe area says, but never more than a bar is tall: the scene is anchored
  // to the bottom of the window, its hills' tops just above the bottom bar.
  const bars = () => ({ top: Math.min(area.top || 0, 96), bottom: Math.min(area.bottom || 0, 96) });

  const rgba = (hex, alpha) => {
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  };

  // The piece as it stands at t (0..1) of the passage from one scene to the next.
  function stage(t) {
    const out = [];
    const room = Math.max(1, height - bars().top - bars().bottom);
    const narrow = width < 760;
    // Pieces pulled out first (near before far), pieces slid in after (far before near).
    for (const [id, a] of from.pieces) {
      const b = to.pieces.get(id);
      if (b && b.paper === a.paper && b.kind === a.kind) {
        const k = ease(t);
        const mix = (x, y) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * k;
        out.push({ ...b, shift: mix(a.shift, b.shift), top: mix(a.top, b.top), amp: mix(a.amp, b.amp), x: mix(a.x, b.x), y: mix(a.y, b.y), lift: 0, moving: k > 0 && k < 1 });
      } else {
        const start = (4 - a.depth) * 0.06, k = ease(clamp01((t - start) / 0.42));
        if (k < 1) out.push({ ...a, lift: k, out: true, moving: k > 0 });
      }
    }
    for (const [id, b] of to.pieces) {
      const a = from.pieces.get(id);
      if (a && a.paper === b.paper && a.kind === b.kind) continue;
      const start = 0.42 + (b.depth - 1) * 0.06, k = ease(clamp01((t - start) / 0.42));
      if (k > 0) out.push({ ...b, lift: 1 - k, moving: k < 1 });
    }
    out.sort((p, q) => p.depth - q.depth || (p.kind === 'hill' ? -1 : 1));
    return { out, room, narrow };
  }

  function shape(p, room, narrow, jitter) {
    const top = bars().top, base = Math.min(width, room);
    const sky = p.kind !== 'hill' && (p.far || p.sky);
    const band = props.band;
    // Off the table: the sky goes up, the ground goes down, by a little more than the room.
    const away = p.lift ? p.lift * (sky ? -(p.y + 0.3) * room : room * 0.42 + 40) : 0;
    paint.beginPath();
    if (p.kind === 'hill') {
      const y0 = top + room - (1 - p.top) * room * band + away + jitter.y;
      const amp = p.amp * room * band;
      const span = 1600;
      paint.moveTo(-20, height + 20);
      for (let x = -20; x <= width + 20; x += 16) {
        const u = ((x + p.shift + jitter.x) / span) * TAU * p.waves + p.phase;
        paint.lineTo(x, y0 - amp * Math.sin(u) - amp * 0.35 * Math.sin(u * 2.3 + p.phase * 1.7));
      }
      paint.lineTo(width + 20, height + 20);
      paint.closePath();
      return;
    }
    let x = p.x * width;
    // Pieces on the ground slide with their hill; past an edge they come back at the other (unseen).
    if (!p.far) {
      const m = 80, w = width + 2 * m;
      x = ((((x - p.shift * 1.0 + m) % w) + w) % w) - m;
    }
    x += jitter.x;
    const y = (p.kind === 'leaf' ? top + room - (1 - p.y) * room * band : top + p.y * room) + away + jitter.y;
    const r = p.r * base;
    const turn = (p.turn ?? 0) + jitter.turn;
    if (p.kind === 'disc') {
      if (!p.scallop) { paint.arc(x, y, r, 0, TAU); return; }
      for (let i = 0; i <= p.scallop * 8; i++) {
        const a = (i / (p.scallop * 8)) * TAU + turn;
        const rr = r * (1 + 0.07 * Math.cos((a - turn) * p.scallop));
        paint.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
      }
      paint.closePath();
    } else if (p.kind === 'cloud') {
      paint.arc(x - r * 0.9, y + r * 0.15, r * 0.7, 0, TAU);
      paint.moveTo(x + r, y);
      paint.arc(x, y - r * 0.2, r, 0, TAU);
      paint.moveTo(x + r * 1.55, y + r * 0.15);
      paint.arc(x + r * 0.95, y + r * 0.15, r * 0.6, 0, TAU);
      paint.rect(x - r * 0.9, y + r * 0.1, r * 1.85, r * 0.6);
    } else if (p.kind === 'leaf') {
      const c = Math.cos(turn), s = Math.sin(turn);
      const pt = (u, v) => [x + (u * c - v * s) * r, y + (u * s + v * c) * r];
      paint.moveTo(...pt(-1, 0));
      paint.bezierCurveTo(...pt(-0.5, -0.75), ...pt(0.5, -0.75), ...pt(1, 0));
      paint.bezierCurveTo(...pt(0.5, 0.75), ...pt(-0.5, 0.75), ...pt(-1, 0));
    } else if (p.kind === 'star') {
      for (let i = 0; i < 10; i++) {
        const a = turn + (i / 10) * TAU - Math.PI / 2, rr = i % 2 ? r * 0.45 : r;
        paint.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
      }
      paint.closePath();
    }
  }

  function draw(t) {
    measure();
    if (!canvas.width) return;
    paint.clearRect(0, 0, width, height);
    const { out, room, narrow } = stage(t);
    for (const p of out) {
      // On a phone the page scrolls over the scene: the paper is left plain under the reading.
      if (narrow) continue;
      const jitter = p.moving && props.boil
        ? { x: noise(`${p.id}x${pose}`) * 3 * props.boil, y: noise(`${p.id}y${pose}`) * 3 * props.boil, turn: noise(`${p.id}r${pose}`) * 0.025 * props.boil }
        : { x: 0, y: 0, turn: 0 };
      shape(p, room, narrow, jitter);
      paint.save();
      // The higher the sheet, the longer and softer its shadow; always toward the bottom right.
      paint.shadowColor = rgba(props.shadow, 0.14 + 0.035 * p.depth);
      paint.shadowOffsetX = 1 + 1.1 * p.depth;
      paint.shadowOffsetY = 2 + 1.8 * p.depth;
      paint.shadowBlur = 3 + 3 * p.depth;
      paint.fillStyle = props[p.paper] ?? props.paper;
      paint.fill();
      paint.restore();
    }
  }

  const offFrame = host.onFrame((dt) => {
    if (elapsed >= duration) return;
    elapsed = Math.min(duration, elapsed + dt);
    // Stop motion: a new pose only every 1/fps of a second.
    const next = elapsed >= duration ? Infinity : Math.floor(elapsed * props.fps);
    if (next === pose) return;
    pose = next;
    draw(elapsed >= duration ? 1 : Math.min(1, pose / props.fps / duration));
  });

  // A new place: a passage from what is shown to what the new context asks. Without a direction (the
  // first screen shown, a session resumed) or with still frames, the scene is there at once.
  function go(next) {
    where = next;
    const target = layout(next);
    const still = host.still || ctx.reducedMotion || next?.direction == null;
    // A passage still on its way: the next one starts from where the last was going.
    from = to;
    to = target;
    if (still) { from = to; duration = 0; elapsed = 0; pose = -1; draw(1); return; }
    const sceneChange = from.name !== to.name;
    duration = props.travel * (sceneChange ? 1.6 : 1);
    elapsed = 0; pose = -1;
  }
  const offContext = host.onContext(go);
  const offArea = host.onSafeArea((next) => { area = { ...next }; pose = -1; draw(duration ? Math.min(1, elapsed / duration) : 1); });
  const offStill = host.onStill(() => { from = to; duration = 0; elapsed = 0; draw(1); });
  resize();

  return {
    update(next) { props = { ...props, ...next }; to = layout(where); from = to; duration = 0; draw(1); },
    getState: () => ({ screenIndex: where?.screenIndex ?? 0, sectionIndex: where?.sectionIndex ?? null, scene: to.name }),
    setState() {},
    dispose() { offFrame(); offContext(); offArea(); offStill(); observer.disconnect(); canvas.remove(); }
  };
}
