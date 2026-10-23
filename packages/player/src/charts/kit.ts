// The chart kit (D60): what makes Elabora's charts move, answer and read the same way, whether a
// built-in block drew them or an agent's free object did (import { … } from '@elabora/charts').
// No DOM is created here that a chart did not ask for, and nothing depends on the player: an object
// passes its own clock (host.onFrame) so that its tests run on virtual time.
//
// Motion, reread for charts from the player's rules (player.css « Motion »):
// - entrances are rare and may be playful: once, in reading order, about a second, staggered; a
//   small overshoot only on small pieces that arrive (spring);
// - answers to the learner are soothing: 200 ms or so, ease-out, a few pixels, no overshoot; what
//   is not pointed at steps back to 40 %; the tip glides to its next item only while visible;
// - with less motion asked, nothing grows or slides: the final state, faded in.

export type Ease = (t: number) => number;
export const easeOut: Ease = (t) => 1 - (1 - t) ** 4; // ≈ cubic-bezier(.23, 1, .32, 1)
export const easeInOut: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const linear: Ease = (t) => t;
export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

// A damped spring sampled into CSS linear(): for the small pieces of an entrance that may overshoot.
export function springEasing({ stiffness = 230, damping = 19, mass = 1 }: { stiffness?: number; damping?: number; mass?: number } = {}): string {
  let x = 0, v = 0, t = 0, calm = 0;
  const dt = 1 / 240, samples: number[] = [];
  while (t < 3) {
    v += ((-stiffness * (x - 1) - damping * v) / mass) * dt; x += v * dt; t += dt; samples.push(x);
    if (Math.abs(x - 1) < 0.002 && Math.abs(v) < 0.02) { if (++calm > 24) break; } else calm = 0;
  }
  const steps = 40, values: number[] = [];
  for (let i = 1; i <= steps; i++) values.push(Math.round(samples[Math.round((i * (samples.length - 1)) / steps)] * 10000) / 10000);
  values[steps - 1] = 1;
  return `linear(0, ${values.join(', ')})`;
}

export function prefersLessMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── time ──
export interface Clock {
  // Calls back every frame with the seconds since the clock started; returns a function that stops.
  frame(callback: (seconds: number) => void): () => void;
}
export const animationFrameClock: Clock = {
  frame(callback) {
    let id = 0;
    let start: number | null = null;
    const step = (now: number) => { start ??= now; callback((now - start) / 1000); id = requestAnimationFrame(step); };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }
};
// A free object's clock: its host's frames (virtual in tests).
export function hostClock(host: { onFrame(callback: (dt: number) => void): () => void }): Clock {
  return { frame(callback) { let elapsed = 0; return host.onFrame((dt) => { elapsed += dt; callback(elapsed); }); } };
}

// Plays progress from 0 to 1 over seconds (after delay), on a clock; resolves when done or stopped.
export function play(seconds: number, ease: Ease, onProgress: (p: number) => void, { delay = 0, clock = animationFrameClock }: { delay?: number; clock?: Clock } = {}): { done: Promise<void>; stop(): void } {
  let stop = () => {};
  const done = new Promise<void>((resolve) => {
    if (seconds <= 0) { onProgress(1); resolve(); return; }
    let finished = false;
    const end = clock.frame((elapsed) => {
      if (finished) return;
      const t = clamp01((elapsed - delay) / seconds);
      onProgress(ease(t));
      if (t >= 1) { finished = true; end(); resolve(); }
    });
    stop = () => { if (!finished) { finished = true; end(); resolve(); } };
  });
  return { done, stop: () => stop() };
}

// ── numbers ──
export interface NumberFormat { unit?: string; decimals?: number }
const NARROW_SPACE = ' ';
export function formatValue(value: number, format: NumberFormat, language: string): string {
  const decimals = Math.max(0, Math.min(3, format.decimals ?? 0));
  const options = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  if (format.unit === '%') return new Intl.NumberFormat(language || 'en', { style: 'percent', ...options }).format(value / 100);
  const number = new Intl.NumberFormat(language || 'en', options).format(value);
  return format.unit ? `${number}${NARROW_SPACE}${format.unit}` : number;
}
export function formatMinutes(minutes: number, language: string): string {
  const total = Math.round(minutes);
  if (total < 60) return `${total}${NARROW_SPACE}min`;
  const hour = language.startsWith('de') ? 'Std.' : 'h';
  const rest = total % 60;
  return rest ? `${Math.floor(total / 60)}${NARROW_SPACE}${hour}${NARROW_SPACE}${String(rest).padStart(2, '0')}` : `${total / 60}${NARROW_SPACE}${hour}`;
}

