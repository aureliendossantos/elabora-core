// Free object « Clockwork » — three.js r186, Elabora free-object contract 0.1.
//
// The gears behind a clock's dial, shown one idea at a time. One object carries the whole module:
// its blocks share a continuity key, so it stays on screen from one screen to the next and each
// screen only changes its `stage`. On a change of stage, update(props, transition) moves the camera,
// lifts or seats the dial, brings parts in or out and rolls the hour wheel, over the passage.
//
// Stages: clock (the question, on the dial), pair (two gears mesh), count (teeth light up as they
// pass), one-gear (the large gear grows to 120 teeth), train (the learner sizes the last gear),
// centre (the learner rolls it back to the centre), answer (the dial, seen through).
//
// The drawing is flat colours with ink outlines (draw.js); colour means "turns together": the
// minute shaft, its gear and the minute hand share one colour, the hour wheel, its tube and the
// hour hand another. Time comes from host.onFrame only, words from the manifest's strings.
import * as THREE from 'three';
import { gearOutline, wheelHoles, shiftFor, circle, TRAIN, meshed, DIRECTION_A } from './gear.js';
import { Part, partGeometries, inkMaterial, strokeGeometry, flatGeometry } from './draw.js';

const TAU = Math.PI * 2;
const STAGES = ['clock', 'pair', 'count', 'one-gear', 'train', 'centre', 'answer'];
const ORBIT_BESIDE = Math.PI / 3;       // the hour wheel beside its pinion (train)
const ORBIT_DOCKED = Math.PI;           // the hour wheel on the minute shaft
const START_MINUTE = -TAU * (10 + 8 / 60); // the clock reads 10:08 when the module opens
const W2_MIN = 16, W2_MAX = 48, W2_STEP = 4;
const FOV = 20;
const INK_PX = 1.35;                    // half-width of the ink, in CSS pixels

// Layers along the axis (z grows towards the dial and the viewer).
const Z = {
  p1: [0, 2.4], w1: [0.6, 1.8], p2: [2.0, 4.0], w2: [2.6, 3.6],
  shaft: [-1.4, 7.0], arbor: [-0.9, 4.5], tube: [3.6, 6.25],
  dial: [5.0, 5.35], hour: [5.75, 6.05], minute: [6.35, 6.6], cap: [6.6, 7.05],
  case: [-2.6, 5.75]
};
const DIAL_R = 40, CASE_R = 43.2;
const BEHIND_DIAL = new Set(['p1', 'w1', 'p2', 'w2', 'shaft', 'arbor', 'tube']);
const HOUR_OFFSET = meshed(meshed(0, TRAIN.p1, TRAIN.w1, DIRECTION_A), TRAIN.p2, TRAIN.w2, ORBIT_DOCKED);

// What each stage shows (1) and hides (0), its view and how the learner handles it.
const SPEC = {
  clock: { show: ['case', 'dial', 'hands', 'shaft', 'p1', 'w1', 'arbor', 'p2', 'w2', 'tube'], pitch: 0, yaw: 0, drag: 'hand', speed: -TAU / 12, frame: 'dial' },
  pair: { show: ['p1', 'w1', 'shaft', 'arbor'], pitch: 0, yaw: 0, drag: 'gears', speed: -TAU / 10, frame: 'pair' },
  count: { show: ['p1', 'w1', 'shaft', 'arbor', 'marks', 'labels'], pitch: 0, yaw: 0, drag: 'gears', speed: -TAU / 8, frame: 'pair' },
  'one-gear': { show: ['p1', 'w1', 'shaft', 'arbor', 'ghost', 'labels'], pitch: 0, yaw: 0, drag: 'gears', speed: -TAU / 6, frame: 'big' },
  train: { show: ['p1', 'w1', 'shaft', 'arbor', 'p2', 'w2', 'labels'], pitch: 0.42, yaw: -0.3, drag: 'gears', speed: -TAU / 6, frame: 'train' },
  centre: { show: ['p1', 'w1', 'shaft', 'arbor', 'p2', 'w2', 'labels'], pitch: 0.42, yaw: -0.3, drag: 'orbit', speed: -TAU / 6, frame: 'train' },
  answer: { show: ['case', 'dial', 'hands', 'shaft', 'p1', 'w1', 'arbor', 'p2', 'w2', 'tube'], pitch: 0.3, yaw: -0.42, drag: 'hand', speed: -TAU / 12, frame: 'dial' }
};

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerp = (a, b, t) => a + (b - a) * t;

