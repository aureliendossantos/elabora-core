// Free object « Phasing lab » — three.js r186, Elabora free-object contract 0.1.
// The learner sets a first burn and a number of phasing orbits; the lab flies the manoeuvre around a
// procedural Earth, burns back at the same point and measures the final gap to the client satellite,
// requirement after requirement (three by default, a list prop).
// Physics: orbit.js (two-body, shared with the course figures). Time: host.onFrame only.
// The canvas is transparent: the scene sits on the course's own starfield, without a frame.
import * as THREE from 'three';
import { RE, SIDEREAL_DAY, manoeuvre, driftPerOrbit } from './orbit.js';
import { NOISE_GLSL } from './noise.js';

const ALT = 500;                              // km, altitude of the circular orbit
const R_ORBIT = RE + ALT;
const RING = R_ORBIT / RE;                    // radius of the orbit in scene units (Earth radius = 1)
const DV_MAX = 5;
const MAX_REQUIREMENTS = 6;                   // most requirements the list may hold (manifest maxItems)
const BURN_S = 0.6;                           // seconds on screen for each burn
const HOLD_S = 1.8;                           // seconds the result stays before the next requirement
const IDLE_WARP = 240;                        // time warp while planning (the Earth turns slowly)
const START = THREE.MathUtils.degToRad(246);  // burn point: front left of the Earth
const SAMPLES_PER_ORBIT = 240;
const NARROW = 760;                           // px of frame width under which the panel goes below the view
const NARROW_VIEW = 340;
const VIEWS = [{ az: 0, el: 0.36 }, { az: 0, el: 1.18 }];
const SUN = new THREE.Vector3(1, 0.42, 0.62).normalize();

