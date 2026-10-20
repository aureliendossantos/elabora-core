// Free object « Chart table » — three.js r186, Elabora free-object contract 0.1.
// A portolan chart on its calfskin lies on the page. As the learner scrolls to it (host.onView),
// the skin unrolls from its neck, the rhumb lines spread from the hidden circle and the coasts are
// inked from west to east. Then the voyages (three by default, a list prop): choose the wind whose
// rhumb lines lead from one harbour to the other (the ruler is laid along it), open the dividers to
// the distance and sail. The first voyage can be guided (a hint per step, the distance shown on the
// scale strip); the first `required` voyages complete the table, any after them are optional.
// Geometry: chart.js (shared with the workshop figures). Time: host.onFrame only. The canvas is
// transparent: the skin and its shadow sit on the course page itself, without a frame.
import * as THREE from 'three';
import {
  COAST, ISLANDS, PORTS, SHEET, SCALE_BAR, HIDDEN_CIRCLE, MILES_PER_UNIT, WINDS, VOYAGE_PORTS,
  angleGap, bearing, inkLine, islandOutline, miles as milesBetween, nearestWind, port, rhumbs, rng, roseCentres, sheetOutline
} from './chart.js';

const W = 0.1;                                  // world units per chart unit
const PAD = 0.3;
const EXT = { left: -SHEET.width / 2 - SHEET.neck - PAD, right: SHEET.width / 2 + PAD, bottom: -SHEET.height / 2 - PAD, top: SHEET.height / 2 + PAD };
const EXT_W = EXT.right - EXT.left, EXT_H = EXT.top - EXT.bottom;
const NARROW = 720;                             // px of frame width under which the log goes under the chart
const MAX_MILES = 800;
const MAX_VOYAGES = 6;
const STRIP_DIVISIONS = 16;                     // divisions drawn on the scale strip of the log (800 miles)
const DIVISION = SCALE_BAR.miles / SCALE_BAR.divisions;
const SAIL_S = 2.8;
const ROLL_RADIUS = 0.16;                       // world units, outer radius of the rolled skin
const RULER = { length: 15, width: 0.42, height: 0.06 };
const LEG = 4.8;                                // chart units, length of a leg of the dividers
const SHIP_SCALE = 0.7;

const smooth = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const approach = (value, target, dt, rate) => value + (target - value) * (1 - Math.exp(-dt * rate));
const toWorld = (x, y, h = 0) => new THREE.Vector3(x * W, h, -y * W);
const DEG = Math.PI / 180;

