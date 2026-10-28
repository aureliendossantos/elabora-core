// Drifting blobs: the backdrop of the Organic template.
// Soft gradient blobs drawn as a field of rounded lobes on a small canvas that CSS scales up (the
// upscaling is the blur). Each screen has its own composition, drawn from its id; each part of the
// module its own hue, from warm (first section) to cool (last), by its rank in the course. When the learner moves, the blobs
// migrate to the new composition and glide to the new hue; a blob that would cross the window
// fades out where it was and fades in where it goes instead. Under reduced motion nothing drifts
// and each screen shows its composition at once, as a still image.

const TAU = Math.PI * 2;
const CELL = 8; // CSS px per canvas pixel
const SLOTS = [
  [0.06, 0.1], [0.94, 0.12], [0.08, 0.9], [0.93, 0.88], [0.5, 0.0], [0.52, 1.0], [0.0, 0.5],
  [1.0, 0.46], [0.28, 0.04], [0.74, 0.96], [0.82, 0.32], [0.18, 0.68], [0.66, 0.08], [0.34, 0.94]
];
const HUE_OFFSETS = [0, 22, -18, 10, -28, 32, -8];
const LOBES = 3;

// ── Colour: sRGB ⇄ OKLab/OKLCH ───────────────────────────────────────
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) h = '808080';
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
function rgbToOklch(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}
function oklchToRgb(L, C, h) {
  // Lower the chroma until the colour fits sRGB.
  for (let tries = 0; tries < 16; tries++) {
    const a = C * Math.cos((h * Math.PI) / 180);
    const b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ];
    if (lin.every((c) => c >= -0.001 && c <= 1.001) || tries === 15) return lin.map((c) => Math.round(toGamma(Math.min(1, Math.max(0, c))) * 255));
    C *= 0.85;
  }
  return [128, 128, 128];
}
const hueLerp = (a, b, t) => { const d = ((b - a + 540) % 360) - 180; return (a + d * t + 360) % 360; };
const lerp = (a, b, t) => a + (b - a) * t;
// Colours glide in OKLCH: the hue turns round the wheel instead of passing through grey.
const mixLch = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), hueLerp(a[2], b[2], t)];
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : -(Math.cos(Math.PI * t) - 1) / 2);

// ── Deterministic shuffles (no Math.random: a screen always gets the same composition) ──
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The look of each variant: lightness, chroma, how opaque the blobs are, how much their core lightens.
const MOODS = {
  day: { L: 0.8, chroma: 1.2, maxC: 0.155, alpha: 1, glow: 0.14 },
  pastel: { L: 0.9, chroma: 0.6, maxC: 0.08, alpha: 0.8, glow: 0.2 },
  night: { L: 0.46, chroma: 1.35, maxC: 0.14, alpha: 0.75, glow: 0.12 },
  mono: { L: 0.85, chroma: 0, maxC: 0.03, alpha: 0.85, glow: 0.2 }
};