// Label positions pushed apart (at least gap between neighbours), keeping their order.
export function dodge(values: readonly number[], gap: number): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let k = 1; k < order.length; k++) {
      const d = order[k].v - order[k - 1].v;
      if (d < gap) { const push = (gap - d) / 2; order[k].v += push; order[k - 1].v -= push; moved = true; }
    }
    if (!moved) break;
  }
  const out: number[] = [];
  for (const entry of order) out[entry.i] = entry.v;
  return out;
}

// ── the monotone curve the core draws lines with (d3-shape's curveMonotoneX) ──
// Each segment is a cubic Bézier whose control points sit at thirds of x, so y is exact at any x:
// a point riding a line stays on it. Points are sorted by x.
export interface XY { x: number; y: number }
function tangents(points: readonly XY[]): number[] {
  const n = points.length;
  const m = new Array<number>(n).fill(0);
  if (n < 3) return m;
  const sign = (v: number) => (v < 0 ? -1 : 1);
  for (let i = 1; i < n - 1; i++) {
    const h0 = points[i].x - points[i - 1].x, h1 = points[i + 1].x - points[i].x;
    const s0 = (points[i].y - points[i - 1].y) / (h0 || (h1 < 0 ? -0 : 0));
    const s1 = (points[i + 1].y - points[i].y) / (h1 || (h0 < 0 ? -0 : 0));
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    m[i] = (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  const end = (a: XY, b: XY, t: number) => { const h = b.x - a.x; return h ? (3 * (b.y - a.y) / h - t) / 2 : t; };
  m[0] = end(points[0], points[1], m[1]);
  m[n - 1] = end(points[n - 2], points[n - 1], m[n - 2]);
  return m;
}
export function monotoneY(points: readonly XY[], x: number): number {
  const n = points.length;
  if (!n) return 0;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[n - 1].x) return points[n - 1].y;
  let i = 0;
  while (i < n - 2 && x > points[i + 1].x) i++;
  const a = points[i], b = points[i + 1], h = b.x - a.x;
  if (n === 2 || !h) return a.y + (b.y - a.y) * (h ? (x - a.x) / h : 0);
  const m = tangents(points);
  const t = (x - a.x) / h, u = 1 - t, dx = h / 3;
  return u * u * u * a.y + 3 * u * u * t * (a.y + dx * m[i]) + 3 * u * t * t * (b.y - dx * m[i + 1]) + t * t * t * b.y;
}
export function monotonePath(points: readonly XY[]): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  if (points.length < 2) return '';
  if (points.length === 2) return `M${r(points[0].x)},${r(points[0].y)}L${r(points[1].x)},${r(points[1].y)}`;
  const m = tangents(points);
  let d = `M${r(points[0].x)},${r(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], dx = (b.x - a.x) / 3;
    d += `C${r(a.x + dx)},${r(a.y + dx * m[i])},${r(b.x - dx)},${r(b.y - dx * m[i + 1])},${r(b.x)},${r(b.y)}`;
  }
  return d;
}

// ── the tip: a value's bubble ──
// It appears in place, fades in; it glides to its next place only while it is still visible (or
// fading out), so that it never travels from where it was last seen long ago.
export interface Tip { show(at: Element | { x: number; y: number }, text: string): void; hide(): void; dispose(): void }
export function createTip(container: HTMLElement, className = 't-chart-tip'): Tip {
  const node = document.createElement('div');
  node.className = className;
  node.setAttribute('aria-hidden', 'true');
  container.append(node);
  let visible = false;
  let hideTimer = 0;
  const place = (at: Element | { x: number; y: number }) => {
    const box = container.getBoundingClientRect();
    if (at instanceof Element) {
      const rect = at.getBoundingClientRect();
      return { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top };
    }
    return at;
  };
  return {
    show(at, text) {
      clearTimeout(hideTimer);
      const { x, y } = place(at);
      node.textContent = text;
      const position = `translate(calc(${Math.round(x)}px - 50%), calc(${Math.round(y)}px - 100% - 8px))`;
      if (!visible) {
        // Appears where it is needed, without travelling from its last place.
        node.style.transition = 'none';
        node.style.transform = position;
        void node.offsetWidth;
        node.style.transition = '';
      } else node.style.transform = position;
      node.classList.add('is-on');
      visible = true;
    },
    hide() {
      node.classList.remove('is-on');
      // Still visible while it fades: a show within the fade glides from here.
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => { visible = false; }, 220);
    },
    dispose() { clearTimeout(hideTimer); node.remove(); }
  };
}

// ── pointing at items: pointer, touch and keyboard as one ──
export interface Items { ids: readonly string[]; elements(id: string): readonly HTMLElement[] }
export interface FocusOptions {
  axis: 'x' | 'y' | 'xy' | 'none';
  items: Items;
  // The item nearest the pointer (null: none); default: nearest along the axis, within the root.
  pick?(event: PointerEvent): string | null | undefined;
  // Items that may be reached now (default: all).
  enabled?(id: string): boolean;
  // Whether pointing answers at all now (default: always). A chart still coming in (its entrance, or
  // the voice bringing its items) does not: what it shows is not all there, and the voice leads.
  active?(): boolean;
  on(id: string, byKeys: boolean): void;
  off(): void;
  say?(id: string): string;
  live?: HTMLElement | null;
}
export function createFocus(root: HTMLElement, options: FocusOptions): { set(id: string | null, byKeys?: boolean): void; readonly current: string | null; dispose(): void } {
  let current: string | null = null;
  const centre = (id: string) => {
    const rects = options.items.elements(id).map((element) => element.getBoundingClientRect()).filter((rect) => rect.width || rect.height);
    if (!rects.length) return null;
    const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  };
  const ids = () => (options.enabled ? options.items.ids.filter(options.enabled) : options.items.ids);
  const nearest = (event: PointerEvent): string | null => {
    if (options.axis === 'none') return null;
    let best: string | null = null, bestDistance = Infinity;
    for (const id of ids()) {
      const c = centre(id);
      if (!c) continue;
      const distance = options.axis === 'x' ? Math.abs(c.x - event.clientX) : options.axis === 'y' ? Math.abs(c.y - event.clientY) : Math.hypot(c.x - event.clientX, c.y - event.clientY);
      if (distance < bestDistance) { bestDistance = distance; best = id; }
    }
    return best;
  };
  const set = (id: string | null, byKeys = false) => {
    if (id === current) return;
    current = id;
    if (id === null) { root.classList.remove('is-focused'); options.off(); return; }
    root.classList.add('is-focused');
    options.on(id, byKeys);
    if (byKeys && options.live && options.say) options.live.textContent = options.say(id);
  };
  // A view's pick may answer undefined: the default (nearest) decides.
  const pick = (event: PointerEvent) => { const id = options.pick?.(event); return id === undefined ? nearest(event) : id; };
  const quiet = () => { if (options.active && !options.active()) { set(null); return true; } return false; };
  const move = (event: PointerEvent) => { if (event.pointerType !== 'touch' && !quiet()) set(pick(event)); };
  const leave = () => set(null);
  const down = (event: PointerEvent) => { if (event.pointerType === 'touch' && !quiet()) { const id = pick(event); set(id === current ? null : id); } };
  const key = (event: KeyboardEvent) => {
    // Keys typed in a control of the chart (a guess's slider, a button) are theirs.
    if (event.target !== root || quiet()) return;
    const reachable = ids();
    if (!reachable.length) return;
    const forward = ['ArrowDown', 'ArrowRight'].includes(event.key), back = ['ArrowUp', 'ArrowLeft'].includes(event.key);
    if (forward || back) {
      event.preventDefault();
      const at = current === null ? -1 : reachable.indexOf(current);
      const index = at < 0 ? (forward ? 0 : reachable.length - 1) : (at + (forward ? 1 : -1) + reachable.length) % reachable.length;
      set(reachable[index], true);
    } else if (event.key === 'Escape') set(null);
  };
  // Leaving the chart (not for one of its own controls) lets go.
  const blur = (event: FocusEvent) => { if (!root.contains(event.relatedTarget as Node | null)) set(null); };
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerleave', leave);
  root.addEventListener('pointerdown', down);
  root.addEventListener('keydown', key);
  root.addEventListener('blur', blur);
  return {
    set,
    get current() { return current; },
    dispose() {
      root.removeEventListener('pointermove', move); root.removeEventListener('pointerleave', leave);
      root.removeEventListener('pointerdown', down); root.removeEventListener('keydown', key); root.removeEventListener('blur', blur);
    }
  };
}

// ── a chart's data for screen readers ──
// A free object's drawing is not read aloud: its data goes in a table that only screen readers see,
// as Elabora's charts do (their frame's .t-chart-table). Returns the table, appended to container.
export function dataTable(container: HTMLElement, { caption, head = [], rows }: { caption?: string; head?: readonly string[]; rows: readonly (readonly string[])[] }): HTMLTableElement {
  const table = document.createElement('table');
  // A table keeps its content's width whatever its own says: shown as a clipped block, it widens nothing.
  table.style.cssText = 'position:absolute;display:block;width:1px;height:1px;max-width:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0';
  const cell = (tag: 'th' | 'td', text: string, scope?: string) => { const node = document.createElement(tag); node.textContent = text; if (scope) node.scope = scope; return node; };
  if (caption) table.createCaption().textContent = caption;
  if (head.length) table.createTHead().insertRow().append(...head.map((text) => cell('th', text, 'col')));
  const body = table.createTBody();
  for (const row of rows) body.insertRow().append(...row.map((text, index) => (index === 0 ? cell('th', text, 'row') : cell('td', text))));
  container.append(table);
  return table;
}