export function mount(container, ctx) {
  const { host } = ctx;
  const t = (key, values) => ctx.t(key, values);
  let props = { ...ctx.props };
  let reduced = !!ctx.reducedMotion;

  // ── State: what the learner did, kept across the chain of screens ──
  const state = {
    minute: START_MINUTE,  // angle of the minute shaft (radians, counterclockwise; the clock runs negative)
    w2: 24,                // teeth chosen for the last gear (train)
    orbit: ORBIT_BESIDE,   // where the last gear stands around its pinion (centre)
    docked: false,         // the last gear has reached the minute shaft
    matched: false,        // the train has been sized to twelve
    grown: false,          // the 120-tooth gear has been shown
    xray: true             // the dial is seen through (answer)
  };
  if (ctx.savedState) Object.assign(state, sanitize(ctx.savedState));

  // ── DOM ──
  container.innerHTML = '';
  container.className = 'ck t-ui';
  const css = document.createElement('style');
  css.textContent = STYLE;
  container.appendChild(css);
  const view = el('div', 'ck-view');
  view.tabIndex = 0;
  view.setAttribute('role', 'slider');
  container.appendChild(view);
  const labels = el('div', 'ck-labels');
  labels.setAttribute('aria-hidden', 'true');
  container.appendChild(labels);
  const bar = el('div', 'ck-bar');
  container.appendChild(bar);
  const status = el('p', 'ck-sr');
  status.setAttribute('role', 'status');
  container.appendChild(status);

  const pauseBtn = el('button', 'ck-round');
  pauseBtn.type = 'button';
  pauseBtn.innerHTML = ICONS.pause + ICONS.play;
  const chips = el('div', 'ck-chips');
  const chipA = chip('a'), chipB = chip('b');
  chips.append(chipA.root, chipB.root);
  const sizer = el('label', 'ck-sizer');
  const sizerName = el('span', 'ck-sizer-name ck-sr');
  const range = el('input', 'ck-range');
  range.type = 'range'; range.min = String(W2_MIN); range.max = String(W2_MAX); range.step = String(W2_STEP);
  const sizerValue = el('output', 'ck-sizer-value');
  sizer.append(sizerName, range, sizerValue);
  const result = el('p', 'ck-result');
  const xray = el('label', 'ck-switch');
  const xrayInput = el('input');
  xrayInput.type = 'checkbox';
  xrayInput.setAttribute('role', 'switch');
  const xrayText = el('span');
  xray.append(xrayInput, el('i', 'ck-switch-track'), xrayText);
  bar.append(pauseBtn, chips, sizer, result, xray);

  const tags = {};
  for (const id of ['p1', 'w1', 'p2', 'w2']) {
    const tag = el('span', `ck-tag ck-tag--${id}`);
    labels.appendChild(tag);
    tags[id] = tag;
  }

  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function chip(kind) {
    const root = el('span', `ck-chip ck-chip--${kind}`);
    const dot = el('i', 'ck-dot');
    const text = el('span');
    root.append(dot, text);
    return { root, dot, text };
  }

  // ── three.js ──
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!ctx.testMode });
  renderer.setPixelRatio(ctx.testMode ? 1 : Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  view.appendChild(renderer.domElement);
  host.registerRenderer(renderer);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 2000);
  host.registerCamera(camera);
  const half = { value: 0.1 };
  const world = new THREE.Group();
  scene.add(world);

  const geometries = new Map();   // cache of part geometries by key
  const ownGeometries = [];
  const keep = (g) => { ownGeometries.push(g); return g; };
  function cached(key, make) {
    if (!geometries.has(key)) {
      const g = make();
      geometries.set(key, g);
      for (const x of Object.values(g)) ownGeometries.push(x);
    }
    return geometries.get(key);
  }
  function gearGeo(z, shift, depth, opts = {}) {
    return cached(`gear:${z}:${shift.toFixed(3)}:${depth.join(',')}:${opts.bore ?? ''}`, () => {
      const g = gearOutline(z, { shift });
      return partGeometries(g.points, wheelHoles(z, { shift, bore: opts.bore }), depth[0], depth[1]);
    });
  }
  function discGeo(key, radius, depth, holeRadius) {
    return cached(key, () => partGeometries(circle(radius, Math.max(32, Math.round(radius * 5))), holeRadius ? [circle(holeRadius, 32, true)] : [], depth[0], depth[1]));
  }

  const ink = () => props.inkColor;
  const parts = {};
  function makePart(id, color, order, shadeK) {
    const p = new Part({ half, color, ink: ink(), renderOrder: order, sideShade: shadeK, name: id });
    parts[id] = p;
    return p;
  }

  // Pivots: one group per turning piece, placed at its centre and turned about z.
  const pivots = {};
  for (const id of ['minute', 'middle', 'hour', 'handM', 'handH']) { pivots[id] = new THREE.Group(); world.add(pivots[id]); }
  const hourPos = new THREE.Group();     // the hour wheel's centre (moves when it rolls)
  world.add(hourPos);
  hourPos.add(pivots.hour);

  // Minute shaft and its pinion (P1); the minute hand turns with them.
  const p1 = makePart('p1', props.minuteColor, 2);
  p1.setGeometry(gearGeo(TRAIN.p1, shiftFor(TRAIN.p1), Z.p1, { bore: 0 }));
  pivots.minute.add(p1.group);
  const shaft = makePart('shaft', props.minuteColor, 2, 0.72);
  shaft.setGeometry(discGeo('shaft', 1.0, Z.shaft));
  pivots.minute.add(shaft.group);

  // Minute wheel (W1) and its pinion (P2) on one arbor.
  const w1 = makePart('w1', props.middleColor, 1);
  pivots.middle.add(w1.group);
  const p2 = makePart('p2', props.middleColor, 3, 0.78);
  p2.setGeometry(gearGeo(TRAIN.p2, shiftFor(TRAIN.p2), Z.p2, { bore: 0 }));
  pivots.middle.add(p2.group);
  const arbor = makePart('arbor', props.middleColor, 1, 0.72);
  arbor.setGeometry(discGeo('arbor', 0.85, Z.arbor));
  pivots.middle.add(arbor.group);

  // Hour wheel (W2), its tube and the hour hand.
  const w2 = makePart('w2', props.hourColor, 4);
  pivots.hour.add(w2.group);
  const tube = makePart('tube', props.hourColor, 4, 0.72);
  tube.setGeometry(discGeo('tube', 1.7, Z.tube));
  pivots.hour.add(tube.group);

  // Dial, case, hands.
  const dialGroup = new THREE.Group();
  world.add(dialGroup);
  const dial = makePart('dial', props.dialColor, 6, 0.9);
  dial.setGeometry(discGeo('dial', DIAL_R, Z.dial, 1.8));
  dialGroup.add(dial.group);
  const ticks = buildTicks();
  dialGroup.add(ticks.mesh);
  const caseRing = makePart('case', props.caseColor, 0, 0.84);
  caseRing.setGeometry(cached('case', () => partGeometries(circle(CASE_R, 220), [circle(DIAL_R + 0.25, 220, true)], Z.case[0], Z.case[1])));
  world.add(caseRing.group);
  const handM = makePart('handM', props.minuteColor, 8);
  handM.setGeometry(cached('handM', () => partGeometries(handOutline(34, 1.15, 6.5, 2.1), [], Z.minute[0], Z.minute[1])));
  pivots.handM.add(handM.group);
  const cap = makePart('cap', props.minuteColor, 9, 0.78);
  cap.setGeometry(discGeo('cap', 1.6, Z.cap));
  pivots.handM.add(cap.group);
  const handH = makePart('handH', props.hourColor, 7);
  handH.setGeometry(cached('handH', () => partGeometries(handOutline(23, 1.9, 5, 2.9), [], Z.hour[0], Z.hour[1])));
  pivots.handH.add(handH.group);

  // The clock's outline, dashed, to compare a gear with the size of the clock (one-gear).
  const ghostMat = inkMaterial(half, props.inkColor);
  const ghost = new THREE.Mesh(keep(strokeGeometry(dashes(CASE_R, 72, 0.55), 0.2)), ghostMat);
  world.add(ghost);

  // Teeth that light up as they pass (count): one tooth shape, one instance per tooth.
  const marks = { p1: buildMarks(TRAIN.p1, shiftFor(TRAIN.p1), Z.p1[1]), w1: buildMarks(TRAIN.w1, -shiftFor(TRAIN.p1), Z.w1[1]) };
  pivots.minute.add(marks.p1.mesh);
  pivots.middle.add(marks.w1.mesh);

  // Gesture hints: an arc with arrow heads around what the learner can turn or roll.
  const hintMaterials = [];
  const hints = {
    hand: hintArc(41.6, Math.PI / 2 - 0.3, Math.PI / 2 + 0.3, 2.6, true),
    gear: hintArc(8.6, Math.PI * 0.64, Math.PI * 1.36, 1.7, true),
    roll: hintArc(20, ORBIT_BESIDE + 0.3, ORBIT_DOCKED - 0.1, 2.2, false)
  };
  pivots.handM.add(hints.hand.group);
  hints.hand.group.position.z = Z.cap[1] + 0.4;
  world.add(hints.gear.group);
  world.add(hints.roll.group);

  // Visibility of each piece (0…1), moved by tweens.
  const vis = {};
  const VIS = ['case', 'dial', 'hands', 'shaft', 'p1', 'w1', 'arbor', 'p2', 'w2', 'tube', 'marks', 'labels', 'ghost', 'hintHand', 'hintGear', 'hintRoll'];
  for (const k of VIS) vis[k] = 0;
  let dialLift = 0;          // 0 seated, 1 lifted away
  let xrayMix = 0;           // 0 opaque dial, 1 seen through
  let shownW1 = TRAIN.w1, shownW2 = state.w2;
  let orbitShown = state.orbit;
  const tried = new Set();   // stages where the learner has already handled the object

  // ── Tweens ──
  const tweens = [];
  function tween(key, from, to, duration, delay, apply, curve = ease) {
    for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].key === key) tweens.splice(i, 1);
    if (duration <= 0 && delay <= 0) { apply(to); return; }
    tweens.push({ key, from, to, duration: Math.max(1, duration), delay, time: 0, apply, curve });
  }
  function cancel(key) {
    for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].key === key) tweens.splice(i, 1);
  }
  function runTweens(dt) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const w = tweens[i];
      w.time += dt * 1000;
      const k = clamp((w.time - w.delay) / w.duration, 0, 1);
      if (w.time >= w.delay) w.apply(lerp(w.from, w.to, w.curve(k)));
      if (k >= 1) tweens.splice(i, 1);
    }
  }

  // ── Stage ──
  let stage = STAGES.includes(props.stage) ? props.stage : 'clock';
  let paused = reduced;
  let dragging = null;
  let idleAfterDrag = 0;
  const cam = { target: new THREE.Vector3(), dist: 300, pitch: 0, yaw: 0 };
  let camTween = null;

  function goalsFor(name) {
    const s = SPEC[name];
    const g = {};
    for (const k of VIS) g[k] = 0;
    for (const k of s.show) g[k] = 1;
    if (name === 'centre') { g.tube = state.docked ? 1 : 0; g.hands = state.docked ? 1 : 0; g.hintRoll = state.docked || tried.has('roll') ? 0 : 1; }
    if (name === 'clock' || name === 'answer') g.hintHand = tried.has(name) ? 0 : 1;
    if (name === 'pair' || name === 'count') g.hintGear = tried.has('gears') ? 0 : 1;
    return g;
  }
  function w1For(name) { return name === 'one-gear' ? (state.grown || props.bigTeeth > TRAIN.w1 ? clamp(Math.round(props.bigTeeth || 120), TRAIN.w1, 150) : TRAIN.w1) : TRAIN.w1; }
  function w2For(name) { return name === 'train' ? state.w2 : TRAIN.w2; }
  function orbitFor(name) {
    if (name === 'train') return ORBIT_BESIDE;
    if (name === 'centre') return state.docked ? ORBIT_DOCKED : clamp(state.orbit, ORBIT_BESIDE, ORBIT_DOCKED);
    return ORBIT_DOCKED;
  }

  // Bounding circle of what a stage shows, in the plane of the gears.
  function frameFor(name, w1Teeth = w1For(name), w2Teeth = w2For(name), orbit = orbitFor(name)) {
    const s = SPEC[name];
    if (s.frame === 'dial') return { x: 0, y: 0, r: CASE_R + 2 };
    const dA = (TRAIN.p1 + w1Teeth) / 2;
    const circles = [[0, 0, name === 'pair' || name === 'count' ? 10.4 : 6.8], [dA, 0, w1Teeth / 2 + 1.2]];
    if (s.frame === 'big') circles.push([0, 0, CASE_R + 1]);
    if (s.frame === 'train') {
      const dB = (TRAIN.p2 + w2Teeth) / 2;
      circles.push([dA + dB * Math.cos(orbit), dB * Math.sin(orbit), w2Teeth / 2 + 1.2]);
      if (name === 'centre' && state.docked) circles.push([0, 0, 30]);
      if (name === 'centre' && !state.docked) circles.push([dA + dB * Math.cos(ORBIT_DOCKED), dB * Math.sin(ORBIT_DOCKED), w2Teeth / 2 + 1.2], [dA + dB * Math.cos(Math.PI / 2 + 0.2), dB * Math.sin(Math.PI / 2 + 0.2), w2Teeth / 2 + 1.2]);
    }
    return enclose(circles);
  }

  // live: what is on screen now (a gear growing, the last gear resized or rolling); otherwise where
  // the stage goes.
  function camGoal(name, live = false) {
    const s = SPEC[name];
    const f = live ? frameFor(name, shownW1, shownW2, orbitShown) : frameFor(name);
    const r = f.r * (s.pitch ? 1.06 : 1);
    return { target: new THREE.Vector3(f.x, f.y, s.frame === 'dial' ? 2 : 1.5), dist: fitDistance(r), pitch: s.pitch, yaw: s.yaw };
  }

  // Distance at which a circle of radius r fills the free part of the view.
  let viewW = 1, viewH = 1, barH = 0;
  function fitDistance(r) {
    const h = Math.max(1, viewH - barH * 1.15);
    const vfov = (FOV * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (viewW / viewH));
    const usable = Math.min(Math.tan(vfov / 2) * (h / viewH), Math.tan(hfov / 2) * 0.96);
    return (r * 1.08) / usable;
  }

  function applyStage(name, transition) {
    const previous = stage;
    stage = name;
    const duration = transition && !reduced && !transition.reducedMotion ? transition.duration || 0 : 0;
    const goals = goalsFor(name);
    // Parts that leave fade over the first part of the passage, parts that arrive over the last.
    // What an opaque dial hides goes at once when the dial lifts, and comes back once it is seated.
    const opaque = (s) => SPEC[s].show.includes('dial') && !(s === 'answer' && state.xray);
    for (const k of VIS) {
      const from = vis[k], to = goals[k];
      if (from === to) { cancel(`vis:${k}`); continue; }
      const leaving = to < from;
      if (BEHIND_DIAL.has(k) && duration > 0 && (leaving ? opaque(previous) : opaque(name))) {
        if (leaving) { tween(`vis:${k}`, 0, 0, 0, 0, (v) => { vis[k] = v; }); continue; }
        tween(`vis:${k}`, from, to, 1, duration, (v) => { vis[k] = v; });
        continue;
      }
      tween(`vis:${k}`, from, to, duration * (leaving ? 0.45 : 0.5), leaving ? 0 : duration * 0.5, (v) => { vis[k] = v; });
    }
    // The dial lifts away or comes back to its seat.
    const lift = SPEC[name].show.includes('dial') ? 0 : 1;
    tween('lift', dialLift, lift, duration * 0.8, lift ? 0 : duration * 0.2, (v) => { dialLift = v; });
    const xr = name === 'answer' && state.xray ? 1 : 0;
    tween('xray', xrayMix, xr, duration * 0.6, duration * 0.4, (v) => { xrayMix = v; });
    // Gears that change size, and the hour wheel that rolls round its pinion.
    resizeW1(w1For(name), duration);
    shownW2 = w2For(name);
    const orbit = orbitFor(name);
    if (vis.w2 > 0.01 && goals.w2 > 0) tween('orbit', orbitShown, orbit, duration, 0, (v) => { orbitShown = v; });
    else orbitShown = orbit;
    // The camera glides from where it is to the new view.
    const goal = camGoal(name);
    if (duration > 0) camTween = { from: { target: cam.target.clone(), dist: cam.dist, pitch: cam.pitch, yaw: cam.yaw }, to: goal, time: 0, duration };
    else { camTween = null; Object.assign(cam, { target: goal.target, dist: goal.dist, pitch: goal.pitch, yaw: goal.yaw }); }
    if (name === 'count' && previous !== 'count') resetMarks();
    controlsFor(name, duration);
  }

  // The large gear grows (or shrinks back) a few teeth at a time, its arbor moving out with it.
  function resizeW1(target, duration) {
    if (target === shownW1) { setW1(target); return; }
    const from = shownW1;
    if (duration <= 0 && !(stage === 'one-gear' && !reduced)) { setW1(target); return; }
    const time = stage === 'one-gear' ? 1600 : duration;
    tween('w1size', from, target, time, 0, (v) => setW1(Math.round(v / 2) * 2));
  }
  function setW1(n) {
    shownW1 = n;
    w1.setGeometry(gearGeo(n, -shiftFor(TRAIN.p1), Z.w1, { bore: 0 }));
  }
  function setW2(n) {
    shownW2 = n;
    w2.setGeometry(gearGeo(n, -shiftFor(TRAIN.p2), Z.w2, { bore: 0 }));
  }
  setW1(TRAIN.w1);
  setW2(w2For(stage));

  // ── Controls of each stage ──
  function controlsFor(name, duration) {
    const show = (node, on) => {
      node.hidden = !on;
      if (on && duration > 0) { node.style.animationDelay = `${Math.round(duration * 0.6)}ms`; node.classList.add('ck-in'); }
      else node.classList.remove('ck-in');
    };
    show(pauseBtn, true);
    show(chips, name === 'count');
    show(sizer, name === 'train');
    show(result, name === 'train');
    show(xray, name === 'answer');
    const handMode = SPEC[name].drag === 'hand';
    view.setAttribute('aria-label', t(handMode ? 'dialLabel' : name === 'centre' && !state.docked ? 'rollLabel' : 'gearsLabel'));
    sizerName.textContent = t('sizerLabel');
    range.value = String(state.w2);
    xrayInput.checked = state.xray;
    xrayText.textContent = t('xray');
    refreshTexts();
  }

  function refreshTexts() {
    pauseBtn.setAttribute('aria-label', t(paused ? 'play' : 'pause'));
    pauseBtn.classList.toggle('is-paused', paused);
    if (stage === 'count') {
      chipA.text.textContent = t('teethPassed', { n: markCount, total: TRAIN.p1 });
      chipB.text.textContent = t('teethPassed', { n: markCount, total: TRAIN.w1 });
    }
    if (stage === 'train') {
      const ratio = Math.round(((TRAIN.w1 / TRAIN.p1) * (state.w2 / TRAIN.p2)) * 10) / 10;
      sizerValue.textContent = t('teeth', { n: state.w2 });
      result.textContent = t('slower', { ratio });
      result.classList.toggle('is-done', state.w2 === TRAIN.w2);
    }
    view.setAttribute('aria-valuetext', valueText());
    view.setAttribute('aria-valuenow', String(Math.round(-state.minute * 180 / Math.PI)));
  }

  function valueText() {
    if (SPEC[stage].drag === 'hand') {
      const total = ((-state.minute / TAU) % 12 + 12) % 12;
      let hour = Math.floor(total);
      const minute = Math.floor((total - hour) * 60 + 1e-6);
      if (hour === 0) hour = 12;
      return t('time', { hour, minute: String(minute).padStart(2, '0') });
    }
    if (stage === 'centre' && !state.docked) return t('rollValue', { percent: Math.round(((orbitShown - ORBIT_BESIDE) / (ORBIT_DOCKED - ORBIT_BESIDE)) * 100) });
    const turns = Math.round(((START_MINUTE - state.minute) / TAU) * 10) / 10;
    return t('turns', { n: turns });
  }

  // ── Teeth that light up (count) ──
  let markFrom = state.minute;
  let markCount = 0;
  let markHold = 0;
  function resetMarks() {
    markFrom = state.minute;
    markCount = 0;
    markHold = 0;
    marks.p1.set(new Set());
    marks.w1.set(new Set());
  }
  function updateMarks(dt) {
    const pitch = TAU / TRAIN.p1;
    const travel = markFrom - state.minute;          // positive: clockwise, as the clock turns
    const passed = clamp(Math.floor(Math.abs(travel) / pitch + 0.5), 0, TRAIN.p1);
    if (markHold > 0) {
      markHold -= dt;
      if (markHold <= 0) resetMarks();
      return;
    }
    if (passed !== markCount) {
      markCount = passed;
      const sign = travel >= 0 ? 1 : -1;
      const pose = poseOf(markFrom);
      // The teeth at the meeting point when counting began, then the next ones in turn.
      const k1 = nearestTooth(pose.p1, TRAIN.p1, DIRECTION_A);
      const k2 = nearestTooth(pose.w1, shownW1, DIRECTION_A + Math.PI);
      const a = new Set(), b = new Set();
      for (let i = 0; i < passed; i++) { a.add(mod(k1 + sign * i, TRAIN.p1)); b.add(mod(k2 - sign * i, TRAIN.w1)); }
      marks.p1.set(a);
      marks.w1.set(b);
      refreshTexts();
      if (passed >= TRAIN.p1) markHold = 1.6;
    }
  }
  const mod = (a, n) => ((a % n) + n) % n;
  function nearestTooth(rotation, z, direction) {
    return mod(Math.round(wrap(direction - rotation) / (TAU / z)), z);
  }

  // ── Kinematics ──
  function poseOf(minute) {
    const a1 = meshed(minute, TRAIN.p1, shownW1, DIRECTION_A);
    const a2 = meshed(a1, TRAIN.p2, shownW2, orbitShown);
    return { p1: minute, w1: a1, p2: a1, w2: a2 };
  }
  function ratioOf(id) {
    // Turn of a piece for one turn of the minute shaft.
    const r1 = -TRAIN.p1 / shownW1;
    if (id === 'p1' || id === 'shaft' || id === 'handM' || id === 'dial' || id === 'case') return 1;
    if (id === 'w1' || id === 'p2' || id === 'arbor') return r1;
    return r1 * (-TRAIN.p2 / shownW2);
  }

  function placeParts() {
    const pose = poseOf(state.minute);
    const dA = (TRAIN.p1 + shownW1) / 2;
    const dB = (TRAIN.p2 + shownW2) / 2;
    pivots.minute.rotation.z = pose.p1;
    pivots.middle.position.set(dA, 0, 0);
    pivots.middle.rotation.z = pose.w1;
    hourPos.position.set(dA + dB * Math.cos(orbitShown), dB * Math.sin(orbitShown), 0);
    pivots.hour.rotation.z = pose.w2;
    pivots.handM.rotation.z = state.minute;
    // The hour hand rides on the hour wheel's tube once that wheel is on the minute shaft.
    const docked = Math.abs(orbitShown - ORBIT_DOCKED) < 1e-3;
    pivots.handH.rotation.z = docked ? pose.w2 - HOUR_OFFSET : state.minute / 12;
    hints.gear.group.position.set(0, 0, Z.p1[1] + 0.4);
    hints.roll.group.position.set(dA, 0, Z.w2[1] + 0.6);
    ghost.position.set(0, 0, 0);
  }

  function applyVisibility() {
    const lift = ease(dialLift);
    const dz = lift * 26;
    dialGroup.position.z = dz;
    const dialOn = vis.dial * (1 - lift);
    dial.setOpacity(dialOn);
    // Seen through, the face of the dial goes faint; its ticks and outline stay.
    dial.face.opacity = dialOn * (1 - 0.86 * xrayMix);
    dial.side.opacity = dialOn * (1 - 0.86 * xrayMix);
    if (dialOn > 0.004) for (const m of [dial.face, dial.side]) m.depthWrite = xrayMix < 0.02 && dialOn > 0.98;
    ticks.material.opacity = dialOn;
    ticks.mesh.visible = dialOn > 0.004;
    caseRing.setOpacity(vis.case);
    const hands = vis.hands * (SPEC[stage].show.includes('dial') ? 1 - lift : 1);
    pivots.handM.position.z = SPEC[stage].show.includes('dial') ? dz : 0;
    pivots.handH.position.z = pivots.handM.position.z;
    handM.setOpacity(hands); cap.setOpacity(hands); handH.setOpacity(hands);
    // Behind an opaque dial nothing needs drawing.
    const hidden = dialOn > 0.99 && xrayMix < 0.01 && lift < 0.01;
    for (const k of ['p1', 'w1', 'p2', 'w2', 'shaft', 'arbor', 'tube']) parts[k].setOpacity(hidden ? 0 : vis[k]);
    ghost.visible = vis.ghost > 0.004;
    ghostMat.uniforms.uOpacity.value = vis.ghost * 0.55;
    marks.p1.mesh.visible = marks.w1.mesh.visible = vis.marks > 0.004;
    marks.p1.material.opacity = marks.w1.material.opacity = vis.marks;
    const pulse = reduced ? 1 : 0.62 + 0.38 * Math.cos(clock * 3.2);
    hints.hand.set(vis.hintHand * pulse * hands);
    hints.gear.set(vis.hintGear * pulse);
    hints.roll.set(vis.hintRoll * pulse);
  }

  // ── Drawing helpers ──
  function buildTicks() {
    const geo = keep(new THREE.PlaneGeometry(1, 1));
    const mat = new THREE.MeshBasicMaterial({ color: props.inkColor, transparent: true });
    const mesh = new THREE.InstancedMesh(geo, mat, 60);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < 60; i++) {
      const a = Math.PI / 2 - (i / 60) * TAU;
      const major = i % 5 === 0;
      const len = major ? 3.6 : 1.5, wid = major ? 0.8 : 0.32;
      const rr = DIAL_R - 2.2 - len / 2;
      p.set(rr * Math.cos(a), rr * Math.sin(a), Z.dial[1] + 0.05);
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a - Math.PI / 2);
      s.set(wid, len, 1);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.renderOrder = 7;
    return { mesh, material: mat };
  }

  function buildMarks(z, shift, zTop) {
    const g = gearOutline(z, { shift });
    // One tooth: the outline points of tooth 0 that stand above the root circle.
    const pitch = TAU / z;
    const toothPts = g.points.filter(([x, y]) => Math.abs(Math.atan2(y, x)) < pitch / 2 && Math.hypot(x, y) > g.rootRadius + 0.05);
    const inner = g.rootRadius + 0.4;
    const shape = new THREE.Shape(toothPts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = keep(new THREE.ShapeGeometry(shape));
    const mat = new THREE.MeshBasicMaterial({ color: props.markColor, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const mesh = new THREE.InstancedMesh(geo, mat, z);
    mesh.position.z = zTop + 0.012;
    mesh.renderOrder = 5;
    const m = new THREE.Matrix4();
    const lit = new Set();
    function set(next) {
      lit.clear();
      for (const k of next) lit.add(k);
      for (let k = 0; k < z; k++) {
        m.makeRotationZ(k * pitch);
        if (!lit.has(k)) m.scale(new THREE.Vector3(0, 0, 0));
        mesh.setMatrixAt(k, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    set(new Set());
    void inner;
    return { mesh, material: mat, set };
  }

  function hintArc(radius, a0, a1, head, both) {
    const group = new THREE.Group();
    const pts = [];
    const n = 40;
    const s0 = a0 + (both ? head / radius * 0.55 : 0), s1 = a1 - head / radius * 0.55;
    for (let i = 0; i <= n; i++) { const a = s0 + ((s1 - s0) * i) / n; pts.push([radius * Math.cos(a), radius * Math.sin(a)]); }
    const hintInk = inkMaterial(half, props.hintColor);
    hintInk.depthWrite = false;
    const hintMat = new THREE.MeshBasicMaterial({ color: props.hintColor, transparent: true, depthWrite: false });
    hintMaterials.push({ hintInk, hintMat });
    const line = new THREE.Mesh(keep(strokeGeometry([{ points: pts, closed: false }], 0)), hintInk);
    line.renderOrder = 10;
    const tris = [arrowHead(radius, a1, head, 1)];
    if (both) tris.push(arrowHead(radius, a0, head, -1));
    const heads = new THREE.Mesh(keep(flatGeometry(tris, 0)), hintMat);
    heads.renderOrder = 10;
    group.add(line, heads);
    return {
      group,
      set(a) { group.visible = a > 0.004; hintInk.uniforms.uOpacity.value = a; hintMat.opacity = a; }
    };
  }
  function arrowHead(radius, a, size, dir) {
    // A triangle whose tip lies on the arc at angle a, pointing along the arc.
    const tip = [radius * Math.cos(a), radius * Math.sin(a)];
    const back = a - (dir * size) / radius;
    const bx = radius * Math.cos(back), by = radius * Math.sin(back);
    const nx = Math.cos(back), ny = Math.sin(back);
    const w = size * 0.48;
    return [tip, [bx + nx * w, by + ny * w], [bx - nx * w, by - ny * w]];
  }

  // ── Camera ──
  function placeCamera() {
    const off = new THREE.Vector3(Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), Math.cos(cam.yaw) * Math.cos(cam.pitch));
    camera.position.copy(cam.target).addScaledVector(off, cam.dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(cam.target);
    // Keep the scene above the control bar.
    const shift = barH * 0.5;
    camera.setViewOffset(viewW, viewH, 0, shift, viewW, viewH);
    camera.updateProjectionMatrix();
    const worldPerPx = (2 * cam.dist * Math.tan((FOV * Math.PI) / 360)) / Math.max(1, viewH);
    half.value = worldPerPx * INK_PX;
  }

  // ── Input ──
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pointerRay(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }
  function planePoint(ray, z) {
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
    const hit = new THREE.Vector3();
    return ray.intersectPlane(plane, hit) ? hit : null;
  }
  function pick(ray) {
    const bodies = [];
    for (const id of ['p1', 'w1', 'p2', 'w2', 'handM', 'handH', 'dial', 'case', 'cap']) if (parts[id].group.visible && parts[id].opacity > 0.5) bodies.push(parts[id].body);
    raycaster.ray.copy(ray);
    const hit = raycaster.intersectObjects(bodies, false)[0];
    return hit ? hit.object.userData.part.group.name : null;
  }
  const centreOf = (id) => {
    if (id === 'p1') return [0, 0, Z.p1[1]];
    if (id === 'w1' || id === 'p2') return [pivots.middle.position.x, 0, id === 'w1' ? Z.w1[1] : Z.p2[1]];
    return [hourPos.position.x, hourPos.position.y, Z.w2[1]];
  };

  let downAt = null;
  view.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const ray = pointerRay(event);
    const mode = SPEC[stage].drag;
    const hit = pick(ray);
    downAt = { x: event.clientX, y: event.clientY, hit, moved: false };
    if (mode === 'hand') {
      const p = planePoint(ray, Z.dial[1] + dialGroup.position.z);
      if (!p || Math.hypot(p.x, p.y) > CASE_R + 4) return;
      dragging = { kind: 'hand' };
      handTo(p);
    } else if (mode === 'orbit' && !state.docked && (hit === 'w2' || hit === 'p2')) {
      dragging = { kind: 'orbit' };
    } else if (hit && ['p1', 'w1', 'p2', 'w2'].includes(hit)) {
      const [cx, cy, cz] = centreOf(hit);
      const p = planePoint(ray, cz);
      if (!p) return;
      dragging = { kind: 'gear', id: hit, cx, cy, cz, last: Math.atan2(p.y - cy, p.x - cx) };
    } else return;
    view.setPointerCapture?.(event.pointerId);
    view.classList.add('is-dragging');
    event.preventDefault();
  });
  view.addEventListener('pointermove', (event) => {
    if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 4) downAt.moved = true;
    if (!dragging) {
      if (event.pointerType === 'mouse') {
        const hit = pick(pointerRay(event));
        const mode = SPEC[stage].drag;
        const grab = mode === 'hand' ? !!hit : mode === 'orbit' && !state.docked ? hit === 'w2' || hit === 'p2' : ['p1', 'w1', 'p2', 'w2'].includes(hit);
        view.classList.toggle('can-grab', grab);
      }
      return;
    }
    const ray = pointerRay(event);
    if (dragging.kind === 'hand') {
      const p = planePoint(ray, Z.dial[1] + dialGroup.position.z);
      if (p) handTo(p);
    } else if (dragging.kind === 'gear') {
      const p = planePoint(ray, dragging.cz);
      if (!p) return;
      const a = Math.atan2(p.y - dragging.cy, p.x - dragging.cx);
      const d = wrap(a - dragging.last);
      dragging.last = a;
      turnBy(d / ratioOf(dragging.id), 'gears');
    } else if (dragging.kind === 'orbit') {
      const p = planePoint(ray, Z.w2[1]);
      if (!p) return;
      const a = Math.atan2(p.y, p.x - pivots.middle.position.x);
      rollTo(a < -Math.PI / 2 ? a + TAU : a);
    }
  });
  const release = (event) => {
    const tap = downAt && !downAt.moved;
    const hit = downAt?.hit;
    downAt = null;
    if (dragging?.kind === 'orbit') settleRoll(tap);
    else if (!dragging && tap && stage === 'centre' && !state.docked && (hit === 'w2' || hit === 'p2')) settleRoll(true);
    if (dragging) idleAfterDrag = 1.2;
    dragging = null;
    view.classList.remove('is-dragging');
    if (event?.pointerId !== undefined) view.releasePointerCapture?.(event.pointerId);
  };
  view.addEventListener('pointerup', release);
  view.addEventListener('pointercancel', release);

  view.addEventListener('keydown', (event) => {
    const mode = SPEC[stage].drag;
    const step = mode === 'hand' ? TAU / 60 : TAU / TRAIN.p1;
    const forward = { ArrowRight: 1, ArrowUp: 1, PageUp: 5, ArrowLeft: -1, ArrowDown: -1, PageDown: -5 }[event.key];
    if (mode === 'orbit' && !state.docked) {
      if (forward) { rollTo(orbitShown + forward * 0.18); settleRoll(false); event.preventDefault(); }
      else if (event.key === 'Enter' || event.key === ' ' || event.key === 'End') { settleRoll(true); event.preventDefault(); }
      return;
    }
    if (forward) { turnBy(-forward * step, mode === 'hand' ? stage : 'gears'); idleAfterDrag = 1.2; event.preventDefault(); }
    else if (event.key === ' ' || event.key === 'p' || event.key === 'P') { togglePause(); event.preventDefault(); }
  });

  function handTo(p) {
    // The minute hand points at the pointer: the shaft turns by the shortest way there.
    const target = Math.atan2(p.y, p.x) - Math.PI / 2;
    turnBy(wrap(target - state.minute), stage);
  }
  function turnBy(d, who) {
    if (!d) return;
    state.minute += d;
    if (who && !tried.has(who)) {
      tried.add(who);
      if (who === 'gears') tween('vis:hintGear', vis.hintGear, 0, 400, 0, (v) => { vis.hintGear = v; });
      else tween('vis:hintHand', vis.hintHand, 0, 400, 0, (v) => { vis.hintHand = v; });
    }
    refreshTexts();
  }

  // ── Rolling the hour wheel back to the centre (centre) ──
  function rollTo(a) {
    if (!tried.has('roll')) { tried.add('roll'); tween('vis:hintRoll', vis.hintRoll, 0, 400, 0, (v) => { vis.hintRoll = v; }); }
    tweens.splice(0, tweens.length, ...tweens.filter((w) => w.key !== 'orbit'));
    orbitShown = clamp(a, ORBIT_BESIDE, ORBIT_DOCKED);
    state.orbit = orbitShown;
    refreshTexts();
  }
  function settleRoll(all) {
    if (state.docked) return;
    if (all || orbitShown > ORBIT_DOCKED - 0.32) {
      const time = reduced ? 0 : 900 * (ORBIT_DOCKED - orbitShown) / (ORBIT_DOCKED - ORBIT_BESIDE) + 250;
      tween('orbit', orbitShown, ORBIT_DOCKED, time, 0, (v) => { orbitShown = v; state.orbit = v; });
      dockAfter = time / 1000;
    }
  }
  let dockAfter = -1;
  function dock() {
    state.docked = true;
    state.orbit = ORBIT_DOCKED;
    orbitShown = ORBIT_DOCKED;
    const d = reduced ? 0 : 1100;
    tween('vis:tube', vis.tube, 1, d * 0.5, 0, (v) => { vis.tube = v; });
    tried.add('roll');
    tween('vis:hintRoll', vis.hintRoll, 0, d * 0.3, 0, (v) => { vis.hintRoll = v; });
    tween('vis:hands', vis.hands, 1, d * 0.6, d * 0.3, (v) => { vis.hands = v; });
    const goal = camGoal('centre');
    goal.pitch = 0.62; goal.yaw = -0.5;
    camTween = d ? { from: { target: cam.target.clone(), dist: cam.dist, pitch: cam.pitch, yaw: cam.yaw }, to: goal, time: 0, duration: d * 1.4 } : null;
    if (!d) Object.assign(cam, goal);
    view.setAttribute('aria-label', t('gearsLabel'));
    say(t('docked'));
    host.emit('docked', {});
    refreshTexts();
  }

  // ── Sizing the last gear (train) ──
  range.addEventListener('input', () => sizeTo(Number(range.value)));
  function sizeTo(n) {
    state.w2 = clamp(Math.round(n / W2_STEP) * W2_STEP, W2_MIN, W2_MAX);
    range.value = String(state.w2);
    setW2(state.w2);
    refreshTexts();
  }
  // The arrows step through the sizes here, so that a key gives the same result whatever sent it.
  range.addEventListener('keydown', (event) => {
    const by = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 2, PageDown: -2 }[event.key];
    const to = event.key === 'Home' ? W2_MIN : event.key === 'End' ? W2_MAX : by ? state.w2 + by * W2_STEP : null;
    if (to === null) return;
    event.preventDefault();
    sizeTo(to);
    range.dispatchEvent(new Event('change'));
  });
  range.addEventListener('change', () => {
    const correct = state.w2 === TRAIN.w2;
    const slower = (TRAIN.w1 / TRAIN.p1) * (state.w2 / TRAIN.p2);
    host.emit('train_sized', { teeth: state.w2, slower, correct });
    if (correct) {
      say(t('matched'));
      if (!state.matched) { state.matched = true; host.emit('train_matched', {}); }
    }
  });
  xrayInput.addEventListener('change', () => {
    state.xray = xrayInput.checked;
    tween('xray', xrayMix, state.xray ? 1 : 0, reduced ? 0 : 500, 0, (v) => { xrayMix = v; });
  });
  pauseBtn.addEventListener('click', togglePause);
  function togglePause() { paused = !paused; refreshTexts(); }
  function say(text) { status.textContent = text; }

  // ── Size ──
  function resize() {
    viewW = Math.max(1, container.clientWidth);
    viewH = Math.max(1, container.clientHeight);
    barH = bar.offsetHeight ? bar.offsetHeight + 16 : 0;
    renderer.setSize(viewW, viewH, false);
    camera.aspect = viewW / viewH;
    if (!camTween) { const g = camGoal(stage); cam.dist = g.dist; }
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  // ── Frames ──
  let clock = 0;
  applyStage(stage, null);
  const stop = host.onFrame((dt) => {
    clock += dt;
    runTweens(dt);
    if (dockAfter >= 0) { dockAfter -= dt; if (dockAfter < 0 && Math.abs(orbitShown - ORBIT_DOCKED) < 1e-3) dock(); }
    if (idleAfterDrag > 0) idleAfterDrag -= dt;
    const turning = !paused && !dragging && idleAfterDrag <= 0 && !(stage === 'centre' && !state.docked) && markHold <= 0;
    if (turning) { state.minute += SPEC[stage].speed * dt; }
    if (stage === 'count') updateMarks(dt);
    if (camTween) {
      camTween.time += dt * 1000;
      const k = ease(clamp(camTween.time / camTween.duration, 0, 1));
      const { from, to } = camTween;
      cam.target.lerpVectors(from.target, to.target, k);
      cam.dist = lerp(from.dist, to.dist, k);
      cam.pitch = lerp(from.pitch, to.pitch, k);
      cam.yaw = lerp(from.yaw, to.yaw, k);
      if (k >= 1) camTween = null;
    } else {
      // Follow what the learner changes (a gear resized) without a jump.
      const g = camGoal(stage, true);
      if (stage === 'centre' && state.docked) { g.pitch = 0.62; g.yaw = -0.5; }
      const k = 1 - Math.exp(-dt * 5);
      cam.target.lerp(g.target, k);
      cam.dist = lerp(cam.dist, g.dist, k);
      cam.pitch = lerp(cam.pitch, g.pitch, k);
      cam.yaw = lerp(cam.yaw, g.yaw, k);
    }
    placeParts();
    applyVisibility();
    placeCamera();
    renderer.render(scene, camera);
    placeTags();
    if (turning && Math.floor(clock * 2) !== Math.floor((clock - dt) * 2)) refreshTexts();
  });

  // Tooth counts beside each gear's centre (count, one-gear, train, centre).
  const v3 = new THREE.Vector3();
  function placeTags() {
    const on = vis.labels;
    labels.style.opacity = String(on);
    if (on < 0.01) return;
    const positions = {
      p1: [0, -8.6, Z.p1[1]],
      w1: [pivots.middle.position.x, 0, Z.w1[1]],
      p2: [pivots.middle.position.x, 0, Z.p2[1]],
      w2: [hourPos.position.x, hourPos.position.y, Z.w2[1]]
    };
    const show = { p1: !(stage === 'centre' && state.docked), w1: true, p2: stage === 'train' || stage === 'centre', w2: stage === 'train' || stage === 'centre' };
    const counts = { p1: TRAIN.p1, w1: shownW1, p2: TRAIN.p2, w2: shownW2 };
    for (const id of Object.keys(tags)) {
      const tag = tags[id];
      if (!show[id] || parts[id].opacity < 0.3) { tag.hidden = true; continue; }
      tag.hidden = false;
      tag.textContent = String(counts[id]);
      const [x, y, z] = positions[id];
      if (id === 'w1') v3.set(x, y + Math.min(shownW1 / 2 * 0.5, 9), z);
      else if (id === 'p2') v3.set(x, y - 6.8, z);
      else if (id === 'w2') v3.set(x, y + 9, z);
      else v3.set(x, y, z);
      v3.project(camera);
      tag.style.transform = `translate(${((v3.x + 1) / 2) * viewW}px, ${((1 - v3.y) / 2) * viewH}px) translate(-50%, -50%)`;
    }
  }

  // ── Registered parts (tests click them, the editor opens their colour) ──
  host.registerObject('minute-hand', handM.group);
  host.registerObject('small-gear', p1.group);
  host.registerObject('large-gear', w1.group);
  host.registerObject('last-gear', w2.group);
  host.registerObject('dial', dial.group);

  function applyColors() {
    p1.setColor(props.minuteColor); shaft.setColor(props.minuteColor); handM.setColor(props.minuteColor); cap.setColor(props.minuteColor);
    w1.setColor(props.middleColor); p2.setColor(props.middleColor); arbor.setColor(props.middleColor);
    w2.setColor(props.hourColor); tube.setColor(props.hourColor); handH.setColor(props.hourColor);
    dial.setColor(props.dialColor); caseRing.setColor(props.caseColor);
    for (const p of Object.values(parts)) p.setInk(props.inkColor);
    ticks.material.color.set(props.inkColor);
    ghostMat.uniforms.uColor.value.set(props.inkColor);
    for (const { hintMat, hintInk } of hintMaterials) { hintMat.color.set(props.hintColor); hintInk.uniforms.uColor.value.set(props.hintColor); }
    marks.p1.material.color.set(props.markColor);
    marks.w1.material.color.set(props.markColor);
    container.style.setProperty('--ck-minute', props.minuteColor);
    container.style.setProperty('--ck-middle', props.middleColor);
    container.style.setProperty('--ck-hour', props.hourColor);
    container.style.setProperty('--ck-ink', props.inkColor);
  }
  applyColors();

  function getState() {
    return { minute: Math.round(state.minute * 1000) / 1000, w2: state.w2, orbit: Math.round(state.orbit * 1000) / 1000, docked: state.docked, matched: state.matched, grown: state.grown, xray: state.xray };
  }

  return {
    update(next, transition) {
      const before = props;
      props = { ...props, ...next };
      if (transition) reduced = !!transition.reducedMotion || !!ctx.reducedMotion;
      applyColors();
      const name = STAGES.includes(props.stage) ? props.stage : 'clock';
      if (name !== stage || transition) applyStage(name, transition);
      else if (props.bigTeeth !== before.bigTeeth) resizeW1(w1For(name), 1);
      if (name === 'one-gear' && props.bigTeeth > TRAIN.w1 && !state.grown) { state.grown = true; host.emit('gear_grown', { teeth: w1For(name) }); }
      controlsFor(name, 0);
    },
    getState,
    setState(s) {
      Object.assign(state, sanitize(s));
      orbitShown = orbitFor(stage);
      applyStage(stage, null);
    },
    pause() { paused = true; refreshTexts(); },
    resume() { paused = reduced; refreshTexts(); },
    dispose() {
      stop();
      observer.disconnect();
      for (const g of ownGeometries) g.dispose?.();
      for (const p of Object.values(parts)) p.dispose();
      for (const m of [ghostMat, ticks.material, marks.p1.material, marks.w1.material, ...hintMaterials.flatMap((h) => [h.hintInk, h.hintMat])]) m.dispose();
      renderer.dispose();
    }
  };
}

function sanitize(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  if (Number.isFinite(s.minute)) out.minute = s.minute;
  if (Number.isInteger(s.w2)) out.w2 = clamp(Math.round(s.w2 / W2_STEP) * W2_STEP, W2_MIN, W2_MAX);
  if (Number.isFinite(s.orbit)) out.orbit = clamp(s.orbit, ORBIT_BESIDE, ORBIT_DOCKED);
  for (const k of ['docked', 'matched', 'grown', 'xray']) if (typeof s[k] === 'boolean') out[k] = s[k];
  return out;
}

// Smallest circle around a few circles (approximate: from the centre of their bounding box).
function enclose(circles) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, r] of circles) { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let r = 0;
  for (const [x, y, rr] of circles) r = Math.max(r, Math.hypot(x - cx, y - cy) + rr);
  return { x: cx, y: cy, r };
}