export function mount(container, ctx) {
  const { host } = ctx;
  const t = ctx.t;
  const tokens = ctx.tokens || {};
  const C = palette(tokens);
  const reduced = !!ctx.reducedMotion;
  const testMode = !!ctx.testMode;
  let values = { ...ctx.props };                  // as the block gives them; update() merges into them
  let props = withDefaults(values);

  // ── DOM: the canvas (decoration for screen readers) and the ship's log ─────────────────────
  const root = document.createElement('div');
  root.className = 'ct-root t-ui';
  root.innerHTML = `<style>${STYLE}</style>
    <canvas class="ct-canvas" aria-hidden="true"></canvas>
    <section class="ct-panel t-ui-panel">
      <p class="t-ui-eyebrow ct-voyage"></p>
      <p class="t-ui-title ct-route"></p>
      <fieldset class="ct-step ct-winds"><legend class="ct-legend"></legend><div class="ct-wind-grid" role="radiogroup"><span class="ct-wind-centre" aria-hidden="true"><svg viewBox="-10 -10 20 20"><path d="M0 -9L2 -2L9 0L2 2L0 9L-2 2L-9 0L-2 -2Z"/><circle r="1.6"/></svg></span></div></fieldset>
      <div class="ct-step ct-dividers" hidden>
        <label class="ct-legend ct-dividers-label"></label>
        <input class="ct-range" type="range" min="0" max="${MAX_MILES}" step="10" value="0">
        <svg class="ct-strip" viewBox="0 0 ${STRIP_DIVISIONS * 20 + 8} 30" aria-hidden="true">${stripDivisions()}<path class="ct-strip-target" d=""/><path class="ct-strip-span" d=""/></svg>
        <p class="ct-miles"><output class="ct-miles-value"></output> <span class="ct-divisions"></span></p>
      </div>
      <div class="ct-actions"><button type="button" class="t-ui-btn t-ui-btn--primary ct-sail" hidden></button><button type="button" class="t-ui-btn ct-next" hidden></button></div>
      <p class="ct-feedback" role="status" aria-live="polite"></p>
      <ol class="ct-log"></ol>
    </section>`;
  container.appendChild(root);
  const $ = (selector) => root.querySelector(selector);
  const canvas = $('.ct-canvas');
  const panel = $('.ct-panel');
  const ui = {
    voyage: $('.ct-voyage'), route: $('.ct-route'), dividers: $('.ct-dividers'), windLegend: $('.ct-winds .ct-legend'), windGrid: $('.ct-wind-grid'),
    dividersLabel: $('.ct-dividers-label'), range: $('.ct-range'), milesValue: $('.ct-miles-value'), divisions: $('.ct-divisions'),
    sail: $('.ct-sail'), next: $('.ct-next'), feedback: $('.ct-feedback'), log: $('.ct-log'),
    stripSpan: $('.ct-strip-span'), stripTarget: $('.ct-strip-target')
  };
  const rangeId = `ct-range-${Math.floor(host.random() * 1e9)}`;
  ui.range.id = rangeId;
  ui.dividersLabel.htmlFor = rangeId;
  panel.setAttribute('aria-label', t('panelLabel'));
  ui.windLegend.textContent = t('windLegend');
  ui.dividersLabel.textContent = t('dividersLabel');
  ui.sail.textContent = t('sail');
  ui.next.textContent = t('next');
  ui.windGrid.setAttribute('aria-label', t('windLegend'));
  const windButtons = WINDS.map((wind, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ct-wind';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.dataset.wind = wind.id;
    button.tabIndex = index === 0 ? 0 : -1;
    button.setAttribute('aria-label', t('windOption', { name: t(`wind_${wind.id}`), direction: t(`dir_${wind.id}`) }));
    button.innerHTML = `<svg class="ct-arrow" viewBox="-10 -10 20 20" aria-hidden="true" style="transform: rotate(${wind.deg}deg)"><path d="M0 -8L4 2H1V8H-1V2H-4Z"/></svg><span class="ct-wind-name"></span>`;
    button.querySelector('.ct-wind-name').textContent = t(`wind_${wind.id}`);
    button.addEventListener('click', () => chooseWind(wind.id));
    button.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      const next = WINDS[(index + step + WINDS.length) % WINDS.length];
      chooseWind(next.id);
      windButtons[WINDS.indexOf(next)].focus();
    });
    ui.windGrid.appendChild(button);
    return button;
  });
  ui.range.addEventListener('input', () => setMiles(Number(ui.range.value)));
  ui.sail.addEventListener('click', () => sail());
  ui.next.addEventListener('click', () => nextVoyage());

  // ── three.js ─────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: testMode });
  renderer.setClearColor(new THREE.Color(), 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.registerRenderer(renderer);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.05, 40);
  host.registerCamera(camera);
  scene.add(new THREE.HemisphereLight(new THREE.Color(C.candle), new THREE.Color(C.sepia), 1.6));
  const sun = new THREE.DirectionalLight(new THREE.Color(C.candle), 2.2);
  sun.position.set(-2.5, 6, 3.5);
  scene.add(sun);

  // The skin: one plane over the chart's extent, rolled and inked by its shader.
  const anisotropy = renderer.capabilities.getMaxAnisotropy?.() || 1;
  const blank = (() => { const c = document.createElement('canvas'); c.width = c.height = 4; return c; })();
  const makeTexture = (source) => {
    const texture = new THREE.CanvasTexture(source);
    texture.colorSpace = THREE.NoColorSpace;      // sRGB values straight from the canvas: the page's colours
    texture.premultiplyAlpha = true;
    texture.anisotropy = Math.min(8, anisotropy);
    return texture;
  };
  const textures = { skin: makeTexture(blank), net: makeTexture(blank), ink: makeTexture(blank) };
  const uniforms = {
    tSkin: { value: textures.skin }, tNet: { value: textures.net }, tInk: { value: textures.ink },
    uUnroll: { value: 0 }, uNet: { value: 0 }, uInk: { value: 0 }, uLeft: { value: EXT.left * W }, uRight: { value: EXT.right * W },
    uRadius: { value: ROLL_RADIUS }, uLight: { value: new THREE.Vector3(-0.42, 0.84, 0.34).normalize() }, uAmbient: { value: 0.66 },
    uCircle: { value: new THREE.Vector2(HIDDEN_CIRCLE.x, HIDDEN_CIRCLE.y) }, uBack: { value: new THREE.Color(C.vellumDeep) }, uTime: { value: 0 }
  };
  const sheetGeometry = new THREE.PlaneGeometry(EXT_W * W, EXT_H * W, 360, 6);
  sheetGeometry.rotateX(-Math.PI / 2);
  sheetGeometry.translate((EXT.left + EXT_W / 2) * W, 0, -(EXT.bottom + EXT_H / 2) * W);
  const sheet = new THREE.Mesh(sheetGeometry, new THREE.ShaderMaterial({ uniforms, vertexShader: SHEET_VERTEX, fragmentShader: SHEET_FRAGMENT, side: THREE.DoubleSide, transparent: false }));
  sheet.userData.id = 'sheet';
  scene.add(sheet);
  host.registerObject('sheet', sheet);

  // Its shadow on the page: a soft rectangle that grows with the unrolled part.
  const shadowTexture = new THREE.CanvasTexture(shadowCanvas());
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, opacity: 0, depthWrite: false, color: new THREE.Color(C.shadow) }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.004;
  shadow.renderOrder = -1;
  scene.add(shadow);

  // Rhumb lines of the chosen wind, lit up across the whole chart (all parallel): thin gilt strips.
  const highlight = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: new THREE.Color(C.gold), transparent: true, opacity: 0, depthWrite: false }));
  highlight.position.y = 0.0015;
  scene.add(highlight);

  // Harbours of the voyage: rings on the chart.
  const ringGeometry = new THREE.RingGeometry(0.3 * W, 0.42 * W, 40);
  ringGeometry.rotateX(-Math.PI / 2);
  const fromRing = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: new THREE.Color(C.gold), transparent: true, opacity: 0, depthWrite: false }));
  const toRing = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: new THREE.Color(C.vermilion), transparent: true, opacity: 0, depthWrite: false }));
  fromRing.position.y = toRing.position.y = 0.002;
  scene.add(fromRing, toRing);

  // Materials of the tools and the ship: their colours are props (group Materials), literal colours
  // of things rather than tokens of the course, which an author may change in the block.
  const material = {
    wood: new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0, transparent: true, opacity: 0.78 }),
    edge: new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.8 }),
    brass: new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.85 }),
    steel: new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.9 }),
    hull: new THREE.MeshStandardMaterial({ roughness: 0.75 }),
    mast: new THREE.MeshStandardMaterial({ roughness: 0.8 })
  };
  function colourMaterials() {
    const { brass, wood, steel, hull } = props.colours;
    if (wood) material.wood.color.set(wood);
    if (brass) { material.edge.color.set(brass); material.brass.color.set(brass); }
    if (steel) material.steel.color.set(steel);
    if (hull) { material.hull.color.set(hull); material.mast.color.set(hull); }
  }
  colourMaterials();

  // The ruler: boxwood with a brass edge. Its working edge runs through the harbour.
  const ruler = new THREE.Group();
  const wood = new THREE.Mesh(new THREE.BoxGeometry(RULER.length * W, RULER.height * W, RULER.width * W), material.wood);
  wood.position.set(RULER.length * W / 2 - 1.2 * W, RULER.height * W / 2, RULER.width * W / 2);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(RULER.length * W, RULER.height * W * 1.1, 0.06 * W), material.edge);
  edge.position.set(RULER.length * W / 2 - 1.2 * W, RULER.height * W * 0.55, 0.03 * W);
  ruler.add(wood, edge);
  ruler.visible = false;
  ruler.userData.id = 'ruler';
  scene.add(ruler);
  host.registerObject('ruler', ruler);

  // The dividers: two brass legs from a hinge, points on the chart.
  const { brass, steel } = material;
  const legGeometry = new THREE.CylinderGeometry(0.035 * W, 0.06 * W, 1, 10);
  const tipGeometry = new THREE.ConeGeometry(0.05 * W, 0.5 * W, 10);
  const dividers = new THREE.Group();
  const legs = [0, 1].map(() => {
    const leg = new THREE.Group();
    const bar = new THREE.Mesh(legGeometry, brass);
    const tip = new THREE.Mesh(tipGeometry, steel);
    leg.add(bar, tip);
    dividers.add(leg);
    return { leg, bar, tip };
  });
  const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * W, 0.16 * W, 0.12 * W, 16), brass);
  hinge.rotation.x = Math.PI / 2;
  dividers.add(hinge);
  dividers.visible = false;
  dividers.userData.id = 'dividers';
  scene.add(dividers);
  host.registerObject('dividers', dividers);

  // The ship: a small cog under a square sail with a red cross, and the ink of its wake.
  const ship = makeShip(C, material);
  ship.visible = false;
  ship.userData.id = 'ship';
  scene.add(ship);
  host.registerObject('ship', ship);
  const wake = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: new THREE.Color(C.ink), dashSize: 0.02, gapSize: 0.014, transparent: true, opacity: 0.85 }));
  wake.position.y = 0.0025;
  wake.visible = false;
  scene.add(wake);

  // ── Textures, painted over the first frames (mount must return quickly) ─────────────────────
  const painting = [
    () => { textures.skin.image = paintSkin(C, 1536); textures.skin.needsUpdate = true; },
    () => { textures.net.image = paintNet(C, 3072); textures.net.needsUpdate = true; },
    () => { textures.ink.image = paintInk(C, 4096, t); textures.ink.needsUpdate = true; }
  ];

  // ── State ────────────────────────────────────────────────────────────
  let view = { visible: true, ratio: 1, progress: 0.5, entry: 1, exit: 0, ...(ctx.view || {}) };
  let reveal = reduced ? 1 : 0;                   // how far the chart has appeared, never back
  let revealTarget = reduced ? 1 : 0;
  const voyages = () => props.voyages;
  const lab = { index: 0, wind: null, miles: 0, attempts: Array(MAX_VOYAGES).fill(0), results: Array(MAX_VOYAGES).fill(null), sailing: null, landed: null };
  const shown = { ruler: 0, rulerAngle: null, span: 0, focus: 0 };
  let width = 0, height = 0, wide = true, panelPx = 0;
  let pointer = { x: 0, y: 0 }, tilt = { x: 0, y: 0 };
  let elapsed = 0;
  // The camera stays on the whole chart until the learner starts working in the log.
  let engaged = false;
  const engage = () => { engaged = true; };
  panel.addEventListener('focusin', engage);
  panel.addEventListener('pointerdown', engage);

  // ── Camera poses ─────────────────────────────────────────────────────
  // A pose: the point looked at (chart units), azimuth and elevation (radians), distance (world).
  const camPose = { x: 0, y: 0, az: 0, el: 0, dist: 1 };
  function fitDistance(spanX, spanY, el, aspect) {
    const v = camera.fov * DEG / 2;
    const h = Math.atan(Math.tan(v) * aspect);
    const dW = (spanX * W / 2) / Math.tan(h);
    const dH = (spanY * W * Math.sin(el) / 2 + spanY * W * Math.cos(el) * 0.08) / Math.tan(v);
    return Math.max(dW, dH) * 1.06;
  }
  const viewAspect = () => Math.max(0.4, (wide ? width - panelPx : width) / Math.max(1, wide ? height : canvasHeight()));
  function overviewPose() {
    const el = 58 * DEG;
    return { x: -SHEET.neck / 2, y: -0.4, az: 0, el, dist: fitDistance(SHEET.width + SHEET.neck + 1.5, SHEET.height + 1.5, el, viewAspect()) };
  }
  function arrivalPose() {
    const o = overviewPose();
    return { x: o.x - 6, y: o.y - 2, az: -16 * DEG, el: 30 * DEG, dist: o.dist * 1.12 };
  }
  function voyagePose() {
    const [fromId, toId] = voyages()[Math.min(lab.index, voyages().length - 1)] || [];
    if (!fromId) return overviewPose();
    const a = port(fromId), b = port(toId);
    const span = Math.max(13, Math.abs(b.x - a.x) + 8), spanY = Math.max(8, Math.abs(b.y - a.y) + 7);
    const el = 62 * DEG;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 0.6, az: 0, el, dist: fitDistance(span, spanY, el, viewAspect()) };
  }
  const lerpPose = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, az: a.az + (b.az - a.az) * k, el: a.el + (b.el - a.el) * k, dist: a.dist + (b.dist - a.dist) * k });
  function placeCamera(pose) {
    const az = pose.az + tilt.x * 2.2 * DEG + (view.progress - 0.5) * (reduced ? 0 : 5 * DEG);
    const el = pose.el + tilt.y * 1.6 * DEG;
    const target = toWorld(pose.x, pose.y);
    camera.position.set(target.x + pose.dist * Math.sin(az) * Math.cos(el), pose.dist * Math.sin(el), target.z + pose.dist * Math.cos(az) * Math.cos(el));
    camera.lookAt(target);
  }

  // ── Layout ───────────────────────────────────────────────────────────
  const canvasHeight = () => (wide ? height : Math.round(width * 0.66));
  function layout() {
    const rect = container.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    wide = width >= NARROW;
    root.classList.toggle('is-narrow', !wide);
    panelPx = wide ? panel.getBoundingClientRect().width + 24 : 0;
    const h = canvasHeight();
    renderer.setSize(width, h, false);
    canvas.style.height = `${h}px`;
    camera.aspect = width / h;
    if (wide && panelPx) camera.setViewOffset(width, h, panelPx / 2, 0, width, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    if (!wide) host.requestHeight(h + panel.getBoundingClientRect().height + 12);
  }
  const resizeObserver = new ResizeObserver(() => layout());
  resizeObserver.observe(container);
  resizeObserver.observe(panel);

  // ── The lab ─────────────────────────────────────────────────────────
  const current = (index = lab.index) => {
    const pair = voyages()[index];
    if (!pair) return null;
    const from = port(pair[0]), to = port(pair[1]);
    const course = bearing(from, to);
    return { from, to, course, wind: nearestWind(course).id, miles: milesBetween(from, to) };
  };
  const milesClose = (voyage) => Math.abs(lab.miles - voyage.miles) <= voyage.miles * props.tolerance / 100;
  const requiredCount = () => Math.min(props.required, voyages().length);
  const guiding = () => props.guided && lab.index === 0 && lab.index < voyages().length && lab.results[0] == null;
  const placeName = (id) => t(`place_${id}`);
  const windDeg = (id) => WINDS.find((wind) => wind.id === id)?.deg ?? 0;

  function chooseWind(id) {
    if (lab.sailing || lab.index >= voyages().length) return;
    lab.wind = id;
    lab.landed = null;
    windButtons.forEach((button) => {
      const on = button.dataset.wind === id;
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
    });
    buildHighlight(windDeg(id));
    // On the guided voyage, a wrong wind says at once which way to turn the ruler.
    const voyage = current();
    if (guiding() && voyage && id !== voyage.wind) {
      const diff = ((voyage.course - windDeg(id) + 540) % 360) - 180;
      say(t(diff > 0 ? 'turnClockwise' : 'turnAnticlockwise', { to: placeName(voyage.to.id) }), false);
    } else say(t('rulerLaid', { wind: t(`wind_${id}`) }), false);
    syncPanel();
  }
  function setMiles(value) {
    if (lab.sailing || lab.index >= voyages().length) return;
    lab.miles = Math.max(0, Math.min(MAX_MILES, Math.round(value / 10) * 10));
    lab.landed = null;
    ui.range.value = String(lab.miles);
    syncPanel();
  }
  function sail() {
    const voyage = current();
    if (!voyage || lab.sailing) return;
    if (!lab.wind) { say(t('noWind', { from: placeName(voyage.from.id) }), true); return; }
    if (!lab.miles) { say(t('noMiles'), true); return; }
    // The guided voyage sails only once the ruler and the dividers are right.
    if (guiding() && !(lab.wind === voyage.wind && milesClose(voyage))) return;
    lab.attempts[lab.index]++;
    lab.landed = null;
    lab.sailing = { t: reduced ? SAIL_S : 0, deg: windDeg(lab.wind), miles: lab.miles };
    say(t('sailing'), false);
    syncPanel();
    if (reduced) finishSail();
  }
  function finishSail() {
    const voyage = current();
    const run = lab.sailing;
    lab.sailing = null;
    if (!voyage || !run) return;
    const correctWind = lab.wind === voyage.wind;
    const gap = run.miles - voyage.miles;
    const correctMiles = Math.abs(gap) <= voyage.miles * props.tolerance / 100;
    const correct = correctWind && correctMiles;
    const attempt = lab.attempts[lab.index];
    lab.landed = { correct };
    const to = placeName(voyage.to.id);
    let message;
    if (correct) message = t('right', { to, wind: t(`wind_${lab.wind}`), miles: run.miles });
    else if (!correctWind) {
      const diff = ((voyage.course - run.deg + 540) % 360) - 180;
      message = t(diff > 0 ? 'turnClockwise' : 'turnAnticlockwise', { to });
    } else message = t(gap < 0 ? 'short' : 'long', { to, gap: Math.round(Math.abs(gap) / 10) * 10 || 10 });
    if (correct) lab.results[lab.index] = attempt;
    host.emit('voyage', {
      voyage: lab.index + 1, from: voyage.from.id, to: voyage.to.id, wind: lab.wind, miles: run.miles,
      correct, attempt, answer: `${lab.wind}-${run.miles}`
    });
    const count = voyages().length, req = requiredCount();
    if (correct && lab.index === req - 1) {
      const score = Math.round(lab.results.slice(0, req).reduce((sum, tries) => sum + Math.max(0.25, 1 - 0.25 * ((tries || 1) - 1)), 0) / req * 100) / 100;
      host.emit('completed', { score });
      message = `${message} ${req < count ? t('requiredDone', { n: req, extra: count - req }) : t('allDone', { n: count })}`;
    } else if (correct && lab.index === count - 1) message = `${message} ${t('allDone', { n: count })}`;
    if (correct && lab.index === count - 1) lab.index = count;
    say(message, false);
    syncPanel();
  }
  function nextVoyage() {
    if (lab.sailing || lab.results[lab.index] == null) return;
    lab.index++;
    lab.wind = null;
    lab.miles = 0;
    lab.landed = null;
    ui.range.value = '0';
    windButtons.forEach((button) => { button.setAttribute('aria-checked', 'false'); button.tabIndex = button === windButtons[0] ? 0 : -1; });
    buildHighlight(null);
    shown.rulerAngle = null;
    say('', false);
    syncPanel();
    if (lab.index < voyages().length) windButtons[0].focus({ preventScroll: true });
  }

  function say(message, alert) {
    ui.feedback.textContent = message;
    ui.feedback.classList.toggle('is-alert', !!alert);
    ui.feedback.classList.toggle('is-ok', !!lab.landed?.correct);
  }

  function syncPanel() {
    const count = voyages().length;
    const done = lab.index >= count;
    const voyage = current();
    const optional = !done && lab.index >= requiredCount();
    ui.voyage.textContent = done ? t('logTitle') : t(optional ? 'voyageOptional' : 'voyage', { i: lab.index + 1, n: count });
    ui.route.textContent = voyage ? t('route', { from: placeName(voyage.from.id), to: placeName(voyage.to.id) }) : t('allDoneTitle', { n: count });
    ui.milesValue.textContent = t('milesValue', { miles: lab.miles });
    ui.divisions.textContent = t('divisions', { div: (lab.miles / DIVISION).toLocaleString(ctx.locale || 'en', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), unit: DIVISION });
    // The scale strip: the span of the dividers laid on the chart's scale of miles; on the guided
    // voyage, the distance between the harbours as a dashed bracket.
    const end = (miles) => (4 + Math.min(STRIP_DIVISIONS, miles / DIVISION) * 20).toFixed(1);
    ui.stripSpan.setAttribute('d', lab.miles > 0 ? `M4 7V2H${end(lab.miles)}V7` : '');
    ui.stripTarget.setAttribute('d', guiding() && voyage ? `M4 23V28H${end(Math.round(voyage.miles / 10) * 10)}V23` : '');
    root.classList.toggle('is-done', done);
    const solved = !done && lab.results[lab.index] != null;
    // One step at a time: the dividers once a wind is chosen, Set sail once they are open. On the
    // guided voyage, each step waits for the one before to be right.
    const guided = guiding();
    const windOk = !!voyage && lab.wind === voyage.wind;
    const milesOk = !!voyage && milesClose(voyage);
    ui.dividers.hidden = done || !(solved || lab.sailing || (guided ? windOk : !!lab.wind));
    ui.sail.hidden = done || solved || !(lab.sailing || (guided ? windOk && milesOk : !!lab.wind && lab.miles > 0));
    ui.sail.disabled = !!lab.sailing;
    ui.sail.textContent = lab.sailing ? t('underSail') : t('sail');
    ui.next.hidden = done || !solved || lab.index === count - 1;
    for (const button of windButtons) button.disabled = !!lab.sailing || done || solved;
    ui.range.disabled = !!lab.sailing || done || solved;
    ui.log.innerHTML = '';
    voyages().forEach(([from, to], index) => {
      const item = document.createElement('li');
      const state = lab.results[index] != null ? 'done' : index === lab.index ? 'open' : index >= requiredCount() ? 'optional' : 'later';
      item.className = `ct-log-item is-${state}`;
      item.textContent = t('logItem', { i: index + 1, from: placeName(from), to: placeName(to), state });
      ui.log.appendChild(item);
    });
  }

  // Shortcuts (also used by the object tests): 1–8 winds from the north clockwise, + and − 10 miles,
  // ] and [ 50 miles, S sets sail, N goes to the next voyage.
  const onKey = (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[1-8sSnN+=\-\[\]]$/.test(event.key)) engage();
    const target = event.target;
    if (target && target.tagName === 'INPUT' && /^(\+|-|=|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(event.key)) return;
    const k = event.key;
    if (/^[1-8]$/.test(k)) chooseWind(WINDS[Number(k) - 1].id);
    else if (k === '+' || k === '=') setMiles(lab.miles + 10);
    else if (k === '-') setMiles(lab.miles - 10);
    else if (k === ']') setMiles(lab.miles + 50);
    else if (k === '[') setMiles(lab.miles - 50);
    else if (k === 's' || k === 'S') sail();
    else if (k === 'n' || k === 'N') nextVoyage();
    else return;
    event.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  const onPointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1 };
  };
  canvas.addEventListener('pointermove', onPointer);
  canvas.addEventListener('pointerleave', () => { pointer = { x: 0, y: 0 }; });

  // The lines of a direction through every rose of the network, clipped to the sheet.
  function buildHighlight(deg) {
    const positions = [];
    if (deg != null) {
      const half = 0.045;
      for (const line of rhumbs()) {
        if (angleGap(line.direction, deg) > 0.01 && angleGap(line.direction, (deg + 180) % 360) > 0.01) continue;
        const dx = line.x2 - line.x1, dy = line.y2 - line.y1, length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length * half, ny = dx / length * half;
        const a = toWorld(line.x1 + nx, line.y1 + ny), b = toWorld(line.x1 - nx, line.y1 - ny), c = toWorld(line.x2 - nx, line.y2 - ny), d = toWorld(line.x2 + nx, line.y2 + ny);
        for (const point of [a, b, c, a, c, d]) positions.push(point.x, point.y, point.z);
      }
    }
    highlight.geometry.dispose();
    highlight.geometry = new THREE.BufferGeometry();
    highlight.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  }

  // ── Frame ────────────────────────────────────────────────────────────
  let painted = 0;
  let lastDrawn = '';
  const offFrame = host.onFrame((dt) => {
    elapsed += dt;
    if (painted < painting.length) { painting[painted++](); if (painted < painting.length) return; }
    // How far the chart has appeared: it follows the scroll (entry into the window) and never goes back.
    // It starts once a quarter of the frame is in the window, so the learner sees it happen.
    const wanted = reduced ? 1 : smooth(view.entry, 0.25, 1);
    revealTarget = Math.max(revealTarget, wanted);
    reveal = reduced ? 1 : Math.min(revealTarget, approach(reveal, revealTarget + 0.02, dt, 1.9));
    const unroll = smooth(reveal, 0.02, 0.5);
    uniforms.uUnroll.value = unroll;
    uniforms.uNet.value = smooth(reveal, 0.3, 0.74);
    uniforms.uInk.value = smooth(reveal, 0.5, 0.97);
    uniforms.uTime.value = elapsed;
    uniforms.uAmbient.value = 0.66 + (reduced ? 0 : 0.012 * Math.sin(elapsed * 1.7) * Math.sin(elapsed * 0.63 + 1));
    // The shadow grows with the flat part of the skin.
    const flatRight = EXT.left + (EXT.right - EXT.left) * unroll;
    const shadowLeft = EXT.left + 0.6, shadowRight = Math.max(shadowLeft + 0.5, flatRight + ROLL_RADIUS / W);
    shadow.scale.set((shadowRight - shadowLeft) * W * 1.04, (SHEET.height + 0.8) * W * 1.08, 1);
    shadow.position.x = ((shadowLeft + shadowRight) / 2 + 0.15) * W;
    shadow.position.z = 0.25 * W;
    shadow.material.opacity = 0.42 * smooth(reveal, 0, 0.2);

    const ready = reveal > 0.9;
    root.classList.toggle('is-ready', ready);
    // Once every voyage is done, the last one stays on the chart (its ship at landfall).
    const finished = lab.index >= voyages().length;
    const voyage = ready ? current(Math.min(lab.index, voyages().length - 1)) : null;
    // Camera: from the arrival over the rolled skin to the whole chart, then to the voyage.
    shown.focus = approach(shown.focus, voyage && reveal > 0.97 && !finished && engaged ? 1 : 0, dt, reduced ? 1e3 : 1.4);
    tilt.x = approach(tilt.x, reduced ? 0 : pointer.x, dt, 2.5);
    tilt.y = approach(tilt.y, reduced ? 0 : pointer.y, dt, 2.5);
    const arrival = lerpPose(arrivalPose(), overviewPose(), smooth(reveal, 0, 0.85));
    Object.assign(camPose, lerpPose(arrival, voyagePose(), smooth(shown.focus, 0, 1)));
    placeCamera(camPose);

    // Harbours, ruler, dividers, ship.
    const pulse = reduced ? 1 : 0.75 + 0.25 * Math.sin(elapsed * 3.2);
    fromRing.material.opacity = toRing.material.opacity = approach(fromRing.material.opacity, voyage && !finished ? 0.9 : 0, dt, 3);
    if (voyage) {
      fromRing.position.copy(toWorld(voyage.from.x, voyage.from.y, 0.002));
      toRing.position.copy(toWorld(voyage.to.x, voyage.to.y, 0.002));
      toRing.scale.setScalar(0.85 + 0.3 * pulse);
    }
    highlight.material.opacity = approach(highlight.material.opacity, voyage && lab.wind && !finished ? 0.55 : 0, dt, 5);
    shown.ruler = approach(shown.ruler, voyage && lab.wind && !finished ? 1 : 0, dt, reduced ? 1e3 : 5);
    ruler.visible = shown.ruler > 0.01 && !!voyage;
    if (voyage && lab.wind) {
      const target = windDeg(lab.wind) * DEG;
      if (shown.rulerAngle == null || reduced) shown.rulerAngle = target;
      const diff = ((target - shown.rulerAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      shown.rulerAngle = approach(shown.rulerAngle, shown.rulerAngle + diff, dt, 7);
    }
    if (ruler.visible && voyage) {
      ruler.position.copy(toWorld(voyage.from.x, voyage.from.y, (1 - shown.ruler) * 0.06));
      ruler.rotation.y = Math.PI / 2 - (shown.rulerAngle ?? 0);
    }
    const span = (lab.sailing ? lab.sailing.miles : lab.miles) / MILES_PER_UNIT;
    shown.span = approach(shown.span, span, dt, reduced ? 1e3 : 6);
    dividers.visible = !!voyage && !finished && (shown.span > 0.05 || !!lab.wind);
    if (dividers.visible) placeDividers(voyage, (shown.rulerAngle ?? windDeg(lab.wind || 'tramontana') * DEG), shown.span);
    // The ship: at the harbour, sailing along the ruler, or where it made landfall.
    ship.visible = !!voyage;
    if (ship.visible) {
      let along = 0;
      const deg = lab.sailing ? lab.sailing.deg : lab.wind ? windDeg(lab.wind) : 0;
      if (lab.sailing) {
        lab.sailing.t += dt;
        const k = Math.min(1, lab.sailing.t / SAIL_S);
        along = (lab.sailing.miles / MILES_PER_UNIT) * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
        if (k >= 1) { along = lab.sailing.miles / MILES_PER_UNIT; finishSail(); }
      } else if (lab.landed || finished) along = lab.miles / MILES_PER_UNIT;
      const dx = Math.sin(deg * DEG), dy = Math.cos(deg * DEG);
      // Resumed after the last landfall: the ship waits in the last harbour.
      const resumedDone = finished && !lab.wind;
      const x = resumedDone ? voyage.to.x : voyage.from.x + dx * along, y = resumedDone ? voyage.to.y : voyage.from.y + dy * along;
      ship.position.copy(toWorld(x, y, 0.004 + (reduced ? 0 : 0.0015 * Math.sin(elapsed * 2.4))));
      ship.rotation.y = Math.PI / 2 - deg * DEG;   // the bow (+x) along the course
      ship.rotation.z = reduced ? 0 : 0.05 * Math.sin(elapsed * 1.9);
      wake.visible = along > 0.05 && !resumedDone;
      if (wake.visible) {
        wake.geometry.setFromPoints([toWorld(voyage.from.x, voyage.from.y), toWorld(x, y)]);
        wake.computeLineDistances();
      }
    } else wake.visible = false;

    // Out of view, the chart draws only what changed (a picture that stays right for captures and
    // for the learner scrolling back), not every frame.
    const key = `${reveal.toFixed(3)}|${shown.focus.toFixed(3)}|${lab.index}|${lab.wind}|${lab.miles}|${!!lab.sailing}|${width}x${height}`;
    if (testMode || view.visible || key !== lastDrawn) { renderer.render(scene, camera); lastDrawn = key; }
  });

  function placeDividers(voyage, angle, span) {
    const dx = Math.sin(angle), dy = Math.cos(angle);
    // Beside the ruler's edge, so both stay readable.
    const side = 0.35;
    const ox = voyage.from.x - dy * side, oy = voyage.from.y + dx * side;
    const a = toWorld(ox, oy), b = toWorld(ox + dx * span, oy + dy * span);
    const half = Math.min(LEG * 0.98, span / 2);
    const rise = Math.sqrt(Math.max(0.01, LEG * LEG - half * half)) * W;
    const top = new THREE.Vector3((a.x + b.x) / 2, rise, (a.z + b.z) / 2);
    hinge.position.copy(top);
    hinge.rotation.set(Math.PI / 2, 0, Math.atan2(b.z - a.z, b.x - a.x));
    [a, b].forEach((point, index) => {
      const { leg, bar, tip } = legs[index];
      const direction = new THREE.Vector3().subVectors(point, top);
      const length = direction.length();
      leg.position.copy(top);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), direction.clone().normalize());
      bar.scale.set(1, length - 0.25 * W, 1);
      bar.position.y = -(length - 0.25 * W) / 2;
      tip.position.y = -length + 0.25 * W;
      tip.rotation.x = Math.PI;
    });
  }

  // ── Contract ─────────────────────────────────────────────────────────
  const offView = host.onView((next) => { view = { ...view, ...next }; });
  if (ctx.savedState) { applyState(ctx.savedState); engaged = lab.index > 0 || lab.attempts.some(Boolean); }
  syncPanel();
  layout();
  if (testMode) for (const step of painting) step();
  if (testMode) painted = painting.length;

  function applyState(state) {
    if (!state || typeof state !== 'object') return;
    const count = voyages().length;
    lab.index = Math.max(0, Math.min(count, Number(state.voyage) || 0));
    const attempts = Array.isArray(state.attempts) ? state.attempts : [];
    lab.attempts = Array.from({ length: MAX_VOYAGES }, (_, index) => Math.max(0, Number(attempts[index]) || 0));
    lab.results = Array.from({ length: MAX_VOYAGES }, (_, index) => (index < lab.index ? Math.max(1, lab.attempts[index]) : null));
    lab.wind = WINDS.some((wind) => wind.id === state.wind) && lab.index < count ? state.wind : null;
    lab.miles = Math.max(0, Math.min(MAX_MILES, Number(state.miles) || 0));
    ui.range.value = String(lab.miles);
    windButtons.forEach((button) => button.setAttribute('aria-checked', String(button.dataset.wind === lab.wind)));
    buildHighlight(lab.wind ? windDeg(lab.wind) : null);
    shown.rulerAngle = null;
    syncPanel();
  }

  return {
    update(next) {
      values = { ...values, ...next };
      props = withDefaults(values);
      lab.index = Math.min(lab.index, voyages().length);
      colourMaterials();
      syncPanel();
    },
    getState() {
      return { voyage: lab.index, wind: lab.wind || '', miles: lab.miles, attempts: lab.attempts.slice(0, voyages().length), sailing: !!lab.sailing };
    },
    setState(state) { applyState(state); engaged = true; },
    pause() {},
    resume() {},
    dispose() {
      offFrame();
      offView();
      resizeObserver.disconnect();
      window.removeEventListener('keydown', onKey);
      scene.traverse((node) => { node.geometry?.dispose?.(); if (node.material) [].concat(node.material).forEach((material) => material.dispose()); });
      Object.values(textures).forEach((texture) => texture.dispose());
      shadowTexture.dispose();
      renderer.dispose();
      root.remove();
    }
  };
}