export function mount(container, ctx) {
  const { host } = ctx;
  // Words come from the manifest strings, as worded (or translated) by the block: ctx.t(key, values).
  const t = ctx.t;
  const loc = ctx.locale || 'en';
  const tx = {
    reduced: t('reduced'), ready: t('ready'), burn: t('firstBurn'), retro: t('retrograde'), pro: t('prograde'), orbits: t('phasingOrbits'),
    execute: t('execute'), running: t('running'), plot: t('plotTitle'), you: t('you'), clientTag: t('clientTag'), client: t('client'),
    burn1: (dv) => t(dv < 0 ? 'burn1Retrograde' : dv > 0 ? 'burn1Prograde' : 'burn1None'),
    gapText: (g, f) => (Math.abs(g) < 0.05 ? t('gapAlongside') : g > 0 ? t('gapAhead', { gap: f(g) }) : t('gapBehind', { gap: f(-g) })),
    final: (where) => t('final', { where }), met: (i, where) => t('met', { i, where }), allDone: t('allDone'),
    noBurn: t('whyNoBurn'), wrongWay: (dv) => t(dv > 0 ? 'whyPrograde' : 'whyRetrograde'), tooLittle: t('tooLittle'), tooMuch: t('tooMuch'), rule: t('rule'),
    overBudget: (cost, budget) => t('overBudget', { cost, budget }), tooLong: (orbits) => t('tooLong', { orbits }),
    coast: (lap, orbits) => t('coast', { lap, orbits }), burn2: t('burn2'),
    explore: t('freeFlight'), req: (i, total) => t('requirement', { i, total }), done: t('allMet'), catchUp: t('catchUp'), letCatch: t('letCatch'),
    freeBrief: t('freeBrief'), brief: (g, orbits, budget, f) => t(g >= 0 ? 'briefAhead' : 'briefBehind', { gap: f(Math.abs(g)), orbits, budget }),
    dvText: (dv, f) => (dv < 0 ? t('burnRetrograde', { dv: f(-dv) }) : dv > 0 ? t('burnPrograde', { dv: f(dv) }) : t('burnNone')),
    propellant: t('propellant'), of: (used, budget) => t('propellantUse', { used, budget }), both: t('bothBurns'),
    predicted: (where) => t('predicted', { where }), play: t('resume'), pause: t('pause'), view: t('view'), viewNames: [t('view34'), t('viewAbove')],
    scale: (k) => t('scale', { k }), along: t('plotAlong'), radial: t('plotAltitude')
  };
  const f1 = (v) => (Math.round(v * 10) / 10).toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fb = (v) => v.toLocaleString(loc, { maximumFractionDigits: 1 });
  const reduced = !!ctx.reducedMotion;
  let values = { ...ctx.props };                // as the block gives them; update() merges into them
  let props = withDefaults(values);
  // Part of the frame covered by the course layout (the brief floating over the stage).
  let safe = { top: 0, right: 0, bottom: 0, left: 0, ...(ctx.safeArea || {}) };

  // step: index of the open requirement (their number once all are met); runs: manoeuvres flown
  // for each, sized to the most requirements a list may hold.
  const state = { dv: 0, orbits: 1, step: 0, runs: Array(MAX_REQUIREMENTS).fill(0) };
  let run = null;          // the manoeuvre being flown
  let paused = false;
  let viewIndex = 0;
  let az = VIEWS[0].az, elev = VIEWS[0].el, dist = 4;
  let earthSpin = 0.6, cloudShift = 0;
  let narrow = false;
  let message = reduced ? tx.reduced : tx.ready;
  let messageKind = '';

  const reqs = () => props.requirements;
  const current = () => (state.step < reqs().length ? reqs()[state.step] : { gap: reqs()[0].gap, orbits: 3, budget: 20, free: true });

  // ── DOM: transparent 3D view, glass control panel, relative-motion plot. The panel uses the Elabora
  // UI kit (t-ui-* classes, --t-* variables), sizes in rem (1rem follows the course size class).
  container.innerHTML = '';
  container.className = 'pl-root t-ui';
  const css = document.createElement('style');
  css.textContent = STYLE;
  container.appendChild(css);

  const view = el('div', 'pl-view');
  const panel = el('div', 'pl-panel pl-glass');
  const hud = el('div', 'pl-hud pl-glass');
  container.append(view, panel, hud);

  const instruction = el('p', 'pl-instruction t-ui-muted');
  const card = el('div', 't-ui-card pl-card');
  const cardEyebrow = el('p', 't-ui-eyebrow'), cardTitle = el('p', 't-ui-title'), cardText = el('p', 'pl-brief'), dots = el('div', 'pl-dots'); // one dot per requirement (refresh)
  card.append(cardEyebrow, cardTitle, cardText, dots);

  const burnBox = el('div', 'pl-burn');
  const burnHead = el('div', 'pl-burn-head');
  const burnLabel = el('label', 'pl-label', tx.burn); burnLabel.htmlFor = 'pl-dv';
  const burnValue = el('output', 'pl-dv'); burnValue.htmlFor = 'pl-dv';
  burnHead.append(burnLabel, burnValue);
  const range = el('input', 'pl-range');
  Object.assign(range, { type: 'range', id: 'pl-dv', min: String(-DV_MAX), max: String(DV_MAX), step: '0.5', value: '0' });
  const ends = el('div', 'pl-ends'); ends.append(el('span', '', tx.retro), el('span', '', tx.pro));
  burnBox.append(burnHead, range, ends);

  const seg = el('fieldset', 't-ui-seg');
  const legend = el('legend', '', tx.orbits);
  const segOptions = el('div', 't-ui-seg-options');
  const orbitInputs = [1, 2, 3].map((n) => {
    const label = el('label');
    const input = el('input'); input.type = 'radio'; input.name = 'pl-orbits'; input.value = String(n);
    input.addEventListener('change', () => { if (input.checked) setOrbits(n); });
    label.append(input, document.createTextNode(String(n)));
    segOptions.append(label);
    return input;
  });
  seg.append(legend, segOptions);

  const meters = el('div', 't-ui-meters');
  const mFuel = el('div', 't-ui-meter'), mGap = el('div', 't-ui-meter');
  meters.append(mFuel, mGap);
  const predict = el('p', 'pl-predict');
  const exec = el('button', 't-ui-btn t-ui-btn--primary pl-exec', tx.execute); exec.type = 'button';
  const status = el('p', 't-ui-status pl-status'); status.setAttribute('role', 'status');
  panel.append(instruction, card, burnBox, seg, meters, predict, exec, status);

  const hudHead = el('div', 'pl-hud-head');
  const hudTitle = el('p', 't-ui-eyebrow', tx.plot);
  const hudButtons = el('div', 'pl-hud-buttons');
  const pauseBtn = el('button', 't-ui-btn t-ui-btn--ghost pl-small'); pauseBtn.type = 'button';
  const viewBtn = el('button', 't-ui-btn t-ui-btn--ghost pl-small'); viewBtn.type = 'button';
  hudButtons.append(pauseBtn, viewBtn);
  hudHead.append(hudTitle, hudButtons);
  const plot = makePlot();
  const scaleNote = el('p', 'pl-scale t-ui-muted');
  hud.append(hudHead, plot.svg, scaleNote);

  const tags = { servicer: makeTag(tx.you, 'is-servicer'), client: makeTag(tx.clientTag, 'is-client') };

  // ── three.js scene ──
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!ctx.testMode });
  renderer.setPixelRatio(ctx.testMode ? 1 : Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  view.prepend(renderer.domElement);
  host.registerRenderer(renderer);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 100);
  host.registerCamera(camera);

  const col = (hex) => new THREE.Color(hex);
  const tok = ctx.tokens || {};
  const palette = () => ({
    servicer: col(props.servicerColor), client: col(props.clientColor), orbit: col(props.orbitColor), atmosphere: col(props.atmosphereColor),
    ocean: col(tok['color.ocean'] || tok['color.primary']), oceanDeep: col(tok['color.ocean-deep'] || tok['color.surface']),
    land: col(tok['color.land'] || tok['color.success']), landDry: col(tok['color.land-dry'] || tok['color.accent']),
    ice: col(tok['color.ice'] || tok['color.text']), city: col(tok['color.city'] || tok['color.accent'])
  });
  let C = palette();

  // Earth surface, city lights and clouds are baked once into two textures on the GPU (procedural
  // noise, no asset to load), then sampled every frame: cheap to draw, crisp at any size.
  // The detailed Earth is baked over the first frames (a plain ocean sphere shows meanwhile, then the
  // baked one fades in): mount() answers the host at once, even without a GPU.
  const bake = earthBaker(renderer, C);
  let reveal = 0;
  const earthGroup = new THREE.Group();
  earthGroup.rotation.z = 0.41;                       // the orbit is inclined on the equator
  scene.add(earthGroup);
  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      uAlbedo: { value: bake.albedo.texture }, uExtra: { value: bake.extra.texture }, uReady: { value: 0 }, uOcean: { value: C.ocean },
      uSun: { value: SUN }, uAtmo: { value: C.atmosphere }, uCity: { value: C.city }, uCloudShift: { value: 0 }
    },
    vertexShader: VERT_SURFACE, fragmentShader: FRAG_EARTH
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), earthMat);
  earth.userData.id = 'earth';
  earthGroup.add(earth);
  host.registerObject('earth', earth);
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: SUN }, uAtmo: { value: C.atmosphere } },
    vertexShader: VERT_SURFACE, fragmentShader: FRAG_ATMOSPHERE, side: THREE.BackSide, transparent: true, depthWrite: false
  });
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.055, 96, 48), atmoMat);
  scene.add(atmosphere);

  // Orbit, burn point, paths.
  const ringGeo = new THREE.TorusGeometry(RING, 0.0026, 6, 256).rotateX(Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: C.orbit, transparent: true, opacity: 0.6, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  scene.add(ring);
  const MAX_SAMPLES = 3 * SAMPLES_PER_ORBIT + 2;
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SAMPLES * 3), 3));
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({ color: C.servicer });
  const trail = new THREE.Line(trailGeo, trailMat);
  trail.frustumCulled = false;
  scene.add(trail);
  const previewGeo = new THREE.BufferGeometry();
  previewGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SAMPLES_PER_ORBIT + 1) * 3), 3));
  const previewMat = new THREE.LineDashedMaterial({ color: C.servicer, transparent: true, opacity: 0.6, dashSize: 0.025, gapSize: 0.02 });
  const preview = new THREE.Line(previewGeo, previewMat);
  preview.frustumCulled = false;
  scene.add(preview);

  const glowTex = glowTexture();
  const sprite = (color, size, opacity = 1) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, depthWrite: false }));
    s.scale.setScalar(size);
    return s;
  };
  const servicer = new THREE.Group();
  const servicerGlow = sprite(C.servicer, 0.17), servicerCore = sprite(new THREE.Color(1, 1, 1), 0.034);
  servicer.add(servicerGlow, servicerCore);
  servicer.userData.id = 'servicer';
  scene.add(servicer);
  host.registerObject('servicer', servicer);
  const client = new THREE.Group();
  const clientGlow = sprite(C.client, 0.15), clientCore = sprite(new THREE.Color(1, 1, 1), 0.03);
  client.add(clientGlow, clientCore);
  client.userData.id = 'client';
  scene.add(client);
  host.registerObject('client', client);
  const burnPoint = sprite(C.servicer, 0.07, 0.35);
  burnPoint.position.copy(polar(RING, START));
  scene.add(burnPoint);
  const flash = sprite(C.servicer, 0.001, 0);
  scene.add(flash);
  const thrust = arrow(C.servicer, 1);
  const velocity = arrow(new THREE.Color(1, 1, 1), 0.55);
  scene.add(thrust.group, velocity.group);

  // ── layout and camera framing ──
  function layout() {
    const w = container.clientWidth || 0;
    const next = w > 0 && w < NARROW;
    if (next !== narrow) { narrow = next; container.classList.toggle('is-narrow', narrow); }
    requestNarrowHeight();
    resize();
  }
  // Narrow frames stack view, panel and plot: the object asks the host for the height of all three.
  // Measured from the last child, not from the frame (whose height is the answer): no feedback loop.
  let requested = 0;
  function requestNarrowHeight() {
    if (!narrow) return;
    const h = Math.ceil(hud.offsetTop + hud.offsetHeight + 12);
    if (Math.abs(h - requested) > 1) { requested = h; host.requestHeight?.(h); }
  }
  function resize() {
    const w = view.clientWidth || 1, h = view.clientHeight || 1;
    renderer.setSize(w, h, false);
    // Wide frames: the Earth sits between the safe area (the part the layout covers) and the panel.
    const left = narrow ? 0 : Math.min(safe.left, w * 0.5);
    const right = narrow ? w : Math.max(left + w * 0.3, w - panel.offsetWidth - 40);
    const top = narrow ? 0 : Math.min(safe.top, h * 0.4);
    const bottom = h - (narrow ? 0 : Math.min(safe.bottom, h * 0.4));
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const rpx = Math.max(60, Math.min((bottom - top) * (narrow ? 0.36 : 0.4), (right - left) * 0.42));
    camera.aspect = w / h;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    dist = 1 / Math.sin(Math.atan((rpx / (h / 2)) * tanHalf));
    camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
    camera.updateProjectionMatrix();
  }
  const offSafe = host.onSafeArea?.((area) => { safe = area; layout(); });
  const ro = new ResizeObserver(layout);
  ro.observe(container);
  ro.observe(panel);
  ro.observe(hud);

  // ── interaction ──
  range.addEventListener('input', () => setDv(Number(range.value)));
  exec.addEventListener('click', execute);
  pauseBtn.addEventListener('click', togglePause);
  viewBtn.addEventListener('click', () => { viewIndex = (viewIndex + 1) % VIEWS.length; az = VIEWS[viewIndex].az; elev = VIEWS[viewIndex].el; refresh(); });
  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') setDv(state.dv - 0.5);
    else if (k === 'p') setDv(state.dv + 0.5);
    else if (k === '1' || k === '2' || k === '3') setOrbits(Number(k));
    else if (k === 'x') execute();
    else if (k === ' ' && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); togglePause(); }
  }
  document.addEventListener('keydown', onKey);
  let drag = null;
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, az, elev }; canvas.setPointerCapture?.(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    az = THREE.MathUtils.clamp(drag.az - (e.clientX - drag.x) * 0.006, -1.2, 1.2);
    elev = THREE.MathUtils.clamp(drag.elev + (e.clientY - drag.y) * 0.005, 0.12, 1.35);
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Busy while a manoeuvre is flown; once it is over (result shown), the learner can plan the next one.
  const busy = () => !!run && run.phase !== 'hold';
  function endRun() { run = null; trailGeo.setDrawRange(0, 0); plot.setPath(null); }
  function setDv(v) {
    if (busy()) return;
    state.dv = THREE.MathUtils.clamp(Math.round(v * 2) / 2, -DV_MAX, DV_MAX);
    if (run) endRun();
    refresh();
  }
  function setOrbits(n) {
    if (busy()) return;
    state.orbits = THREE.MathUtils.clamp(n, 1, 3);
    if (run) endRun();
    refresh();
  }
  function togglePause() { paused = !paused; refresh(); }

  // ── the manoeuvre ──
  function execute() {
    if (busy()) return;
    if (run) endRun();
    const req = current();
    const plan = manoeuvre({ altitude: ALT, dv: state.dv, orbits: state.orbits, gap0: req.gap });
    const n = state.orbits * SAMPLES_PER_ORBIT;
    const samples = Array.from({ length: n + 1 }, (_, i) => plan.at((plan.duration * i) / n));
    run = { req, plan, samples, dv: state.dv, orbits: state.orbits, phase: 'burn1', time: 0, simT: 0, reported: false };
    plot.setPath(samples);
    if (reduced) { run.phase = 'hold'; run.simT = plan.duration; finish(); }
    else say(tx.burn1(state.dv));
    refresh();
  }

  function finish() {
    const { req, plan, dv, orbits } = run;
    run.reported = true;
    const fin = plan.finalGap;
    const where = tx.gapText(fin, f1);
    const reach = Math.abs(fin) <= props.tolerance;
    const inBudget = plan.cost <= req.budget + 1e-9;
    const inTime = orbits <= req.orbits;
    const correct = dv !== 0 && reach && inBudget && inTime;
    if (req.free) { say(tx.final(where), reach ? 'is-ok' : ''); return; }
    const i = state.step;
    const count = reqs().length;
    state.runs[i] += 1;
    host.emit('manoeuvre', { requirement: i + 1, plan: `${dv > 0 ? '+' : ''}${dv.toFixed(1)}x${orbits}`, dv, orbits, finalGap: Math.round(fin * 10) / 10, correct });
    if (correct) {
      host.emit('requirement_met', { requirement: i + 1, runs: state.runs[i] });
      state.step += 1;
      if (state.step === count) {
        const score = state.runs.slice(0, count).reduce((s, r) => s + Math.max(0.25, 1 - 0.25 * (r - 1)), 0) / count;
        host.emit('completed', { score: Math.round(score * 100) / 100 });
        say(`${tx.met(i + 1, where)} ${tx.allDone}`, 'is-ok');
      } else say(tx.met(i + 1, where), 'is-ok');
      return;
    }
    let why;
    if (dv === 0) why = tx.noBurn;
    else if (Math.sign(dv) === Math.sign(req.gap)) why = tx.wrongWay(dv);
    else if (!reach) why = `${Math.sign(fin) === Math.sign(req.gap) ? tx.tooLittle : tx.tooMuch} ${tx.rule}`;
    else if (!inBudget) why = tx.overBudget(fb(plan.cost), fb(req.budget));
    else why = tx.tooLong(req.orbits);
    say(`${tx.final(where)} ${why}`, 'is-ko');
  }

  function say(text, kind = '') { message = text; messageKind = kind; status.textContent = text; status.className = `t-ui-status pl-status ${kind}`; }

  // ── per-frame update ──
  const tmp = new THREE.Vector3();
  host.onFrame((dt) => {
    if (!bake.done) bake.step(2);
    else if (reveal < 1) { reveal = reduced || ctx.testMode ? 1 : Math.min(1, reveal + dt / 0.5); earthMat.uniforms.uReady.value = reveal; }
    const step = paused ? 0 : dt;
    let simDt = reduced ? 0 : step * IDLE_WARP;
    if (run) {
      run.time += step;
      const coastS = run.orbits * props.secondsPerOrbit;
      if (run.phase === 'burn1' && run.time >= BURN_S) { run.phase = 'coast'; run.time -= BURN_S; }
      if (run.phase === 'coast') {
        const k = Math.min(1, run.time / coastS);
        simDt = Math.max(0, k * run.plan.duration - run.simT);
        run.simT = k * run.plan.duration;
        const lap = Math.min(run.orbits, Math.floor(k * run.orbits) + 1);
        if (run.lap !== lap) { run.lap = lap; say(tx.coast(lap, run.orbits)); }
        if (k >= 1) { run.phase = 'burn2'; run.time = 0; say(tx.burn2); }
      }
      if (run.phase === 'burn2' && run.time >= BURN_S) { run.phase = 'hold'; run.time = 0; finish(); refresh(); }
      if (run.phase === 'hold' && run.time >= HOLD_S) { endRun(); refresh(); }
    }
    earthSpin += (simDt * 2 * Math.PI) / SIDEREAL_DAY;
    cloudShift += simDt / (SIDEREAL_DAY * 4);
    earth.rotation.y = earthSpin;
    earthMat.uniforms.uCloudShift.value = cloudShift % 1;
    placeCraft();
    camera.position.set(dist * Math.cos(elev) * Math.sin(az), dist * Math.sin(elev), dist * Math.cos(elev) * Math.cos(az));
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    const a = placeTag(tags.servicer, servicer.position);
    const b = placeTag(tags.client, client.position);
    if (Math.hypot(a.x - b.x, a.y - b.y) < 70) placeTag(tags.client, client.position, true);
  });

  // Visual positions: the servicer at its true angle, its altitude offset magnified; the client placed
  // from the servicer with the along-track gap magnified the same way (the plot keeps the true scale).
  function placeCraft() {
    const k = props.exaggeration;
    const req = current();
    const s = run ? run.plan.at(run.simT) : { servicer: { r: R_ORBIT, angle: 0 }, client: { r: R_ORBIT, angle: req.gap / R_ORBIT }, gap: req.gap, radial: 0 };
    const phiS = START + s.servicer.angle;
    servicer.position.copy(polar(RING + (k * s.radial) / RE, phiS));
    const rel = THREE.MathUtils.clamp(k * (s.client.angle - s.servicer.angle), -2.6, 2.6);
    client.position.copy(polar(RING, phiS + rel));
    // Trail of the servicer during the manoeuvre.
    if (run) {
      const n = Math.min(run.samples.length, Math.floor((run.simT / run.plan.duration) * (run.samples.length - 1)) + 1);
      const arr = trailGeo.attributes.position.array;
      for (let i = run.drawn || 0; i < n; i++) {
        const p = run.samples[i];
        tmp.copy(polar(RING + (k * p.radial) / RE, START + p.servicer.angle));
        arr[i * 3] = tmp.x; arr[i * 3 + 1] = tmp.y; arr[i * 3 + 2] = tmp.z;
      }
      run.drawn = n;
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.setDrawRange(0, n);
      plot.progress(n, s);
      const live = tx.gapText(s.gap, f1);
      if (live !== run.shown) { run.shown = live; meter(mGap, tx.client, live, ''); }
    } else plot.idle(req.gap);
    // Arrows: velocity along the motion, thrust along or against it (or nothing without a burn).
    const tangent = new THREE.Vector3(-Math.sin(phiS), 0, -Math.cos(phiS));
    const outward = servicer.position.clone().normalize();
    const burning = run && (run.phase === 'burn1' || run.phase === 'burn2');
    const dv = run ? run.dv * (run.phase === 'burn2' ? -1 : 1) : state.dv;
    const showThrust = dv !== 0 && (!run || burning);
    thrust.group.visible = showThrust;
    if (showThrust) thrust.set(servicer.position, tangent.clone().multiplyScalar(Math.sign(dv)), 0.06 + 0.026 * Math.abs(dv));
    velocity.group.visible = !run;
    velocity.set(servicer.position.clone().addScaledVector(outward, 0.035), tangent, 0.13);
    // Flash at each burn.
    if (burning && !reduced) {
      const k2 = Math.min(1, run.time / BURN_S);
      flash.position.copy(servicer.position);
      flash.scale.setScalar(0.05 + 0.3 * Math.sin(k2 * Math.PI));
      flash.material.opacity = 0.9 * Math.sin(k2 * Math.PI);
    } else flash.material.opacity = 0;
    burnPoint.visible = !!run;
    // Prediction (help prop): the phasing path, before executing.
    preview.visible = !!props.showPrediction && !run && state.dv !== 0;
    if (preview.visible) {
      const plan = manoeuvre({ altitude: ALT, dv: state.dv, orbits: 1, gap0: 0 });
      const arr = previewGeo.attributes.position.array;
      for (let i = 0; i <= SAMPLES_PER_ORBIT; i++) {
        const p = plan.at((plan.duration * i) / SAMPLES_PER_ORBIT);
        tmp.copy(polar(RING + (k * p.radial) / RE, START + p.servicer.angle));
        arr[i * 3] = tmp.x; arr[i * 3 + 1] = tmp.y; arr[i * 3 + 2] = tmp.z;
      }
      previewGeo.attributes.position.needsUpdate = true;
      preview.computeLineDistances();
    }
  }

  // ── panel text ──
  function refresh() {
    const req = current();
    instruction.textContent = props.instruction;
    cardEyebrow.textContent = req.free ? tx.explore : tx.req(state.step + 1, reqs().length);
    cardTitle.textContent = req.free ? tx.done : req.gap >= 0 ? tx.catchUp : tx.letCatch;
    cardText.textContent = req.free ? tx.freeBrief : tx.brief(req.gap, req.orbits, fb(req.budget), fb);
    if (dots.children.length !== reqs().length) dots.replaceChildren(...reqs().map(() => el('i')));
    [...dots.children].forEach((d, i) => { d.className = i < state.step ? 'on' : i === state.step ? 'cur' : ''; });
    range.value = String(state.dv);
    const dvText = tx.dvText(state.dv, f1);
    burnValue.textContent = dvText;
    range.setAttribute('aria-valuetext', dvText);
    range.disabled = busy();
    orbitInputs.forEach((input, i) => { input.checked = state.orbits === i + 1; input.disabled = busy(); });
    const cost = 2 * Math.abs(state.dv);
    meter(mFuel, tx.propellant, tx.of(fb(cost), fb(req.budget)), tx.both);
    mFuel.classList.toggle('is-over', !req.free && cost > req.budget + 1e-9);
    const gapNow = run ? run.plan.at(run.simT).gap : req.gap;
    meter(mGap, tx.client, tx.gapText(gapNow, f1), '');
    predict.hidden = !props.showPrediction || busy() || req.free;
    if (!predict.hidden) predict.textContent = tx.predicted(tx.gapText(req.gap - driftPerOrbit(ALT, state.dv) * state.orbits, f1));
    exec.setAttribute('aria-disabled', String(busy()));
    exec.textContent = busy() ? tx.running : tx.execute;
    pauseBtn.textContent = paused ? tx.play : tx.pause;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    viewBtn.textContent = tx.viewNames[viewIndex];
    viewBtn.setAttribute('aria-label', `${tx.view}: ${tx.viewNames[viewIndex]}`);
    scaleNote.textContent = tx.scale(props.exaggeration);
    if (status.textContent !== message) say(message, messageKind);
    requestNarrowHeight();
  }
  function meter(node, label, value, sub) {
    node.replaceChildren(el('small', '', label), el('b', '', value), sub ? el('em', '', sub) : '');
  }

  // ── tags over the craft (hidden when the Earth is in front) ──
  function makeTag(text, cls) {
    const tag = el('div', `pl-tag ${cls}`, text);
    tag.setAttribute('aria-hidden', 'true');
    view.appendChild(tag);
    return tag;
  }
  const ndc = new THREE.Vector3();
  function placeTag(tag, pos, below = false) {
    ndc.copy(pos).project(camera);
    const w = view.clientWidth, h = view.clientHeight;
    const x = ((ndc.x + 1) / 2) * w, y = ((1 - ndc.y) / 2) * h;
    tag.style.opacity = occluded(pos) || ndc.z > 1 ? '0' : '1';
    tag.style.transform = `translate(${x}px, ${y}px) translate(-50%, ${below ? '0.75rem' : 'calc(-100% - 0.75rem)'})`;
    return { x, y };
  }
  function occluded(p) {
    const o = camera.position, d = tmp.copy(p).sub(o);
    const a = d.dot(d), b = 2 * o.dot(d), c = o.dot(o) - 0.995 * 0.995;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    const s = (-b - Math.sqrt(disc)) / (2 * a);
    return s > 0 && s < 1;
  }

  // ── relative-motion plot (SVG, true scale) ──
  function makePlot() {
    const W = 320, H = 150, L = 34, R = 10, T = 14, B = 26;
    const mk = (tag, attrs) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const svg = mk('svg', { class: 'pl-plot', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    const grid = mk('g', { class: 'pl-grid' });
    const trace = mk('polyline', { class: 'pl-trace', fill: 'none' });
    const clientMark = mk('path', { class: 'pl-cmark', d: 'M0 -5L5 0L0 5L-5 0Z' });
    const dot = mk('circle', { class: 'pl-sdot', r: '4' });
    const xLabel = mk('text', { class: 'pl-axis', x: String(W - R), y: String(H - 4), 'text-anchor': 'end' });
    const yLabel = mk('text', { class: 'pl-axis', x: String(L), y: '9' });
    xLabel.textContent = tx.along; yLabel.textContent = tx.radial;
    svg.append(grid, trace, clientMark, dot, xLabel, yLabel);
    let sx = (x) => x, sy = (y) => y, key = '';
    function nice(range) {
      const raw = range / 4, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
      return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    }
    function setRange(x0, x1, yr) {
      const k = `${x0.toFixed(2)}|${x1.toFixed(2)}|${yr.toFixed(2)}`;
      if (k === key) return;
      key = k;
      sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
      sy = (y) => T + ((yr - y) / (2 * yr)) * (H - T - B);
      grid.replaceChildren();
      const xs = nice(x1 - x0), ys = nice(2 * yr);
      for (let x = Math.ceil(x0 / xs) * xs; x <= x1 + 1e-9; x += xs) {
        grid.append(mk('line', { x1: sx(x), x2: sx(x), y1: T, y2: H - B, class: Math.abs(x) < 1e-9 ? 'pl-zero' : '' }));
        const lab = mk('text', { x: sx(x), y: H - B + 11, 'text-anchor': 'middle' }); lab.textContent = fb(Math.round(x * 10) / 10); grid.append(lab);
      }
      for (let y = Math.ceil(-yr / ys) * ys; y <= yr + 1e-9; y += ys) {
        grid.append(mk('line', { x1: L, x2: W - R, y1: sy(y), y2: sy(y), class: Math.abs(y) < 1e-9 ? 'pl-zero' : '' }));
        const lab = mk('text', { x: L - 4, y: sy(y) + 3, 'text-anchor': 'end' }); lab.textContent = fb(Math.round(y * 10) / 10); grid.append(lab);
      }
      clientMark.setAttribute('transform', `translate(${sx(0)} ${sy(0)})`);
    }
    let path = null;
    return {
      svg,
      idle(gap) {
        const span = Math.max(10, Math.abs(gap) * 1.25);
        setRange(-span, span, 5);
        trace.setAttribute('points', '');
        dot.setAttribute('cx', sx(-gap)); dot.setAttribute('cy', sy(0));
      },
      setPath(samples) {
        path = samples;
        if (!samples) return;
        let x0 = 0, x1 = 0, y = 2;
        for (const p of samples) { x0 = Math.min(x0, -p.gap); x1 = Math.max(x1, -p.gap); y = Math.max(y, Math.abs(p.radial)); }
        const pad = Math.max(4, (x1 - x0) * 0.08);
        setRange(x0 - pad, x1 + pad, y * 1.25);
      },
      progress(n, s) {
        if (!path) return;
        let pts = '';
        for (let i = 0; i < n; i++) pts += `${sx(-path[i].gap).toFixed(1)},${sy(path[i].radial).toFixed(1)} `;
        trace.setAttribute('points', pts);
        dot.setAttribute('cx', sx(-s.gap)); dot.setAttribute('cy', sy(s.radial));
      }
    };
  }

  function applyColors() {
    C = palette();
    earthMat.uniforms.uAtmo.value = C.atmosphere;
    atmoMat.uniforms.uAtmo.value = C.atmosphere;
    ringMat.color.copy(C.orbit);
    trailMat.color.copy(C.servicer);
    previewMat.color.copy(C.servicer);
    servicerGlow.material.color.copy(C.servicer);
    clientGlow.material.color.copy(C.client);
    burnPoint.material.color.copy(C.servicer);
    flash.material.color.copy(C.servicer);
    thrust.setColor(C.servicer);
    container.style.setProperty('--pl-servicer', props.servicerColor);
    container.style.setProperty('--pl-client', props.clientColor);
  }
  applyColors();
  layout();
  refresh();
  say(message);

  return {
    update(next) {
      values = { ...values, ...next };
      props = withDefaults(values);
      state.step = Math.min(state.step, reqs().length);
      endRun();
      applyColors(); layout(); refresh();
    },
    getState() { return { dv: state.dv, orbits: state.orbits, step: state.step, runs: state.runs.slice(0, reqs().length), running: busy() }; },
    setState(s) {
      if (!s) return;
      endRun();
      if (Number.isFinite(s.dv)) state.dv = THREE.MathUtils.clamp(s.dv, -DV_MAX, DV_MAX);
      if (Number.isInteger(s.orbits)) state.orbits = THREE.MathUtils.clamp(s.orbits, 1, 3);
      if (Number.isInteger(s.step)) state.step = THREE.MathUtils.clamp(s.step, 0, reqs().length);
      if (Array.isArray(s.runs)) state.runs = Array.from({ length: MAX_REQUIREMENTS }, (_, i) => Math.max(0, s.runs[i] | 0));
      message = state.step >= reqs().length ? tx.allDone : tx.ready; messageKind = '';
      refresh();
    },
    pause() { paused = true; refresh(); },
    resume() { paused = false; refresh(); },
    dispose() {
      ro.disconnect();
      offSafe?.();
      document.removeEventListener('keydown', onKey);
      scene.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
      glowTex.dispose();
      thrust.dispose(); velocity.dispose();
      bake.dispose();
      renderer.dispose();
      container.innerHTML = '';
    }
  };

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
}

// ── Props ──
// The requirements, a list of { gap, orbits, budget } (up to six): an item without its three numbers
// is left out, numbers are brought within their bounds, and a list with none left gives the default
// requirements. The other props are used as they are.
const REQUIREMENTS = [{ gap: 51, orbits: 1, budget: 8 }, { gap: 51, orbits: 3, budget: 2.5 }, { gap: -34, orbits: 2, budget: 2.5 }];
function withDefaults(props = {}) {
  const { clamp } = THREE.MathUtils;
  const listed = (Array.isArray(props.requirements) ? props.requirements : [])
    .filter((req) => req && Number.isFinite(req.gap) && Number.isFinite(req.orbits) && Number.isFinite(req.budget))
    .slice(0, MAX_REQUIREMENTS)
    .map(({ gap, orbits, budget }) => ({ gap: clamp(gap, -150, 150), orbits: clamp(Math.round(orbits), 1, 3), budget: clamp(budget, 1, 20) }));
  return { ...props, requirements: listed.length ? listed : REQUIREMENTS.map((req) => ({ ...req })) };
}

// Point of the orbital plane (XZ) at radius r and angle a, counter-clockwise seen from above.
function polar(r, a) { return new THREE.Vector3(r * Math.cos(a), 0, -r * Math.sin(a)); }

function arrow(color, opacity) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  const shaftGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 1, 10).translate(0, 0.5, 0);
  const headGeo = new THREE.ConeGeometry(0.014, 0.036, 16).translate(0, -0.018, 0);
  const shaft = new THREE.Mesh(shaftGeo, mat), head = new THREE.Mesh(headGeo, mat);
  group.add(shaft, head);
  const up = new THREE.Vector3(0, 1, 0);
  return {
    group,
    set(origin, dir, length) {
      group.position.copy(origin);
      group.quaternion.setFromUnitVectors(up, dir.clone().normalize());
      shaft.scale.y = Math.max(0.001, length - 0.036);
      head.position.y = length;
    },
    setColor(c) { mat.color.copy(c); },
    dispose() { shaftGeo.dispose(); headGeo.dispose(); mat.dispose(); }
  };
}