export function mount(container, ctx) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  container.append(canvas);
  const g = canvas.getContext('2d');

  let props = { ...ctx.props };
  let context = ctx.context || null;
  let W = 0, H = 0, image = null;
  let time = 0;
  let alive = 0; // seconds since mount
  let paused = false;
  let blobs = [];   // { from, to, p, wFrom, wTo, phase… }
  let ghosts = [];  // blobs fading out where they were
  let progress = 1;
  let duration = 1;
  let part = 0, hue = 0;
  let dirty = true;

  function resize() {
    const w = container.clientWidth || window.innerWidth || 960;
    const h = container.clientHeight || window.innerHeight || 600;
    const nw = Math.max(16, Math.min(320, Math.ceil(w / CELL)));
    const nh = Math.max(16, Math.min(320, Math.ceil(h / CELL)));
    if (nw === W && nh === H) return;
    W = nw; H = nh;
    canvas.width = W; canvas.height = H;
    image = g.createImageData(W, H);
    dirty = true;
  }

  // Where the learner is → the part's place on the journey (0 the first section, 1 the last: its
  // rank in the course) and its hue. A screen outside any section keeps the hue it had.
  function partOf(where) {
    const index = where?.sectionIndex, count = where?.sectionCount;
    if (!Number.isInteger(index) || !Number.isInteger(count)) return part;
    return count > 1 ? Math.min(1, index / (count - 1)) : 0;
  }
  function journeyColour(t) {
    const [w, m, c] = [props.warm, props.middle, props.cool].map((x) => rgbToOklch(hexToRgb(x)));
    const [a, b, u] = t <= 0.5 ? [w, m, t * 2] : [m, c, (t - 0.5) * 2];
    return { C: lerp(a[1], b[1], u), h: hueLerp(a[2], b[2], u) };
  }

  // The composition of a screen: slots near the edges, so that the reading column stays calm.
  function compose(where) {
    const screen = where?.screen || '';
    const variant = where?.variant || 'day';
    const mood = MOODS[variant] || MOODS.day;
    const t = partOf(where);
    const tone = journeyColour(t);
    const ink = rgbToOklch(hexToRgb(props.ink));
    const cool = rgbToOklch(hexToRgb(props.cool));
    const random = generator(hash(`${screen}#${props.seed || 0}`));
    const slots = SLOTS.map((slot) => [slot, random()]).sort((x, y) => x[1] - y[1]).map((x) => x[0]);
    const step = Math.max(1, Number(where?.step) || 1);
    const nudge = random() * TAU;
    const count = Math.max(3, Math.min(7, Math.round(props.count || 5)));
    const targets = [];
    for (let i = 0; i < count; i++) {
      const [u, v] = slots[i % slots.length];
      // Each step of the screen moves the composition a little: the module advances.
      const angle = nudge + i * 2.1;
      const shift = (step - 1) * 0.035;
      const x = u + (random() - 0.5) * 0.1 + Math.cos(angle + step) * shift;
      const y = v + (random() - 0.5) * 0.1 + Math.sin(angle + step) * shift;
      const r = 0.17 + random() * 0.13;
      const lift = (random() - 0.5) * 0.06;
      let h = variant === 'mono' ? ink[2] : (tone.h + HUE_OFFSETS[i % HUE_OFFSETS.length] + 360) % 360;
      // At night the parts keep a quarter of their hue and lean to the cool tone: deep teals and blues.
      if (variant === 'night') h = (hueLerp(cool[2], tone.h, 0.25) + HUE_OFFSETS[i % HUE_OFFSETS.length] + 360) % 360;
      // No violet: hues past blue lean back to it.
      if (variant !== 'mono' && h > 255 && h < 345) h = h < 300 ? 255 - (h - 255) * 0.2 : 345 + (h - 345) * 0.2;
      const C = variant === 'mono' ? Math.min(ink[1], 0.02) + 0.012 : Math.min(mood.maxC, tone.C * mood.chroma);
      // Yellows and yellow-greens turn olive when dark: they get lighter.
      const fresh = variant === 'mono' || variant === 'night' ? 0 : 0.07 * Math.exp(-(((h - 100) / 32) ** 2));
      const L = mood.L + fresh + (variant === 'mono' ? (i % 3 - 1) * 0.035 : lift);
      targets.push({
        x, y, r,
        top: [Math.min(0.97, L + 0.035), C * 0.9, (h + 352) % 360],
        bottom: [L - 0.04, C * 1.08, (h + 12) % 360],
        alpha: mood.alpha,
        glow: mood.glow
      });
    }
    return { targets, t, hue: Math.round(variant === 'mono' ? ink[2] : tone.h) };
  }

  function snapshot(blob) {
    const k = ease(progress);
    const a = blob.from, b = blob.to;
    return {
      x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), r: lerp(a.r, b.r, k),
      top: mixLch(a.top, b.top, k), bottom: mixLch(a.bottom, b.bottom, k),
      alpha: lerp(a.alpha, b.alpha, k), glow: lerp(a.glow, b.glow, k)
    };
  }
  const weightOf = (blob) => lerp(blob.wFrom, blob.wTo, ease(progress));

  // Move to where the learner is now. instant: no migration (first frame, a new number of blobs).
  function arrive(instant) {
    const { targets, t, hue: h } = compose(context);
    part = t; hue = h;
    const still = !!ctx.reducedMotion;
    const S = Math.sqrt(W * H) || 1;
    // Under reduced motion the new composition replaces the old one at once: still images only.
    if (instant || still || blobs.length !== targets.length) {
      blobs = targets.map((target, i) => ({ from: target, to: target, wFrom: 1, wTo: 1, phase: hash(`phase${i}`) / 4294967296 * TAU, spin: i % 2 ? 1 : -1 }));
      ghosts = [];
      progress = 1;
      dirty = true;
      return;
    }
    const current = blobs.map((blob) => ({ blob, at: snapshot(blob), w: weightOf(blob) }));
    // The ghosts of an earlier change finish fading where they are.
    ghosts = ghosts.map((ghost) => { const at = snapshot(ghost); return { ...ghost, from: at, to: at, wFrom: weightOf(ghost), wTo: 0 }; }).filter((ghost) => ghost.wFrom > 0.02);
    // Pair each blob with the nearest free target, shortest moves first.
    const pairs = [];
    current.forEach((c, i) => targets.forEach((target, j) => pairs.push([Math.hypot((c.at.x - target.x) * W, (c.at.y - target.y) * H) / S, i, j])));
    pairs.sort((a, b) => a[0] - b[0]);
    const takenBlob = new Set(), takenTarget = new Set();
    const next = new Array(blobs.length);
    for (const [distance, i, j] of pairs) {
      if (takenBlob.has(i) || takenTarget.has(j)) continue;
      takenBlob.add(i); takenTarget.add(j);
      const c = current[i];
      const target = targets[j];
      // A blob that would cross the window: a fade, not a flight.
      if (distance > 0.62) {
        if (c.w > 0.02) ghosts.push({ from: c.at, to: { ...c.at }, wFrom: c.w, wTo: 0, phase: c.blob.phase, spin: c.blob.spin });
        next[i] = { from: target, to: target, wFrom: 0, wTo: 1, phase: c.blob.phase, spin: c.blob.spin };
      } else {
        next[i] = { from: c.at, to: target, wFrom: c.w, wTo: 1, phase: c.blob.phase, spin: c.blob.spin };
      }
    }
    blobs = next;
    progress = 0;
    duration = Math.max(0.8, Number(props.transition) || 2.4);
    dirty = true;
  }

  function draw() {
    if (!image) return;
    const data = image.data;
    const S = Math.sqrt(W * H) * 0.75;
    const amplitude = (Number(props.drift) || 0) * 0.05 * S;
    const lobes = [];
    const add = (blob, w) => {
      if (w <= 0.01) return;
      const b = snapshot(blob);
      const top = oklchToRgb(...b.top), bottom = oklchToRgb(...b.bottom);
      const breathe = 1 + 0.04 * Math.sin(time * TAU / 21 + blob.phase);
      const cx = b.x * W + Math.sin(time * TAU / (29 + blob.phase * 4) + blob.phase) * amplitude;
      const cy = b.y * H + Math.cos(time * TAU / (37 + blob.phase * 3) + blob.phase * 1.7) * amplitude;
      const r = b.r * S * breathe;
      for (let k = 0; k < LOBES; k++) {
        const satellite = k > 0;
        const angle = blob.phase + k * 2.4 + blob.spin * time * TAU / (46 + k * 9);
        const x = satellite ? cx + Math.cos(angle) * r * 0.45 : cx;
        const y = satellite ? cy + Math.sin(angle) * r * 0.38 : cy;
        const radius = (satellite ? r * 0.64 : r) * 2; // support of the kernel
        lobes.push({ x, y, R2: radius * radius, w, top, bottom, y0: cy - r, span: 2 * r, alpha: b.alpha, glow: b.glow });
      }
    };
    for (const ghost of ghosts) add(ghost, weightOf(ghost));
    for (const blob of blobs) add(blob, weightOf(blob));
    const n = lobes.length;
    let alphaMax = 0.9, glow = 0.2;
    if (n) { alphaMax = lobes.reduce((s, l) => s + l.alpha, 0) / n; glow = lobes.reduce((s, l) => s + l.glow, 0) / n; }
    let o = 0;
    for (let y = 0; y < H; y++) {
      const py = y + 0.5;
      for (let x = 0; x < W; x++, o += 4) {
        const px = x + 0.5;
        let F = 0, R = 0, G = 0, B = 0;
        for (let i = 0; i < n; i++) {
          const l = lobes[i];
          const dx = px - l.x, dy = py - l.y;
          const q = (dx * dx + dy * dy) / l.R2;
          if (q >= 1) continue;
          const f = (1 - q) * (1 - q) * (1 - q) * l.w;
          const v = Math.min(1, Math.max(0, (py - l.y0) / l.span));
          F += f;
          R += f * (l.top[0] + (l.bottom[0] - l.top[0]) * v);
          G += f * (l.top[1] + (l.bottom[1] - l.top[1]) * v);
          B += f * (l.top[2] + (l.bottom[2] - l.top[2]) * v);
        }
        if (F < 0.06) { data[o + 3] = 0; continue; }
        const core = smoothstep(0.7, 1.8, F) * glow;
        data[o] = R / F + (255 - R / F) * core;
        data[o + 1] = G / F + (255 - G / F) * core;
        data[o + 2] = B / F + (255 - B / F) * core;
        data[o + 3] = smoothstep(0.16, 0.42, F) * alphaMax * 255;
      }
    }
    g.putImageData(image, 0, 0);
    dirty = false;
  }

  resize();
  arrive(true);
  draw();

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); }) : null;
  observer?.observe(container);

  const offFrame = ctx.host.onFrame((dt) => {
    if (paused) return;
    alive += dt;
    const moving = !ctx.reducedMotion && (Number(props.drift) || 0) > 0;
    if (moving) time += dt;
    if (progress < 1) {
      progress = Math.min(1, progress + dt / duration);
      if (progress >= 1) ghosts = [];
      dirty = true;
    }
    if (moving || dirty || ctx.testMode) draw();
  });
  const offContext = ctx.host.onContext((next) => {
    const key = (c) => (c ? `${c.screen}|${c.section}|${c.step}|${c.variant}` : '');
    if (key(next) === key(context)) return;
    context = next;
    // Right after the course opens (a session resumed on a later screen), land at once: no journey
    // from a screen the learner never saw.
    arrive(alive < 1.2);
  });

  return {
    update(nextProps) {
      const recount = nextProps.count !== props.count;
      props = { ...nextProps };
      arrive(recount);
    },
    getState() {
      return {
        screen: context?.screen ?? null,
        section: context?.section ?? null,
        variant: context?.variant ?? null,
        part: Math.round(part * 100) / 100,
        hue,
        settled: progress >= 1 && ghosts.length === 0
      };
    },
    setState() {},
    pause() { paused = true; },
    resume() { paused = false; dirty = true; },
    dispose() {
      offFrame();
      offContext();
      observer?.disconnect();
      canvas.remove();
    }
  };
}