// A clock hand pointing up (+y): a straight blade with a round tip, a round hub and a short tail.
function handOutline(length, width, tail, hub) {
  const w = width / 2;
  const h = Math.sqrt(hub * hub - w * w);
  const low = Math.atan2(-h, w), up = Math.atan2(h, w);
  const pts = [];
  const arc = (cx, cy, r, a0, a1, n) => { for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  pts.push([w, -tail]);
  arc(0, 0, hub, low, up, 18);                       // right half of the hub
  arc(0, length - w, w, 0, Math.PI, 10);             // the blade's round tip
  arc(0, 0, hub, Math.PI - up, Math.PI - low, 18);   // left half of the hub
  arc(0, -tail, w, Math.PI, TAU, 10);                // the tail's round end
  pts.pop();
  return pts;
}

// Short arcs around a circle, for a dashed outline.
function dashes(radius, count, fill) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const a0 = (i / count) * TAU, a1 = a0 + (fill * TAU) / count;
    const pts = [];
    for (let k = 0; k <= 4; k++) { const a = a0 + ((a1 - a0) * k) / 4; pts.push([radius * Math.cos(a), radius * Math.sin(a)]); }
    lines.push({ points: pts, closed: false });
  }
  return lines;
}

const ICONS = {
  pause: '<svg class="ck-icon ck-icon--pause" viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="4" width="3.2" height="12" rx="1.2"/><rect x="11.8" y="4" width="3.2" height="12" rx="1.2"/></svg>',
  play: '<svg class="ck-icon ck-icon--play" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 4.2v11.6a.8.8 0 0 0 1.2.7l9.2-5.8a.8.8 0 0 0 0-1.4L7.7 3.5a.8.8 0 0 0-1.2.7z"/></svg>'
};