function glowTexture() {
  const N = 64, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) / (N / 2);
    const a = Math.max(0, 1 - r) ** 2.4;
    const i = (y * N + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(a * 255);
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.needsUpdate = true;
  return tex;
}

// Renders the procedural Earth into two equirectangular textures (same UV layout as SphereGeometry):
// albedo (gamma-encoded) + land mask, and city lights + cloud cover. The work is cut into strips,
// a few per frame, so the activity stays responsive on machines without a GPU (software WebGL).
const STRIPS = 16;
function earthBaker(renderer, C) {
  const make = (W, H) => new THREE.WebGLRenderTarget(W, H, {
    generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping
  });
  const albedo = make(2048, 1024), extra = make(1024, 512);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMode: { value: 0 }, uOcean: { value: C.ocean }, uOceanDeep: { value: C.oceanDeep }, uLand: { value: C.land },
      uLandDry: { value: C.landDry }, uIce: { value: C.ice }, uAtmo: { value: C.atmosphere }
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FRAG_BAKE, depthTest: false, depthWrite: false
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const jobs = [];
  for (const [rt, mode] of [[albedo, 0], [extra, 1]]) for (let i = 0; i < STRIPS; i++) jobs.push({ rt, mode, i });
  let k = 0;
  function draw(rt, mode, y, h) {
    mat.uniforms.uMode.value = mode;
    rt.scissor.set(0, y, rt.width, h);
    rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    rt.scissorTest = false;
  }
  return {
    albedo, extra,
    get done() { return k >= jobs.length; },
    step(n) {
      if (k >= jobs.length) return;
      const prev = renderer.getRenderTarget();
      for (let c = 0; c < n && k < jobs.length; c++, k++) {
        const { rt, mode, i } = jobs[k];
        draw(rt, mode, (i * rt.height) / STRIPS, rt.height / STRIPS);
      }
      if (k >= jobs.length) { quad.geometry.dispose(); mat.dispose(); }
      renderer.setRenderTarget(prev);
    },
    dispose() { albedo.dispose(); extra.dispose(); if (k < jobs.length) { quad.geometry.dispose(); mat.dispose(); } }
  };
}

