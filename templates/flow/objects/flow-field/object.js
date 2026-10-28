// Flow field — the decoration of the Flow charter (theme.backdrop.object).
// Two bundles of luminous lines undulate low in the window and particles float across it. At each new
// screen the particles stretch into streaks and speed up, as in a leap forward, then settle; going back,
// they leap the other way. A new part leaps a little further and moves the palette from the first colour
// towards the second; a step revealed is a small nudge. Variants: "calm" (fewer, dimmer particles, a
// softer leap) and "ink" (dark ink on light paper). Under reduced motion the frame shows still frames:
// particles are dots, nothing leaps.

const BASE_DRIFT = 0.011;   // screen widths per second, for the nearest particle
const LEAP = 30;            // speed multiplier at the top of a full leap
const TRAIL = 0.16;         // seconds of motion a streak shows

export function mount(container, ctx) {
  const { host } = ctx;
  let props = { ...ctx.props };
  const reduced = !!ctx.reducedMotion;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
  // The frame's root has no height of its own: the field fills the frame.
  container.style.position = 'absolute';
  container.style.inset = '0';
  container.style.overflow = 'hidden';
  container.append(canvas);
  const g = canvas.getContext('2d');

  let W = 1;
  let H = 1;
  let dpr = 1;
  const resize = () => {
    dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    W = Math.max(1, container.clientWidth || window.innerWidth);
    H = Math.max(1, container.clientHeight || window.innerHeight);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // Particles, seeded by the host: x and y in [0, 1] of the window, z the depth (near particles are
  // larger, brighter and faster), t their place between the two colours.
  const MAX = 280;
  const particles = [];
  for (let i = 0; i < MAX; i++) {
    const z = 0.22 + 0.78 * Math.pow(host.random(), 1.6);
    particles.push({ x: host.random(), y: host.random(), z, t: host.random(), phase: host.random() * Math.PI * 2, keep: host.random() });
  }

  // Where the learner is, and what it does to the field.
  let context = ctx.context || null;
  const seenScreens = [];
  const seenSections = [];
  if (context?.screen) seenScreens.push(context.screen);
  if (context?.section) seenSections.push(context.section);
  const variantOf = (c) => (c && c.variant) || null;
  const isLight = (hex) => {
    const [r, gg, b] = rgb(hex);
    return 0.2126 * r + 0.7152 * gg + 0.0722 * b > 150;
  };
  const inkWanted = () => variantOf(context) === 'ink' || isLight(props.field);
  const biasOf = (section) => {
    const i = Math.max(0, seenSections.indexOf(section));
    return Math.min(0.85, 0.18 + 0.22 * i);
  };

  let calm = variantOf(context) === 'calm' ? 1 : 0;
  let calmTarget = calm;
  let ink = inkWanted();
  let vis = 1;              // fades out and in when the ink variant comes or goes
  let bias = biasOf(context?.section);
  let biasTarget = bias;
  let boost = 0;            // signed: > 0 forward, < 0 back
  let boostTarget = 0;
  let clock = 0;            // the lines' own time, which runs faster in a leap

  function leap(direction, strength) {
    if (reduced || props.jump <= 0) return;
    boostTarget = direction * LEAP * props.jump * strength * (1 - 0.45 * calmTarget);
  }

  function direction(from, to) {
    const order = Array.isArray(props.order) ? props.order : [];
    const a = order.indexOf(from);
    const b = order.indexOf(to);
    if (a >= 0 && b >= 0) return b > a ? 1 : -1;
    const sa = seenScreens.indexOf(from);
    const sb = seenScreens.indexOf(to);
    return sa >= 0 && sb >= 0 && sb < sa ? -1 : 1;
  }

  function onContext(next) {
    const previous = context;
    context = next || null;
    if (!context) return;
    if (context.section && !seenSections.includes(context.section)) seenSections.push(context.section);
    const newScreen = previous && context.screen !== previous.screen;
    const newSection = previous && context.section !== previous.section;
    if (newScreen) {
      const dir = direction(previous.screen, context.screen);
      leap(dir, newSection ? 1.3 : 1);
    } else if (previous && (context.step ?? 0) !== (previous.step ?? 0)) {
      leap((context.step ?? 0) > (previous.step ?? 0) ? 1 : -1, 0.28);
    }
    if (context.screen && !seenScreens.includes(context.screen)) seenScreens.push(context.screen);
    calmTarget = variantOf(context) === 'calm' ? 1 : 0;
    biasTarget = biasOf(context.section);
    if (reduced) { calm = calmTarget; bias = biasTarget; ink = inkWanted(); }
  }
  const offContext = host.onContext(onContext);

  function draw() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (vis <= 0) return;
    const A = rgb(ink ? props.inkA : props.colorA);
    const B = rgb(ink ? props.inkB : props.colorB);
    g.globalCompositeOperation = ink ? 'source-over' : 'lighter';
    g.lineCap = 'round';
    const intensity = vis * (1 - 0.5 * calm) * (ink ? 0.75 : 1);

    // Luminous lines: two bundles of slow waves, low in the window, out of the way of the text.
    const lineAlpha = props.lines * intensity;
    if (lineAlpha > 0.001) {
      const grad = g.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, css(A, 1));
      grad.addColorStop(Math.min(0.95, Math.max(0.05, 1 - bias)), css(mix(A, B, 0.5), 1));
      grad.addColorStop(1, css(B, 1));
      g.strokeStyle = grad;
      const bundles = [
        { y: 0.74, a: 0.055, k: 1.15, w: 0.16, spread: 0.0065, n: 11, alpha: 0.42 },
        { y: 0.83, a: 0.04, k: 1.7, w: -0.11, spread: 0.009, n: 8, alpha: 0.22 }
      ];
      const step = Math.max(8, Math.round(W / 140));
      for (const b of bundles) {
        for (let i = 0; i < b.n; i++) {
          const f = i / (b.n - 1);
          g.globalAlpha = lineAlpha * b.alpha * (0.35 + 0.65 * Math.sin(Math.PI * f));
          g.lineWidth = i === Math.floor(b.n / 2) ? 1.6 : 1;
          g.beginPath();
          for (let x = -step; x <= W + step; x += step) {
            const u = x / W;
            const y = H * (b.y + b.spread * (i - b.n / 2)
              + b.a * Math.sin(2 * Math.PI * b.k * u + clock * b.w * 6 + f * 0.9)
              + b.a * 0.45 * Math.sin(2 * Math.PI * (b.k * 2.3) * u - clock * b.w * 4 + f * 2.1));
            if (x === -step) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke();
        }
      }
    }

    // Particles: dots at rest, streaks in a leap, drawn behind their motion.
    const count = Math.round(MAX * props.density);
    const keepCalm = 1 - 0.55 * calm;
    const speed = Math.abs(boost);
    for (let i = 0; i < count; i++) {
      const p = particles[i];
      if (p.keep > keepCalm) continue;
      const vx = -(BASE_DRIFT + BASE_DRIFT * boost) * p.z * W;
      const len = reduced ? 0 : Math.abs(vx) * TRAIL;
      const x = p.x * W;
      const y = p.y * H + Math.sin(clock * 0.35 + p.phase) * 6 * p.z;
      const c = mix(A, B, smooth(0.8 - bias, 1.2 - bias, p.t));
      g.globalAlpha = Math.min(1, intensity * (0.25 + 0.6 * p.z) * (1 + Math.min(0.6, speed / LEAP)));
      g.strokeStyle = css(c, 1);
      g.lineWidth = (1 + 2.1 * p.z) * (ink ? 0.9 : 1);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - Math.sign(vx) * Math.max(0.01, len), y);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  const stop = host.onFrame((dt) => {
    const d = Math.min(0.1, Math.max(0, dt || 0));
    if (!reduced) {
      // The leap: the target falls back to calm, the speed follows it a little behind.
      boostTarget *= Math.exp(-d / 0.42);
      boost += (boostTarget - boost) * (1 - Math.exp(-d / 0.13));
      calm += (calmTarget - calm) * (1 - Math.exp(-d / 0.6));
      bias += (biasTarget - bias) * (1 - Math.exp(-d / 1.4));
      const wantInk = inkWanted();
      if (wantInk !== ink) { vis -= d / 0.3; if (vis <= 0) { vis = 0; ink = wantInk; } }
      else vis = Math.min(1, vis + d / 0.45);
      clock += d * (1 + 0.12 * boost);
      for (const p of particles) {
        p.x += -(BASE_DRIFT + BASE_DRIFT * boost) * p.z * d;
        if (p.x < -0.06) p.x += 1.12;
        else if (p.x > 1.06) p.x -= 1.12;
      }
    } else {
      ink = inkWanted();
    }
    draw();
  });

  draw();

  return {
    update(next) { props = { ...props, ...next }; if (reduced) ink = inkWanted(); draw(); },
    getState() { return {}; },
    setState() {},
    dispose() { stop(); offContext(); ro.disconnect(); canvas.remove(); }
  };
}

function rgb(hex) {
  const s = String(hex || '').replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function css(c, a) { return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`; }
function smooth(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
