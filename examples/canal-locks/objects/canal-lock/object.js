// Free object « Canal lock diorama » — three.js r186, Elabora free-object contract 0.1.
// A slice of canal with a lock, two pairs of mitre gates, their paddles and a small barge.
// Three modes share one scene: explore (the learner operates the lock), explain (steps with
// captions, replayable) and display (moved only by screen events through the Command prop).
// The rules live in sim.js and never depend on the style, the camera or the motion settings.
// The canvas is transparent: the diorama sits on the course's paper, on a watercolour pool.
// Placed on several screens with the same continuity key (D65), it is one lock: going from one screen
// to the next, update(props, transition) moves its camera, water, gates and controls from what the
// departing screen showed to what the arriving block asks, over the time of the passage; a boat that
// is elsewhere on the arriving screen fades out and comes back there, rather than sail through walls.
import * as THREE from 'three';
import {
  createSim, reset as resetSim, step as stepSim, openGates, closeGates, setPaddles, moveBoat, nextAction,
  snapshot, restore, levelsEqual, gateOpen, forwardDir, goalPlace, needsGate, EPS
} from './sim.js';
import {
  dims, terrainBoxes, terrainGeometry, terrainCap, paint, waterFootprints, waterPrism, footprintSpan,
  footprintOutline, leafGeometry, paddleGeometry, boatGeometry, flagGeometry
} from './geometry.js';
import { palette, sceneColours, dioramaMaterial, waterMaterial, jetMaterial, revealMaterial, paintWash, dotTexture } from './materials.js';
import { createAudio } from './audio.js';
import { STYLE, ICON, el, button } from './ui.js';

const VIEW_DIRS = { isometric: [-0.372, 0.669, 0.644], topDown: [0.0001, 1, 0.34], section: [0, 0.13, 1] };
const SECTION_Z = 1.35;          // the cut-away keeps everything behind this plane (the boat stays whole)
const NARROW = 640;              // px of frame width under which the panel goes below the scene
const CONTROLS = ['lowerGates', 'lowerPaddles', 'upperPaddles', 'upperGates'];
const REVEAL_S = { subtle: 2.0, expressive: 2.6 };
// Where each control sits, per view: on the rail above the diorama or below it, and on which row
// of that rail (0: next to the diorama). The middle of the scene stays clear.
const RAILS = {
  isometric: { lowerPaddles: ['top', 0], upperPaddles: ['top', 0], boat: ['top', 0], lowerGates: ['bottom', 0], upperGates: ['bottom', 0] },
  topDown: { lowerPaddles: ['top', 0], upperPaddles: ['top', 0], boat: ['top', 0], lowerGates: ['bottom', 0], upperGates: ['bottom', 0] },
  section: { lowerGates: ['top', 0], upperGates: ['top', 0], boat: ['top', 0], lowerPaddles: ['top', 1], upperPaddles: ['top', 1] }
};

