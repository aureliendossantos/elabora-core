// Accent rule: the one movement of the Clear template.
// A rail of hairline segments, one per part of the module, runs under the top bar across the
// width of the grid. A short rule in the accent colour underlines the part the learner is in.
// When the learner reaches the next or the previous part, the rule slides to its segment; when
// they jump further (the outline, a relaunch), a slide across the window would be unrealistic, so
// the rule fades out where it was and fades in where it goes. Under reduced motion, and in still
// mode, it is drawn at its place at once. Nothing else moves.

const SLIDE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2); // ease in-out (cubic)
const FADE = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return [128, 128, 128];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (rgb, alpha) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;

export function mount(container, ctx) {
  const { host } = ctx;
  let props = { ...ctx.props };
  const reduced = Boolean(ctx.reducedMotion);

  // The frame's root has no height of its own: take the whole frame.
  container.style.position = 'absolute';
  container.style.inset = '0';
  container.style.overflow = 'hidden';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.append(canvas);
  const g = canvas.getContext('2d');

  // Where the rule is, in segment units (0 is the first part), and how it moves.
  let context = ctx.context || null;
  let index = null;        // the segment of the current part, or null before any known part
  let shownAt = null;      // the segment drawn now (a fraction while it slides)
  let motion = null;       // { kind: 'slide' | 'fade', from, to, t, duration }
  let dark = isDark(context);
  let darkness = dark ? 1 : 0; // 0 light, 1 dark: the inks glide between the two
  let width = 0, height = 0, ratio = 1, dirty = true;

  function isDark(where) { return Boolean(where && props.darkVariants.includes(where.variant)); }
  function sections() { return Array.isArray(props.sections) ? props.sections : []; }
  function rem() { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; }

  function place(where, animate) {
    context = where || null;
    const next = context && context.section ? sections().indexOf(context.section) : -1;
    const nowDark = isDark(context);
    if (nowDark !== dark) { dark = nowDark; if (!animate) darkness = dark ? 1 : 0; }
    // A section outside the list keeps the rule where it was.
    if (next < 0 || next === index) { dirty = true; return; }
    const from = shownAt;
    index = next;
    if (!animate || from === null) { shownAt = index; motion = null; dirty = true; return; }
    const distance = Math.abs(index - Math.round(from));
    const seconds = Math.max(0.2, Number(props.duration) || 0.7);
    motion = distance <= 1
      ? { kind: 'slide', from, to: index, t: 0, duration: seconds }
      : { kind: 'fade', from: Math.round(from), to: index, t: 0, duration: seconds * 0.9 };
    dirty = true;
  }

  function resize() {
    const r = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    if (w === width && h === height && r === ratio) return;
    width = w; height = h; ratio = r;
    canvas.width = Math.round(w * r);
    canvas.height = Math.round(h * r);
    dirty = true;
  }

  // The rail's geometry in CSS px: centred on the grid, as wide as the wide column.
  function geometry() {
    const unit = rem();
    const narrow = width < 760;
    const gutter = (narrow ? 1 : 2) * unit;
    const railWidth = Math.min(Number(props.width) * unit, width - 2 * gutter);
    const left = Math.round((width - railWidth) / 2);
    const count = Math.max(1, sections().length);
    const gap = Math.round(0.5 * unit);
    const segment = (railWidth - gap * (count - 1)) / count;
    const offset = Number(props.offset) * unit;
    const y = Math.round(props.position === 'bottom' ? height - offset : offset);
    return { left, count, gap, segment, y, thickness: Math.max(1, Number(props.thickness) || 3) };
  }

  function draw() {
    resize();
    const { left, count, gap, segment, y, thickness } = geometry();
    const ink = mixRgb(hexToRgb(props.ink), hexToRgb(props.inkOnDark), darkness);
    const accent = mixRgb(hexToRgb(props.accent), hexToRgb(props.accentOnDark), darkness);
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    // The rail: one hairline per part.
    // At the top the rail hangs from its line (under the bar); at the bottom it stands on it.
    const top = props.position !== 'bottom';
    g.fillStyle = rgba(ink, 0.2);
    const hair = Math.max(1, ratio) / ratio;
    for (let i = 0; i < count; i++) g.fillRect(Math.round(left + i * (segment + gap)), top ? y : y - hair, segment, hair);
    // The rule, flush with the rail.
    const rule = (at, alpha) => {
      if (alpha <= 0) return;
      g.fillStyle = rgba(accent, alpha);
      g.fillRect(left + at * (segment + gap), top ? y : y - thickness, segment, thickness);
    };
    if (shownAt === null) return;
    if (motion && motion.kind === 'fade') {
      const t = motion.t;
      // The two fades overlap a little, so that the rule is never wholly gone.
      rule(motion.from, 1 - FADE(clamp01(t / 0.6)));
      rule(motion.to, FADE(clamp01((t - 0.4) / 0.6)));
    } else rule(shownAt, 1);
  }

  function frame(dt) {
    const step = Math.min(0.1, Math.max(0, dt || 0));
    if (motion) {
      motion.t = reduced ? 1 : clamp01(motion.t + step / motion.duration);
      if (motion.kind === 'slide') shownAt = motion.from + (motion.to - motion.from) * SLIDE(motion.t);
      if (motion.t >= 1) { shownAt = motion.to; motion = null; }
      dirty = true;
    }
    const target = dark ? 1 : 0;
    if (darkness !== target) {
      darkness = reduced ? target : target > darkness ? Math.min(target, darkness + step / 0.4) : Math.max(target, darkness - step / 0.4);
      dirty = true;
    }
    if (dirty || ctx.testMode) { dirty = false; draw(); }
  }

  place(context, false);
  draw();
  const off = [
    host.onFrame((dt) => frame(dt)),
    host.onContext((next) => place(next, !reduced)),
    host.onSafeArea(() => { dirty = true; })
  ];
  const watcher = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { dirty = true; }) : null;
  watcher?.observe(container);

  return {
    update(next) {
      props = { ...props, ...next };
      dark = isDark(context);
      darkness = dark ? 1 : 0;
      const section = context && context.section;
      const at = section ? sections().indexOf(section) : -1;
      index = at < 0 ? null : at;
      shownAt = index;
      motion = null;
      dirty = true;
    },
    getState() {
      return {
        section: context && context.section ? context.section : null,
        index: index === null ? -1 : index,
        count: sections().length,
        moving: motion ? motion.kind : 'none',
        dark
      };
    },
    setState() {},
    pause() {},
    resume() { dirty = true; },
    dispose() {
      for (const unsubscribe of off) unsubscribe?.();
      watcher?.disconnect();
      canvas.remove();
    }
  };
}