const STYLE = `
.ck{position:absolute;inset:0;overflow:hidden;font-family:var(--t-font-body,system-ui,sans-serif);color:var(--t-text)}
.ck-view{position:absolute;inset:0;outline:none;touch-action:none}
.ck-view.can-grab{cursor:grab}.ck-view.is-dragging{cursor:grabbing}
.ck-view:focus-visible{box-shadow:inset 0 0 0 3px var(--t-focus)}
.ck-view canvas{display:block;width:100%;height:100%}
.ck-labels{position:absolute;inset:0;pointer-events:none;transition:opacity .3s ease}
.ck-tag{position:absolute;left:0;top:0;padding:.125rem .5rem;border-radius:999px;font:600 .9375rem/1.3 var(--t-font-body,inherit);font-variant-numeric:tabular-nums;color:var(--t-text);background:var(--t-surface);box-shadow:0 0 0 1.5px var(--ck-ink)}
.ck-bar{position:absolute;left:1rem;right:1rem;bottom:1.25rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;justify-content:center;pointer-events:none}.ck-bar>*{pointer-events:auto}
.ck-bar [hidden]{display:none!important}
.ck-in{animation:ck-in .45s var(--t-ease-out,ease) both}
@keyframes ck-in{from{opacity:0;translate:0 .375rem}}
.ck-round{display:grid;place-items:center;width:44px;height:44px;border-radius:999px;border:1.5px solid var(--ck-ink);background:var(--t-surface);color:var(--ck-ink);cursor:pointer;padding:0}
.ck-round:hover{background:color-mix(in srgb,var(--ck-ink) 6%,var(--t-surface))}
.ck-round:focus-visible,.ck-range:focus-visible,.ck-switch input:focus-visible+.ck-switch-track{outline:3px solid var(--t-focus);outline-offset:2px}
.ck-icon{width:18px;height:18px;fill:currentColor}
.ck-round .ck-icon--play{display:none}.ck-round.is-paused .ck-icon--play{display:block}.ck-round.is-paused .ck-icon--pause{display:none}
.ck-chips{display:flex;gap:.5rem}
.ck-chip{display:inline-flex;align-items:center;gap:.5rem;min-height:44px;padding:0 1rem;border-radius:999px;background:var(--t-surface);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--ck-ink) 22%,transparent);font-size:1rem;font-variant-numeric:tabular-nums}
.ck-dot{width:.75rem;height:.75rem;border-radius:999px;box-shadow:0 0 0 1.5px var(--ck-ink)}
.ck-chip--a .ck-dot{background:var(--ck-minute)}.ck-chip--b .ck-dot{background:var(--ck-middle)}
.ck-sizer{display:inline-flex;align-items:center;gap:.75rem;min-height:44px;padding:0 1rem;border-radius:999px;background:var(--t-surface);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--ck-ink) 22%,transparent);font-size:1rem}
.ck-sizer-name{color:var(--t-muted)}
.ck-sizer-value{min-width:4.5em;font-weight:600;font-variant-numeric:tabular-nums}
.ck-range{width:11rem;accent-color:var(--ck-hour);cursor:pointer}
.ck-result{margin:0;display:inline-flex;align-items:center;gap:.4rem;min-height:44px;padding:0 1rem;border-radius:999px;font-size:1rem;font-weight:600;font-variant-numeric:tabular-nums;background:var(--t-surface);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--ck-ink) 22%,transparent)}
.ck-result.is-done{background:var(--ck-hour);box-shadow:inset 0 0 0 1.5px var(--ck-ink);color:var(--ck-ink)}
.ck-switch{display:inline-flex;align-items:center;gap:.625rem;min-height:44px;padding:0 1rem 0 .75rem;border-radius:999px;background:var(--t-surface);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--ck-ink) 22%,transparent);font-size:1rem;cursor:pointer}
.ck-switch input{position:absolute;opacity:0;width:1px;height:1px}
.ck-switch-track{position:relative;width:2.25rem;height:1.25rem;border-radius:999px;background:color-mix(in srgb,var(--ck-ink) 18%,var(--t-surface));box-shadow:inset 0 0 0 1.5px var(--ck-ink);transition:background .2s ease}
.ck-switch-track::after{content:"";position:absolute;top:.1875rem;left:.1875rem;width:.875rem;height:.875rem;border-radius:999px;background:var(--t-surface);box-shadow:0 0 0 1.5px var(--ck-ink);transition:translate .2s var(--t-ease-out,ease)}
.ck-switch input:checked+.ck-switch-track{background:var(--ck-hour)}
.ck-switch input:checked+.ck-switch-track::after{translate:1rem 0}
.ck-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;margin:0}
@media (prefers-reduced-motion: reduce){.ck-in{animation:none}.ck-labels{transition:none}}
`;