const VERT_SURFACE = `
varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
void main(){
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG_EARTH = `
uniform sampler2D uAlbedo; uniform sampler2D uExtra;
uniform vec3 uSun; uniform vec3 uAtmo; uniform vec3 uCity; uniform float uCloudShift; uniform float uReady; uniform vec3 uOcean;
varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
void main(){
  vec4 a = texture2D(uAlbedo, vUv);
  vec3 surface = mix(uOcean, a.rgb * a.rgb, uReady);
  float land = a.a * uReady;
  float lights = texture2D(uExtra, vUv).r * uReady;
  float clouds = texture2D(uExtra, vec2(vUv.x + uCloudShift, vUv.y)).g * uReady;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vPos);
  float ndl = dot(N, uSun);
  float day = smoothstep(-0.12, 0.22, ndl);
  vec3 H = normalize(uSun + V);
  float glint = pow(max(dot(N, H), 0.0), 160.0) * (1.0 - land) * (1.0 - clouds) * step(0.0, ndl);
  vec3 ground = mix(surface, vec3(0.92), clouds * 0.9);
  vec3 lit = ground * (0.02 + 1.05 * max(ndl, 0.0)) + glint * 0.32 * mix(vec3(1.0), uAtmo, 0.3);
  float twilight = smoothstep(-0.18, 0.0, ndl) * (1.0 - smoothstep(0.0, 0.22, ndl));
  lit += uCity * twilight * 0.07;
  vec3 night = uCity * lights * (1.0 - clouds * 0.85) * 1.1 + ground * 0.01;
  vec3 c = mix(night, lit, day);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6);
  c += uAtmo * rim * (0.08 + 0.9 * smoothstep(-0.35, 0.55, ndl));
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const FRAG_ATMOSPHERE = `
uniform vec3 uSun; uniform vec3 uAtmo;
varying vec2 vUv; varying vec3 vN; varying vec3 vPos;
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vPos);
  // Back faces: 0 at the outer edge of the shell, growing towards the limb of the Earth.
  float k = clamp(-dot(N, V) / 0.33, 0.0, 1.0);
  float light = 0.12 + 0.88 * smoothstep(-0.45, 0.45, dot(N, uSun));
  float alpha = pow(k, 1.7) * light * 0.95;
  gl_FragColor = vec4(uAtmo * (0.8 + 0.4 * k), alpha);
  #include <colorspace_fragment>
}`;

