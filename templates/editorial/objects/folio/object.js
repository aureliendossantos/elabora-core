// Decoration « Folio and plates » behind the course — Elabora free-object contract 0.1, section 4c.
// The magazine page of the Editorial template, drawn on a 2D canvas the size of the window:
// - a thumb index on the right edge of the page: one tab per part of the module, in the part's
//   plate colour; the tab of the part in progress stands out, the others are slivers;
// - the plate: on a part opener (variant « plate ») the part's tab unfolds into a colour plate on the
//   right of the page; on the first and last screens every part's plate shows, side by side (the
//   whole issue at a glance); back on a page, the plate folds back into its tab;
// - the rules: a heavy and a fine rule under the top bar, a fine rule at the foot of the page, both
//   ending where a plate begins;
// - the folio: the page number at the foot of the page, verso on the left (even pages), recto on the
//   right (odd pages), which turns through a mask at each new screen (up going forward, down going
//   back), with a short rule in the part's colour beside it.
// Nothing crosses the page: plates unfold and fold along their own edge, tabs keep their place, the
// folio changes in its slot. It keeps out of the player's bars (ctx.safeArea, host.onSafeArea) and
// lands at once when frames are still (reduced motion, a slow machine: host.still, host.onStill), on
// the first screen shown and on a session resumed (direction null).

// ── Settings ─────────────────────────────────────────────────────────────
const NARROW = 640; // px: below it (phones), only the tabs and a slim plate along the edge