// ── Props ──────────────────────────────────────────────────────────────
// The voyages, a list of { from, to } (up to six): an item that is not two different harbours of
// the chart is left out, and a list with none left gives the default voyages. The colours of the
// materials: a value that is not a colour leaves the material as it is.
function withDefaults(props = {}) {
  const ids = new Set(PORTS.map((p) => p.id));
  const listed = (Array.isArray(props.voyages) ? props.voyages : [])
    .filter((voyage) => voyage && ids.has(voyage.from) && ids.has(voyage.to) && voyage.from !== voyage.to)
    .slice(0, MAX_VOYAGES).map(({ from, to }) => [from, to]);
  const colour = (value) => (/^#[0-9a-f]{6}$/i.test(value) ? value : null);
  return {
    voyages: listed.length ? listed : VOYAGE_PORTS.map(([from, to]) => [from, to]),
    required: Math.max(1, Math.min(MAX_VOYAGES, Math.round(Number(props.required)) || 2)),
    guided: props.guided !== false,
    tolerance: Math.max(5, Math.min(20, Number(props.tolerance) || 10)),
    colours: { brass: colour(props.brassColor), wood: colour(props.woodColor), steel: colour(props.steelColor), hull: colour(props.hullColor) }
  };
}

// The divisions of the scale strip, as on the chart's scale bar: black and blank in turn.
function stripDivisions() {
  let out = '';
  for (let k = 0; k < STRIP_DIVISIONS; k++) out += `<rect class="ct-strip-div${k % 2 ? '' : ' is-ink'}" x="${4 + k * 20}" y="12" width="20" height="8"/>`;
  return `<rect class="ct-strip-frame" x="4" y="12" width="${STRIP_DIVISIONS * 20}" height="8"/>${out}`;
}

// ── Colours of the chart (theme tokens) ───────────────────────────────
// The inks and the vellum are tokens of the course (custom tokens of the vellum theme, which its
// pages use too); a course without them falls back on its charter: text, surface, primary, accent.
// The materials of the tools and the ship are props (colourMaterials).
function palette(tk) {
  const pick = (key, fallback) => (typeof tk[key] === 'string' ? tk[key] : tk[fallback]);
  return {
    ink: pick('color.ink', 'color.text'), sepia: pick('color.sepia', 'color.muted'),
    vellum: pick('color.vellum', 'color.surface'), vellumLight: pick('color.vellum-light', 'color.surface'), vellumDeep: pick('color.vellum-deep', 'color.surface'),
    edge: pick('color.vellum-edge', 'color.muted'), shadow: pick('color.vellum-shadow', 'color.text'),
    gold: pick('color.gold', 'color.accent'), goldLight: pick('color.gold-light', 'color.accent'), vermilion: pick('color.vermilion', 'color.primary'),
    verdigris: pick('color.verdigris', 'color.success'), lapis: pick('color.lapis', 'color.accent'),
    wind: pick('color.rhumb-wind', 'color.text'), half: pick('color.rhumb-half', 'color.success'), quarter: pick('color.rhumb-quarter', 'color.primary'),
    candle: pick('color.candle', 'color.surface'),
    chartFont: pick('font.chart', 'font.heading')
  };
}
function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ── Painting the chart (chart units, y up) ─────────────────────────────
function chartCanvas(widthPx) {
  const k = widthPx / EXT_W;
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = Math.round(EXT_H * k);
  const g = canvas.getContext('2d');
  g.setTransform(k, 0, 0, -k, -EXT.left * k, EXT.top * k);
  return { canvas, g, k };
}
function polyline(g, points, close = false) {
  g.beginPath();
  points.forEach(([x, y], index) => (index ? g.lineTo(x, y) : g.moveTo(x, y)));
  if (close) g.closePath();
}
const skinPath = () => { const path = new Path2D(); sheetOutline().forEach(([x, y], index) => (index ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath(); return path; };

function paintSkin(C, px) {
  const { canvas, g } = chartCanvas(px);
  const path = skinPath();
  g.save();
  g.clip(path);
  const ageing = g.createRadialGradient(-1, 0, 3, -1, 0, 31);
  ageing.addColorStop(0, C.vellumLight);
  ageing.addColorStop(0.55, C.vellum);
  ageing.addColorStop(1, C.vellumDeep);
  g.fillStyle = ageing;
  g.fillRect(EXT.left, EXT.bottom, EXT_W, EXT_H);
  const random = rng(42);
  for (let i = 0; i < 16; i++) {
    g.fillStyle = rgba(C.edge, 0.04 + random() * 0.08);
    g.beginPath();
    g.ellipse((random() - 0.5) * SHEET.width, (random() - 0.5) * SHEET.height, 0.8 + random() * 3.5, 0.6 + random() * 2.4, random() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 14000; i++) {
    g.fillStyle = random() < 0.55 ? rgba(C.shadow, 0.05 + random() * 0.05) : rgba(C.vellumLight, 0.12);
    const s = 0.02 + random() * 0.05;
    g.fillRect(EXT.left + random() * EXT_W, EXT.bottom + random() * EXT_H, s, s * (0.5 + random()));
  }
  // Darker along the trimmed edge, as handled skins are.
  g.lineWidth = 1.4; g.strokeStyle = rgba(C.edge, 0.22); g.stroke(path);
  g.lineWidth = 0.5; g.strokeStyle = rgba(C.edge, 0.35); g.stroke(path);
  g.restore();
  g.lineWidth = 0.05; g.strokeStyle = rgba(C.shadow, 0.5); g.stroke(path);
  return canvas;
}

function paintNet(C, px) {
  const { canvas, g, k } = chartCanvas(px);
  g.save();
  g.clip(skinPath());
  const colour = { wind: C.wind, half: C.half, quarter: C.quarter };
  const alpha = { wind: 0.46, half: 0.32, quarter: 0.26 };
  for (const kind of ['quarter', 'half', 'wind']) {
    g.strokeStyle = rgba(colour[kind], alpha[kind]);
    g.lineWidth = (kind === 'wind' ? 1.5 : 1.2) / k;
    g.beginPath();
    for (const line of rhumbs()) if (line.kind === kind) { g.moveTo(line.x1, line.y1); g.lineTo(line.x2, line.y2); }
    g.stroke();
  }
  // The pinpricks of the dividers at the centres of the roses.
  for (const point of roseCentres()) {
    g.fillStyle = rgba(C.ink, 0.55);
    g.beginPath(); g.arc(point.x, point.y, 0.06, 0, Math.PI * 2); g.fill();
  }
  g.restore();
  return canvas;
}

function paintInk(C, px, t) {
  const { canvas, g, k } = chartCanvas(px);
  g.save();
  g.clip(skinPath());
  g.lineJoin = 'round'; g.lineCap = 'round';
  // Islands: their colours, then the coasts over them.
  const fills = { gold: C.gold, red: C.vermilion, green: C.verdigris, blue: C.lapis };
  for (const island of ISLANDS) {
    polyline(g, islandOutline(island), true);
    if (island.fill) { g.fillStyle = rgba(fills[island.fill], 0.85); g.fill(); }
    g.strokeStyle = rgba(C.ink, 0.9); g.lineWidth = 0.032; g.stroke();
  }
  polyline(g, inkLine(COAST));
  g.strokeStyle = rgba(C.ink, 0.92); g.lineWidth = 0.04; g.stroke();
  // Scale of miles.
  const { x: sx, y: sy, miles: scaleMiles, divisions } = SCALE_BAR;
  const unit = (scaleMiles / divisions) / MILES_PER_UNIT;
  g.fillStyle = C.vellumLight; g.strokeStyle = C.ink; g.lineWidth = 0.035;
  g.fillRect(sx, sy - 0.16, unit * divisions, 0.32); g.strokeRect(sx, sy - 0.16, unit * divisions, 0.32);
  for (let d = 0; d < divisions; d++) {
    if (d % 2 === 0) { g.fillStyle = C.ink; g.fillRect(sx + d * unit, sy - 0.16, unit, 0.32); }
    for (let s = 1; s < 5; s++) { g.fillStyle = d % 2 === 0 ? C.vellumLight : C.ink; g.beginPath(); g.arc(sx + (d + s / 5) * unit, sy, 0.035, 0, Math.PI * 2); g.fill(); }
  }
  g.fillStyle = C.vermilion;
  for (const [x, dir] of [[sx - 0.05, -1], [sx + unit * divisions + 0.05, 1]]) { g.beginPath(); g.moveTo(x + dir * 0.28, sy); g.lineTo(x, sy + 0.16); g.lineTo(x, sy - 0.16); g.closePath(); g.fill(); }
  // A wind rose in the empty land of Africa.
  paintRose(g, C, 2.4, -8.6, 2.2);
  g.restore();
  // Harbour names: written inland at right angles to the coast (in pixels, so text stays crisp).
  g.setTransform(1, 0, 0, 1, 0, 0);
  const size = Math.round(0.33 * k);
  const family = C.chartFont || 'serif';
  g.textBaseline = 'middle';
  for (const harbour of PORTS) {
    const p = port(harbour.id);
    const px0 = (p.x - EXT.left) * k, py0 = (EXT.top - p.y) * k;
    const a = p.inlandSheet * DEG;
    g.save();
    g.translate(px0, py0);
    g.rotate(Math.atan2(-Math.cos(a), Math.sin(a)));
    g.fillStyle = harbour.major ? C.vermilion : C.ink;
    g.font = `${harbour.major ? 600 : 400} ${size}px ${family}`;
    g.fillText(t(`port_${harbour.id}`), 0.26 * k, 0);
    g.beginPath(); g.arc(0, 0, 0.07 * k, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  return canvas;
}

function paintRose(g, C, cx, cy, R) {
  const point = (deg, length, width, fill) => {
    const a = deg * DEG;
    g.beginPath();
    g.moveTo(cx + width * Math.sin(a - Math.PI / 2), cy + width * Math.cos(a - Math.PI / 2));
    g.lineTo(cx + length * Math.sin(a), cy + length * Math.cos(a));
    g.lineTo(cx + width * Math.sin(a + Math.PI / 2), cy + width * Math.cos(a + Math.PI / 2));
    g.closePath();
    g.fillStyle = fill; g.fill();
    g.strokeStyle = C.ink; g.lineWidth = 0.025; g.stroke();
  };
  g.beginPath(); g.arc(cx, cy, R * 0.98, 0, Math.PI * 2); g.fillStyle = rgba(C.vellumLight, 0.5); g.fill(); g.strokeStyle = C.ink; g.lineWidth = 0.03; g.stroke();
  g.beginPath(); g.arc(cx, cy, R * 0.9, 0, Math.PI * 2); g.strokeStyle = C.gold; g.lineWidth = 0.05; g.stroke();
  for (let s = 1; s < 32; s += 2) point(s * 11.25, R * 0.5, R * 0.035, C.quarter);
  for (let s = 0; s < 8; s++) point(22.5 + s * 45, R * 0.66, R * 0.06, C.half);
  for (let s = 0; s < 8; s++) point(s * 45, R * 0.86, R * 0.095, s % 2 ? C.lapis : C.gold);
  g.beginPath(); g.arc(cx, cy, R * 0.09, 0, Math.PI * 2); g.fillStyle = C.vermilion; g.fill(); g.strokeStyle = C.ink; g.stroke();
  // The cross on the east point, towards the Holy Land.
  const x = cx + R * 0.97, s = R * 0.09;
  g.strokeStyle = C.vermilion; g.lineWidth = 0.06;
  g.beginPath(); g.moveTo(x - s, cy); g.lineTo(x + s, cy); g.moveTo(x, cy - s); g.lineTo(x, cy + s); g.stroke();
}

function shadowCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const g = canvas.getContext('2d');
  g.shadowColor = 'rgba(255,255,255,1)';
  g.shadowBlur = 18;
  g.shadowOffsetX = 1000;
  g.fillStyle = '#fff';
  g.fillRect(24 - 1000, 22, 208, 84);
  return canvas;
}

// ── The ship ──────────────────────────────────────────────────────────
// A small cog, bow along +x: a round-bellied hull drawn to a point at the bow, its sheer rising
// fore and aft, a deck, a stern castle and a little forecastle, one mast with a square sail
// bellied forward under a red cross, and a pennant streaming aft.
const HULL = { length: 1.25, depth: 0.5, beam: 0.42, sheer: 0.16, floats: 0.42 };
const hullWidth = (x) => (x > 0 ? 1 - 0.55 * Math.pow(x / HULL.length, 1.6) : 1);   // drawn in at the bow
const hullSheer = (x) => HULL.sheer * Math.pow(x / HULL.length, 2);
function makeShip(C, material) {
  const group = new THREE.Group();
  const s = W * SHIP_SCALE;
  // Hull: the lower half of an ellipsoid, narrowed at the bow, its rim lifted into a sheer line.
  const hullGeometry = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const position = hullGeometry.attributes.position;
  for (let k = 0; k < position.count; k++) {
    const x = position.getX(k) * HULL.length, y = position.getY(k), z = position.getZ(k) * HULL.beam * hullWidth(position.getX(k) * HULL.length);
    const rim = Math.max(0, 1 + y / 0.15);          // the rim and the planks just under it follow the sheer
    position.setXYZ(k, x, y * HULL.depth + hullSheer(x) * Math.min(1, rim) + HULL.floats, z);
  }
  hullGeometry.computeVertexNormals();
  material.hull.side = THREE.DoubleSide;
  const hull = new THREE.Mesh(hullGeometry, material.hull);
  // Deck, just under the rim.
  const outline = new THREE.Shape();
  for (let k = 0; k <= 40; k++) {
    const a = (k / 40) * Math.PI * 2, x = Math.cos(a) * HULL.length * 0.97;
    const z = Math.sin(a) * HULL.beam * 0.97 * hullWidth(x);
    if (k === 0) outline.moveTo(x, z); else outline.lineTo(x, z);
  }
  const deckGeometry = new THREE.ShapeGeometry(outline, 2);
  deckGeometry.rotateX(Math.PI / 2);
  deckGeometry.translate(0, HULL.floats - 0.04, 0);
  const deckMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(C.edge), roughness: 0.85, side: THREE.DoubleSide });
  const deck = new THREE.Mesh(deckGeometry, deckMaterial);
  // Castles: a raised box at the stern, a smaller one at the bow.
  const sternCastle = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.56), material.hull);
  sternCastle.position.set(-0.92, HULL.floats + hullSheer(-0.92) + 0.08, 0);
  const foreCastle = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.34), material.hull);
  foreCastle.position.set(0.86, HULL.floats + hullSheer(0.86) + 0.04, 0);
  // Mast and yard.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 2.1, 8), material.mast);
  mast.position.set(0.05, HULL.floats + 1.0, 0);
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), material.mast);
  yard.rotation.x = Math.PI / 2;
  yard.position.set(0.08, HULL.floats + 1.62, 0);
  // The square sail, across the ship and bellied forward.
  const sailMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(C.vellumLight), roughness: 0.9, side: THREE.DoubleSide });
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 1.05, 8, 6), sailMaterial);
  const belly = sail.geometry.attributes.position;
  for (let k = 0; k < belly.count; k++) belly.setZ(k, 0.2 * Math.cos(belly.getX(k) * 1.5) * (1 - Math.abs(belly.getY(k)) * 0.5));
  sail.geometry.computeVertexNormals();
  sail.rotation.y = Math.PI / 2;                       // its plane across the keel, its belly towards the bow
  sail.position.set(0.1, HULL.floats + 1.08, 0);
  const crossMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.vermilion), side: THREE.DoubleSide });
  const crossA = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.8), crossMaterial);
  const crossB = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.18), crossMaterial);
  for (const bar of [crossA, crossB]) { bar.rotation.y = Math.PI / 2; bar.position.set(0.31, HULL.floats + 1.08, 0); }
  // A pennant at the masthead, streaming aft.
  const pennantShape = new THREE.Shape();
  pennantShape.moveTo(0, 0); pennantShape.lineTo(-0.55, -0.07); pennantShape.lineTo(0, -0.16);
  const pennant = new THREE.Mesh(new THREE.ShapeGeometry(pennantShape), crossMaterial);
  pennant.position.set(0.05, HULL.floats + 2.05, 0);
  // The yard braced round a little, as on a reach: the sail shows from every side of the table.
  const rig = new THREE.Group();
  rig.add(yard, sail, crossA, crossB);
  for (const part of rig.children) part.position.x -= 0.05;   // turned about the mast
  rig.position.x = 0.05;
  rig.rotation.y = 0.5;
  group.add(hull, deck, sternCastle, foreCastle, mast, rig, pennant);
  group.scale.setScalar(s);
  return group;
}