export function mount(container, ctx) {
  const { host } = ctx;
  const t = ctx.t;
  const tokens = ctx.tokens || {};
  const reduced = !!ctx.reducedMotion;
  const testMode = !!ctx.testMode;
  let props = { ...ctx.props };
  let safe = { top: 0, right: 0, bottom: 0, left: 0, ...(ctx.safeArea || {}) };
  const loc = ctx.locale || 'en';
  const fmt = (v, digits = 2) => (Math.round(v * 100) / 100).toLocaleString(loc, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const fmt1 = (v) => (Math.round(v * 10) / 10).toLocaleString(loc, { maximumFractionDigits: 1 });

  // ── State ──
  const sim = createSim(props.rise, props.scenario);
  let d = dims(props.rise);
  let hints = 0, mistakes = 0, hintLevel = 0, hintKey = null, suggested = null;
  let view = props.cameraView;
  let muted = !props.sound;
  let paused = false;
  let completedSent = false;
  let clock = 0;                                // animation time (stops when paused)
  let message = '', messageKind = 'info';
  const ex = { index: -1, t: 0, steps: [], done: false, hold: 0, seen: 0, anchor: 'boat', at: null, startH: 0 };
  // The passage from another screen (D65): what was drawn when it began, eased toward what this
  // block shows. shown: what the last frame drew. lab: the lock as the learner left it in explore
  // mode, found again when they come back to it. learnerMuted: the learner's own choice of sound.
  // The boat does not glide (it would sail through gates and walls, or turn round in the chamber):
  // it fades out where it was over the passage's first BOAT_OUT and fades in at its new place over
  // its last part, from BOAT_IN (shown.fade: how much of it the last frame drew).
  let passage = null;
  const shown = { h: 0, boatX: 0, yaw: 0, place: 'lower', fade: 1, gates: { lower: 0, upper: 0 }, paddles: { lower: 0, upper: 0 } };
  const BOAT_OUT = 0.45, BOAT_IN = 0.55;
  let lab = null;
  let learnerMuted = null;
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const blend = () => (passage ? ease(passage.t) : 1);
  const mix = (a, b) => a + (b - a) * blend();
  const smooth = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
  // lab in the saved state: a short line (the state keeps flat values).
  const OC = { open: 'o', closed: 'c' };
  const packLab = (s) => [s.scenario === 'downhill' ? 'd' : 'u', s.level, OC[s.lowerGates], OC[s.upperGates], OC[s.lowerPaddles], OC[s.upperPaddles], s.boat[0], s.done ? 1 : 0].join(',');
  function unpackLab(line) {
    const [j, level, lg, ug, lp, up, boat, done] = String(line).split(',');
    const gate = (c) => (c === 'o' ? 'open' : 'closed');
    return { scenario: j === 'd' ? 'downhill' : 'uphill', level: Number(level) || 0, lowerGates: gate(lg), upperGates: gate(ug), lowerPaddles: gate(lp), upperPaddles: gate(up), boat: { l: 'lower', c: 'chamber', u: 'upper' }[boat] || 'lower', done: done === '1' };
  }

  // ── DOM ──
  container.innerHTML = '';
  container.className = 'cl-root t-ui';
  const css = el('style'); css.textContent = STYLE; container.appendChild(css);
  const stage = el('div', 'cl-stage');
  const svgNS = 'http://www.w3.org/2000/svg';
  const anno = document.createElementNS(svgNS, 'svg'); anno.setAttribute('class', 'cl-anno'); anno.setAttribute('aria-hidden', 'true');
  const labels = el('div', 'cl-labels'); labels.setAttribute('aria-hidden', 'true');
  const hotspots = el('div', 'cl-hotspots');
  const pauseBtn = button('cl-pause');
  const panel = el('div', 'cl-panel');
  container.append(stage, panel);
  stage.append(anno, labels, hotspots, pauseBtn);

  // What happens is announced to screen readers in every mode; on screen, the scene shows it.
  const status = el('p', 'cl-sr'); status.setAttribute('role', 'status');
  const hintBox = el('div', 'cl-hint'); hintBox.hidden = true;
  hintBox.setAttribute('aria-live', 'polite');
  const hintHead = el('small'); const hintText = el('p');
  const hintClose = button('cl-round'); hintClose.innerHTML = ICON.close; hintClose.setAttribute('aria-label', t('hintClose'));
  hintBox.append(hintHead, hintText, hintClose);
  const tools = el('div', 'cl-tools');
  const hintBtn = button('cl-tool'); hintBtn.innerHTML = ICON.hint; hintBtn.append(el('span', '', t('toolHint')));
  hintBtn.setAttribute('aria-expanded', 'false');
  const resetBtn = button('cl-tool'); resetBtn.innerHTML = ICON.reset; resetBtn.append(el('span', '', t('toolReset')));
  const seg = el('div', 'cl-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t('viewLabel'));
  const viewBtns = {};
  for (const [k, key] of [['isometric', 'viewIsometric'], ['topDown', 'viewTopDown'], ['section', 'viewSection']]) {
    const b = button('', t(key)); b.addEventListener('click', () => { learnerGesture(); setView(k, true); }); viewBtns[k] = b; seg.append(b);
  }
  const soundBtn = button('cl-tool');
  tools.append(hintBtn, resetBtn, seg, soundBtn);
  const side = el('div', 'cl-side');

  // Explain mode: one bubble in the scene, with the step's words and the way between steps.
  const bubble = el('div', 'cl-bubble'); bubble.setAttribute('role', 'group');
  const bubbleBody = el('div', 'cl-bubble-body'); bubbleBody.setAttribute('aria-live', 'polite');
  const capTitle = el('p', 'cl-bubble-title'); const capText = el('p', 'cl-bubble-text');
  bubbleBody.append(capTitle, capText);
  const nav = el('div', 'cl-bubble-nav');
  const replayBtn = button('cl-round is-replay'); replayBtn.innerHTML = ICON.replay; replayBtn.setAttribute('aria-label', t('replay')); replayBtn.title = t('replay');
  const prevBtn = button('cl-round'); prevBtn.innerHTML = ICON.prev; prevBtn.setAttribute('aria-label', t('stepPrev')); prevBtn.title = t('stepPrev');
  const nextBtn = button('cl-round'); nextBtn.innerHTML = ICON.next; nextBtn.setAttribute('aria-label', t('stepNext')); nextBtn.title = t('stepNext');
  nav.append(replayBtn, prevBtn, nextBtn);
  bubble.append(bubbleBody, nav);
  const bub = { x: 0, y: 0, w: 0, h: 0, maxH: 0, placed: false, measuredFor: '' };

  // Controls in the scene: one button per mechanism, and the boat's two moves.
  const hot = {};
  for (const k of CONTROLS) {
    const b = button('cl-hot');
    b.dataset.control = k;
    const text = el('span', 'cl-hot-text');
    const name = el('span', 'cl-hot-name'); const st = el('span', 'cl-hot-state');
    text.setAttribute('aria-hidden', 'true');
    text.append(name, st);
    b.append(text);
    b.addEventListener('click', () => { learnerGesture(); toggle(k); });
    hot[k] = { el: b, name, st, x: 0, y: 0, w: 0, h: 0, shown: true };
  }
  const boatBox = el('div', 'cl-hot cl-hot--boat'); boatBox.setAttribute('role', 'group');
  boatBox.setAttribute('aria-label', t('ctlBoat'));
  const boatName = el('span', 'cl-hot-name', t('ctlBoat')); boatName.setAttribute('aria-hidden', 'true');
  const backBtn = button('cl-round cl-dir is-back'); backBtn.innerHTML = ICON.arrow;
  const aheadBtn = button('cl-round cl-dir'); aheadBtn.innerHTML = ICON.arrow;
  for (const [b, key] of [[aheadBtn, 'boatAhead'], [backBtn, 'boatBack']]) { b.setAttribute('aria-label', t(key)); b.title = t(key); }
  boatBox.append(boatName, backBtn, aheadBtn);
  // A move with nowhere to go does nothing; one blocked by shut gates is tried, and refused.
  aheadBtn.addEventListener('click', () => { if (aheadBtn.getAttribute('aria-disabled') === 'true') return; learnerGesture(); act('boat-forward'); });
  backBtn.addEventListener('click', () => { if (backBtn.getAttribute('aria-disabled') === 'true') return; learnerGesture(); act('boat-back'); });
  hot.boat = { el: boatBox, x: 0, y: 0, w: 0, h: 0, shown: true, dir: null };
  for (const k of [...CONTROLS, 'boat']) hotspots.append(hot[k].el);

  hintBtn.addEventListener('click', () => { learnerGesture(); showHint(); });
  hintClose.addEventListener('click', () => { closeHint(); hintBtn.focus(); });
  resetBtn.addEventListener('click', () => { learnerGesture(); act('reset'); });
  soundBtn.addEventListener('click', () => { learnerGesture(); setMuted(!muted); learnerMuted = muted; });
  pauseBtn.addEventListener('click', () => { paused = !paused; refreshPause(); });
  prevBtn.addEventListener('click', () => { learnerGesture(); if (ex.index > 0) startPhase(ex.index - 1); });
  nextBtn.addEventListener('click', () => { learnerGesture(); if (ex.index < phases().length - 1) startPhase(ex.index + 1, { follow: true }); });
  replayBtn.addEventListener('click', () => { learnerGesture(); startPhase(Math.max(0, ex.index)); });

  // ── three.js ──
  const renderer = new THREE.WebGLRenderer({ antialias: !testMode, alpha: true, preserveDrawingBuffer: testMode });
  renderer.setPixelRatio(testMode ? 1 : Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  stage.prepend(renderer.domElement);
  host.registerRenderer(renderer);
  // A lost context (busy machines, software WebGL) comes back by itself: three.js uploads everything
  // again; until then the frame keeps its last picture.
  let contextLost = false;
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); contextLost = true; });
  renderer.domElement.addEventListener('webglcontextrestored', () => { contextLost = false; washDirty = true; });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
  host.registerCamera(camera);

  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 99);
  const matTerrain = dioramaMaterial(); matTerrain.clippingPlanes = [clipPlane]; matTerrain.clipShadows = true;
  const matBoat = dioramaMaterial();
  const matWater = waterMaterial(); matWater.clippingPlanes = [clipPlane];
  const matEdges = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.3, clippingPlanes: [clipPlane] });
  const matEdgesBoat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.3 });
  const matRim = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7, clippingPlanes: [clipPlane] });
  const reveal = revealMaterial();

  const hemi = new THREE.HemisphereLight();
  const key = new THREE.DirectionalLight();
  key.position.set(-9, 18, 9);
  key.castShadow = true;
  key.shadow.mapSize.set(testMode ? 512 : 1024, testMode ? 512 : 1024);
  Object.assign(key.shadow.camera, { left: -22, right: 22, top: 16, bottom: -16, near: 1, far: 70 });
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02; key.shadow.radius = 3;
  const fill = new THREE.DirectionalLight();
  fill.position.set(12, 6, -4);
  scene.add(hemi, key, key.target, fill);

  // Ground: a watercolour pool painted once, and a shadow catcher on the paper.
  const washCanvas = document.createElement('canvas'); washCanvas.width = 512; washCanvas.height = 340;
  const washTex = new THREE.CanvasTexture(washCanvas); washTex.colorSpace = THREE.SRGBColorSpace;
  const wash = new THREE.Mesh(new THREE.PlaneGeometry(52, 34), new THREE.MeshBasicMaterial({ map: washTex, transparent: true, depthWrite: false }));
  wash.rotation.x = -Math.PI / 2; wash.renderOrder = -2;
  const shadowGround = new THREE.Mesh(new THREE.PlaneGeometry(52, 34), new THREE.ShadowMaterial({ opacity: 0.2, depthWrite: false }));
  shadowGround.rotation.x = -Math.PI / 2; shadowGround.receiveShadow = true; shadowGround.renderOrder = -1;
  scene.add(wash, shadowGround);

  // Parts rebuilt when the rise changes.
  const world = new THREE.Group(); scene.add(world);
  let boxes = [], terrain, terrainEdges, capMesh, waterCapMesh, waters = {}, leaves = [], jets = [], footprints;
  const boatGroup = new THREE.Group(); scene.add(boatGroup);
  const boatParts = boatGeometry();
  const boatMesh = new THREE.Mesh(boatParts.geo, matBoat); boatMesh.castShadow = true; boatMesh.receiveShadow = true;
  const boatEdges = new THREE.LineSegments(new THREE.BufferGeometry(), matEdgesBoat);   // drawn at the first frame
  const flagGeo = flagGeometry();
  const flag = new THREE.Mesh(flagGeo, matBoat); flag.position.set(boatParts.poleX, boatParts.poleTop, 0); flag.castShadow = true;
  const flagMat = dioramaMaterial(); flagMat.side = THREE.DoubleSide; flag.material = flagMat;
  // Transparent from the start, so that fading the boat in a passage compiles no shader then (a
  // compile froze the first passage for over a second). Drawn first of what is transparent, before
  // the water, as when it was opaque; the flag in one pass, as an opaque double-sided flag is.
  matBoat.transparent = flagMat.transparent = true; flagMat.forceSinglePass = true;
  boatMesh.renderOrder = flag.renderOrder = -1;
  boatGroup.add(boatMesh, boatEdges, flag);
  boatMesh.userData.id = 'boat';
  // Click targets: an anchor on each part, at a point that stays in view (tests click there).
  const boatAnchor = new THREE.Object3D(); boatAnchor.position.set(0.6, 1.2, 0); boatAnchor.userData.id = 'boat';
  boatGroup.add(boatAnchor);
  host.registerObject('boat', boatAnchor);
  const anchors = { boat: boatAnchor };
  // The boat drawn at o of its opacity (1: whole).
  function fadeBoat(o) {
    matBoat.opacity = flagMat.opacity = o;
    matEdgesBoat.opacity = (matEdgesBoat.userData.ink ?? 0.3) * o;
    boatMesh.castShadow = flag.castShadow = o > 0.5;
    boatGroup.visible = o > 0;
  }

  // Spray, ripples and the leaves of the celebration.
  const SPRAY = 90;
  const sprayGeo = new THREE.BufferGeometry();
  sprayGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(SPRAY * 3).fill(-999), 3));
  const dotTex = dotTexture(new THREE.Color(1, 1, 1));
  const sprayMat = new THREE.PointsMaterial({ size: 4.6 * renderer.getPixelRatio(), map: dotTex, transparent: true, depthWrite: false, sizeAttenuation: false, clippingPlanes: [clipPlane] });
  const spray = new THREE.Points(sprayGeo, sprayMat); spray.frustumCulled = false; scene.add(spray);
  const sprayP = Array.from({ length: SPRAY }, () => ({ life: 0, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0 }));
  const RIPPLES = 18;
  const ringGeo = new THREE.RingGeometry(0.88, 1, 40); ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, clippingPlanes: [clipPlane] });
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, RIPPLES); rings.frustumCulled = false; rings.renderOrder = 2;
  const ringP = Array.from({ length: RIPPLES }, () => ({ age: 1, life: 1, x: 0, z: 0, place: 'chamber', size: 1 }));
  scene.add(rings);
  const LEAVES = 46;
  const leafShape = new THREE.Shape(); leafShape.moveTo(0, -0.38); leafShape.quadraticCurveTo(0.27, 0, 0, 0.38); leafShape.quadraticCurveTo(-0.27, 0, 0, -0.38);
  const leafMesh = new THREE.InstancedMesh(new THREE.ShapeGeometry(leafShape, 4), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), LEAVES);
  leafMesh.frustumCulled = false; scene.add(leafMesh);
  const leafP = Array.from({ length: LEAVES }, () => ({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0, vr: 0, s: 1 }));
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpV = new THREE.Vector3(), tmpE = new THREE.Euler();

  // The entrance: while it lasts, the scene is drawn into a texture that a quad composes with the
  // wash (the texture is freed once the diorama has fully appeared).
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const composite = new THREE.Mesh(quadGeo, reveal.material);
  composite.frustumCulled = false;
  quadScene.add(composite);
  let revealRT = null;
  const bufSize = new THREE.Vector2();
  function revealTarget() {
    renderer.getDrawingBufferSize(bufSize);
    const w = Math.max(1, bufSize.x), h = Math.max(1, bufSize.y);
    if (!revealRT) revealRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
    else if (revealRT.width !== w || revealRT.height !== h) revealRT.setSize(w, h);
    reveal.uniforms.tScene.value = revealRT.texture;
    reveal.uniforms.uTexel.value.set(1 / w, 1 / h);
    reveal.uniforms.uRadius.value = 8 * renderer.getPixelRatio();
    return revealRT;
  }
  let revealT = 1, revealDur = 1;
  const entrance = testMode || reduced ? (props.entrance === 'none' ? 'none' : 'fade') : props.entrance;
  if (entrance === 'watercolor') { revealT = 0; container.classList.add('is-revealing'); revealDur = REVEAL_S[props.motionIntensity] || 2; reveal.uniforms.uSeed.value.set(host.random() * 20, host.random() * 20); }
  else if (entrance === 'fade' && !testMode) { container.classList.add('is-fading'); }

  const audio = createAudio(() => host.random());

  function build() {
    if (!boatEdges.geometry.attributes.position) { boatEdges.geometry.dispose(); boatEdges.geometry = new THREE.EdgesGeometry(boatParts.geo, 32); }
    d = dims(props.rise);
    sim.rise = props.rise;
    sim.h = Math.min(sim.h, sim.rise);
    for (const o of [...world.children]) { world.remove(o); o.traverse?.((n) => { if (n.geometry && n.geometry !== capMesh?.geometry) n.geometry.dispose?.(); }); }
    boxes = terrainBoxes(d);
    const tg = terrainGeometry(boxes);
    terrain = new THREE.Mesh(tg, matTerrain); terrain.castShadow = true; terrain.receiveShadow = true;
    terrainEdges = new THREE.LineSegments(new THREE.EdgesGeometry(tg, 25), matEdges);
    capMesh = new THREE.Mesh(new THREE.BufferGeometry(), matTerrain); capMesh.visible = false;
    world.add(terrain, terrainEdges, capMesh);
    // Water bodies.
    footprints = waterFootprints(d);
    waters = {};
    for (const k of ['lower', 'chamber', 'upper']) {
      const geo = waterPrism(footprints[k]);
      const m = new THREE.Mesh(geo, matWater); m.receiveShadow = true; m.renderOrder = 1;
      const rim = new THREE.LineSegments(footprintOutline(footprints[k]), matRim); rim.position.y = 1; rim.renderOrder = 3;
      m.add(rim);
      world.add(m);
      waters[k] = { mesh: m, rim, bed: k === 'upper' ? d.bedUp : d.bedLow };
    }
    waters.chamber.mesh.userData.id = 'chamber';
    const chamberAnchor = new THREE.Object3D(); chamberAnchor.position.set(-3.2, 1, 1.2); chamberAnchor.userData.id = 'chamber';
    waters.chamber.mesh.add(chamberAnchor);
    host.registerObject('chamber', chamberAnchor);
    waterCapMesh = new THREE.Mesh(new THREE.BufferGeometry(), matWater); waterCapMesh.visible = false; waterCapMesh.renderOrder = 1;
    world.add(waterCapMesh);
    // Gates: two leaves per pair, each with its paddle board and rack.
    leaves = [];
    jets.forEach((j) => { j.mesh.geometry.dispose(); j.mesh.material.dispose(); });
    jets = [];
    for (const side of ['lower', 'upper']) {
      const lg = leafGeometry(d, side);
      const pg = paddleGeometry(lg.paddleX, lg.openingY, lg.top);
      for (const s of [1, -1]) {
        const g = new THREE.Group();
        g.position.set(side === 'lower' ? d.xL : d.xU, 0, s * (d.hw - 0.18));
        const mesh = new THREE.Mesh(lg.geo, matTerrain); mesh.castShadow = true; mesh.receiveShadow = true;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(lg.geo, 30), matEdges);
        const board = new THREE.Mesh(pg.board, matTerrain); board.castShadow = true;
        const rack = new THREE.Mesh(pg.rack, matTerrain);
        g.add(mesh, edges, board, rack);
        world.add(g);
        const leaf = { side, s, group: g, mesh, board, rack, paddleX: lg.paddleX, openingY: lg.openingY, top: lg.top };
        leaves.push(leaf);
        const jet = makeJet();
        world.add(jet.mesh);
        jets.push({ ...jet, leaf });
      }
      // Click targets: the middle of the near leaf for the gates, the far leaf's paddle gear for the paddles.
      const near = leaves.find((l) => l.side === side && l.s === 1);
      const far = leaves.find((l) => l.side === side && l.s === -1);
      const ga = new THREE.Object3D(); ga.position.set(d.leafLen * 0.55, lg.top - 0.7, 0); ga.userData.id = side + '-gates'; near.group.add(ga);
      const pa = new THREE.Object3D(); pa.position.set(lg.paddleX, lg.top + 0.75, 0); pa.userData.id = side + '-paddles'; far.group.add(pa);
      anchors[side + '-gates'] = ga; anchors[side + '-paddles'] = pa;
      host.registerObject(side + '-gates', ga);
      host.registerObject(side + '-paddles', pa);
    }
    wash.position.y = d.baseY - 0.03;
    shadowGround.position.y = d.baseY - 0.015;
    key.target.position.set(0, d.baseY, 0);
    applyLook();
    lastCapZ = null;
  }

  function makeJet() {
    const NS = 16, NR = 6;
    const pos = new Float32Array((NS + 1) * NR * 3), aT = new Float32Array((NS + 1) * NR), aA = new Float32Array((NS + 1) * NR);
    const idx = [];
    for (let i = 0; i <= NS; i++) for (let j = 0; j < NR; j++) { aT[i * NR + j] = i / NS; aA[i * NR + j] = j / NR; }
    for (let i = 0; i < NS; i++) for (let j = 0; j < NR; j++) {
      const a = i * NR + j, b = i * NR + ((j + 1) % NR), c = (i + 1) * NR + j, e = (i + 1) * NR + ((j + 1) % NR);
      idx.push(a, c, b, b, c, e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    geo.setAttribute('aA', new THREE.BufferAttribute(aA, 1));
    geo.setIndex(idx);
    const mat = jetMaterial(); mat.clippingPlanes = [clipPlane];
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.visible = false;
    return { mesh, NS, NR, strength: 0, impact: null };
  }

  // ── Pointer: a click on a gate, a paddle gear or the boat operates it, like its button ──
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ANCHOR_CONTROL = { 'lower-gates': 'lowerGates', 'upper-gates': 'upperGates', 'lower-paddles': 'lowerPaddles', 'upper-paddles': 'upperPaddles', boat: 'boat' };
  function nearestAnchor(px, py, reach) {
    let best = null, bestD = reach;
    for (const [id, a] of Object.entries(anchors)) {
      if (!ANCHOR_CONTROL[id] || (id === 'boat' && shown.fade < 1)) continue;
      a.getWorldPosition(tmpV);
      const [x, y] = toScreen(tmpV.x, tmpV.y, tmpV.z);
      const dd = Math.hypot(x - px, y - py);
      if (dd < bestD) { bestD = dd; best = ANCHOR_CONTROL[id]; }
    }
    return best;
  }
  function pick(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const exact = nearestAnchor(px, py, 10);
    if (exact) return exact;
    ndc.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    // A boat fading out or in during a passage is not there to be clicked.
    const targets = shown.fade < 1 ? [] : [boatMesh];
    for (const l of leaves) if (l.group.visible) targets.push(l.mesh, l.board, l.rack);
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (hit) {
      if (hit.object === boatMesh) return 'boat';
      const l = leaves.find((q) => q.mesh === hit.object || q.board === hit.object || q.rack === hit.object);
      if (l) {
        if (hit.object !== l.mesh) return l.side + 'Paddles';
        tmpV.copy(hit.point); l.group.worldToLocal(tmpV);
        return Math.abs(tmpV.x - l.paddleX) < 0.5 && tmpV.y > l.top ? l.side + 'Paddles' : l.side + 'Gates';
      }
    }
    return nearestAnchor(px, py, 42);
  }
  renderer.domElement.addEventListener('click', (e) => {
    if (props.mode !== 'explore') return;
    const k = pick(e.clientX, e.clientY);
    if (!k) return;
    learnerGesture();
    if (k === 'boat') act('boat-forward'); else toggle(k);
  });
  let lastHover = -1;
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (props.mode !== 'explore' || clock - lastHover < 0.06) return;
    lastHover = clock;
    renderer.domElement.style.cursor = pick(e.clientX, e.clientY) ? 'pointer' : '';
  });

  // ── Look: palette, lights and line weights for the style ──
  let colours = sceneColours(props.visualStyle, props, tokens);
  function applyLook() {
    if (!terrain) return;
    const style = props.visualStyle;
    const pal = palette(style, props, tokens);
    colours = sceneColours(style, props, tokens);
    paint(terrain.geometry, pal);
    for (const l of leaves) { paint(l.mesh.geometry, pal); paint(l.board.geometry, pal); paint(l.rack.geometry, pal); }
    paint(boatMesh.geometry, pal); paint(flagGeo, pal);
    if (capMesh.geometry.attributes.aRole) paint(capMesh.geometry, pal);
    lastPalette = pal;
    const technical = style === 'technical', playful = style === 'playful';
    for (const m of [matTerrain, matBoat, flagMat]) {
      const u = m.userData.uniforms;
      u.uGrain.value = technical ? 0.25 : playful ? 0.2 : 1;
      u.uJoint.value = technical ? 0.12 : playful ? 0.12 : 0.2;
      u.uHatch.value = technical ? 1 : 0;
      u.uInk.value.copy(colours.ink);
      u.uEdgeZ.value.set(d.zNear, d.zFar); u.uEdgeX.value = d.X1;
      u.uLift.value = technical ? 0.04 : 0;
    }
    const inkOpacity = technical ? 0.8 : playful ? 0.12 : 0.3;
    for (const m of [matEdges, matEdgesBoat]) { m.color.copy(colours.ink); m.opacity = inkOpacity; }
    matEdgesBoat.userData.ink = inkOpacity; fadeBoat(shown.fade);
    matRim.color.copy(technical ? colours.waterDeep : colours.waterDeep.clone().lerp(colours.paper, 0.15));
    matRim.opacity = technical ? 0.95 : 0.6;
    matWater.color.copy(colours.water);
    matWater.opacity = technical ? 0.72 : 0.86;
    const wu = matWater.userData.uniforms;
    wu.uLight.value.copy(colours.waterLight); wu.uDeep.value.copy(colours.waterDeep); wu.uFoamCol.value.copy(colours.foam);
    wu.uExpr.value = props.motionIntensity === 'expressive' && !reduced ? 1 : 0.45;
    wu.uSplit.value.set(d.xL, d.xU);
    for (const j of jets) { j.mesh.material.uniforms.uColor.value.copy(colours.foam); j.mesh.material.uniforms.uWater.value.copy(colours.waterLight); }
    sprayMat.color.copy(colours.foam);
    ringMat.color.copy(colours.foam);
    hemi.color.copy(colours.paper).lerp(new THREE.Color(1, 1, 1), 0.35);
    hemi.groundColor.copy(colours.grass).lerp(colours.earth, 0.4);
    key.color.copy(colours.paper).lerp(new THREE.Color(1, 1, 1), 0.6);
    hemi.intensity = technical ? 2.7 : playful ? 2.5 : 2.15;
    key.intensity = technical ? 1.25 : playful ? 1.55 : 1.85;
    fill.intensity = technical ? 0.7 : 0.45;
    shadowGround.material.color.copy(colours.ink);
    shadowGround.material.opacity = technical ? 0.12 : 0.2;
    // The pool is repainted on the next frame (mount returns sooner).
    washDirty = true;
    const ru = reveal.uniforms;
    ru.uA.value.copy(colours.sage); ru.uB.value.copy(colours.water); ru.uC.value.copy(colours.ochre);
  }
  let lastPalette = null;
  let washDirty = true;
  function paintPool() {
    // A seeded random, so it is the same picture at every mount.
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    paintWash(washCanvas, props.visualStyle, colours, rnd);
    washTex.needsUpdate = true;
    washDirty = false;
  }

  // ── Camera: orthographic, framed on the slice, out of the part the layout covers ──
  const cam = { dir: new THREE.Vector3(...VIEW_DIRS[view]).normalize(), frustum: null, cut: view === 'section' ? SECTION_Z : d.zNear + 1 };
  const target = new THREE.Vector3(0, 0, 0);
  function basis(dir) {
    const f = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, f).normalize();
    return { right, up };
  }
  let W = 1, H = 1, narrow = false, stageH = 1, lastSize = '';
  function frameFor(dir) {
    const { right, up } = basis(dir);
    const sec = view === 'section';
    // In the cut-away, the frame keeps the water and the gates, and lets the deep base run off.
    const zs = sec ? [-d.zFar, SECTION_Z] : [-d.zFar - 0.3, d.zNear + 0.3];
    const ys = sec ? [d.bedLow - 0.9, d.gHigh + 1.3] : [d.baseY, d.gHigh + 1.7];
    const xs = sec ? [d.X0 + 0.2, d.X1 - 0.2] : [d.X0 - 0.3, d.X1 + 0.3];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const x of xs) for (const y of ys) for (const z of zs) {
      tmpV.set(x, y, z).sub(target);
      const u = tmpV.dot(right), v = tmpV.dot(up);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const m = Math.max(12, Math.min(W, stageH) * 0.04);
    const reserveBottom = narrow ? 0 : panelReserve();
    const ax0 = (narrow ? 0 : Math.min(safe.left, W * 0.5)) + m;
    const ax1 = W - (narrow ? 0 : Math.min(safe.right, W * 0.4)) - m;
    const ay0 = (narrow ? 0 : Math.min(safe.top, stageH * 0.45)) + m + (sec ? stageH * 0.04 : 0);
    const ay1 = stageH - Math.max(narrow ? 0 : Math.min(safe.bottom, stageH * 0.4), reserveBottom) - m;
    const aw = Math.max(40, ax1 - ax0), ah = Math.max(40, ay1 - ay0);
    let s = Math.max((u1 - u0) / aw, (v1 - v0) / ah) * 1.04;
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    const acx = (ax0 + ax1) / 2;
    let acy = (ay0 + ay1) / 2;
    // Explain mode keeps room above the diorama for the bubble: the diorama sits lower, and
    // shrinks a little (15 % at most) when the frame is short.
    const room = topRoom();
    if (room > 0) {
      if ((v1 - v0) / s > ah - room) s = Math.min(s * 1.15, (v1 - v0) / Math.max(40, ah - room));
      const hD = (v1 - v0) / s;
      acy = hD <= ah - room ? (ay0 + room + ay1) / 2 : ay1 - hD / 2;
    }
    // Where the diorama sits on screen, for the watercolour entrance.
    reveal.uniforms.uCenter.value.set(acx / Math.max(1, W), 1 - acy / Math.max(1, stageH));
    reveal.uniforms.uExtent.value.set(((u1 - u0) / s / 2) / Math.max(1, W), ((v1 - v0) / s / 2) / Math.max(1, stageH));
    const left = uc - acx * s, top = vc + acy * s;
    return { left, right: left + W * s, top, bottom: top - stageH * s, scale: s };
  }
  // Room kept at the bottom for the tool bar, measured at layout time (not every frame). The hint
  // opens above the tool bar, over the scene, and does not move the diorama.
  let reserve = 0;
  function panelReserve() { return reserve; }
  function measureReserve() {
    if (props.mode === 'display' || narrow) { reserve = 0; return; }
    const h = tools.offsetHeight;
    reserve = h ? h + 16 : 0;
  }
  function topRoom() { return props.mode === 'explain' && !narrow && bub.maxH ? bub.maxH + 40 : 0; }
  function applyCamera(dt, snap) {
    const goalDir = new THREE.Vector3(...VIEW_DIRS[view]).normalize();
    const k = snap || reduced ? 1 : 1 - Math.exp(-dt * (props.motionIntensity === 'expressive' ? 4.2 : 6));
    if (passage && !snap) {
      // A passage: from the departing camera to this block's, on one curve with everything else.
      const e = blend();
      cam.dir.copy(passage.from.dir).lerp(goalDir, e).normalize();
      const goal = frameFor(cam.dir);
      cam.frustum = {};
      for (const f of ['left', 'right', 'top', 'bottom']) cam.frustum[f] = passage.from.frustum[f] + (goal[f] - passage.from.frustum[f]) * e;
    } else {
      cam.dir.lerp(goalDir, k).normalize();
      const goal = frameFor(cam.dir);
      if (!cam.frustum || snap || reduced) cam.frustum = goal;
      else for (const f of ['left', 'right', 'top', 'bottom']) cam.frustum[f] += (goal[f] - cam.frustum[f]) * Math.min(1, k * 1.4);
    }
    camera.position.copy(target).addScaledVector(cam.dir, 80);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    Object.assign(camera, { left: cam.frustum.left, right: cam.frustum.right, top: cam.frustum.top, bottom: cam.frustum.bottom });
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // The cut-away slides in from the near edge.
    const cutGoal = view === 'section' ? SECTION_Z : d.zNear + 1;
    if (passage && !snap) cam.cut = passage.from.cut + (cutGoal - passage.from.cut) * blend();
    else cam.cut += (cutGoal - cam.cut) * (snap || reduced ? 1 : Math.min(1, k * 1.2));
    if (Math.abs(cam.cut - cutGoal) < 0.01) cam.cut = cutGoal;
    clipPlane.constant = cam.cut;
    for (const m of [matTerrain]) m.userData.uniforms.uCutZ.value = cam.cut < d.zNear ? cam.cut - 0.002 : 99;
    updateCaps();
  }
  let lastCapZ = null;
  function updateCaps() {
    if (!capMesh) return;
    const active = cam.cut < d.zNear;
    capMesh.visible = active; waterCapMesh.visible = active;
    if (!active) return;
    const z = cam.cut - 0.002;
    if (lastCapZ === null || Math.abs(lastCapZ - z) > 0.0005) {
      const acc = terrainCap(boxes, z);
      // Gate leaves crossing the cut are hidden, so they need no cap.
      capMesh.geometry.dispose();
      capMesh.geometry = acc.build();
      if (lastPalette) paint(capMesh.geometry, lastPalette);
      lastCapZ = z;
    }
    // Water cross-section: one quad per body from its bed to its level (built every frame: the level moves).
    const P = [], N = [], T = [], D = [];
    for (const k of ['lower', 'chamber', 'upper']) {
      const span = footprintSpan(footprints[k], z);
      if (!span) continue;
      const y0 = waters[k].bed, y1 = levelOf(k);
      if (y1 - y0 < 0.01) continue;
      const [x0, x1] = span;
      const quad = [[x0, y0, 1], [x1, y0, 1], [x1, y1, 0], [x0, y0, 1], [x1, y1, 0], [x0, y1, 0]];
      for (const [x, y, dep] of quad) { P.push(x, y, z); N.push(0, 0, 1); T.push(0); D.push(dep); }
    }
    const g = waterCapMesh.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('aTop', new THREE.Float32BufferAttribute(T, 1));
    g.setAttribute('aDepth', new THREE.Float32BufferAttribute(D, 1));
    g.computeBoundingSphere();
  }
  // The chamber's level as drawn: during a passage, on its way from the departing screen's.
  function levelOf(k) { return k === 'lower' ? 0 : k === 'upper' ? sim.rise : passage ? mix(passage.from.h, sim.h) : sim.h; }

  function setView(v, byLearner) {
    if (!VIEW_DIRS[v]) return;
    view = v;
    for (const [k, b] of Object.entries(viewBtns)) b.setAttribute('aria-pressed', String(k === v));
    if (byLearner) emitState();
  }

  // ── Layout of the frame ──
  function layout() {
    const w = container.clientWidth || 1;
    // Display mode has no panel to stack: it keeps filling its frame at any width.
    const n = w > 0 && w < NARROW && props.mode !== 'display';
    if (n !== narrow) { narrow = n; container.classList.toggle('is-narrow', narrow); placeHotspots(); }
    W = w;
    if (narrow) {
      stageH = Math.round(Math.min(380, Math.max(240, w * 0.72)));
      stage.style.height = stageH + 'px';
      requestHeight();
    } else {
      stage.style.height = '';
      stageH = container.clientHeight || 1;
    }
    H = stageH;
    panel.style.setProperty('--cl-left', (narrow ? 16 : Math.max(16, Math.min(safe.left, W * 0.5) + 16)) + 'px');
    measureReserve();
    measureBubble();
    const size = `${W}x${H}:${safe.left},${safe.top},${safe.right},${safe.bottom}:${reserve}:${bub.maxH}`;
    if (size !== lastSize) {
      const first = !lastSize;
      lastSize = size;
      renderer.setSize(W, H, false);
      applyCamera(0, first);
    }
  }
  // The bubble's height for the longest step, so the diorama keeps the same place from step to step.
  function measureBubble() {
    if (props.mode !== 'explain' || narrow) return;
    const list = phases();
    const key = `${W}:${JSON.stringify(list.map((p) => [p.title, p.caption]))}`;
    if (key === bub.measuredFor || !bubble.isConnected) return;
    const keep = [capTitle.textContent, capText.textContent];
    let maxH = 0;
    for (const p of list) {
      capTitle.textContent = p.title || ''; capText.textContent = p.caption || '';
      maxH = Math.max(maxH, bubble.offsetHeight);
    }
    [capTitle.textContent, capText.textContent] = keep;
    bub.maxH = maxH; bub.w = bubble.offsetWidth; bub.h = bubble.offsetHeight;
    bub.measuredFor = key;
  }
  let requested = 0;
  function requestHeight() {
    if (!narrow) return;
    const h = Math.ceil(stageH + panel.offsetHeight + 8);
    if (Math.abs(h - requested) > 1) { requested = h; host.requestHeight?.(h); }
  }
  function placeHotspots() {
    // Wide: the controls and the bubble float over the scene; narrow: they line up under it.
    if (narrow) { panel.prepend(hotspots); if (props.mode === 'explain') panel.prepend(bubble); }
    else { stage.insertBefore(hotspots, pauseBtn); if (props.mode === 'explain') stage.insertBefore(bubble, pauseBtn); }
    bub.placed = false;
  }

  // ── Modes ──
  function phases() { return Array.isArray(props.phases) && props.phases.length ? props.phases : [{ phase: 'flow', title: '', caption: '' }]; }
  function applyMode() {
    const mode = props.mode;
    container.dataset.mode = mode;
    panel.innerHTML = '';
    bubble.remove();
    hotspots.hidden = mode !== 'explore';
    side.innerHTML = '';
    if (mode === 'explore') {
      side.append(hintBox, tools);
      panel.append(side);
      if (narrow) panel.prepend(hotspots);
      hintBtn.hidden = !props.hints;
      resetBtn.hidden = false;
    } else if (mode === 'explain') {
      panel.append(tools);
      hintBtn.hidden = true; resetBtn.hidden = true;
      if (narrow) panel.prepend(bubble); else stage.insertBefore(bubble, pauseBtn);
      bub.placed = false; bub.measuredFor = '';
      refreshCaption();
    }
    // Display: the scene alone; what happens is still announced to screen readers.
    seg.hidden = !props.allowViewChange;
    panel.append(status);
    if (mode !== 'explore') closeHint();
    refreshControls();
    refreshPause();
    refreshSound();
  }

  // ── Actions (learners and screen events share them, under the same rules) ──
  function learnerGesture() { if (!testMode && props.sound !== false) audio.unlock(); }
  function toggle(k) {
    const side = k.startsWith('lower') ? 'lower' : 'upper';
    if (k.endsWith('Gates')) act((sim.gates[side].target === 'open' ? 'close-' : 'open-') + side + '-gates');
    else act((sim.paddles[side].target === 'open' ? 'close-' : 'open-') + side + '-paddles');
  }
  function act(action, source = 'learner') {
    if (props.mode === 'explain' && source === 'learner') return;
    const lvl = props.informationLevel;
    const fdir = forwardDir(sim);
    let r = null;
    const m = /^(open|close)-(lower|upper)-(gates|paddles)$/.exec(action);
    if (m) {
      const [, verb, side, what] = m;
      if (what === 'gates') r = verb === 'open' ? openGates(sim, side, { wait: source === 'event' }) : closeGates(sim, side);
      else r = setPaddles(sim, side, verb === 'open');
      const hk = side + (what === 'gates' ? 'Gates' : 'Paddles');
      const h = hot[hk];
      if (r.ok && r.reason !== 'already') {
        if (what === 'gates' && (r.reason === 'opening' || r.reason === 'closing')) audio.gate(2.4);
        if (what === 'paddles') audio.paddle(verb === 'open');
      }
      if (!r.ok) { audio.strain(); flash(h); }
      if (what === 'gates') {
        if (r.reason === 'opening') say(t('gateOpening', { gate: side }));
        else if (r.reason === 'closing') say(t('gateClosing', { gate: side }));
        else if (r.reason === 'levels') say(t('refuseLevels', { level: lvl, d: fmt(r.diff) }), 'warn');
        else if (r.reason === 'boat-passing') say(t('refuseBoatPassing'), 'warn');
        else if (r.reason === 'waiting-level') say(t('waitingLevel'));
      } else if (r.reason !== 'already') {
        const key = { fill: 'fill', drain: 'drain', leak: 'leak', 'leak-down': 'leakDown', through: 'through', 'no-flow': 'noFlow' }[r.reason];
        if (key) say(t(key, { level: lvl }), ['leak', 'leak-down', 'through', 'no-flow'].includes(r.reason) ? 'warn' : 'info');
        else if (r.reason === 'closed') say(t('paddlesClosed', { side }));
      }
      if (!r.ok || ['leak', 'leak-down'].includes(r.reason)) mistakes++;
    } else if (action === 'boat-forward' || action === 'boat-back') {
      const dir = action === 'boat-forward' ? fdir : (fdir === 'up' ? 'down' : 'up');
      r = moveBoat(sim, dir);
      if (r.reason === 'sailing') { say(t('boatSails', { to: r.to })); audio.boat(); }
      else if (r.reason === 'waiting-gate') say(t('waitingGate'));
      else if (r.reason === 'gate-closed') { say(t('refuseGateClosed', { gate: r.gate }), 'warn'); flash(hot.boat); audio.strain(); mistakes++; }
      else if (r.reason === 'end') say(t('refuseEnd'), 'warn');
      else if (r.reason === 'moving') say(t('refuseMoving'));
    } else if (action === 'reset') {
      resetSim(sim, props.scenario);
      hintLevel = 0; hintKey = null; setSuggested(null); closeHint();
      completedSent = false;
      leafP.forEach((p) => { p.life = 0; });
      say(t('resetDone'));
      r = { ok: true, reason: 'reset' };
    } else if (action === 'replay' || action === 'next-step' || action === 'previous-step') {
      if (props.mode === 'explain') {
        const i = action === 'replay' ? Math.max(0, ex.index) : action === 'next-step' ? Math.min(phases().length - 1, ex.index + 1) : Math.max(0, ex.index - 1);
        startPhase(i, { follow: action === 'next-step' });
      }
      return;
    }
    if (!r) return;
    host.emit('manoeuvre', { action, accepted: !!r.ok, reason: r.reason || '' });
    refreshControls();
    checkHint();
  }
  function flash(h) {
    if (!h) return;
    h.el.classList.remove('is-refused'); void h.el.offsetWidth; h.el.classList.add('is-refused');
    h.refusedUntil = clock + 0.6;
  }
  function say(text, kind = 'info') {
    message = text; messageKind = kind;
    status.textContent = text;
  }
  function emitState() { /* the view and the sound live in the state; saved with the next declared event */ }

  // Reactions to what the water and the boat do by themselves.
  function onSimEvents(events) {
    for (const e of events) {
      if (e.type === 'level-equal') {
        host.emit('level_equal', { side: e.side });
        const p = sim.paddles[e.side];
        if (p.target === 'open' && props.mode !== 'explain') say(t(e.side === 'upper' ? 'levelUpper' : 'levelLower'), 'ok');
      } else if (e.type === 'settled' && props.mode !== 'explain') say(t('settled'), 'warn');
      else if (e.type === 'gates-auto' && e.ok) { say(t('gateOpening', { gate: e.side })); audio.gate(2.4); }
      else if (e.type === 'boat-arrived') {
        host.emit('boat_arrived', { where: e.where });
        if (props.mode !== 'explain') {
          if (e.where === 'chamber') say(t('boatInChamber'));
          else if (e.where !== goalPlace(sim)) say(t('boatBackOut'));
        }
      } else if (e.type === 'done') {
        if (props.mode !== 'explain') {
          say(t(sim.scenario === 'downhill' ? 'successDownhill' : 'successUphill', { rise: fmt1(sim.rise) }), 'ok');
          celebrate();
          if (!completedSent) { completedSent = true; host.emit('completed', { hints, mistakes }); }
        }
      }
    }
    if (events.length) { refreshControls(); checkHint(); }
  }

  // ── Hints: a principle, then what to do, then the control itself ──
  function openHint() {
    if (hintBox.hidden) { hintBox.hidden = false; hintBtn.setAttribute('aria-expanded', 'true'); }
  }
  function closeHint() {
    hintBox.hidden = true; hintBtn.setAttribute('aria-expanded', 'false');
    setSuggested(null);
  }
  function showHint() {
    const na = nextAction(sim);
    openHint();
    if (!na) { hintHead.textContent = ''; hintText.textContent = t('hintDone'); return; }
    if (na.key !== hintKey) { hintKey = na.key; hintLevel = 0; }
    hintLevel = Math.min(3, hintLevel + 1);
    hints++;
    hintHead.textContent = t('hintLabel', { i: hintLevel });
    if (hintLevel === 1) hintText.textContent = t(na.nudge);
    else if (hintLevel === 2) hintText.textContent = t(na.key);
    else {
      if (na.control) { hintText.textContent = t('showControl', { control: controlName(na.control) }); setSuggested(na.control); }
      else hintText.textContent = t('showWait');
    }
    host.emit('hint_shown', { level: hintLevel });
  }
  function checkHint() {
    // Progress made: the hint about the previous step goes away.
    if (hintBox.hidden || !hintKey) return;
    const na = nextAction(sim);
    if (!na || na.key !== hintKey) { closeHint(); hintKey = null; hintLevel = 0; }
  }
  function setSuggested(k) {
    if (suggested && hot[suggested]) hot[suggested].el.classList.remove('is-suggested');
    suggested = k;
    if (k && hot[k]) hot[k].el.classList.add('is-suggested');
  }
  function controlName(k) {
    const lvl = props.informationLevel;
    return k === 'boat' ? t('ctlBoat') : t({ lowerGates: 'ctlLowerGates', upperGates: 'ctlUpperGates', lowerPaddles: 'ctlLowerPaddles', upperPaddles: 'ctlUpperPaddles' }[k], { level: lvl });
  }

  // ── Explain mode: each step plays a moment of the journey from its own starting point ──
  // Going on from a step that has played to its end continues from where the lock is (the steps
  // follow each other); going back, replaying or skipping ahead starts the step from its own state.
  function startPhase(i, { follow = false } = {}) {
    const list = phases();
    if (!list.length) return;
    i = Math.max(0, Math.min(list.length - 1, i));
    const name = list[i].phase;
    const up = sim.scenario !== 'downhill';
    const R = sim.rise;
    const entry = up ? 'lower' : 'upper', exit = up ? 'upper' : 'lower';
    const startH = up ? 0 : R, endH = up ? R : 0;
    const dir = up ? 'up' : 'down';
    const continuing = follow && ex.index === i - 1 && ex.done;
    const hereH = sim.h;
    resetSim(sim, sim.scenario);
    const set = (h, at, gates = {}) => {
      sim.h = h; sim.boat.at = at;
      for (const s of ['lower', 'upper']) { const g = sim.gates[s]; g.target = gates[s] ? 'open' : 'closed'; g.t = gates[s] ? 1 : 0; g.strain = 0; }
      for (const s of ['lower', 'upper']) { sim.paddles[s].target = 'closed'; sim.paddles[s].t = 0; }
      sim.equal.lower = levelsEqual(sim, 'lower'); sim.equal.upper = levelsEqual(sim, 'upper');
    };
    // anchor: what the bubble points at; at: where along the canal the bubble stands (fixed for the
    // step, so its buttons do not move while the boat does).
    let steps = [], end = () => true, anchor = 'boat', at = d.boatX.chamber;
    const gateX = (side) => (side === 'lower' ? d.xL : d.xU);
    if (name === 'enter') {
      set(startH, entry, { [entry]: true });
      steps = [{ at: 0.6, do: () => moveBoat(sim, dir) }];
      end = () => sim.boat.at === 'chamber' && !sim.boat.move;
    } else if (name === 'close') {
      set(startH, 'chamber', { [entry]: true });
      steps = [{ at: 0.6, do: () => { closeGates(sim, entry); audio.gate(2.4); } }];
      end = () => sim.gates[entry].t <= 0;
      anchor = entry + 'Gates'; at = gateX(entry);
    } else if (name === 'flow') {
      set(startH, 'chamber');
      steps = [
        { at: 0.6, do: () => { setPaddles(sim, exit, true); audio.paddle(true); } },
        { when: () => Math.abs(sim.h - startH) >= R * 0.3, do: () => { setPaddles(sim, exit, false); audio.paddle(false); } }
      ];
      end = () => sim.paddles[exit].t <= 0 && Math.abs(sim.h - startH) > R * 0.2;
      anchor = 'flow'; at = anchorOf('flow')[0];
    } else if (name === 'level') {
      const from = startH + (endH - startH) * 0.3;
      const between = (h) => (h - startH) * (endH - startH) >= 0 && Math.abs(h - startH) < Math.abs(endH - startH);
      set(continuing && between(hereH) ? hereH : from, 'chamber');
      steps = [
        { at: 0.4, do: () => { setPaddles(sim, exit, true); audio.paddle(true); } },
        { when: () => levelsEqual(sim, exit), do: () => { setPaddles(sim, exit, false); audio.paddle(false); } }
      ];
      end = () => levelsEqual(sim, exit) && sim.paddles[exit].t <= 0;
    } else if (name === 'open') {
      set(endH, 'chamber');
      steps = [{ at: 1.0, do: () => { openGates(sim, exit); audio.gate(2.4); } }];
      end = () => gateOpen(sim, exit);
      anchor = exit + 'Gates'; at = gateX(exit);
    } else if (name === 'exit') {
      set(endH, 'chamber', { [exit]: true });
      steps = [{ at: 0.6, do: () => moveBoat(sim, dir) }];
      end = () => sim.boat.at === exit && !sim.boat.move;
      at = d.boatX[exit];
    }
    const turned = ex.index !== i;
    Object.assign(ex, { index: i, t: 0, steps: steps.map((s) => ({ ...s, ran: false })), end, done: false, hold: 0, anchor, at, startH });
    refreshCaption(turned);
    refreshControls();
  }
  function tickExplain(dt) {
    if (ex.index < 0 || ex.done) return;
    ex.t += dt;
    for (const s of ex.steps) {
      if (s.ran) continue;
      if ((s.at !== undefined && ex.t >= s.at) || (s.when && s.when())) { s.ran = true; s.do(); }
      if (!s.ran) break;
    }
    if (ex.steps.every((s) => s.ran) && ex.end()) {
      ex.hold += dt;
      if (ex.hold > 0.6) {
        ex.done = true;
        const bit = 1 << ex.index;
        if (!(ex.seen & bit)) {
          ex.seen |= bit;
          host.emit('step_viewed', { index: ex.index + 1, phase: phases()[ex.index].phase });
        }
        // The explanation is complete once its last step has played to its end.
        if (ex.index === phases().length - 1 && !completedSent) { completedSent = true; host.emit('completed', { hints: 0, mistakes: 0 }); }
        refreshCaption();
      }
    }
  }
  function refreshCaption(turned = false) {
    const list = phases();
    const i = Math.max(0, ex.index);
    const p = list[i] || list[0];
    if (capTitle.textContent !== (p.title || '') || capText.textContent !== (p.caption || '')) {
      capTitle.textContent = p.title || '';
      capText.textContent = p.caption || '';
      turned = true;
    }
    if (turned && !reduced) { bubbleBody.classList.remove('is-new'); void bubbleBody.offsetWidth; bubbleBody.classList.add('is-new'); }
    bubble.setAttribute('aria-label', p.title || '');
    bub.dirty = true;
    const first = ex.index <= 0, last = ex.index >= list.length - 1;
    prevBtn.setAttribute('aria-disabled', String(first));
    nextBtn.setAttribute('aria-disabled', String(last));
    nextBtn.classList.toggle('is-ready', ex.done && !last);
    prevBtn.hidden = nextBtn.hidden = list.length < 2;
  }

  // ── Controls: names, states and availability ──
  function refreshControls() {
    const lvl = props.informationLevel;
    for (const k of CONTROLS) {
      const side = k.startsWith('lower') ? 'lower' : 'upper';
      const isGate = k.endsWith('Gates');
      const o = isGate ? sim.gates[side] : sim.paddles[side];
      const moving = o.t > 0 && o.t < 1;
      const open = o.target === 'open';
      const state = moving ? t(open ? 'stOpening' : 'stClosing') : t(open ? 'stOpen' : 'stClosed');
      const name = controlName(k);
      const h = hot[k];
      if (h.name.textContent !== name || h.st.textContent !== state) { h.name.textContent = name; h.st.textContent = state; h.dirty = true; }
      h.el.classList.toggle('is-open', open);
      h.el.classList.toggle('is-moving', moving);
      h.el.setAttribute('aria-label', t(open ? 'ariaToggleClose' : 'ariaToggleOpen', { name, state }));
    }
    // Only a move the boat can make now is in the accent colour; one with nowhere to go (or while
    // the boat moves) is disabled; one blocked by shut gates stays neutral and can be tried.
    const fwd = forwardDir(sim);
    for (const [b, dir] of [[aheadBtn, fwd], [backBtn, fwd === 'up' ? 'down' : 'up']]) {
      const m = boatMove(dir);
      b.classList.toggle('is-main', m === 'possible');
      b.setAttribute('aria-disabled', String(m === 'none'));
    }
    void lvl;
    soundBtn.setAttribute('aria-pressed', String(!muted));
  }
  function boatMove(dir) {
    if (sim.boat.move) return 'none';
    const side = needsGate(sim, dir);
    if (!side) return 'none';
    const g = sim.gates[side];
    return g.t >= 1 || g.target === 'open' || sim.pendingGate[side] ? 'possible' : 'blocked';
  }
  function refreshSound() {
    soundBtn.innerHTML = muted ? ICON.muted : ICON.sound;
    soundBtn.append(el('span', '', t('toolSound')));
    soundBtn.setAttribute('aria-pressed', String(!muted));
    soundBtn.hidden = !props.sound;
  }
  function setMuted(m) { muted = m; audio.setMuted(m); refreshSound(); }
  function refreshPause() {
    pauseBtn.innerHTML = paused ? ICON.play : ICON.pause;
    pauseBtn.setAttribute('aria-label', t(paused ? 'playAria' : 'pauseAria'));
    pauseBtn.setAttribute('aria-pressed', String(paused));
  }

  // ── Annotations: labels on the canals, flows, target level, level difference ──
  const svgEl = (tag, cls) => { const e = document.createElementNS(svgNS, tag); if (cls) e.setAttribute('class', cls); return e; };
  const gLeads = svgEl('g'), gFlow = svgEl('g'), gTarget = svgEl('g'), gDim = svgEl('g');
  anno.append(gTarget, gFlow, gDim, gLeads);
  const flowPaths = { upper: makeFlow(), lower: makeFlow() };
  function makeFlow() { const p = svgEl('path', 'flow'); const head = svgEl('path', 'flow-head'); gFlow.append(p, head); return { p, head, offset: 0 }; }
  const targetLine = svgEl('path', 'target'); gTarget.append(targetLine);
  const dimLine = svgEl('path', 'dim'); gDim.append(dimLine);
  const leadPool = [];
  function lead(i) { while (leadPool.length <= i) { const l = svgEl('path', 'lead'); const c = svgEl('circle', 'dot'); c.setAttribute('r', '3.5'); gLeads.append(l, c); leadPool.push({ l, c }); } return leadPool[i]; }
  const zoneLabels = { lower: el('div', 'cl-label'), chamber: el('div', 'cl-label'), upper: el('div', 'cl-label') };
  const flowLabels = { upper: el('div', 'cl-label'), lower: el('div', 'cl-label') };
  const dimLabel = el('div', 'cl-label is-dim');
  labels.append(...Object.values(zoneLabels), ...Object.values(flowLabels), dimLabel);

  const proj = new THREE.Vector3();
  function toScreen(x, y, z) { proj.set(x, y, z).project(camera); return [(proj.x + 1) / 2 * W, (1 - proj.y) / 2 * H]; }
  function placeLabel(node, x, y, on, dx = 0, dy = 0) {
    node.classList.toggle('is-on', on);
    if (on) node.style.translate = `${Math.round(x + dx)}px ${Math.round(y + dy)}px`;
  }
  // The outline of the diorama on screen (its block, projected), for the rails of the controls.
  const hullPts = [];
  function updateHull() {
    hullPts.length = 0;
    const zs = view === 'section' ? [-d.zFar, SECTION_Z] : [-d.zFar, d.zNear];
    const pts = [];
    for (const x of [d.X0, d.X1]) for (const y of [d.baseY, d.gHigh + 1.3]) for (const z of zs) pts.push(toScreen(x, y, z));
    // Convex hull (monotone chain).
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    hullPts.push(...lower.slice(0, -1), ...upper.slice(0, -1));
  }
  // The top and the bottom of the diorama on screen at a given x (px).
  function hullAt(px) {
    let x0 = Infinity, x1 = -Infinity;
    for (const p of hullPts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); }
    const x = Math.max(x0 + 0.5, Math.min(x1 - 0.5, px));
    let top = Infinity, bottom = -Infinity;
    for (let i = 0; i < hullPts.length; i++) {
      const a = hullPts[i], b = hullPts[(i + 1) % hullPts.length];
      if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
      const y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return Number.isFinite(top) ? { top, bottom } : { top: H * 0.3, bottom: H * 0.7 };
  }
  // Text and size of a label, measured again only when its text changes.
  function setText(node, text) { if (node.textContent !== text) { node.textContent = text; node._w = 0; } }
  function widthOf(node) { if (!node._w) { node._w = node.offsetWidth; node._h = node.offsetHeight; } return node._w; }
  function heightOf(node) { widthOf(node); return node._h; }

  function anchorOf(name) {
    // World points the hotspots and notes hang from.
    if (name === 'boat') { const p = boatGroup.position; return [p.x, p.y + 2.5, p.z]; }
    const sec = view === 'section';
    const m = /^(lower|upper)(Gates|Paddles)$/.exec(name);
    if (m) {
      const side = m[1];
      if (m[2] === 'Gates') {
        const s = sec ? -1 : 1;
        const leaf = leaves.find((l) => l.side === side && l.s === s);
        tmpV.set(0.35, leaf.top + 0.55, 0); leaf.group.localToWorld(tmpV);
        return [tmpV.x, tmpV.y, tmpV.z];
      }
      const leaf = leaves.find((l) => l.side === side && l.s === -1);
      tmpV.set(leaf.paddleX, leaf.top + 1.05, 0); leaf.group.localToWorld(tmpV);
      return [tmpV.x, tmpV.y, tmpV.z];
    }
    if (name === 'flow') {
      const up = sim.scenario !== 'downhill';
      return up ? [d.xU - 1.6, Math.max(sim.h, d.bedLow) + 0.6, -0.8] : [d.xL - 2.4, 0.5, -0.8];
    }
    return [0, 0, 0];
  }
  function updateOverlay(dt = 0) {
    if (!terrain) return;
    const mode = props.mode;
    const lvl = props.informationLevel;
    const sec = view === 'section', top = view === 'topDown';
    const showA = !!props.showAnnotations;
    let leadIndex = 0;
    const hotRects = [];
    const topLimit = Math.min(safe.top, H * 0.45) + 8;
    const minX = Math.min(safe.left, W * 0.5) + 8, maxX = W - Math.min(safe.right, W * 0.4) - 8;
    const drawLead = (ax, ay, cx, cy, open = false) => {
      const L = lead(leadIndex++);
      L.l.setAttribute('d', `M${ax.toFixed(1)},${ay.toFixed(1)}L${cx.toFixed(1)},${cy.toFixed(1)}`);
      L.c.setAttribute('cx', ax.toFixed(1)); L.c.setAttribute('cy', ay.toFixed(1));
      L.c.setAttribute('class', 'dot' + (open ? ' is-open' : ''));
      L.l.style.display = L.c.style.display = '';
    };
    // Top of the diorama under a span of the screen (for things placed above it), bottom (below it).
    const topOver = (x, w) => Math.min(hullAt(x).top, hullAt(x + w / 2).top, hullAt(x + w).top);
    const bottomUnder = (x, w) => Math.max(hullAt(x).bottom, hullAt(x + w / 2).bottom, hullAt(x + w).bottom);

    // Controls (explore, wide): on a rail above or below the diorama, side by side, each tied to
    // its part by a leader line. The middle of the scene stays clear.
    if (mode === 'explore' && !narrow) {
      updateHull();
      const rails = RAILS[view] || RAILS.isometric;
      const rects = [];
      for (const k of [...CONTROLS, 'boat']) {
        const h = hot[k];
        const [wx, wy, wz] = anchorOf(k);
        const [ax, ay] = toScreen(wx, wy, wz);
        if (!h.w || h.dirty) { h.w = h.el.offsetWidth; h.h = h.el.offsetHeight; h.dirty = false; }
        const [rail, row] = rails[k];
        rects.push({ k, rail, row, x: ax - h.w / 2, y: 0, w: h.w, h: h.h, ax, ay });
      }
      const groups = {};
      for (const r of rects) (groups[r.rail + r.row] ||= []).push(r);
      for (const g of Object.values(groups)) {
        g.sort((a, b) => a.ax - b.ax);
        for (let i = 1; i < g.length; i++) g[i].x = Math.max(g[i].x, g[i - 1].x + g[i - 1].w + 10);
        const last = g[g.length - 1];
        if (last.x + last.w > maxX) last.x = maxX - last.w;
        for (let i = g.length - 2; i >= 0; i--) g[i].x = Math.min(g[i].x, g[i + 1].x - g[i].w - 10);
        if (g[0].x < minX) g[0].x = minX;
        for (let i = 1; i < g.length; i++) g[i].x = Math.max(g[i].x, g[i - 1].x + g[i - 1].w + 10);
      }
      const maxY = H - panelReserve() - 4;
      for (const r of rects) {
        const step = (r.h + 10) * r.row;
        r.y = r.rail === 'top' ? topOver(r.x, r.w) - 22 - r.h - step : bottomUnder(r.x, r.w) + 22 + step;
        r.y = Math.max(topLimit, Math.min(maxY - r.h, r.y));
        hotRects.push(r);
        const h = hot[r.k];
        if (Math.abs(h.x - r.x) > 0.5 || Math.abs(h.y - r.y) > 0.5) { h.x = r.x; h.y = r.y; h.el.style.translate = `${Math.round(r.x)}px ${Math.round(r.y)}px`; }
        const cx = Math.max(r.x + 18, Math.min(r.x + r.w - 18, r.ax));
        const cy = r.ay < r.y ? r.y : r.y + r.h;
        const isOpen = r.k === 'boat' ? false : (r.k.endsWith('Gates') ? sim.gates[r.k.startsWith('lower') ? 'lower' : 'upper'] : sim.paddles[r.k.startsWith('lower') ? 'lower' : 'upper']).target === 'open';
        drawLead(r.ax, r.ay, cx, cy, isOpen);
      }
      // The boat's arrows point where it would go on screen.
      const bx = boatGroup.position.x, by = boatGroup.position.y;
      const fwd = forwardDir(sim) === 'up' ? 1 : -1;
      const [p0x, p0y] = toScreen(bx, by, 0), [p1x, p1y] = toScreen(bx + fwd, by, 0);
      const ang = Math.round(Math.atan2(p1y - p0y, p1x - p0x) * 180 / Math.PI);
      if (hot.boat.dir !== ang) { hot.boat.dir = ang; boatBox.style.setProperty('--cl-dir', ang + 'deg'); }
    }

    // The bubble of the explanation (wide): above the diorama where the step happens, pointing at
    // what moves. It glides to its place from one step to the next.
    if (mode === 'explain' && !narrow && bubble.isConnected) {
      updateHull();
      if (bub.dirty || !bub.w) { bub.w = bubble.offsetWidth; bub.h = bubble.offsetHeight; bub.dirty = false; }
      const [wx, wy, wz] = anchorOf(ex.anchor || 'boat');
      const [ax, ay] = toScreen(wx, wy, wz);
      const [sx] = toScreen(ex.at ?? wx, d.gHigh, 0);
      const tx = Math.max(minX, Math.min(W - bub.w - 8, sx - bub.w / 2));
      const ty = Math.max(topLimit, topOver(tx, bub.w) - 30 - bub.h);
      if (!bub.placed || reduced) { bub.x = tx; bub.y = ty; bub.placed = true; }
      else { const k = 1 - Math.exp(-dt * 7); bub.x += (tx - bub.x) * k; bub.y += (ty - bub.y) * k; }
      bubble.style.translate = `${Math.round(bub.x)}px ${Math.round(bub.y)}px`;
      hotRects.push({ x: bub.x, y: bub.y, w: bub.w, h: bub.h });
      const cx = Math.max(bub.x + 24, Math.min(bub.x + bub.w - 24, ax));
      if (ex.index >= 0) drawLead(ax, ay, cx, bub.y + bub.h);
    }
    for (let i = leadIndex; i < leadPool.length; i++) { leadPool[i].l.style.display = 'none'; leadPool[i].c.style.display = 'none'; }

    // Zone labels, kept clear of the controls (nudged, or hidden when they cannot be).
    const zonesOn = showA && lvl !== 'minimal';
    // The chamber's name stays at the end away from the level difference drawn at the other.
    const zx = { lower: d.X0 + 2.4, chamber: sim.scenario === 'downhill' ? d.xU - 2.8 : d.xL + 2.8, upper: d.X1 - 3.0 };
    for (const k of ['lower', 'chamber', 'upper']) {
      const node = zoneLabels[k];
      const lvlK = levelOf(k);
      const name = t(k === 'lower' ? 'zoneLower' : k === 'chamber' ? 'zoneChamber' : 'zoneUpper');
      const text = lvl === 'technical' ? t('zoneLevel', { zone: name, value: (lvlK >= 0 ? '+' : '') + fmt(lvlK) }) : name;
      setText(node, text);
      node.classList.toggle('is-tech', lvl === 'technical');
      // In 3D the names sit on the far bank, above their water, like the names on a map.
      const iso = !sec && !top;
      const zz = sec ? 0 : top ? d.hw - 0.7 : -(d.hw + 1.1);
      const yy = iso ? (k === 'lower' ? d.gLow : d.gHigh) + 0.05 : lvlK + 0.05;
      const [x, y] = toScreen(zx[k], yy, zz);
      const w = widthOf(node), hgt = heightOf(node);
      let lx = x - w / 2, ly = y + (sec ? 8 : 4), free = true;
      if (zonesOn && hotRects.length && !narrow) {
        free = false;
        for (const dy of [0, 26, -30, 52]) {
          const r = { x: lx, y: ly + dy, w, h: hgt };
          if (!hotRects.some((q) => r.x < q.x + q.w + 4 && r.x + r.w + 4 > q.x && r.y < q.y + q.h + 2 && r.y + r.h + 2 > q.y)) { ly += dy; free = true; break; }
        }
      }
      placeLabel(node, lx, ly, zonesOn && free);
    }

    // Flows of water through the paddles (and through open gates).
    const flowOn = showA && lvl !== 'minimal';
    for (const side of ['upper', 'lower']) {
      const f = flowPaths[side];
      const q = side === 'upper' ? sim.qIn : sim.qOut;
      const strength = Math.min(1, Math.abs(q) / 0.6);
      const on = flowOn && strength > 0.04;
      f.p.style.display = f.head.style.display = on ? '' : 'none';
      const lab = flowLabels[side];
      if (!on) { lab.classList.remove('is-on'); continue; }
      const R = sim.rise, h = sim.h;
      let pts;
      if (side === 'upper') {
        const from = q >= 0;
        pts = [[d.xU + 3.2, R - 0.35, -0.9], [d.xU + 0.4, R - 1.1, -0.9], [d.xU - 0.9, Math.max(h, d.bedLow + 0.4) - 0.35, -0.9], [d.xU - 3.4, Math.max(h, d.bedLow + 0.4) - 0.45, -0.9]];
        if (!from) pts.reverse();
      } else {
        const out = q >= 0;
        pts = [[d.xL + 3.0, Math.max(h, d.bedLow + 0.4) - 0.45, -0.9], [d.xL + 0.6, d.bedLow + 0.75, -0.9], [d.xL - 1.0, -0.6, -0.9], [d.xL - 3.6, -0.4, -0.9]];
        if (!out) pts.reverse();
      }
      const sp = pts.map(([x, y, z]) => toScreen(x, y, z));
      let dStr = `M${sp[0][0].toFixed(1)},${sp[0][1].toFixed(1)}`;
      for (let i = 1; i < sp.length; i++) dStr += `L${sp[i][0].toFixed(1)},${sp[i][1].toFixed(1)}`;
      f.p.setAttribute('d', dStr);
      f.offset = (f.offset - (paused || reduced ? 0 : 0.6 + strength * 1.2)) % 1100;
      f.p.style.strokeDashoffset = String(f.offset);
      f.p.style.opacity = String(0.35 + 0.65 * strength);
      const [x1, y1] = sp[sp.length - 2], [x2, y2] = sp[sp.length - 1];
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const hx = x2, hy = y2, s = 7;
      f.head.setAttribute('d', `M${(hx + Math.cos(ang) * s).toFixed(1)},${(hy + Math.sin(ang) * s).toFixed(1)}L${(hx + Math.cos(ang + 2.5) * s).toFixed(1)},${(hy + Math.sin(ang + 2.5) * s).toFixed(1)}L${(hx + Math.cos(ang - 2.5) * s).toFixed(1)},${(hy + Math.sin(ang - 2.5) * s).toFixed(1)}Z`);
      f.head.style.opacity = f.p.style.opacity;
      const flowsIn = side === 'upper' ? q >= 0 : q < 0;
      setText(lab, t(flowsIn ? 'flowIn' : 'flowOut', { level: lvl }));
      lab.classList.toggle('is-tech', lvl === 'technical');
      // Words on the flow, the target level and the level difference are for the technical level;
      // guided and minimal keep the arrows alone.
      const mid = sp[1];
      const fr = { x: mid[0] - widthOf(lab) / 2, y: mid[1] - (top ? 34 : 30), w: widthOf(lab), h: heightOf(lab) };
      const clash = hotRects.some((q) => fr.x < q.x + q.w && fr.x + fr.w > q.x && fr.y < q.y + q.h && fr.y + fr.h > q.y);
      placeLabel(lab, fr.x, fr.y, lvl === 'technical' && mode !== 'explain' && !clash);
    }

    // The level the chamber must reach next: the boat's reach while it waits there, the goal's once
    // it is in the chamber; nothing once it has arrived.
    const goalSide = goalPlace(sim) === 'upper' ? 'upper' : 'lower';
    let exitSide = goalSide;
    if (mode !== 'explain') {
      if (sim.done || (!sim.boat.move && sim.boat.at === goalPlace(sim))) exitSide = null;
      else if (!sim.boat.move && sim.boat.at !== 'chamber') exitSide = sim.boat.at;
    }
    const targetY = exitSide === 'upper' ? sim.rise : 0;
    const diff = exitSide ? Math.abs(targetY - sim.h) : 0;
    const targetOn = !!exitSide && showA && lvl === 'technical' && !top && (mode !== 'explore' || sim.boat.at === 'chamber' || diff > EPS);
    if (targetOn) {
      const zW = -d.hw + 0.02;
      const a = toScreen(d.xL + 0.5, targetY, zW), b = toScreen(d.xU - 0.5, targetY, zW);
      targetLine.setAttribute('d', `M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}`);
      gTarget.style.opacity = diff > EPS ? '1' : '0.45';
    } else gTarget.style.opacity = '0';
    const dimOn = targetOn;
    if (dimOn) {
      const xD = exitSide === 'upper' ? d.xU - 1.0 : d.xL + 1.0;
      const zD = -d.hw + 0.05;
      const a = toScreen(xD, sim.h, zD), b = toScreen(xD, targetY, zD);
      const tick = 6;
      dimLine.setAttribute('d', `M${a[0]},${a[1]}L${b[0]},${b[1]}M${a[0] - tick},${a[1]}L${a[0] + tick},${a[1]}M${b[0] - tick},${b[1]}L${b[0] + tick},${b[1]}`);
      dimLine.setAttribute('class', 'dim' + (diff <= EPS ? ' is-equal' : ''));
      gDim.style.opacity = '1';
      setText(dimLabel, diff <= EPS ? t('sameLevel') : t('diffLabel', { level: lvl, d: fmt(diff) }));
      dimLabel.classList.toggle('is-equal', diff <= EPS);
      placeLabel(dimLabel, (a[0] + b[0]) / 2 + (exitSide === 'upper' ? -widthOf(dimLabel) - 10 : 10), (a[1] + b[1]) / 2 - 8, true);
    } else { gDim.style.opacity = '0'; dimLabel.classList.remove('is-on'); }
  }

  // ── Scene update from the simulation ──
  const drift = { speed: [0.06, 0.06, 0.06], phase: [0, 0, 0] };
  function updateScene(dt) {
    if (!terrain) return;
    const amp = paused || reduced ? 0 : props.motionIntensity === 'expressive' ? 1 : 0.35;
    // Water levels.
    for (const k of ['lower', 'chamber', 'upper']) {
      const w = waters[k];
      const depth = Math.max(0.02, levelOf(k) - w.bed);
      w.mesh.position.y = w.bed; w.mesh.scale.y = depth;
      w.rim.scale.y = 1 / depth; w.rim.position.y = 1;
    }
    // Gates: swing, with a shiver when they are pushed against the water.
    const sec = view === 'section';
    const m = d.miter;
    for (const l of leaves) {
      const g = sim.gates[l.side];
      const gt = passage ? mix(passage.from.gates[l.side], g.t) : g.t;
      shown.gates[l.side] = gt;
      const e = gt * gt * (3 - 2 * gt);
      const closed = Math.PI / 2 - m;
      let yaw = closed * (1 - e);
      if (g.strain > 0) yaw += Math.sin(clock * 46) * 0.018 * g.strain * (reduced ? 0 : 1);
      l.group.rotation.y = l.s * yaw;
      const p = passage ? mix(passage.from.paddles[l.side], sim.paddles[l.side].t) : sim.paddles[l.side].t;
      shown.paddles[l.side] = p;
      l.board.position.y = 0.62 * p;
      l.rack.position.y = 0.6 * p;
      l.group.visible = !(sec && l.s === 1 && cam.cut < d.hw);
    }
    // Boat: along the canal, floating on the water under it.
    const b = sim.boat;
    let x, place = b.move ? b.move.from : b.at;
    if (b.move) {
      const e = b.move.t * b.move.t * (3 - 2 * b.move.t);
      x = d.boatX[b.move.from] + (d.boatX[b.move.to] - d.boatX[b.move.from]) * e;
    } else x = d.boatX[b.at];
    // During a passage the boat stays put and rides the water, or, if the arriving block has it
    // elsewhere or heading the other way, fades out where the departing screen left it and fades in
    // at its new place: it never sails through the gates, the walls or the bank, nor turns round in
    // the chamber. Whether it goes is decided at the passage's first frame.
    const yawGoal = sim.scenario === 'downhill' ? Math.PI : 0;
    let yaw = yawGoal, fade = 1;
    if (passage) {
      const from = passage.from;
      if (passage.boatAway === undefined) passage.boatAway = Math.abs(from.boatX - x) > 0.05 || Math.abs(from.yaw - yawGoal) > 0.01;
      if (!passage.boatAway) { x = mix(from.boatX, x); fade = mix(from.fade, 1); }
      else if (passage.t < 0.5) { x = from.boatX; place = from.place; yaw = from.yaw; fade = from.fade * (1 - smooth(passage.t / BOAT_OUT)); }
      else fade = smooth((passage.t - BOAT_IN) / (1 - BOAT_IN));
    }
    const y = levelOf(place);
    if (fade !== shown.fade) fadeBoat(fade);
    Object.assign(shown, { h: levelOf('chamber'), boatX: x, yaw, place, fade });
    const turb = Math.min(1, (Math.abs(sim.qIn) + Math.abs(sim.qOut)) * 0.8) * (b.at === 'chamber' ? 1 : 0.3);
    const bob = amp * (0.05 * Math.sin(clock * 1.7) + 0.02 * Math.sin(clock * 2.9 + 1)) * (1 + turb * 1.5);
    boatGroup.position.set(x, y + bob + celebrateBob(), 0);
    boatGroup.rotation.set(amp * (0.012 + turb * 0.02) * Math.sin(clock * 1.3), yaw, amp * (0.02 + turb * 0.03) * Math.sin(clock * 1.1 + 0.5));
    // Flag in the wind.
    const pa = flagGeo.attributes.position, rest = flagGeo.userData.rest;
    for (let i = 0; i < pa.count; i++) {
      const fx = rest[i * 3];
      pa.array[i * 3 + 2] = Math.sin(clock * 5 - fx * 9) * 0.06 * fx * (0.3 + amp);
    }
    pa.needsUpdate = true;

    // Jets, foam, currents.
    const wu = matWater.userData.uniforms;
    wu.uTime.value = clock;
    const foams = wu.uFoam.value;
    foams.forEach((f) => f.set(0, 0, 0, 1));
    let fi = 0, splash = 0;
    for (const j of jets) {
      const l = j.leaf;
      const p = sim.paddles[l.side].t;
      let head = 0, from = 0, to = 0;
      if (l.side === 'upper') { head = sim.rise - sim.h; } else { head = sim.h; }
      j.strength = p * Math.min(1, Math.max(0, head) / 0.8);
      tmpV.set(l.paddleX, l.openingY + 0.27, 0); l.group.localToWorld(tmpV);
      const sx = tmpV.x - 0.22, sy = tmpV.y, sz = tmpV.z;
      const surface = l.side === 'upper' ? sim.h : 0;
      const free = l.side === 'upper' && sy > surface + 0.1 && j.strength > 0.02;
      const visible = free && !(sec && l.s === 1);
      j.mesh.visible = visible;
      void from; void to;
      if (free) {
        const vx = 1.25 * Math.sqrt(Math.max(0.05, head));
        const g = 9.8 * 0.55;
        const drop = sy - surface;
        const tEnd = Math.sqrt((2 * drop) / g);
        const pos = j.mesh.geometry.attributes.position;
        const rW = 0.42 * (0.4 + 0.6 * j.strength), rH = 0.15 * (0.4 + 0.6 * j.strength);
        for (let i = 0; i <= j.NS; i++) {
          const tt = (i / j.NS) * tEnd;
          const px = sx - vx * tt, py = sy - 0.5 * g * tt * tt, pz = sz;
          const dx = -vx, dy = -g * tt;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len;          // normal in the x-y plane
          for (let k = 0; k < j.NR; k++) {
            const a = (k / j.NR) * Math.PI * 2;
            const o = (i * j.NR + k) * 3;
            const spread = 1 + (i / j.NS) * 0.6;
            pos.array[o] = px + nx * Math.cos(a) * rH * spread;
            pos.array[o + 1] = py + ny * Math.cos(a) * rH * spread;
            pos.array[o + 2] = pz + Math.sin(a) * rW * spread;
          }
        }
        pos.needsUpdate = true;
        j.mesh.material.uniforms.uTime.value = clock;
        j.mesh.material.uniforms.uAlpha.value = Math.min(1, 1.15 * j.strength);
        j.impact = [sx - vx * tEnd, surface, sz];
        splash += j.strength;
      } else j.impact = null;
      // Foam where the water enters (or leaves) under the surface.
      if (j.strength > 0.02 && fi < 4) {
        if (l.side === 'upper') {
          const fx = free ? j.impact[0] : d.xU - 0.9;
          foams[fi++].set(fx, sz * 0.8, (free ? 0.75 : 0.55) * j.strength, free ? 1.0 : 1.5);
        } else if (l.s === -1) {
          foams[fi++].set(d.xL - 1.4, 0, 0.7 * j.strength, 2.1);
        } else if (fi < 4) {
          foams[fi++].set(d.xL + 1.1, 0, 0.22 * j.strength, 1.4);
        }
      }
    }
    // Currents along the canals (+x drifts towards the upper canal).
    const lowerCurrent = -sim.qOut * 0.25;
    const chamberCurrent = (-(sim.qIn) * 0.18 - sim.qOut * 0.18);
    const upperCurrent = -sim.qIn * 0.22;
    // The streaks drift at a speed that eases towards the current's, and their offset is the sum of
    // that speed over time: when the current changes, they speed up or slow down where they are.
    const clampC = (v) => Math.max(-0.6, Math.min(0.6, v));
    const goal = [lowerCurrent, chamberCurrent, upperCurrent].map((c) => 0.06 + clampC(c * (0.4 + amp)) * 0.9);
    const ease = 1 - Math.exp(-dt * 2.5);
    const dtc = paused ? 0 : dt;
    for (let i = 0; i < 3; i++) { drift.speed[i] += (goal[i] - drift.speed[i]) * ease; drift.phase[i] += drift.speed[i] * dtc; }
    wu.uPhase.value.set(drift.phase[0], drift.phase[1], drift.phase[2]);
    const flowAmount = Math.min(1, (Math.abs(sim.qIn) + Math.abs(sim.qOut)) * 0.9);
    if (!muted) audio.setFlow(flowAmount, Math.min(1, splash));

    // Spray where jets hit the water; ripples there, behind a moving boat, at the boils.
    if (amp > 0) {
      for (const j of jets) {
        if (!j.impact || j.strength < 0.1 || !j.mesh.visible) continue;
        const n = props.motionIntensity === 'expressive' ? 3 : 1;
        for (let i = 0; i < n; i++) spawnSpray(j.impact, j.strength);
        if (host.random() < dt * 4 * j.strength) spawnRing(j.impact[0], j.impact[2], 'chamber', 0.9 + host.random() * 0.6, 1.4);
      }
      if (b.move && host.random() < dt * 3 && shown.fade === 1) {
        const sternX = boatGroup.position.x + (sim.scenario === 'downhill' ? 3.1 : -3.1) * (b.move.dir === forwardDir(sim) ? 1 : -1);
        spawnRing(sternX, (host.random() - 0.5) * 0.8, placeAt(sternX), 1.2 + host.random() * 0.8, 1.8);
      }
      if (sim.paddles.lower.t > 0.3 && sim.h > 0.05 && host.random() < dt * 2.5) spawnRing(d.xL - 1.4 + (host.random() - 0.5), (host.random() - 0.5) * 2.5, 'lower', 1.2, 1.6);
    }
    stepParticles(dt);
  }
  function placeAt(x) { return x < d.xL ? 'lower' : x > d.xU ? 'upper' : 'chamber'; }
  function spawnSpray(at, strength) {
    const p = sprayP.find((q) => q.life <= 0);
    if (!p) return;
    p.life = 0.5 + host.random() * 0.4;
    p.x = at[0] + (host.random() - 0.5) * 0.3; p.y = at[1] + 0.05; p.z = at[2] + (host.random() - 0.5) * 0.5;
    p.vx = (host.random() - 0.6) * 1.6; p.vy = 1.2 + host.random() * 1.8 * strength; p.vz = (host.random() - 0.5) * 1.4;
  }
  function spawnRing(x, z, place, size, life) {
    const r = ringP.find((q) => q.age >= q.life);
    if (!r) return;
    Object.assign(r, { age: 0, life, x, z, place, size });
  }
  function stepParticles(dt) {
    const pos = sprayGeo.attributes.position;
    let any = false;
    for (let i = 0; i < SPRAY; i++) {
      const p = sprayP[i];
      if (p.life > 0) {
        p.life -= dt; p.vy -= 9.8 * 0.6 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.life <= 0) p.y = -999;
        any = true;
      }
      pos.array[i * 3] = p.x; pos.array[i * 3 + 1] = p.life > 0 ? p.y : -999; pos.array[i * 3 + 2] = p.z;
    }
    if (any || pos.needsUpdate === false) pos.needsUpdate = true;
    const light = colours.foam, water = colours.water;
    const col = new THREE.Color();
    for (let i = 0; i < RIPPLES; i++) {
      const r = ringP[i];
      if (r.age < r.life) {
        r.age += dt;
        const k = Math.min(1, r.age / r.life);
        const s = r.size * (0.3 + k * 1.2);
        tmpQ.identity(); tmpS.set(s, 1, s);
        tmpV.set(r.x, levelOf(r.place) + 0.02, r.z);
        tmpM.compose(tmpV, tmpQ, tmpS);
        col.copy(light).lerp(water, k);
      } else { tmpM.makeScale(0, 0, 0); col.copy(water); }
      rings.setMatrixAt(i, tmpM); rings.setColorAt(i, col);
    }
    rings.instanceMatrix.needsUpdate = true; if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    for (let i = 0; i < LEAVES; i++) {
      const p = leafP[i];
      if (p.life > 0) {
        p.life -= dt;
        p.vy -= 1.6 * dt; p.vx *= 0.99; p.vz *= 0.99;
        p.x += (p.vx + Math.sin(clock * 3 + i) * 0.5) * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.r += p.vr * dt;
        const s = p.s * Math.min(1, p.life / 0.6);
        tmpE.set(p.r, p.r * 0.7, p.r * 0.4); tmpQ.setFromEuler(tmpE); tmpS.set(s, s, s); tmpV.set(p.x, p.y, p.z);
        tmpM.compose(tmpV, tmpQ, tmpS);
      } else tmpM.makeScale(0, 0, 0);
      leafMesh.setMatrixAt(i, tmpM);
    }
    leafMesh.instanceMatrix.needsUpdate = true;
  }
  let celebrateT = -1;
  function celebrateBob() {
    if (celebrateT < 0 || reduced) return 0;
    const k = celebrateT;
    return k < 1.2 ? Math.sin(k * Math.PI / 0.6) * 0.12 * (1 - k / 1.2) : 0;
  }
  function celebrate() {
    audio.success();
    if (reduced) return;
    celebrateT = 0;
    const bx = boatGroup.position.x, place = goalPlace(sim);
    for (let i = 0; i < 3; i++) spawnRing(bx, 0, place, 2.2 + i * 1.4, 1.6 + i * 0.5);
    const style = props.visualStyle;
    if (style === 'technical' || props.motionIntensity !== 'expressive') return;
    const pal = [colours.sage, colours.ochre, colours.accent, colours.grass, colours.waterLight];
    const n = style === 'playful' ? LEAVES : 30;
    for (let i = 0; i < n; i++) {
      const p = leafP[i];
      p.life = 2.2 + host.random() * 1.2;
      p.x = bx + (host.random() - 0.5) * 2; p.y = levelOf(place) + 1.6; p.z = (host.random() - 0.5) * 1.5;
      const a = host.random() * Math.PI * 2;
      p.vx = Math.cos(a) * (1 + host.random() * 2); p.vz = Math.sin(a) * (1 + host.random() * 2); p.vy = 3 + host.random() * 2.5;
      p.r = host.random() * 6; p.vr = (host.random() - 0.5) * 8; p.s = 0.8 + host.random() * 0.7;
      leafMesh.setColorAt(i, pal[i % pal.length]);
    }
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
  }

  // ── Commands from screen events ──
  function runCommand(cmd) {
    if (!cmd || cmd === 'none') return;
    if (cmd === 'replay' || cmd === 'next-step' || cmd === 'previous-step') { act(cmd, 'event'); return; }
    if (props.mode === 'explain') return;
    act(cmd, 'event');
  }

  // ── Frame loop ──
  let lastFrame = 0;
  const stop = host.onFrame((dt) => {
    // The scene is built at the first frame, so mount() answers the host at once (software WebGL).
    if (!terrain) { build(); layout(); }
    dt = Math.min(0.1, Math.max(0, dt || 0));
    if (!paused) clock += dt;
    if (celebrateT >= 0) { celebrateT += dt; if (celebrateT > 4) celebrateT = -1; }
    const events = stepSim(sim, dt);
    if (props.mode === 'explain') tickExplain(dt);
    if (events.length) onSimEvents(events);
    // Refresh moving states a few times a second.
    lastFrame += dt;
    if (lastFrame > 0.15) { lastFrame = 0; refreshControls(); }
    if (props.mode === 'explore') for (const k of [...CONTROLS, 'boat']) { const h = hot[k]; if (h.refusedUntil && clock > h.refusedUntil) { h.el.classList.remove('is-refused'); h.refusedUntil = 0; } }
    if (washDirty) paintPool();
    if (passage) {
      passage.t = Math.min(1, passage.t + dt / passage.dur);
      // The controls of the arriving block come back once the scene is mostly there.
      if (passage.t >= 0.55) container.classList.remove('is-passing');
      if (passage.t >= 1) passage = null;
    }
    applyCamera(dt, false);
    updateScene(dt);
    updateOverlay(dt);
    if (narrow) requestHeight();
    if (contextLost) return;
    renderer.autoClear = true;
    if (revealT >= 1) { renderer.render(scene, camera); return; }
    // The entrance: the scene into a texture, then composed with the wash on the canvas.
    if (!paused) revealT = Math.min(1, revealT + dt / revealDur);
    container.classList.toggle('is-revealing', revealT < 0.75);
    reveal.uniforms.uT.value = revealT;
    renderer.setRenderTarget(revealTarget());
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCam);
    if (revealT >= 1) {
      revealRT.dispose(); revealRT = null; reveal.uniforms.tScene.value = null;
      if (props.mode === 'explain' && ex.index < 0 && props.demoStep > 0) startPhase(props.demoStep - 1);
    }
  });

  // ── Start ──
  applyMode();
  setView(view);
  if (ctx.savedState) applySaved(ctx.savedState);
  if (!message) say(t(sim.scenario === 'downhill' ? 'readyDownhill' : 'readyUphill'));
  setMuted(muted);
  const ro = new ResizeObserver(layout);
  ro.observe(container);
  const offSafe = host.onSafeArea?.((area) => { safe = { ...safe, ...area }; layout(); });
  layout();
  if (container.classList.contains('is-fading')) { const off = host.onFrame(() => { container.classList.add('is-in'); off(); }); }
  if (props.mode === 'explain' && revealT >= 1 && props.demoStep > 0) startPhase(props.demoStep - 1);

  function applySaved(s) {
    restore(sim, s);
    if (typeof s.hints === 'number') hints = s.hints;
    if (typeof s.mistakes === 'number') mistakes = s.mistakes;
    if (typeof s.seen === 'number') ex.seen = s.seen;
    if (VIEW_DIRS[s.view]) setView(s.view);
    if (typeof s.muted === 'boolean') muted = s.muted;
    if (typeof s.lab === 'string' && s.lab) lab = unpackLab(s.lab);
    completedSent = props.mode === 'explain' ? !!(ex.seen & (1 << (phases().length - 1))) : !!s.done;
    if (props.mode === 'explain' && s.step > 0) { ex.index = Math.min(phases().length - 1, s.step - 1); ex.done = true; }
    refreshControls(); refreshCaption();
    if (sim.done && props.mode !== 'explain') say(t(sim.scenario === 'downhill' ? 'successDownhill' : 'successUphill', { rise: fmt1(sim.rise) }), 'ok');
  }

  // The lock as the arriving block finds it: explore mode takes the lock where the learner left it
  // (or at the start of the journey), display mode at the start of its journey when it comes from
  // another mode (its description says so), explain mode at its first step (applyMode below).
  // Whether this block's completion was sent is read again: each block completes on its own.
  function arrive(prev) {
    if (props.mode === 'explore') {
      resetSim(sim, props.scenario);
      if (lab && lab.scenario === props.scenario) restore(sim, lab);
    } else if (props.mode === 'display' && (prev.mode !== 'display' || prev.scenario !== props.scenario)) resetSim(sim, props.scenario);
    completedSent = props.mode === 'explain' ? !!(ex.seen & (1 << (phases().length - 1))) : props.mode === 'explore' && !!sim.done;
    closeHint();
    say(t(sim.done && props.mode === 'explore' ? (sim.scenario === 'downhill' ? 'successDownhill' : 'successUphill') : sim.scenario === 'downhill' ? 'readyDownhill' : 'readyUphill', { rise: fmt1(sim.rise) }));
  }

  return {
    update(next, transition) {
      const prev = props;
      // A block of another screen gives way to this one (D65): what is drawn now is where it starts.
      const from = transition && cam.frustum ? { dir: cam.dir.clone(), frustum: { ...cam.frustum }, cut: cam.cut, h: shown.h, boatX: shown.boatX, yaw: shown.yaw, place: shown.place, fade: shown.fade, gates: { ...shown.gates }, paddles: { ...shown.paddles } } : null;
      if (transition && prev.mode === 'explore') lab = snapshot(sim);
      props = { ...props, ...next };
      if (transition) arrive(prev);
      const partial = Object.keys(next).length < Object.keys(prev).length;
      const changed = (k) => k in next && JSON.stringify(next[k]) !== JSON.stringify(prev[k]);
      if (changed('rise')) { build(); }
      // (A passage into explore mode found the lock where the learner left it: arrive above.)
      if (changed('scenario') && !(transition && props.mode === 'explore')) { resetSim(sim, props.scenario); completedSent = false; say(t(props.scenario === 'downhill' ? 'readyDownhill' : 'readyUphill')); if (props.mode === 'explain') startPhase(Math.max(0, ex.index)); }
      if (changed('mode')) { applyMode(); if (props.mode === 'explain') startPhase(Math.max(0, (props.demoStep || 1) - 1)); }
      if (changed('cameraView')) setView(props.cameraView);
      if (['visualStyle', 'waterColor', 'grassColor', 'earthColor', 'stoneColor', 'gateColor', 'hullColor', 'cabinColor', 'motionIntensity'].some(changed)) applyLook();
      if (changed('phases')) { bub.measuredFor = ''; if (ex.index >= phases().length) startPhase(0); else refreshCaption(); }
      if (changed('hints') || changed('allowViewChange')) applyMode();
      if (changed('sound')) { muted = !props.sound; setMuted(muted); }
      if (changed('informationLevel') || changed('showAnnotations')) refreshControls();
      if ('demoStep' in next && props.mode === 'explain' && (partial || changed('demoStep')) && props.demoStep > 0) startPhase(props.demoStep - 1);
      if ('command' in next && next.command && next.command !== 'none' && (partial || changed('command'))) runCommand(next.command);
      if (transition) {
        // The sound: off where this block says so, else as the learner last chose.
        setMuted(!props.sound || learnerMuted === true);
        const duration = reduced ? 0 : (transition.duration || 0) / 1000;
        passage = from && duration > 0 ? { t: 0, dur: duration, from } : null;
        container.classList.toggle('is-passing', !!passage);
      }
      layout();
      // A cut: the arriving camera at once.
      if (transition && !passage) applyCamera(0, true);
    },
    getState() {
      return { ...snapshot(sim), hints, mistakes, step: Math.max(0, ex.index + 1), seen: ex.seen, view, muted, ...(lab ? { lab: packLab(lab) } : {}) };
    },
    setState(s) { applySaved(s || {}); },
    pause() { paused = true; refreshPause(); },
    resume() { paused = false; refreshPause(); },
    dispose() {
      stop(); ro.disconnect(); offSafe?.();
      audio.dispose();
      scene.traverse((o) => { o.geometry?.dispose?.(); });
      for (const m of [matTerrain, matBoat, flagMat, matWater, matEdges, matEdgesBoat, matRim, sprayMat, ringMat, leafMesh.material, wash.material, shadowGround.material, reveal.material]) m.dispose();
      jets.forEach((j) => j.mesh.material.dispose());
      washTex.dispose(); dotTex.dispose(); quadGeo.dispose(); revealRT?.dispose();
      renderer.dispose();
      container.innerHTML = '';
    }
  };
}
