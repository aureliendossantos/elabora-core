// Decoration "Watercolour blooms" behind the course — Elabora free-object contract 0.1, § 4c.
// Washes of water tones bloom on the paper. At each new screen, fresh washes spread from where the
// last ones were, as wet paint runs into the paper, while those of the screen before dry into pale
// stains; a new part brings its own tone. Going back, nothing un-spreads: the washes of the screen
// left fade out and those of the screen found again fade in. It draws on a 2D canvas, out of the
// player's bars, and only while something changes; still frames land at once.
import { wash, extent } from './wash.js';

// ── Composition ──
// Spots around the edges of the room between the bars (0..1), so the reading area stays light.
// The first wash of a screen sits where the second wash of the screen before was: paint carries on.
const SPOTS = [
  [0.88, 0.16], [0.93, 0.8], [0.08, 0.88], [0.12, 0.14],
  [0.62, 0.96], [0.98, 0.48], [0.42, 0.04], [0.02, 0.52]
];
const JOURNEY = ['lagoon', 'cerulean', 'sea', 'deep'];

function tones(where) {
  const variant = where?.variant;
  if (variant === 'dawn') return ['blush', 'ochre', 'lagoon'];
  const index = where?.sectionIndex;
  const count = where?.sectionCount ?? 1;
  if (index == null || index === 0) return ['lagoon', 'cerulean', 'blush'];
  if (count > 2 && index === count - 1) return ['lagoon', 'blush', 'ochre'];
  return [JOURNEY[index % 4], JOURNEY[(index + 1) % 4], JOURNEY[(index + 3) % 4]];
}

function composition(where, screenIndex, count) {
  const list = [];
  const cover = screenIndex === 0;
  const total = cover ? count + 1 : count;
  const colours = tones(where);
  for (let k = 0; k < total; k++) {
    const seed = 7919 + screenIndex * 131 + k * 17;
    const jitter = ((seed * 2654435761) >>> 0) / 4294967296;
    const [sx, sy] = SPOTS[(screenIndex * 3 + k * 3) % SPOTS.length];
    // Drawn a little toward the middle, more for the wash that carries on from the screen before.
    const pull = k === 0 && !cover ? 0.1 : 0.03;
    list.push({
      key: `${screenIndex}:${k}`,
      seed,
      x: sx + (0.5 - sx) * pull + (jitter - 0.5) * 0.06,
      y: sy + (0.5 - sy) * pull + (jitter - 0.5) * 0.08,
      // Washes near the middle of an edge stay smaller: they would reach the text.
      r: ((k === 0 ? 0.34 : 0.27) + jitter * 0.08 + (cover ? 0.06 : 0)) * (Math.abs(sx - 0.5) < 0.25 ? 0.7 : 1),
      tone: colours[k % colours.length]
    });
  }
  return list;
}