export function mount(container, ctx) {
  const { host } = ctx;
  let props = { ...ctx.props };
  let where = ctx.context || {};
  let area = { ...ctx.safeArea };
  let still = !!(host.still || ctx.reducedMotion);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);
  const paint = canvas.getContext('2d');

  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const headingFont = () => String((ctx.tokens && ctx.tokens['font.heading']) || getComputedStyle(document.documentElement).getPropertyValue('--t-font-heading') || 'Georgia, serif').trim();

  // ── Colours ────────────────────────────────────────────────────────────
  const plates = () => [props.plate1, props.plate2, props.plate3, props.plate4, props.plate5];
  const plateOf = (section) => { const list = plates(); return list[((section ?? 0) % list.length + list.length) % list.length]; };
  const rgb = (hex) => { const h = String(hex).replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`; };

  // ── Geometry: where each part's band is for a context ──────────────────
  let width = container.clientWidth, height = container.clientHeight;
  const isEnds = (c) => c.screenIndex === 0 || c.screenIndex === (c.screenCount || 1) - 1;

  function layout(c) {
    const n = Math.max(1, c.sectionCount || 1), current = c.sectionIndex ?? 0, r = rem();
    const top = area.top || 0, bottom = height - (area.bottom || 0);
    const narrow = width < NARROW;
    const tab = narrow ? 6 : props.tabWidth * r, sliver = narrow ? 2 : 4;
    const slotTop = top + (narrow ? 1 : 3.5) * r, slotBottom = bottom - (narrow ? 1 : 3.5) * r;
    const slot = (slotBottom - slotTop) / n;
    const plateX = narrow ? width - 0.75 * r : Math.round(width * props.plateStart);
    const bands = [];
    for (let i = 0; i < n; i++) {
      const y0 = slotTop + i * slot + 1, y1 = slotTop + (i + 1) * slot - 1;
      let band = { x0: width - sliver, y0, y1, alpha: 0.7 };
      if (c.variant === 'plate' && isEnds(c)) {
        const h = (bottom - top) / n;
        band = { x0: plateX, y0: top + i * h, y1: top + (i + 1) * h - (i < n - 1 ? 3 : 0), alpha: 1 };
      } else if (i === current) {
        band = c.variant === 'plate' ? { x0: plateX, y0: top, y1: bottom, alpha: 1 } : { x0: width - tab, y0, y1, alpha: 1 };
      }
      bands.push(band);
    }
    return bands;
  }

  // ── Motion: bands, ink and folio, each from where it was to where it goes ──
  let shown = layout(where), from = shown, goal = shown, elapsed = 0;
  const inkOf = (c) => (c.variant === 'ink' ? 1 : 0);
  let ink = inkOf(where), inkFrom = ink;
  let folio = { page: (where.screenIndex ?? 0) + 1, previous: null, dir: 1, section: where.sectionIndex ?? 0, previousSection: null };
  const duration = () => (still ? 0 : props.duration);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;

  function arrive(next, animate) {
    where = next || {};
    goal = layout(where);
    if (!animate || where.direction == null || duration() === 0) {
      shown = from = goal; ink = inkFrom = inkOf(where); elapsed = duration();
      folio = { page: (where.screenIndex ?? 0) + 1, previous: null, dir: 1, section: where.sectionIndex ?? 0, previousSection: null };
    } else {
      // The parts may have changed in number: bands that did not exist start as a sliver at the edge.
      from = goal.map((g, i) => shown[i] || { ...g, x0: width, alpha: 0 });
      inkFrom = ink; elapsed = 0;
      const page = (where.screenIndex ?? 0) + 1;
      if (page !== folio.page) folio = { page, previous: folio.page, dir: where.direction === 'back' ? -1 : 1, section: where.sectionIndex ?? 0, previousSection: folio.section };
      else folio = { ...folio, section: where.sectionIndex ?? 0 };
    }
    draw();
  }

  // ── Drawing ────────────────────────────────────────────────────────────
  function draw() {
    if (!canvas.width) return;
    const r = rem(), t = duration() ? ease(Math.min(1, elapsed / duration())) : 1;
    shown = goal.map((g, i) => {
      const f = from[i] || g;
      return { x0: lerp(f.x0, g.x0, t), y0: lerp(f.y0, g.y0, t), y1: lerp(f.y1, g.y1, t), alpha: lerp(f.alpha, g.alpha, t) };
    });
    ink = lerp(inkFrom, inkOf(where), t);
    paint.clearRect(0, 0, width, height);
    const narrow = width < NARROW;
    const line = mix(props.ink, props.inkLight, ink);
    const current = where.sectionIndex ?? 0;

    // The bands: the others first, the part in progress over them.
    const order = shown.map((b, i) => i).sort((a, b) => (a === current) - (b === current));
    for (const i of order) {
      const b = shown[i];
      if (b.alpha <= 0.01 || b.x0 >= width) continue;
      paint.globalAlpha = Math.min(1, b.alpha);
      paint.fillStyle = plateOf(i);
      paint.fillRect(b.x0, b.y0, width - b.x0, Math.max(0, b.y1 - b.y0));
    }
    paint.globalAlpha = 1;
    if (narrow) return;

    // Where a plate begins on the page (the rules end before it).
    const top = area.top || 0, bottom = height - (area.bottom || 0);
    const margin = Math.max(1.5 * r, (width - props.measure * r) / 2);
    const plateLeft = (y) => {
      let x = width;
      for (const b of shown) if (b.alpha > 0.5 && y >= b.y0 && y <= b.y1 && width - b.x0 > 2 * props.tabWidth * r) x = Math.min(x, b.x0);
      return x;
    };
    const ruleEnd = (y) => Math.min(width - margin, plateLeft(y) - 2 * r);

    // The rules under the top bar: a heavy one and a fine one.
    const head = top + 0.875 * r;
    paint.fillStyle = line;
    const headEnd = ruleEnd(head);
    if (headEnd > margin) { paint.fillRect(margin, head, headEnd - margin, 2); paint.fillRect(margin, head + 5, headEnd - margin, 1); }

    if (!props.folio) return;
    // The foot of the page: a fine rule, the folio under it, a short rule of the part's colour.
    const foot = bottom - 2.375 * r;
    const footEnd = ruleEnd(foot);
    if (footEnd > margin) paint.fillRect(margin, foot, footEnd - margin, 1);
    const size = 0.9375 * r;
    paint.font = `500 ${size}px ${headingFont()}`;
    paint.textBaseline = 'alphabetic';
    const baseline = foot + 1.5 * r;
    const slot = (page) => (page % 2 === 0 ? 'start' : 'end');
    const place = (page) => {
      const text = String(page).padStart(2, '0');
      const w = paint.measureText(text).width;
      const end = Math.min(width - margin, plateLeft(foot) - 2 * r);
      return slot(page) === 'start' ? { text, x: margin, w } : { text, x: Math.max(margin, end - w), w };
    };
    const onPlate = (x) => x >= plateLeft(baseline - size / 2);
    // The folio turns inside its slot: clipped between the rule and the bottom bar.
    paint.save();
    paint.beginPath();
    paint.rect(0, foot + 2, width, bottom - foot - 2);
    paint.clip();
    const travel = 1.25 * r * folio.dir;
    const drawFolio = (page, offset, alpha, section) => {
      if (alpha <= 0.01) return;
      const p = place(page);
      paint.globalAlpha = alpha;
      paint.fillStyle = onPlate(p.x) ? props.onPlate : line;
      paint.fillText(p.text, p.x, baseline + offset);
      // The short rule of the part, on the side of the folio.
      paint.fillStyle = plateOf(section);
      const rx = slot(page) === 'start' ? p.x + p.w + 0.75 * r : p.x - 2.75 * r;
      paint.fillRect(rx, baseline - size * 0.36 + offset, 2 * r, 3);
    };
    if (folio.previous != null && t < 1) {
      drawFolio(folio.previous, -travel * t, 1 - t, folio.previousSection ?? folio.section);
      drawFolio(folio.page, travel * (1 - t), t, folio.section);
    } else drawFolio(folio.page, 0, 1, folio.section);
    paint.restore();
    paint.globalAlpha = 1;
  }

  // ── Size and course ────────────────────────────────────────────────────
  const resize = () => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    width = container.clientWidth; height = container.clientHeight;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    goal = layout(where); from = goal.map((g, i) => (elapsed < duration() ? from[i] || g : g));
    draw();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  const offFrame = host.onFrame((dt) => {
    if (elapsed >= duration() && !ctx.testMode) return;
    elapsed = Math.min(duration(), elapsed + dt);
    draw();
  });
  const offContext = host.onContext((next) => arrive(next, true));
  const offArea = host.onSafeArea((next) => { area = { ...next }; goal = layout(where); from = goal; shown = goal; draw(); });
  // Frozen later (a slow machine): whatever is on its way lands at once.
  const offStill = host.onStill(() => { still = true; arrive(where, false); });
  resize();
  // The folio's face may still be loading: draw again once it is there.
  try { document.fonts?.ready?.then(() => draw()); } catch { /* no font loading API */ }

  return {
    update(next) { props = { ...props, ...next }; goal = layout(where); from = goal; elapsed = duration(); draw(); },
    getState: () => ({ screenIndex: where.screenIndex ?? 0, sectionIndex: where.sectionIndex ?? null, variant: where.variant ?? null }),
    setState() {},
    dispose() { offFrame(); offContext(); offArea(); offStill(); observer.disconnect(); canvas.remove(); }
  };
}