// ── Shaders ───────────────────────────────────────────────────────────
// The skin is flat up to a boundary that moves from west to east as it unrolls; beyond it, it
// winds round a roll whose radius shrinks a little at each turn. The inked side faces up, so the
// outside of the roll shows the back of the skin.
const SHEET_VERTEX = /* glsl */ `
uniform float uUnroll, uLeft, uRight, uRadius;
varying vec2 vUv;
varying vec2 vChart;
varying vec3 vNormal;
varying float vRolled;
void main() {
  vUv = uv;
  vec3 p = position;
  vChart = vec2(position.x, -position.z) * ${(1 / W).toFixed(1)};
  float b = mix(uLeft, uRight, uUnroll);
  vec3 n = vec3(0.0, 1.0, 0.0);
  vRolled = 0.0;
  if (p.x > b) {
    float s = p.x - b;
    float theta = s / uRadius;
    float r = uRadius * max(0.35, 1.0 - 0.018 * theta);
    p.x = b + r * sin(theta);
    p.y = r * (1.0 - cos(theta));
    n = vec3(-sin(theta), cos(theta), 0.0);
    vRolled = 1.0;
  }
  // The cockle of a skin that never lies quite flat.
  p.y += 0.0016 * sin(position.x * 9.0 + position.z * 5.0) * sin(position.z * 7.0 - position.x * 2.0) * (1.0 - vRolled);
  vNormal = n;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const SHEET_FRAGMENT = /* glsl */ `