export function mount(container, ctx) {
  const { host } = ctx;
  let props = { ...ctx.props };
  let where = ctx.context;
  let area = { top: 0, bottom: 0, ...ctx.safeArea };
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);
  const paint = canvas.getContext('2d');

  // ── Size ──
  let width = container.clientWidth, height = container.clientHeight, ratio = 1;
  const scale = () => Math.max(Math.min(width, height), 0.62 * Math.max(width, height));
  const images = new Map();
  const resize = () => {
    ratio = Math.min(2, window.devicePixelRatio || 1);
    width = container.clientWidth; height = container.clientHeight;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    images.clear();
    dirty = true;
    draw();
  };

  // ── One wash, painted once ──
  // The glazes are laid on a canvas of their own; each frame only places that picture, clipped to
  // the outline the paint has reached.
  const shapes = new Map();
  const shapeOf = (seed) => {
    if (!shapes.has(seed)) shapes.set(seed, wash(seed, { layers: 22, detail: 3 }));
    return shapes.get(seed);
  };
  function picture(entry) {
    const id = `${entry.seed}|${entry.tone}|${entry.mode}`;
    if (images.has(id)) return images.get(id);
    const shape = shapeOf(entry.seed);
    const radius = entry.r * scale() * ratio;
    const reach = Math.max(...shape.glazes.map(extent), extent(shape.base)) * 1.05;
    const size = Math.max(2, Math.ceil(radius * reach * 2));
    const sheet = document.createElement('canvas');
    sheet.width = size; sheet.height = size;
    const brush = sheet.getContext('2d');
    const trace = (points) => {
      brush.beginPath();
      points.forEach((p, i) => (i ? brush.lineTo(size / 2 + p.x * radius, size / 2 + p.y * radius) : brush.moveTo(size / 2 + p.x * radius, size / 2 + p.y * radius)));
      brush.closePath();
    };
    const colour = props[entry.tone] ?? props.lagoon;
    brush.fillStyle = colour; brush.strokeStyle = colour;
    brush.lineWidth = 1.4 * ratio;
    shape.glazes.forEach((glaze, i) => {
      trace(glaze);
      brush.globalAlpha = 0.055;
      brush.fill();
      if (i >= shape.glazes.length - 3) { brush.globalAlpha = 0.05; brush.stroke(); }
    });
    // Back-runs: water pushed the pigment out of a pool and left a darker rim around it.
    for (const pool of shape.pools) {
      trace(pool);
      brush.globalCompositeOperation = 'destination-out';
      brush.globalAlpha = 0.22; brush.fill();
      brush.globalCompositeOperation = 'source-over';
      brush.globalAlpha = 0.16; brush.stroke();
    }
    const made = { sheet, size, radius };
    images.set(id, made);
    return made;
  }

  // ── What is on the paper ──
  // Each wash has a reach (0: a drop, 1: spread out) and an opacity going toward its target.
  const entries = new Map();
  let dirty = true;
  const moving = () => !(host.still || ctx.reducedMotion);

  function plan(next, previous) {
    const count = props.count;
    const index = next?.screenIndex ?? 0;
    const mode = next?.variant === 'quiet' ? 'quiet' : next?.variant === 'ink' ? 'ink' : 'paper';
    const wanted = new Map();
    for (const b of composition(next, index, count)) wanted.set(`${b.key}|${mode}|${b.tone}`, { ...b, mode, target: 1, current: true });
    // The screen before, in the same part, stays as a pale stain.
    if (index > 0) {
      const before = { ...next, screenIndex: index - 1 };
      for (const b of composition(before, index - 1, count)) wanted.set(`${b.key}|${mode}|${b.tone}`, { ...b, mode, target: 0.38, current: false });
    }
    const spreads = moving() && next?.direction === 'forward' && previous != null;
    for (const [id, entry] of entries) if (!wanted.has(id)) entry.target = 0;
    for (const [id, b] of wanted) {
      const entry = entries.get(id);
      if (entry) { entry.target = b.target; continue; }
      const fresh = spreads && b.current;
      entries.set(id, { ...b, reach: fresh ? 0 : 1, opacity: fresh ? 1 : 0 });
    }
    if (!moving() || next?.direction == null) settle();
    dirty = true;
  }

  function settle() {
    for (const [id, entry] of entries) {
      entry.reach = 1; entry.opacity = entry.target;
      if (entry.target === 0) entries.delete(id);
    }
  }

  // ── Drawing ──
  function draw() {
    if (!canvas.width) return;
    paint.setTransform(1, 0, 0, 1, 0, 0);
    paint.clearRect(0, 0, canvas.width, canvas.height);
    const top = area.top * ratio, bottom = area.bottom * ratio;
    const room = Math.max(1, canvas.height - top - bottom);
    paint.save();
    paint.beginPath(); paint.rect(0, top, canvas.width, room); paint.clip();
    const strength = props.strength;
    for (const entry of [...entries.values()].sort((a, b) => Number(b.current === false) - Number(a.current === false) || 0)) {
      if (entry.opacity <= 0.001) continue;
      const quiet = entry.mode === 'quiet';
      const ink = entry.mode === 'ink';
      const spread = quiet ? 1.14 : 1;
      const cx = (0.5 + (entry.x - 0.5) * spread) * canvas.width;
      const cy = top + (0.5 + (entry.y - 0.5) * spread) * room;
      const shown = picture(entry);
      const alpha = entry.opacity * strength * (quiet ? 0.5 : ink ? 0.36 : 1);
      paint.globalCompositeOperation = ink ? 'screen' : 'multiply';
      if (entry.reach >= 1) {
        paint.globalAlpha = alpha;
        paint.drawImage(shown.sheet, cx - shown.size / 2, cy - shown.size / 2);
        continue;
      }
      // The wet front: the outline the paint has reached, a little softer just past it.
      const shape = shapeOf(entry.seed);
      const towardX = Math.sign(entry.x - 0.5) * 0.35, towardY = Math.sign(entry.y - 0.5) * 0.3;
      // The drop falls off-centre, toward the edge of the window, and the paint runs inward.
      const ox = cx + towardX * shown.radius * (1 - entry.reach), oy = cy + towardY * shown.radius * (1 - entry.reach);
      const reach = 1.8 * entry.reach;
      for (const [grow, share] of [[1.12, 0.35], [1, 1]]) {
        paint.save();
        paint.beginPath();
        shape.base.forEach((p, i) => {
          const x = ox + p.x * shown.radius * reach * grow;
          const y = oy + p.y * shown.radius * reach * grow;
          if (i) paint.lineTo(x, y); else paint.moveTo(x, y);
        });
        paint.closePath(); paint.clip();
        paint.globalAlpha = alpha * share;
        paint.drawImage(shown.sheet, cx - shown.size / 2, cy - shown.size / 2);
        paint.restore();
      }
    }
    // The washes thin out before the bars rather than stopping on a straight line.
    const fade = Math.min(room / 4, 56 * ratio);
    paint.globalCompositeOperation = 'destination-out';
    paint.globalAlpha = 1;
    for (const [from, to] of [[top, top + fade], [top + room, top + room - fade]]) {
      const thin = paint.createLinearGradient(0, from, 0, to);
      thin.addColorStop(0, props.lagoon);
      thin.addColorStop(1, 'transparent');
      paint.fillStyle = thin;
      paint.fillRect(0, Math.min(from, to), canvas.width, fade);
    }
    paint.restore();
    paint.globalAlpha = 1;
    paint.globalCompositeOperation = 'source-over';
    dirty = false;
  }

  // ── Time ──
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const offFrame = host.onFrame((dt) => {
    let changed = dirty;
    const spreadRate = dt / Math.max(0.1, props.spread);
    const fadeRate = dt / Math.max(0.1, props.fade);
    for (const [id, entry] of entries) {
      if (entry.reach < 1) {
        entry.linear = Math.min(1, (entry.linear ?? 0) + spreadRate);
        entry.reach = entry.linear >= 1 ? 1 : easeOut(entry.linear);
        changed = true;
      }
      if (entry.opacity !== entry.target) {
        const step = Math.sign(entry.target - entry.opacity) * fadeRate;
        entry.opacity = Math.abs(entry.target - entry.opacity) <= Math.abs(step) ? entry.target : entry.opacity + step;
        changed = true;
      }
      if (entry.opacity === 0 && entry.target === 0) entries.delete(id);
    }
    if (changed || ctx.testMode) draw();
  });

  const offContext = host.onContext((next) => { const previous = where; where = next; plan(next, previous); });
  const offArea = host.onSafeArea((next) => { area = { top: 0, bottom: 0, ...next }; dirty = true; });
  const offStill = host.onStill(() => { settle(); dirty = true; });
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  plan(where, null);
  resize();

  return {
    update(next) {
      const recolour = Object.keys(next).some((key) => next[key] !== props[key]);
      props = { ...props, ...next };
      if (recolour) images.clear();
      plan(where, where);
      settle();
      dirty = true;
    },
    getState: () => ({
      screen: where?.screen ?? null,
      section: where?.section ?? null,
      variant: where?.variant ?? null,
      washes: [...entries.values()].filter((e) => e.current && e.target > 0).length,
      settled: [...entries.values()].every((e) => e.reach >= 1 && e.opacity === e.target)
    }),
    setState() {},
    dispose() { offFrame(); offContext(); offArea(); offStill(); observer.disconnect(); images.clear(); canvas.remove(); }
  };
}