const FRAG_BAKE = `
uniform int uMode;
uniform vec3 uOcean; uniform vec3 uOceanDeep; uniform vec3 uLand; uniform vec3 uLandDry; uniform vec3 uIce; uniform vec3 uAtmo;
varying vec2 vUv;
${NOISE_GLSL}
float fbm(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * snoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float fbm3(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ s += a * snoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
void main(){
  // Same mapping as THREE.SphereGeometry: u around the axis, v from the south pole to the north pole.
  float phi = vUv.x * 6.28318530718;
  float theta = (1.0 - vUv.y) * 3.14159265359;
  vec3 p = vec3(-cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));
  float lat = abs(p.y);
  vec3 q = p * 1.3 + vec3(3.1, 1.3, 7.7);
  vec3 warp = vec3(fbm3(q + 1.7), fbm3(q + 9.2), fbm3(q + 4.4));
  float h = fbm(q + 0.85 * warp) + 0.035 * snoise(p * 14.0);
  float land = smoothstep(0.075, 0.1, h);
  if (uMode == 0) {
    float shelf = smoothstep(-0.12, 0.05, h) * (1.0 - land);
    vec3 ocean = mix(uOceanDeep, uOcean, smoothstep(-0.45, 0.05, h)) + uAtmo * shelf * 0.12;
    float dry = clamp(0.5 + 0.9 * fbm(p * 3.3 + 11.0) - 1.1 * abs(lat - 0.36) + 0.25, 0.0, 1.0);
    vec3 ground = mix(uLand, uLandDry, smoothstep(0.35, 0.75, dry));
    ground *= 0.85 + 0.3 * smoothstep(0.1, 0.5, h);
    vec3 c = mix(ocean, ground, land);
    float ice = smoothstep(0.8, 0.88, lat + 0.06 * snoise(p * 7.0)) + land * smoothstep(0.62, 0.75, lat) * 0.8;
    c = mix(c, uIce, clamp(ice, 0.0, 1.0));
    gl_FragColor = vec4(sqrt(max(c, 0.0)), land);
  } else {
    float towns = smoothstep(0.62, 0.9, snoise(p * 70.0) * 0.5 + 0.5) * smoothstep(0.5, 0.85, snoise(p * 6.0) * 0.5 + 0.5);
    float lights = towns * land * (1.0 - smoothstep(0.6, 0.72, lat));
    vec3 c0 = vec3(p.x * 2.2, p.y * 4.5, p.z * 2.2) + vec3(5.0, 9.0, 2.0);
    vec3 cw = vec3(fbm3(c0 + 3.3), fbm3(c0 + 7.1), fbm3(c0 + 1.9));
    float cover = fbm(c0 + 1.4 * cw) + 0.1 * snoise(p * 9.0 + cw);
    float clouds = smoothstep(0.08, 0.5, cover) * (0.65 + 0.35 * smoothstep(0.15, 0.6, lat));
    gl_FragColor = vec4(lights, clouds, 0.0, 1.0);
  }
}`;