uniform sampler2D tSkin, tNet, tInk;
uniform float uNet, uInk, uAmbient, uTime;
uniform vec2 uCircle;
uniform vec3 uLight, uBack;
varying vec2 vUv;
varying vec2 vChart;
varying vec3 vNormal;
varying float vRolled;
float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  vec4 skin = texture2D(tSkin, vUv);
  if (skin.a < 0.5) discard;
  vec3 col = skin.rgb / max(skin.a, 0.001);
  vec3 N = normalize(gl_FrontFacing ? vNormal : -vNormal);
  if (gl_FrontFacing) {
    // Rhumb lines spread from the centre of the hidden circle, with a wavering ink front.
    float d = length(vChart - uCircle);
    float front = uNet * 36.0 + (noise(vChart * 0.6) - 0.5) * 3.0;
    float net = 1.0 - smoothstep(front - 2.5, front, d);
    vec4 lines = texture2D(tNet, vUv);
    col = col * (1.0 - lines.a * net) + lines.rgb * net;
    // Coasts, names and colours inked from west to east.
    float pen = uInk * 58.0 - 30.0 + (noise(vChart * 0.45 + 3.0) - 0.5) * 4.0;
    float ink = 1.0 - smoothstep(pen - 1.6, pen, vChart.x);
    vec4 drawn = texture2D(tInk, vUv);
    col = col * (1.0 - drawn.a * ink) + drawn.rgb * ink;
  } else {
    col = mix(col, uBack, 0.55);
  }
  float light = uAmbient + 0.4 * max(dot(N, uLight), 0.0) - 0.06 * vRolled;
  gl_FragColor = vec4(col * light, 1.0);
}`;

// ── Styles of the ship's log ───────────────────────────────────────────
const STYLE = `
.ct-root { position: relative; width: 100%; height: 100%; font-family: var(--t-font-body); color: var(--t-color-ink, var(--t-text)); }
.ct-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: pan-y;
  /* Zoomed in on a voyage, the chart runs off the canvas: its edges fade into the page instead of being cut. */
  -webkit-mask-image: linear-gradient(to right, transparent, black 4%, black 96%, transparent), linear-gradient(transparent, black 5%, black 95%, transparent);
  -webkit-mask-composite: source-in; mask-image: linear-gradient(to right, transparent, black 4%, black 96%, transparent), linear-gradient(transparent, black 5%, black 95%, transparent); mask-composite: intersect; }
