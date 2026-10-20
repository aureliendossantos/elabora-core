// Free object « Planetary gearset test bench » — three.js r186, Elabora free-object contract 0.1.
// The learner chooses the held member and the driven member, runs the bench and reads the output.
// Geometry and kinematics come from gear.js (shared with the SVG figures of the course).
// Time comes from host.onFrame only; colours from props (bound to theme tokens) and ctx.tokens.
import * as THREE from 'three';
import { MEMBERS, gearset, parseConfig, speeds, toothOutline, planetPhase, ringPhase, planetAngle, radii } from './gear.js';

const TEXT = {
  en: {
    member: { sun: 'Sun', carrier: 'Carrier', ring: 'Ring' },
    held: 'Held member (brake)', input: 'Motor drives', output: 'Output',
    run: 'Run the bench', pause: 'Pause', play: 'Resume', front: 'Front view', angled: '3/4 view',
    requirement: (i) => `Requirement ${i} of 3`, done: 'All requirements met',
    titles: { 'ring-sun': 'Electric-drive reducer', 'sun-ring': 'Second gear', 'sun-carrier': 'Overdrive', 'ring-carrier': 'Wind-turbine speed-up', 'carrier-sun': 'Reverse gear', 'carrier-ring': 'Reverse speed-up' },
    want: (r) => r > 1 ? `The output must turn ${fmtX(r)} times slower than the motor, in the same direction.`
      : r > 0 ? `The output must turn ${fmtX(1 / r)} times faster than the motor, in the same direction.`
      : -r > 1 ? `The output must turn the other way, ${fmtX(-r)} times slower than the motor.`
      : `The output must turn the other way, ${fmtX(-1 / r)} times faster than the motor.`,
    same: 'same direction', reverse: 'opposite direction',
    ratio: (r) => `ratio ${fmtR(r)} : 1`,
    stopped: 'Bench stopped. Choose a configuration, then run it.',
    selected: (m) => `${m} selected: press H to hold it, M to put the motor on it.`,
    measured: (o, rpm, dir) => `Measured: ${o} at ${rpm} rpm, ${dir}.`,
    met: (i) => `Requirement ${i} met.`,
    missed: 'This does not meet the requirement. Change the held member or the driven member, then run again.',
    hint: 'Hint: put 0 for the held member in Zs × ns + Zr × nr = (Zs + Zr) × nc and solve for the output.',
    allDone: 'All three requirements met. The bench stays open: try any configuration.',
    reduced: 'Animation off (reduced motion): read the speeds on the panel.',
    explore: 'Free exploration',
    rpm: 'rpm', inputLabel: 'Input', outputLabel: 'Output'
  },
  fr: {
    member: { sun: 'Planétaire', carrier: 'Porte-satellites', ring: 'Couronne' },
    held: 'Élément bloqué (frein)', input: 'Le moteur entraîne', output: 'Sortie',
    run: 'Lancer le banc', pause: 'Pause', play: 'Reprendre', front: 'Vue de face', angled: 'Vue 3/4',
    requirement: (i) => `Exigence ${i} sur 3`, done: 'Toutes les exigences sont remplies',
    titles: { 'ring-sun': 'Réducteur de motorisation électrique', 'sun-ring': 'Deuxième rapport', 'sun-carrier': 'Surmultiplication', 'ring-carrier': 'Multiplicateur d’éolienne', 'carrier-sun': 'Marche arrière', 'carrier-ring': 'Inverseur multiplicateur' },
    want: (r) => r > 1 ? `La sortie doit tourner ${fmtX(r, 'fr')} fois moins vite que le moteur, dans le même sens.`
      : r > 0 ? `La sortie doit tourner ${fmtX(1 / r, 'fr')} fois plus vite que le moteur, dans le même sens.`
      : -r > 1 ? `La sortie doit tourner en sens inverse, ${fmtX(-r, 'fr')} fois moins vite que le moteur.`
      : `La sortie doit tourner en sens inverse, ${fmtX(-1 / r, 'fr')} fois plus vite que le moteur.`,
    same: 'même sens', reverse: 'sens inverse',
    ratio: (r) => `rapport ${fmtR(r, 'fr')} : 1`,
    stopped: 'Banc à l’arrêt. Choisissez une configuration, puis lancez-la.',
    selected: (m) => `${m} sélectionné : H pour le bloquer, M pour y mettre le moteur.`,
    measured: (o, rpm, dir) => `Mesure : ${o} à ${rpm} tr/min, ${dir}.`,
    met: (i) => `Exigence ${i} remplie.`,
    missed: 'Cette configuration ne remplit pas l’exigence. Changez l’élément bloqué ou l’élément entraîné, puis relancez.',
    hint: 'Indice : mettez 0 pour l’élément bloqué dans Zs × ns + Zr × nr = (Zs + Zr) × nc et résolvez pour la sortie.',
    allDone: 'Les trois exigences sont remplies. Le banc reste ouvert : essayez toutes les configurations.',
    reduced: 'Animation désactivée (mouvement réduit) : lisez les vitesses dans le panneau.',
    explore: 'Exploration libre',
    rpm: 'tr/min', inputLabel: 'Entrée', outputLabel: 'Sortie'
  }
};
function fmtX(x, locale = 'en') { return (Math.round(x * 100) / 100).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: 2 }); }
function fmtR(x, locale = 'en') { return (x < 0 ? '−' : '') + Math.abs(x).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

const M = 0.1;          // module of the model, in scene units
const REV = 0.12;       // input speed of the animation, in revolutions per second
const VIEWS = { angled: [0.58, 0.36, 0.73], front: [0.0, 0.08, 1] };
const NARROW_VIEW = 300; // px of 3D view above the panel on narrow frames

export function mount(container, ctx) {
  const { host, tokens } = ctx;
  const lang = (ctx.locale || 'en').slice(0, 2) === 'fr' ? 'fr' : 'en';
  const t = TEXT[lang];
  const nf = (v) => Math.round(v).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US');
  let props = { ...ctx.props };
  const state = { held: 'sun', input: 'ring', step: 0, runs: [0, 0, 0], ran: false };
  let selected = null;
  let paused = false;
  let viewName = 'angled';
  let message = t.stopped;

  // ── DOM: 3D view and control panel. The panel uses the Elabora UI kit (t-ui-* classes and
  // --t-* variables injected by the host), so it looks like the course and follows its theme.
  // Text sizes are in rem: the host sets 1rem to the size class of the course page.
  // Wide frames: view | panel side by side. Narrow frames (< 640 px): view above, panel below,
  // and the object asks the host for the height it needs (block aspectRatio "auto").
  const surface = tokens['color.surface'];
  container.innerHTML = '';
  container.className = 'pl-root t-ui';
  const css = document.createElement('style');
  css.textContent = `
  .pl-root{position:absolute;inset:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,35%);background:var(--t-surface)}
  .pl-root.is-narrow{position:static;grid-template-columns:1fr;grid-template-rows:${NARROW_VIEW}px auto}
  .pl-view{position:relative;min-width:0;overflow:hidden;touch-action:none}
  .pl-view canvas{display:block;width:100%;height:100%;cursor:grab}
  .pl-tag{position:absolute;left:0;top:0;transform:translate(-50%,-100%);pointer-events:none;white-space:nowrap;display:flex;flex-direction:column;align-items:center;gap:3px}
  .pl-tag b{font:700 0.8125rem/1 var(--t-font-heading);color:#fff;letter-spacing:.02em;text-shadow:0 1px 3px rgba(0,0,0,.6)}
  .pl-tag .t-ui-badge:empty{display:none}
  .pl-tag .is-held{background:var(--t-error)}.pl-tag .is-input{background:color-mix(in srgb,var(--t-accent) 78%,#000)}.pl-tag .is-output{background:var(--t-success)}
  .pl-hud{position:absolute;left:12px;bottom:10px;display:flex;gap:6px}
  .pl-hud button{min-height:36px;min-width:44px;padding:0 0.75rem;border-radius:999px;border:1px solid rgba(255,255,255,.35);background:rgba(10,20,35,.55);color:#fff;font:600 0.8125rem var(--t-font-body);cursor:pointer}
  .pl-hud button:focus-visible{outline:3px solid var(--t-focus);outline-offset:2px}
  .pl-panel{gap:0.5rem;border-left:1px solid color-mix(in srgb,var(--t-text) 12%,transparent);font-size:0.875rem}
  .is-narrow .pl-panel{border-left:0;overflow:visible}
  .pl-instruction{margin:0;font-size:0.78125rem;line-height:1.35}
  .pl-dots{display:flex;gap:5px;margin-top:7px}.pl-dots i{width:22px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--t-text) 18%,transparent)}.pl-dots i.on{background:var(--t-success)}.pl-dots i.cur{background:var(--t-accent)}
  .pl-out{margin:0;font-size:0.8125rem}
  .pl-panel .t-ui-status{font-size:0.8125rem;line-height:1.35;min-height:2.8em}`;
  container.appendChild(css);

  const view = el('div', 'pl-view');
  const panel = el('div', 'pl-panel t-ui-panel');
  container.append(view, panel);
  const instruction = el('p', 'pl-instruction t-ui-muted');
  const card = el('div', 't-ui-card');
  const cardHead = el('p', 't-ui-eyebrow'); const cardTitle = el('p', 't-ui-title'); const cardText = el('p'); const dots = el('div', 'pl-dots');
  card.append(cardHead, cardTitle, cardText, dots);
  const heldGroup = segmented('held', t.held);
  const inputGroup = segmented('input', t.input);
  const out = el('p', 'pl-out');
  const run = el('button', 't-ui-btn t-ui-btn--primary'); run.type = 'button';
  const meter = el('div', 't-ui-meters');
  const mIn = el('div', 't-ui-meter'); const mOut = el('div', 't-ui-meter');
  meter.append(mIn, mOut);
  const status = el('p', 't-ui-status'); status.setAttribute('role', 'status');
  panel.append(instruction, card, heldGroup.root, inputGroup.root, out, run, status, meter);
  const hud = el('div', 'pl-hud');
  const pauseBtn = el('button'); pauseBtn.type = 'button';
  const viewBtn = el('button'); viewBtn.type = 'button';
  hud.append(pauseBtn, viewBtn);
  view.appendChild(hud);
  const tags = {};
  for (const m of MEMBERS) {
    const tag = el('div', 'pl-tag'); tag.setAttribute('aria-hidden', 'true');
    tag.append(el('b'), el('span', 't-ui-badge'));
    view.appendChild(tag);
    tags[m] = tag;
  }

  // Narrow frames stack the panel under the view and request their full height from the host.
  let narrow = false;
  function layoutMode() {
    const w = container.clientWidth || 0;
    const next = w > 0 && w < 640;
    if (next !== narrow) { narrow = next; container.classList.toggle('is-narrow', narrow); resize(); }
    if (narrow) host.requestHeight?.(NARROW_VIEW + panel.scrollHeight);
  }

  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function segmented(name, legendText) {
    const root = el('fieldset');
    const legend = el('legend'); legend.textContent = legendText;
    root.className = 't-ui-seg';
    const seg = el('div', 't-ui-seg-options');
    const inputs = {};
    for (const m of MEMBERS) {
      const label = el('label');
      const input = el('input'); input.type = 'radio'; input.name = name; input.value = m;
      input.addEventListener('change', () => assign(name, m));
      label.append(input, document.createTextNode(t.member[m]));
      seg.appendChild(label);
      inputs[m] = input;
    }
    root.append(legend, seg);
    return { root, inputs };
  }

  // ── three.js scene ──
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: !!ctx.testMode });
  renderer.setPixelRatio(ctx.testMode ? 1 : Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  view.insertBefore(renderer.domElement, hud);
  host.registerRenderer(renderer);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  host.registerCamera(camera);

  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };

  // Studio environment for metal reflections (built in code: no asset, no network).
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envBox = new THREE.Mesh(track(new THREE.BoxGeometry(30, 30, 30)), track(new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: new THREE.Color(0.18, 0.2, 0.24) })));
  envScene.add(envBox);
  const panelGeo = track(new THREE.PlaneGeometry(1, 1));
  for (const [x, y, z, sx, sy, k] of [[0, 14, 0, 16, 16, 3.2], [-14, 4, 4, 10, 8, 1.6], [14, 2, -4, 8, 10, 1.1], [0, 4, 14, 12, 6, 1.4]]) {
    const p = new THREE.Mesh(panelGeo, track(new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k * 1.04), side: THREE.DoubleSide })));
    p.position.set(x, y, z); p.scale.set(sx, sy, 1); p.lookAt(0, 0, 0);
    envScene.add(p);
  }
  const envRT = pmrem.fromScene(envScene, 0.035);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.85;
  pmrem.dispose();

  // Background: vignette from the stage colour.
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = 512; bgCanvas.height = 512;
  const bgTex = track(new THREE.CanvasTexture(bgCanvas));
  bgTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = bgTex;
  function paintBackground() {
    const g = bgCanvas.getContext('2d');
    const base = new THREE.Color(props.stageColor);
    const light = base.clone().lerp(new THREE.Color(1, 1, 1), 0.16);
    const dark = base.clone().multiplyScalar(0.55);
    const grad = g.createRadialGradient(300, 230, 20, 256, 256, 380);
    grad.addColorStop(0, '#' + light.getHexString());
    grad.addColorStop(0.55, '#' + base.getHexString());
    grad.addColorStop(1, '#' + dark.getHexString());
    g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
    g.strokeStyle = 'rgba(160,200,240,0.07)'; g.lineWidth = 1;
    for (let i = 16; i < 512; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
    bgTex.needsUpdate = true;
  }

  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(6, 9, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -7; key.shadow.camera.right = 7; key.shadow.camera.top = 7; key.shadow.camera.bottom = -7;
  key.shadow.camera.near = 1; key.shadow.camera.far = 40;
  key.shadow.bias = -0.0008;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 1.4);
  rim.position.set(-8, 3, -6);
  scene.add(rim);

  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(40, 40)), track(new THREE.ShadowMaterial({ opacity: 0.28 })));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Materials (colours applied in applyProps)
  const mats = {
    sun: track(new THREE.MeshStandardMaterial({ metalness: 0.8, roughness: 0.3 })),
    planet: track(new THREE.MeshStandardMaterial({ metalness: 0.9, roughness: 0.26 })),
    ring: track(new THREE.MeshStandardMaterial({ metalness: 0.7, roughness: 0.42 })),
    carrier: track(new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.4 })),
    shaftSun: track(new THREE.MeshStandardMaterial({ metalness: 0.9, roughness: 0.22 })),
    shaftCarrier: track(new THREE.MeshStandardMaterial({ metalness: 0.9, roughness: 0.22 })),
    brake: track(new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.5 })),
    input: track(new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.4 })),
    output: track(new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.4 }))
  };

  // Groups: the three members rotate about the z axis; planets orbit with the carrier.
  const groups = { sun: new THREE.Group(), carrier: new THREE.Group(), ring: new THREE.Group() };
  const root = new THREE.Group();
  root.position.y = 0;
  for (const m of MEMBERS) { groups[m].userData.member = m; root.add(groups[m]); }
  scene.add(root);
  const spinners = { sun: new THREE.Group(), carrier: new THREE.Group(), ring: new THREE.Group() };
  for (const m of MEMBERS) groups[m].add(spinners[m]);
  let planets = [];
  let set = null;
  let r = null;
  let built = [];
  const anchors = {};

  function mesh(geo, mat, into, member) {
    const o = new THREE.Mesh(geo, mat);
    o.castShadow = true; o.receiveShadow = true;
    o.userData.member = member;
    into.add(o);
    built.push(o);
    return o;
  }
  function gearGeometry(z, opts, depth, hole) {
    const pts = toothOutline(z, M, opts);
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    if (hole) { const h = new THREE.Path(); h.absarc(0, 0, hole, 0, Math.PI * 2, true); shape.holes.push(h); }
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.012, bevelSegments: 1, curveSegments: 24 });
    geo.translate(0, 0, -depth / 2);
    return geo;
  }

  function build() {
    for (const o of built) { o.removeFromParent(); o.geometry?.dispose(); }
    built = [];
    for (const m of MEMBERS) spinners[m].rotation.z = 0;
    set = gearset(props.gearset);
    r = radii(set, M);
    const housing = r.ring + 1.25 * M + 0.42;
    root.position.y = housing + 0.55;
    ground.position.y = -housing - 0.55;

    // Sun gear and its shaft (towards the viewer)
    mesh(gearGeometry(set.zs, { phase: 0 }, 0.9, 0.2), mats.sun, spinners.sun, 'sun');
    mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.4, 32).rotateX(Math.PI / 2).translate(0, 0, 1.6), mats.shaftSun, spinners.sun, 'sun');
    mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.16, 40).rotateX(Math.PI / 2).translate(0, 0, 2.75), mats.sun, spinners.sun, 'sun');
    mesh(new THREE.BoxGeometry(0.16, 0.5, 0.18).translate(0, 0.45, 2.75), mats.shaftSun, spinners.sun, 'sun');

    // Ring gear inside its housing
    const outer = new THREE.Shape(); outer.absarc(0, 0, housing, 0, Math.PI * 2, false);
    const inner = toothOutline(set.zr, M, { internal: true, phase: ringPhase(set) });
    outer.holes.push(new THREE.Path(inner.map(([x, y]) => new THREE.Vector2(x, y)).reverse()));
    const ringGeo = new THREE.ExtrudeGeometry(outer, { depth: 1, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.02, bevelSegments: 1, curveSegments: 96 });
    ringGeo.translate(0, 0, -0.5);
    mesh(ringGeo, mats.ring, spinners.ring, 'ring');
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
      mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 12).rotateX(Math.PI / 2).translate(Math.cos(a) * (housing - 0.2), Math.sin(a) * (housing - 0.2), 0.53), mats.shaftCarrier, spinners.ring, 'ring');
    }

    // Carrier: back plate, shaft (away from the viewer), pins and caps
    const plate = new THREE.Shape(); plate.absarc(0, 0, r.centre + 0.62, 0, Math.PI * 2, false);
    for (let k = 0; k < set.planets; k++) {
      const a = planetAngle(k, set.planets) + Math.PI / set.planets;
      const h = new THREE.Path(); h.absarc(Math.cos(a) * r.centre * 0.92, Math.sin(a) * r.centre * 0.92, 0.42, 0, Math.PI * 2, true);
      plate.holes.push(h);
    }
    const plateGeo = new THREE.ExtrudeGeometry(plate, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1, curveSegments: 64 });
    plateGeo.translate(0, 0, -0.66);
    mesh(plateGeo, mats.carrier, spinners.carrier, 'carrier');
    mesh(new THREE.CylinderGeometry(0.4, 0.4, 2.6, 32).rotateX(Math.PI / 2).translate(0, 0, -1.95), mats.shaftCarrier, spinners.carrier, 'carrier');
    mesh(new THREE.CylinderGeometry(0.78, 0.78, 0.18, 40).rotateX(Math.PI / 2).translate(0, 0, -3.2), mats.carrier, spinners.carrier, 'carrier');
    planets = [];
    for (let k = 0; k < set.planets; k++) {
      const a = planetAngle(k, set.planets);
      const px = Math.cos(a) * r.centre, py = Math.sin(a) * r.centre;
      mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.25, 16).rotateX(Math.PI / 2).translate(px, py, -0.05), mats.shaftCarrier, spinners.carrier, 'carrier');
      mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 24).rotateX(Math.PI / 2).translate(px, py, 0.47), mats.carrier, spinners.carrier, 'carrier');
      const holder = new THREE.Group();
      holder.position.set(px, py, 0);
      spinners.carrier.add(holder);
      built.push(holder);
      const planet = mesh(gearGeometry(set.zp, { phase: planetPhase(k, set) }, 0.8, 0.17), mats.planet, holder, 'carrier');
      planet.userData.member = 'planet';
      planets.push({ holder, mesh: planet });
    }

    // Click anchors for tests and editors: a visible point of each member
    anchors.sun = anchorAt(spinners.sun, 0, 0, 2.84);
    anchors.ring = anchorAt(groups.ring, 0, housing - 0.12, 0.5);
    anchors.carrier = anchorAt(spinners.carrier, Math.cos(planetAngle(0, set.planets)) * r.centre, Math.sin(planetAngle(0, set.planets)) * r.centre, 0.53);
    for (const m of MEMBERS) host.registerObject(m, anchors[m]);

    buildIndicators(housing);
    resize();
  }
  function anchorAt(into, x, y, z) {
    const a = new THREE.Object3D();
    a.position.set(x, y, z);
    into.add(a);
    built.push(a);
    return a;
  }

  // Role indicators: brake collars (held), motor arrow (input), output arrow.
  const indicators = { brake: {}, arrow: {} };
  function buildIndicators(housing) {
    const spots = { sun: { z: 2.3, rad: 0.42, arrowRad: 0.95, arrowZ: 1.75 }, carrier: { z: -2.7, rad: 0.52, arrowRad: 1.1, arrowZ: -2.2 }, ring: { z: 0, rad: housing + 0.06, arrowRad: housing + 0.42, arrowZ: 0.62 } };
    for (const m of MEMBERS) {
      const s = spots[m];
      const brake = new THREE.Group();
      const collar = mesh(new THREE.TorusGeometry(s.rad, m === 'ring' ? 0.09 : 0.1, 12, 64), mats.brake, brake, 'brake');
      collar.position.z = s.z;
      const clamp = mesh(new THREE.BoxGeometry(m === 'ring' ? 0.9 : 0.36, m === 'ring' ? 0.5 : 0.7, m === 'ring' ? 1.25 : 0.36), mats.brake, brake, 'brake');
      clamp.position.set(0, -s.rad - (m === 'ring' ? 0.2 : 0.3), s.z);
      groups[m].add(brake);
      built.push(brake);
      indicators.brake[m] = brake;

      const arrow = new THREE.Group();
      const arc = 1.45 * Math.PI;
      mesh(new THREE.TorusGeometry(s.arrowRad, 0.055, 10, 80, arc), mats.input, arrow, 'arrow');
      const head = mesh(new THREE.ConeGeometry(0.17, 0.42, 20), mats.input, arrow, 'arrow');
      head.position.set(Math.cos(arc) * s.arrowRad, Math.sin(arc) * s.arrowRad, 0);
      head.rotation.z = arc;
      arrow.position.z = s.arrowZ;
      arrow.rotation.z = Math.PI * 0.8;
      groups[m].add(arrow);
      built.push(arrow);
      indicators.arrow[m] = arrow;
    }
  }

  // ── props → scene and panel ──
  function config() { return `${state.held}-${state.input}`; }
  function requirementConfig(i) { return [props.requirement1, props.requirement2, props.requirement3][i]; }
  function current() { return speeds(set, state.held, state.input, props.inputRpm); }

  function applyProps(rebuild) {
    instruction.textContent = props.instruction;
    mats.sun.color.set(props.sunColor);
    mats.planet.color.set(props.planetColor);
    mats.ring.color.set(props.ringColor);
    mats.carrier.color.set(props.carrierColor);
    mats.shaftSun.color.set(props.planetColor);
    mats.shaftCarrier.color.set(props.planetColor);
    mats.brake.color.set(tokens['color.error']);
    mats.input.color.set(props.sunColor); mats.input.emissive.set(props.sunColor); mats.input.emissiveIntensity = 0.35;
    mats.output.color.set(tokens['color.success']); mats.output.emissive.set(tokens['color.success']); mats.output.emissiveIntensity = 0.35;
    hemi.color.set(surface).lerp(new THREE.Color(props.carrierColor), 0.12);
    hemi.groundColor.set(props.stageColor).multiplyScalar(0.6);
    rim.color.set(props.carrierColor).lerp(new THREE.Color(1, 1, 1), 0.55);
    paintBackground();
    if (rebuild) build();
    refresh();
  }

  function refresh() {
    const sp = current();
    const { output } = parseConfig(config());
    // Panel: requirement card
    const done = state.step >= 3;
    cardHead.textContent = done ? t.explore : t.requirement(state.step + 1);
    if (done) { cardTitle.textContent = t.done; cardText.textContent = t.allDone; }
    else {
      const rc = requirementConfig(state.step);
      const rp = parseConfig(rc);
      cardTitle.textContent = t.titles[rc];
      cardText.textContent = t.want(speeds(set, rp.held, rp.input, 1).ratio);
    }
    dots.innerHTML = '';
    for (let i = 0; i < 3; i++) { const d = el('i', i < state.step ? 'on' : i === state.step ? 'cur' : ''); dots.appendChild(d); }
    for (const m of MEMBERS) {
      heldGroup.inputs[m].checked = state.held === m;
      inputGroup.inputs[m].checked = state.input === m;
      inputGroup.inputs[m].disabled = state.held === m;
    }
    out.innerHTML = '';
    out.append(document.createTextNode(`${t.output}: `));
    const ob = el('b'); ob.textContent = t.member[output]; out.appendChild(ob);
    run.textContent = t.run;
    // Meters
    meterCell(mIn, t.inputLabel, `${nf(props.inputRpm)} ${t.rpm}`, t.member[state.input]);
    if (state.ran) {
      const n = sp[output];
      const dir = Math.sign(n) === Math.sign(props.inputRpm) ? t.same : t.reverse;
      meterCell(mOut, t.outputLabel, `${n < 0 ? '−' : ''}${nf(Math.abs(n))} ${t.rpm}`, `${t.member[output]} · ${dir}${props.showRatio ? ` · ${t.ratio(sp.ratio)}` : ''}`);
    } else meterCell(mOut, t.outputLabel, '—', t.member[output]);
    status.textContent = message;
    status.className = 't-ui-status' + (message.startsWith('✓') ? ' is-ok' : message.startsWith('✗') ? ' is-ko' : '');
    pauseBtn.textContent = paused ? t.play : t.pause;
    viewBtn.textContent = viewName === 'angled' ? t.front : t.angled;
    // Scene indicators
    for (const m of MEMBERS) {
      indicators.brake[m].visible = state.held === m;
      const isIn = state.input === m, isOut = output === m;
      const arrow = indicators.arrow[m];
      arrow.visible = isIn || (isOut && state.ran);
      const mat = isIn ? mats.input : mats.output;
      arrow.traverse((o) => { if (o.isMesh) o.material = mat; });
      const sign = Math.sign(isIn ? props.inputRpm : sp[m]) || 1;
      arrow.scale.x = sign;
      const tag = tags[m];
      tag.firstChild.textContent = t.member[m];
      const badge = tag.lastChild;
      badge.className = `t-ui-badge ${state.held === m ? 'is-held' : isIn ? 'is-input' : isOut ? 'is-output' : ''}`;
      badge.textContent = state.held === m ? (lang === 'fr' ? 'bloqué' : 'held') : isIn ? (lang === 'fr' ? 'moteur' : 'motor') : (isOut && state.ran) ? `${sp[m] < 0 ? '−' : ''}${nf(Math.abs(sp[m]))} ${t.rpm}` : isOut ? t.output : '';
    }
    for (const m of [...MEMBERS, 'planet']) {
      const mat = m === 'planet' ? mats.planet : mats[m];
      // Selected member glows in its own colour (keyboard and pointer selection).
      if (selected === m) mat.emissive.copy(mat.color); else mat.emissive.set('#000000');
      mat.emissiveIntensity = selected === m ? 0.28 : 0;
    }
  }
  function meterCell(cell, label, value, sub) {
    cell.innerHTML = '';
    const s = el('small'); s.textContent = label;
    const b = el('b'); b.textContent = value;
    const e = el('em'); e.textContent = sub;
    cell.append(s, b, e);
  }

  // ── behaviour ──
  function assign(role, m) {
    if (role === 'held') {
      if (state.held === m) return;
      if (state.input === m) state.input = state.held;
      state.held = m;
    } else {
      if (state.input === m) return;
      if (state.held === m) state.held = state.input;
      state.input = m;
    }
    state.ran = false;
    message = t.stopped;
    refresh();
  }

  function runBench() {
    state.ran = true;
    const sp = current();
    const { output } = parseConfig(config());
    const n = sp[output];
    const dir = Math.sign(n) === Math.sign(props.inputRpm) ? t.same : t.reverse;
    const measured = t.measured(t.member[output].toLowerCase(), `${n < 0 ? '−' : ''}${nf(Math.abs(n))}`, dir);
    if (state.step >= 3) { message = measured; refresh(); return; }
    const i = state.step;
    state.runs[i]++;
    const target = parseConfig(requirementConfig(i));
    const want = speeds(set, target.held, target.input, 1).ratio;
    const correct = Math.abs(sp.ratio - want) < 1e-9;
    host.emit('bench_run', { requirement: i + 1, config: config(), correct });
    if (correct) {
      state.step++;
      host.emit('requirement_met', { requirement: i + 1, runs: state.runs[i] });
      message = `✓ ${t.met(i + 1)} ${measured}`;
      if (state.step >= 3) {
        const score = state.runs.reduce((s, k) => s + (k <= 1 ? 1 : k === 2 ? 0.75 : k === 3 ? 0.5 : 0.25), 0) / 3;
        host.emit('completed', { score: Math.round(score * 100) / 100 });
        message += ` ${t.allDone}`;
      }
    } else {
      message = `✗ ${measured} ${t.missed}${state.runs[i] >= 2 ? ` ${t.hint}` : ''}`;
    }
    refresh();
  }
  run.addEventListener('click', runBench);

  function setPaused(v) { paused = v; refresh(); }
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  viewBtn.addEventListener('click', () => { viewName = viewName === 'angled' ? 'front' : 'angled'; orbit.yaw = 0; orbit.pitch = 0; resize(); refresh(); });

  const onKey = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'p') setPaused(!paused);
    else if (k === 'r') runBench();
    else if ((k === 'h' || k === 'm') && selected) assign(k === 'h' ? 'held' : 'input', selected === 'planet' ? 'carrier' : selected);
  };
  const doc = container.ownerDocument;
  doc.addEventListener('keydown', onKey);

  // Pointer: drag to orbit, click to select a member.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const orbit = { yaw: 0, pitch: 0, dragging: false, moved: 0, x: 0, y: 0 };
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => { orbit.dragging = true; orbit.moved = 0; orbit.x = e.clientX; orbit.y = e.clientY; });
  const onMove = (e) => {
    if (!orbit.dragging) return;
    const dx = e.clientX - orbit.x, dy = e.clientY - orbit.y;
    orbit.x = e.clientX; orbit.y = e.clientY;
    orbit.moved += Math.abs(dx) + Math.abs(dy);
    orbit.yaw = THREE.MathUtils.clamp(orbit.yaw - dx * 0.006, -1.2, 1.2);
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy * 0.004, -0.5, 0.6);
    resize();
  };
  const onUp = () => { orbit.dragging = false; };
  doc.addEventListener('pointermove', onMove);
  doc.addEventListener('pointerup', onUp);
  canvas.addEventListener('click', (e) => {
    if (orbit.moved > 6) return;
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(root.children, true).find((h) => h.object.visible && ['sun', 'carrier', 'ring', 'planet'].includes(h.object.userData.member));
    selected = hit ? hit.object.userData.member : null;
    if (selected) message = t.selected(selected === 'planet' ? t.member.carrier : t.member[selected]);
    refresh();
  });

  // Camera framing: fit the gearset whatever the aspect ratio.
  const target = new THREE.Vector3();
  function resize() {
    const w = Math.max(1, view.clientWidth), h = Math.max(1, view.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const housing = r ? r.ring + 0.55 : 4.5;
    target.set(0, root.position.y, -0.2);
    const base = new THREE.Vector3(...VIEWS[viewName]).normalize();
    const sph = new THREE.Spherical().setFromVector3(base);
    sph.theta += orbit.yaw; sph.phi = THREE.MathUtils.clamp(sph.phi - orbit.pitch, 0.35, 1.65);
    const dir = new THREE.Vector3().setFromSpherical(sph);
    const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
    const extent = housing + 1.1;
    const dist = Math.max(extent / Math.tan(halfV), extent / (Math.tan(halfV) * camera.aspect)) * (narrow ? 1.28 : 1.08);
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(() => { layoutMode(); resize(); });
  ro.observe(view);
  ro.observe(container);
  ro.observe(panel);

  // Labels follow fixed points of the members.
  const tagPoints = { sun: () => new THREE.Vector3(0, 0.95, 2.75), carrier: () => new THREE.Vector3(0, 1.15, -3.2), ring: () => new THREE.Vector3(0, r.ring + 0.75, 0.3) };
  const v = new THREE.Vector3();
  function placeTags() {
    const w = view.clientWidth, h = view.clientHeight;
    for (const m of MEMBERS) {
      v.copy(tagPoints[m]()).add(root.position).project(camera);
      tags[m].style.transform = `translate(${Math.round((v.x + 1) / 2 * w)}px, ${Math.round((1 - v.y) / 2 * h)}px) translate(-50%, -100%)`;
    }
  }

  // ── animation: integrate the member angles at their computed speeds ──
  const angle = { sun: 0, carrier: 0, ring: 0, planet: 0 };
  const stop = host.onFrame((dt) => {
    if (state.ran && !paused && !ctx.reducedMotion) {
      const sp = current();
      const k = (2 * Math.PI * REV * props.animationSpeed) / props.inputRpm;
      angle.sun += sp.sun * k * dt;
      angle.ring += sp.ring * k * dt;
      angle.carrier += sp.carrier * k * dt;
      angle.planet += sp.planet * k * dt;
    }
    spinners.sun.rotation.z = angle.sun;
    spinners.ring.rotation.z = angle.ring;
    spinners.carrier.rotation.z = angle.carrier;
    // The planet holders turn with the carrier; the planet spin is absolute, so subtract it.
    for (const p of planets) p.mesh.rotation.z = angle.planet - angle.carrier;
    placeTags();
    renderer.render(scene, camera);
  });

  applyProps(true);
  if (ctx.savedState) setState(ctx.savedState);
  if (ctx.reducedMotion) message = t.reduced;
  refresh();

  function setState(s) {
    if (MEMBERS.includes(s.held)) state.held = s.held;
    if (MEMBERS.includes(s.input) && s.input !== state.held) state.input = s.input;
    if (state.input === state.held) state.input = MEMBERS.find((m) => m !== state.held);
    state.step = Math.max(0, Math.min(3, Number(s.step) || 0));
    state.runs = Array.isArray(s.runs) && s.runs.length === 3 ? s.runs.map((n) => Math.max(0, Number(n) || 0)) : [0, 0, 0];
    state.ran = !!s.ran;
    refresh();
  }

  return {
    update(next) {
      const rebuild = next.gearset !== undefined && next.gearset !== props.gearset;
      props = { ...props, ...next };
      applyProps(rebuild);
    },
    getState() { return { held: state.held, input: state.input, step: state.step, runs: [...state.runs], ran: state.ran }; },
    setState,
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    dispose() {
      stop();
      ro.disconnect();
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      envRT.dispose();
      for (const o of built) o.geometry?.dispose();
      for (const d of disposables) d.dispose?.();
      renderer.dispose();
      container.innerHTML = '';
    }
  };
}