const STYLE = `
.pl-root{position:absolute;inset:0;overflow:hidden;color:var(--t-text)}
.pl-view{position:absolute;inset:0;touch-action:none}
.pl-view canvas{display:block;width:100%;height:100%;cursor:grab}
.pl-view canvas:active{cursor:grabbing}
.pl-glass{background:color-mix(in srgb,var(--t-color-panel,var(--t-surface)) 80%,transparent);border:1px solid color-mix(in srgb,var(--t-primary) 20%,transparent);border-radius:calc(var(--t-radius) + 6px);box-shadow:0 1.25rem 3rem rgba(0,0,0,.45);backdrop-filter:blur(10px)}
.pl-panel{position:absolute;top:0.75rem;right:1.5rem;max-height:calc(100% - 1.5rem);width:21rem;display:flex;flex-direction:column;gap:0.625rem;padding:0.875rem 1rem;overflow:auto;overscroll-behavior:none;font-size:0.875rem}
.pl-instruction{margin:0;font-size:0.8125rem;line-height:1.4}
.pl-card{border-left-color:var(--pl-servicer,var(--t-accent));background:color-mix(in srgb,var(--t-primary) 8%,transparent)}
.pl-card .t-ui-title{margin:0.125rem 0 0.25rem}
.pl-brief{font-size:0.8125rem;line-height:1.4}
.pl-dots{display:flex;gap:5px;margin-top:0.5rem}.pl-dots i{width:22px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--t-text) 20%,transparent)}.pl-dots i.on{background:var(--t-success)}.pl-dots i.cur{background:var(--pl-servicer,var(--t-accent))}
.pl-burn-head{display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem}
.pl-label{font-weight:700;font-size:0.875rem}
.pl-dv{font-variant-numeric:tabular-nums;font-weight:600;color:var(--pl-servicer,var(--t-accent));font-size:0.8125rem;text-align:right}
.pl-range{-webkit-appearance:none;appearance:none;width:100%;height:2rem;margin:0.125rem 0 0;background:transparent;cursor:pointer}
.pl-range::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:linear-gradient(90deg,color-mix(in srgb,var(--pl-servicer,var(--t-accent)) 70%,transparent),color-mix(in srgb,var(--t-text) 22%,transparent) 50%,color-mix(in srgb,var(--t-primary) 70%,transparent))}
.pl-range::-moz-range-track{height:6px;border-radius:3px;background:linear-gradient(90deg,color-mix(in srgb,var(--pl-servicer,var(--t-accent)) 70%,transparent),color-mix(in srgb,var(--t-text) 22%,transparent) 50%,color-mix(in srgb,var(--t-primary) 70%,transparent))}
.pl-range::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;margin-top:-8px;border-radius:50%;background:var(--t-text);border:3px solid var(--pl-servicer,var(--t-accent));box-shadow:0 0 12px color-mix(in srgb,var(--pl-servicer,var(--t-accent)) 60%,transparent)}
.pl-range::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--t-text);border:3px solid var(--pl-servicer,var(--t-accent))}
.pl-range:focus-visible{outline:3px solid var(--t-focus);outline-offset:3px;border-radius:6px}
.pl-range:disabled{opacity:.5;cursor:not-allowed}
.pl-ends{display:flex;justify-content:space-between;font-size:0.6875rem;letter-spacing:.06em;text-transform:uppercase;color:var(--t-muted)}
.pl-root .t-ui-seg label{min-height:36px;color:var(--t-text);border-color:color-mix(in srgb,var(--t-primary) 30%,transparent)}
.pl-root .t-ui-seg label:has(input:checked){color:var(--t-on-primary)}
.pl-root .t-ui-meter{background:color-mix(in srgb,var(--t-text) 6%,transparent)}
.pl-root .t-ui-meter b{font-size:1rem}
.pl-root .t-ui-meter.is-over b{color:var(--t-error)}
.pl-predict{margin:0;font-size:0.8125rem;color:var(--t-muted)}
.pl-exec{width:100%}.pl-exec[aria-disabled=true]{opacity:.6;cursor:progress}
.pl-status{font-size:0.8125rem;line-height:1.4;min-height:2.8em}
.pl-hud{position:absolute;left:3rem;bottom:0.75rem;width:21.5rem;padding:0.625rem 0.75rem 0.5rem}
.pl-hud-head{display:flex;justify-content:space-between;align-items:center;gap:0.5rem}
.pl-hud-buttons{display:flex;gap:0.25rem}
.pl-small{min-height:32px;min-width:44px;padding:0 0.5rem;font-size:0.75rem;white-space:nowrap;border:1px solid color-mix(in srgb,var(--t-text) 22%,transparent)}
.pl-plot{display:block;width:100%;height:auto;margin-top:0.25rem;font:0.5625rem var(--t-font-body);fill:var(--t-muted)}
.pl-grid line{stroke:color-mix(in srgb,var(--t-text) 12%,transparent);stroke-width:1}
.pl-grid line.pl-zero{stroke:color-mix(in srgb,var(--t-text) 35%,transparent)}
.pl-axis{fill:var(--t-muted);font-size:0.5625rem}
.pl-trace{stroke:var(--pl-servicer,var(--t-accent));stroke-width:2;stroke-linejoin:round}
.pl-sdot{fill:var(--pl-servicer,var(--t-accent));stroke:var(--t-text);stroke-width:1.5}
.pl-cmark{fill:var(--pl-client,var(--t-primary));stroke:var(--t-text);stroke-width:1}
.pl-scale{margin:0.25rem 0 0;font-size:0.6875rem;line-height:1.3}
.pl-tag{position:absolute;left:0;top:0;pointer-events:none;white-space:nowrap;padding:0.125rem 0.5rem;border-radius:999px;font:700 0.6875rem/1.4 var(--t-font-heading,inherit);letter-spacing:.06em;text-transform:uppercase;color:var(--t-surface);transition:opacity .2s}
.pl-tag.is-servicer{background:var(--pl-servicer,var(--t-accent))}
.pl-tag.is-client{background:var(--pl-client,var(--t-primary))}
.pl-root.is-narrow{position:static;display:flex;flex-direction:column;gap:0.75rem;overflow:visible}
.is-narrow .pl-view{position:relative;height:${NARROW_VIEW}px;flex:none}
.is-narrow .pl-panel,.is-narrow .pl-hud{position:static;width:auto;margin:0 0.5rem;overflow:visible}
.is-narrow .pl-hud{margin-bottom:0.5rem}
`;