.ct-panel { position: absolute; top: 0.5rem; right: 0.5rem; bottom: 0.5rem; width: 19.5rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.7rem;
  padding: 1.15rem 1.2rem; background: color-mix(in srgb, var(--t-color-vellum-light, var(--t-surface)) 92%, transparent); border: 1px solid color-mix(in srgb, var(--t-color-sepia, var(--t-muted)) 45%, transparent);
  border-radius: 4px; box-shadow: 0 1px 0 rgba(255,255,255,.6) inset, 0 18px 40px -20px rgba(60,40,10,.45);
  opacity: 0; translate: 1.25rem 0; visibility: hidden; transition: opacity .7s ease, translate .7s ease, visibility 0s linear .7s; }
.ct-root.is-ready .ct-panel { opacity: 1; translate: 0 0; visibility: visible; transition: opacity .7s ease, translate .7s cubic-bezier(.2,.7,.2,1); }
.ct-panel .t-ui-eyebrow { margin: 0; color: var(--t-color-vermilion, var(--t-primary)); letter-spacing: .08em; font-variant-caps: all-small-caps; font-size: 1.05rem; }
.ct-panel .t-ui-title { margin: 0; font-size: 1.45rem; line-height: 1.15; font-weight: 600; }
.ct-step { margin: 0; padding: 0; border: 0; display: grid; gap: 0.45rem; }
.ct-legend { padding: 0; font-weight: 600; font-size: 1.02rem; }
.ct-wind-grid { display: grid; grid-template-columns: repeat(3, 1fr); grid-template-areas: "nw n ne" "w c e" "sw s se"; gap: 0.3rem; }
/* Each wind where it points on a compass card, a little rose in the middle. */
.ct-wind[data-wind="tramontana"] { grid-area: n; } .ct-wind[data-wind="greco"] { grid-area: ne; } .ct-wind[data-wind="levante"] { grid-area: e; }
.ct-wind[data-wind="scirocco"] { grid-area: se; } .ct-wind[data-wind="ostro"] { grid-area: s; } .ct-wind[data-wind="libeccio"] { grid-area: sw; }
.ct-wind[data-wind="ponente"] { grid-area: w; } .ct-wind[data-wind="maestro"] { grid-area: nw; }
.ct-wind-centre { grid-area: c; display: grid; place-items: center; }
.ct-wind-centre svg { width: 2.1rem; height: 2.1rem; fill: var(--t-color-gold, var(--t-accent)); stroke: var(--t-color-ink, var(--t-text)); stroke-width: .5; }
.ct-wind-centre circle { fill: var(--t-color-vermilion, var(--t-primary)); }
.ct-wind { display: grid; justify-items: center; gap: 0.1rem; min-height: 44px; padding: 0.35rem 0.1rem 0.3rem; border: 1px solid color-mix(in srgb, var(--t-color-sepia, var(--t-muted)) 50%, transparent);
  border-radius: 4px; background: var(--t-color-vellum-light, var(--t-surface)); color: inherit; font: inherit; font-size: 0.82rem; line-height: 1.1; cursor: pointer; }
