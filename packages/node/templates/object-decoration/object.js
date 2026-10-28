// Decoration "__TITLE__" behind the course — Elabora free-object contract 0.1, section 4c (see skill
// elabora-free-objects). A soft glow that moves along the course: across the window with the screen's
// rank, a little lower in each section. It draws on a 2D canvas the size of the frame, keeps out of
// the player's bars (ctx.safeArea, host.onSafeArea) and lands at once when frames are still (reduced
// motion, a slow machine: host.still, host.onStill) or on the first screen shown.
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

  // Where the glow goes, 0..1 across the window (x) and down the room between the bars (y).
  const target = () => {
    const screens = Math.max(1, (where?.screenCount ?? 1) - 1);
    const sections = Math.max(1, where?.sectionCount ?? 1);
    return { x: 0.15 + 0.7 * ((where?.screenIndex ?? 0) / screens), y: 0.3 + 0.4 * ((where?.sectionIndex ?? 0) / sections) };
  };
  let at = target();
  let from = at;
  let elapsed = 0;

  // The frame's size, measured when it changes (not at every frame).
  let width = container.clientWidth, height = container.clientHeight;
  const resize = () => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    width = container.clientWidth; height = container.clientHeight;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  function draw() {
    if (!canvas.width) return;
    paint.clearRect(0, 0, width, height);
    const top = area.top, room = Math.max(1, height - area.top - area.bottom);
    const x = at.x * width, y = top + at.y * room, radius = Math.max(width, height) * 0.45;
    const glow = paint.createRadialGradient(x, y, 0, x, y, radius);
    const alpha = Math.round(props.strength * 255).toString(16).padStart(2, '0');
    glow.addColorStop(0, `${props.tint}${alpha}`);
    glow.addColorStop(1, `${props.tint}00`);
    paint.fillStyle = glow;
    paint.fillRect(0, 0, width, height);
  }

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const offFrame = host.onFrame((dt) => {
    const goal = target();
    const duration = host.still || ctx.reducedMotion ? 0 : props.travel;
    elapsed = Math.min(duration, elapsed + dt);
    const t = duration ? ease(elapsed / duration) : 1;
    at = { x: from.x + (goal.x - from.x) * t, y: from.y + (goal.y - from.y) * t };
    draw();
  });
  // A new place: the glow sets off from where it is now (without a direction, a session resumed or
  // the first screen shown, it is there at once).
  const offContext = host.onContext((next) => { where = next; from = next?.direction == null ? target() : at; elapsed = 0; });
  const offArea = host.onSafeArea((next) => { area = { ...next }; draw(); });
  const offStill = host.onStill(() => { from = target(); });
  resize();

  return {
    update(next) { props = { ...props, ...next }; draw(); },
    getState: () => ({ screenIndex: where?.screenIndex ?? 0, sectionIndex: where?.sectionIndex ?? null }),
    setState() {},
    dispose() { offFrame(); offContext(); offArea(); offStill(); observer.disconnect(); canvas.remove(); }
  };
}