.ct-wind .ct-arrow { width: 1.1rem; height: 1.1rem; fill: var(--t-color-sepia, var(--t-muted)); transition: fill .2s; }
.ct-wind:hover { background: color-mix(in srgb, var(--t-color-gold-light, var(--t-accent)) 35%, var(--t-color-vellum-light, var(--t-surface))); }
.ct-wind[aria-checked="true"] { background: var(--t-color-ink, var(--t-text)); color: var(--t-color-vellum-light, var(--t-surface)); border-color: var(--t-color-ink, var(--t-text)); }
.ct-wind[aria-checked="true"] .ct-arrow { fill: var(--t-color-gold-light, var(--t-accent)); }
.ct-wind:disabled { cursor: default; opacity: .7; }
.ct-range { width: 100%; accent-color: var(--t-color-vermilion, var(--t-primary)); min-height: 44px; margin: 0; }
.ct-strip { width: 100%; height: auto; margin: -0.35rem 0 0; overflow: visible; }
.ct-strip-frame { fill: var(--t-color-vellum-light, var(--t-surface)); stroke: var(--t-color-ink, var(--t-text)); stroke-width: 1; }
.ct-strip-div { fill: none; }
.ct-strip-div.is-ink { fill: var(--t-color-ink, var(--t-text)); }
.ct-strip-span { fill: none; stroke: var(--t-color-gold, var(--t-accent)); stroke-width: 2.6; stroke-linejoin: round; transition: d .2s ease; }
.ct-strip-target { fill: none; stroke: var(--t-color-vermilion, var(--t-primary)); stroke-width: 1.4; stroke-dasharray: 3 2.5; }
/* Steps appear one after the other. */
.ct-step[hidden], .ct-actions [hidden] { display: none; }
.ct-dividers:not([hidden]), .ct-sail:not([hidden]) { animation: ct-step-in .35s ease both; }
@keyframes ct-step-in { from { opacity: 0; translate: 0 .4rem; } to { opacity: 1; translate: 0 0; } }
.ct-log-item.is-optional { font-style: italic; }
.ct-miles { margin: -0.4rem 0 0; display: flex; flex-wrap: wrap; gap: 0 0.5rem; align-items: baseline; font-variant-numeric: tabular-nums lining-nums; }
/* Fixed widths and tabular figures: the line does not move as the numbers change. */
.ct-miles-value { display: inline-block; min-width: 5.2em; font-size: 1.25rem; font-weight: 600; }
.ct-divisions { color: var(--t-muted); font-size: 0.92rem; }
.ct-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.ct-actions [hidden] { display: none; }
.ct-feedback { margin: 0; min-height: 3.2em; font-size: 0.98rem; line-height: 1.35; }
.ct-feedback.is-ok { color: var(--t-success); }
.ct-feedback.is-alert { color: var(--t-error); }
.ct-log { list-style: none; margin: auto 0 0; padding: 0.6rem 0 0; border-top: 1px solid color-mix(in srgb, var(--t-color-sepia, var(--t-muted)) 35%, transparent); display: grid; gap: 0.2rem; font-size: 0.9rem; color: var(--t-muted); }
.ct-log-item::before { content: ""; display: inline-block; width: 0.55rem; height: 0.55rem; margin-right: 0.45rem; border-radius: 50%; border: 1.5px solid currentColor; vertical-align: 0.05em; }
.ct-log-item.is-open { color: var(--t-color-ink, var(--t-text)); font-weight: 600; }
.ct-log-item.is-done::before { background: var(--t-color-verdigris, var(--t-success)); border-color: var(--t-color-verdigris, var(--t-success)); }
.ct-root.is-done .ct-winds, .ct-root.is-done .ct-dividers { display: none; }
.ct-root.is-narrow { height: auto; }
.ct-root.is-narrow .ct-canvas { position: relative; height: auto; }
.ct-root.is-narrow .ct-panel { position: relative; inset: auto; width: auto; margin: 0.5rem 0 0; translate: 0 0.75rem; }
.ct-root.is-narrow.is-ready .ct-panel { translate: 0 0; }
.ct-root.is-narrow .ct-log { margin-top: 0.4rem; }
@media (prefers-reduced-motion: reduce) { .ct-panel, .ct-root.is-ready .ct-panel, .ct-strip-span { transition: none; } }
`;
