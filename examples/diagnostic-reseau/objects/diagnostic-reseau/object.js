// Free object « Le réseau du siège en 3D » — three.js r186, Elabora free-object contract 0.1.
// One diorama for the whole module (blocks share a continuity key): a sand plate, soft devices,
// cables and amber packets. Display sets the scene, explain lights the path device by device,
// diagnose lets the learner check the devices in order. Words come from props and strings,
// colours from props bound to the theme, time from the host.
import * as THREE from 'three';

const ORDER = ['poste', 'commutateur', 'routeur', 'parefeu', 'serveur'];
const CHAIN = [...ORDER, 'imprimante'];
const SPOT = { poste: [-3.45, 1.15], commutateur: [-1.85, -0.6], parefeu: [1.6, -1.25], serveur: [4.0, 0.9], imprimante: [2.35, 2.2] };
const TOP = { poste: 1.4, commutateur: 0.32, routeur: 1.0, parefeu: 0.84, serveur: 1.78, imprimante: 0.66 };
const RING = { poste: 0.9, commutateur: 0.98, routeur: 0.78, parefeu: 0.8, serveur: 0.76, imprimante: 0.72 };
const VIEW = new THREE.Vector3(5.45, 8, 12.24).normalize();
const TARGET = new THREE.Vector3(0, 0.5, 0);
const PLATE_BOX = { x: [-4.95, 4.95], y: [-0.46, 0], z: [-3.25, 3.25] };
const FLOW = 0.2; // a packet's share of a cable per second, at speed 1

export function mount(container, ctx) {
  const { host } = ctx;
  const reduced = !!ctx.reducedMotion;
  const testMode = !!ctx.testMode;
  const t = (key, values) => ctx.t(key, values);
  let props = { ...ctx.props };
  let safe = { top: 0, right: 0, bottom: 0, left: 0, ...(ctx.safeArea || {}) };
  const state = { checked: [], attempts: 0, found: false, hint: false };
  let paused = false;
  let clock = 0;

  // ── DOM: the view, a chip over each device, the zones' names, the instruction, pause, status ──
  container.innerHTML = '';
  container.classList.add('nw-root');
  const style = document.createElement('style');
  style.textContent = CSS;
  container.appendChild(style);
  const view = el('div', 'nw-view');
  container.appendChild(view);
  const layer = el('div', 'nw-layer');
  container.appendChild(layer);
  const zoneTags = { floor: el('span', 'nw-zone'), server: el('span', 'nw-zone') };
  for (const z of Object.values(zoneTags)) { z.setAttribute('aria-hidden', 'true'); layer.appendChild(z); }
  const chips = {};
  for (const id of CHAIN) {
    const chip = el('div', 'nw-chip');
    chip.dataset.id = id;
    const inner = el('div', 'nw-chip-in');
    chip.appendChild(inner);
    const tag = el('span', 'nw-tag');
    chips[id] = { chip, inner, name: null, tag, tagKey: '' };
    layer.appendChild(chip);
  }
  const instruction = el('p', 'nw-instruction');
  container.appendChild(instruction);
  const pauseBtn = el('button', 'nw-pause');
  pauseBtn.type = 'button';
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  container.appendChild(pauseBtn);
  const status = el('p', 'nw-sr');
  status.setAttribute('role', 'status');
  container.appendChild(status);

  // ── three.js ──
  const renderer = new THREE.WebGLRenderer({ antialias: !testMode, alpha: true, preserveDrawingBuffer: testMode });
  renderer.setPixelRatio(testMode ? 1 : Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  view.appendChild(renderer.domElement);
  host.registerRenderer(renderer);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  host.registerCamera(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b0b0, 2.3));
  const sun = new THREE.DirectionalLight(0xffffff, 2.9);
  sun.position.set(-5, 10, 6);
  sun.castShadow = true;
  const shadowSize = testMode ? 512 : 1024;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 6, bottom: -6, near: 1, far: 30 });
  sun.shadow.radius = 3;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(6, 4, -3);
  scene.add(fill);

  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };
  const color = (v) => new THREE.Color(v);
  const mat = (o = {}) => keep(new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.04, ...o }));

  // Palette: every brand colour comes from a prop; the rest is grey or mixed from them.
  const palette = {};
  function mixPalette() {
    const primary = color(props.primaryColor);
    const white = color(0xffffff);
    palette.primary = primary;
    palette.navy2 = mix(primary, white, 0.1);
    palette.graphite = mix(primary, color(0x3a3a3a), 0.6);
    palette.port = mix(primary, color(0x4a4a4a), 0.45);
    palette.cable = mix(primary, white, 0.6);
    palette.screen = mix(mix(primary, white, 0.62), color(props.accentColor), 0.0);
    palette.accent = color(props.accentColor);
    palette.ok = color(props.okColor);
    palette.fault = color(props.faultColor);
    palette.plate = color(props.plateColor);
    palette.rim = palette.plate.clone().multiplyScalar(0.9);
    palette.white = color(0xf6f6f6);
    palette.paper = color(0xfcfcfc);
  }
  mixPalette();

  // Materials, recoloured by applyColors().
  const M = {
    plate: mat({ roughness: 0.92 }), rim: mat({ roughness: 0.95 }),
    white: mat({ roughness: 0.5 }), graphite: mat(), navy: mat(), navy2: mat(), port: mat(),
    screen: mat({ roughness: 0.4, emissiveIntensity: 0.5 }), accent: mat({ roughness: 0.48 }),
    led: mat({ emissiveIntensity: 0.9 }), cable: mat({ roughness: 0.5 }),
    lit: mat({ roughness: 0.4, emissiveIntensity: 0.55 }), paper: mat({ roughness: 0.8 }),
    packet: mat({ roughness: 0.35, emissiveIntensity: 0.7 })
  };
  const gridMat = keep(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));

  // The plate and its rim.
  const plate = new THREE.Mesh(keep(rbox(9.6, 0.36, 6.2, 0.22)), M.plate);
  plate.position.y = -0.18; plate.receiveShadow = true; scene.add(plate);
  const rim = new THREE.Mesh(keep(rbox(9.9, 0.2, 6.5, 0.1)), M.rim);
  rim.position.y = -0.36; scene.add(rim);
  const grid = new THREE.Mesh(keep(new THREE.PlaneGeometry(9.2, 5.8)), gridMat);
  grid.rotation.x = -Math.PI / 2; grid.position.y = 0.002; grid.renderOrder = 1; scene.add(grid);

  // The two networks, tinted on the plate (transparent from the start: their fade never recompiles).
  const zones = {};
  for (const [id, x0, x1, lx, lz] of [['floor', -4.55, -0.5, -4.25, 2.55], ['server', 1.15, 4.55, 3.4, 2.8]]) {
    const m = keep(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    const mesh = new THREE.Mesh(keep(roundRect(x1 - x0, 5.7, 0.45)), m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.set((x0 + x1) / 2, 0.006, 0); mesh.renderOrder = 1;
    scene.add(mesh);
    zones[id] = { mesh, label: [lx, lz], shown: 0 };
  }

  // ── Devices ──
  const devices = {};
  const instanced = (geo, material, positions) => {
    const im = new THREE.InstancedMesh(geo, material, positions.length);
    const m4 = new THREE.Matrix4();
    positions.forEach((p, i) => im.setMatrixAt(i, m4.makeTranslation(p[0], p[1], p[2])));
    return im;
  };
  function addDevice(id, group) {
    group.userData.id = id;
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.id = id; } });
    scene.add(group);
    host.registerObject(id, group);
    devices[id] = group;
  }
  { // Marc's workstation
    const g = new THREE.Group();
    g.add(at(new THREE.Mesh(keep(rbox(0.6, 0.06, 0.38, 0.03)), M.graphite), 0, 0.03, 0));
    g.add(at(new THREE.Mesh(keep(new THREE.CylinderGeometry(0.045, 0.06, 0.42, 16)), M.graphite), 0, 0.27, 0));
    g.add(at(new THREE.Mesh(keep(rbox(1.3, 0.82, 0.09, 0.04)), M.navy), 0, 0.88, 0));
    g.add(at(new THREE.Mesh(keep(new THREE.PlaneGeometry(1.18, 0.7)), M.screen), 0, 0.88, 0.047));
    g.add(at(new THREE.Mesh(keep(new THREE.PlaneGeometry(0.5, 0.08)), M.navy), -0.26, 1.1, 0.049));
    g.add(at(new THREE.Mesh(keep(new THREE.PlaneGeometry(0.7, 0.05)), M.navy2), -0.16, 0.96, 0.049));
    g.add(at(new THREE.Mesh(keep(rbox(1.0, 0.05, 0.32, 0.02)), M.white), 0.05, 0.025, 0.52));
    g.position.set(SPOT.poste[0], 0, SPOT.poste[1]);
    addDevice('poste', g);
  }
  { // the floor switch
    const g = new THREE.Group();
    g.add(at(new THREE.Mesh(keep(rbox(1.5, 0.26, 0.7, 0.06)), M.white), 0, 0.13, 0));
    const xs = Array.from({ length: 8 }, (_, i) => -0.56 + i * 0.16);
    g.add(instanced(keep(new THREE.BoxGeometry(0.11, 0.07, 0.02)), M.port, xs.map((x) => [x, 0.14, 0.355])));
    g.add(instanced(keep(new THREE.BoxGeometry(0.04, 0.025, 0.015)), M.led, xs.map((x) => [x, 0.215, 0.355])));
    g.position.set(SPOT.commutateur[0], 0, SPOT.commutateur[1]);
    addDevice('commutateur', g);
  }
  { // the router, between the two networks
    const g = new THREE.Group();
    g.add(at(new THREE.Mesh(keep(rbox(1.1, 0.34, 0.72, 0.08)), M.white), 0, 0.17, 0));
    g.add(at(new THREE.Mesh(keep(rbox(1.12, 0.07, 0.74, 0.03)), M.accent), 0, 0.2, 0));
    const antenna = keep(new THREE.CylinderGeometry(0.03, 0.035, 0.7, 12));
    const tip = keep(new THREE.SphereGeometry(0.045, 16, 12));
    for (const sx of [-0.36, 0.36]) {
      const a = at(new THREE.Mesh(antenna, M.graphite), sx, 0.62, -0.22); a.rotation.z = sx < 0 ? 0.18 : -0.18; g.add(a);
      g.add(at(new THREE.Mesh(tip, M.graphite), sx + (sx < 0 ? -0.065 : 0.065), 0.97, -0.22));
    }
    g.add(instanced(keep(new THREE.SphereGeometry(0.03, 12, 8)), M.led, [0, 1, 2, 3].map((i) => [-0.3 + i * 0.12, 0.27, 0.37])));
    addDevice('routeur', g);
  }
  { // the firewall
    const g = new THREE.Group();
    g.add(at(new THREE.Mesh(keep(rbox(1.1, 0.78, 0.7, 0.08)), M.navy2), 0, 0.39, 0));
    const sh = new THREE.Shape();
    sh.moveTo(0, 0.24); sh.quadraticCurveTo(0.12, 0.2, 0.2, 0.2); sh.lineTo(0.2, 0.02); sh.quadraticCurveTo(0.2, -0.18, 0, -0.27);
    sh.quadraticCurveTo(-0.2, -0.18, -0.2, 0.02); sh.lineTo(-0.2, 0.2); sh.quadraticCurveTo(-0.12, 0.2, 0, 0.24);
    const shield = at(new THREE.Mesh(keep(new THREE.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2 })), M.accent), 0, 0.42, 0.34);
    g.add(shield);
    const bricks = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) { const x = -0.36 + c * 0.24 + (r % 2) * 0.06; if (Math.abs(x) < 0.5) bricks.push([x, 0.12 + r * 0.075, 0.36]); }
    g.add(instanced(keep(new THREE.BoxGeometry(0.2, 0.06, 0.02)), M.navy, bricks));
    g.position.set(SPOT.parefeu[0], 0, SPOT.parefeu[1]);
    addDevice('parefeu', g);
  }
  { // the print server
    const g = new THREE.Group();
    g.add(at(new THREE.Mesh(keep(rbox(0.9, 1.7, 0.9, 0.08)), M.graphite), 0, 0.85, 0));
    const ys = [0, 1, 2, 3, 4].map((i) => 0.3 + i * 0.28);
    g.add(instanced(keep(rbox(0.74, 0.2, 0.04, 0.02)), M.port, ys.map((y) => [0, y, 0.45])));
    g.add(instanced(keep(new THREE.SphereGeometry(0.025, 10, 8)), M.led, ys.map((y) => [0.28, y, 0.48])));
    g.position.set(SPOT.serveur[0], 0, SPOT.serveur[1]);
    addDevice('serveur', g);
  }
  // The printer, at the end of the path: its sheets come out once the path is clear.
  const sheets = [];
  { const g = new THREE.Group();
    g.add(at(new THREE.Mesh(keep(rbox(1.0, 0.46, 0.78, 0.09)), M.white), 0, 0.23, 0));
    g.add(at(new THREE.Mesh(keep(rbox(0.92, 0.1, 0.5, 0.04)), M.graphite), 0, 0.47, -0.1));
    g.add(at(new THREE.Mesh(keep(rbox(0.62, 0.04, 0.42, 0.02)), M.graphite), 0, 0.17, 0.52));
    g.add(at(new THREE.Mesh(keep(new THREE.SphereGeometry(0.03, 10, 8)), M.led), 0.36, 0.42, 0.4));
    const sheetGeo = keep(new THREE.PlaneGeometry(0.42, 0.5));
    sheetGeo.rotateX(-Math.PI / 2);
    const page = keep(new THREE.MeshStandardMaterial({ roughness: 0.85, map: keep(pageTexture()), side: THREE.DoubleSide }));
    for (let i = 0; i < 4; i++) { const s = new THREE.Mesh(sheetGeo, page); s.visible = false; s.castShadow = true; g.add(s); sheets.push(s); }
    g.position.set(SPOT.imprimante[0], 0, SPOT.imprimante[1]);
    g.rotation.y = -0.35;
    addDevice('imprimante', g);
  }

  // Rings under the devices: what the scene says about each (transparent from the start).
  const ringGeo = keep(new THREE.RingGeometry(0.86, 1, 64));
  const haloGeo = keep(new THREE.CircleGeometry(0.86, 64));
  const rings = {};
  for (const id of CHAIN) {
    const rm = keep(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    const hm = keep(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    const ring = new THREE.Mesh(ringGeo, rm), halo = new THREE.Mesh(haloGeo, hm);
    for (const m of [ring, halo]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 2; scene.add(m); }
    ring.position.y = 0.014; halo.position.y = 0.012;
    rings[id] = { ring, halo, shown: 0, tint: new THREE.Color(), pulse: false };
  }

  // Cables, the lit path drawn along them, and the packets.
  const links = [];
  const PACKETS = 3;
  const packetGeo = keep(new THREE.SphereGeometry(0.085, 16, 12));
  const packets = new THREE.InstancedMesh(packetGeo, M.packet, (CHAIN.length - 1) * PACKETS);
  packets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  packets.castShadow = false; packets.renderOrder = 3; packets.frustumCulled = false;
  scene.add(packets);
  function buildLinks() {
    for (const l of links) { scene.remove(l.cable, l.lit); l.cable.geometry.dispose(); l.lit.geometry.dispose(); }
    links.length = 0;
    for (let i = 0; i < CHAIN.length - 1; i++) {
      const a = devices[CHAIN[i]].position, b = devices[CHAIN[i + 1]].position;
      const mid = new THREE.Vector3((a.x + b.x) / 2, 0.05, (a.z + b.z) / 2 + 0.45);
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(a.x, 0.05, a.z), mid, new THREE.Vector3(b.x, 0.05, b.z)]);
      const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.032, 8, false), M.cable);
      cable.receiveShadow = true;
      const lit = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.05, 8, false), M.lit);
      lit.geometry.setDrawRange(0, 0); lit.renderOrder = 2;
      scene.add(cable, lit);
      links.push({ curve, cable, lit, grow: 0, total: lit.geometry.index.count });
    }
  }

  // ── Props → scene ──
  function applyColors() {
    mixPalette();
    M.plate.color.copy(palette.plate); M.rim.color.copy(palette.rim);
    M.white.color.copy(palette.white); M.paper.color.copy(palette.paper);
    M.graphite.color.copy(palette.graphite); M.navy.color.copy(palette.primary); M.navy2.color.copy(palette.navy2); M.port.color.copy(palette.port);
    M.screen.color.copy(palette.screen); M.screen.emissive.copy(palette.screen);
    M.accent.color.copy(palette.accent);
    M.led.color.copy(palette.ok); M.led.emissive.copy(palette.ok);
    M.cable.color.copy(palette.cable);
    M.lit.color.copy(palette.accent); M.lit.emissive.copy(palette.accent);
    M.packet.color.copy(palette.accent); M.packet.emissive.copy(palette.accent);
    gridMat.map?.dispose();
    gridMat.map = gridTexture(palette.primary);
    gridMat.needsUpdate = true;
    zones.floor.mesh.material.color.copy(mix(palette.primary, color(0xffffff), 0.35));
    zones.server.mesh.material.color.copy(palette.accent);
  }
  function placeRouter() {
    const p = Array.isArray(props.routerPosition) ? props.routerPosition : [0.6, 0, 1.35];
    devices.routeur.position.set(Number(p[0]) || 0, 0, Number(p[2]) || 0);
    for (const [id, r] of Object.entries(rings)) { r.ring.position.x = r.halo.position.x = devices[id].position.x; r.ring.position.z = r.halo.position.z = devices[id].position.z; r.ring.scale.setScalar(RING[id]); r.halo.scale.setScalar(RING[id]); }
    const keepGrow = links.map((l) => l.grow);
    buildLinks();
    links.forEach((l, i) => { l.grow = keepGrow[i] ?? 0; });
  }
  function deviceInfo(id) {
    const list = Array.isArray(props.devices) ? props.devices : [];
    const found = list.find((d) => d && d.id === id) || {};
    const fallback = (ctx.objects || []).find((o) => o.id === id)?.label || id;
    return { label: found.label || fallback, ok: found.ok || '', fault: found.fault || found.ok || '' };
  }
  const label = (id) => (id === 'imprimante' ? props.printerLabel || deviceInfo(id).label : deviceInfo(id).label);

  // The chips: a button per device while the learner diagnoses, a plain name otherwise.
  let chipsMode = '';
  function buildChips() {
    const diagnose = props.mode === 'diagnose';
    chipsMode = diagnose ? 'diagnose' : 'plain';
    for (const id of CHAIN) {
      const c = chips[id];
      c.inner.innerHTML = '';
      const selectable = diagnose && id !== 'imprimante';
      const name = el(selectable ? 'button' : 'span', 'nw-name');
      if (selectable) {
        name.type = 'button';
        name.setAttribute('aria-label', t('check', { device: label(id) }));
        name.addEventListener('click', () => check(id));
        name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); check(id); } });
        name.addEventListener('pointerenter', () => { hover = id; });
        name.addEventListener('pointerleave', () => { if (hover === id) hover = null; });
      }
      name.textContent = label(id);
      c.name = name;
      c.inner.append(name, c.tag);
      c.chip.setAttribute('aria-hidden', selectable ? 'false' : 'true');
      c.tagKey = '';
    }
  }
  function applyText() {
    instruction.textContent = props.instruction || '';
    zoneTags.floor.textContent = props.floorZone || '';
    zoneTags.server.textContent = props.serverZone || '';
    buildChips();
  }

  // ── What the learner has done ──
  const startChecked = () => ORDER.filter((id) => (props.checked || []).includes(id));
  function done() {
    const base = startChecked();
    return [...base, ...state.checked.filter((id) => !base.includes(id))];
  }
  const nextDevice = () => ORDER[done().length];
  const flashes = {}; // id → seconds left of « trop tôt »
  let hover = null;

  function check(id) {
    if (props.mode !== 'diagnose' || state.found || !ORDER.includes(id)) return;
    const list = done();
    if (list.includes(id)) { announceDevice(id); return; }
    const next = ORDER[list.length];
    const faulty = id === props.failingDevice;
    if (id !== next) {
      state.attempts++;
      flashes[id] = 2.6;
      status.textContent = t('tooEarlyStatus', { device: label(id), next: label(next) });
      host.emit('device_checked', { device: id, inOrder: false, faulty });
      if (!state.hint && state.attempts >= (props.hintAfterErrors ?? 2)) {
        state.hint = true;
        host.emit('hint_shown', {});
      }
      refresh();
      return;
    }
    state.checked.push(id);
    announceDevice(id);
    host.emit('device_checked', { device: id, inOrder: true, faulty });
    if (faulty) {
      state.found = true;
      host.emit('completed', { score: Math.max(0, 1 - 0.25 * state.attempts), attempts: state.attempts });
    }
    refresh();
  }
  function announceDevice(id) {
    const info = deviceInfo(id);
    const faulty = id === props.failingDevice && !props.resolved;
    status.textContent = faulty ? t('statusFault', { device: info.label, finding: info.fault }) : t('statusOk', { device: info.label, finding: info.ok });
  }

  // What each device shows now: its ring and its tag.
  function deviceLook(id) {
    const mode = props.mode;
    const list = mode === 'diagnose' ? done() : startChecked();
    const failing = props.failingDevice;
    const resolved = !!props.resolved;
    const found = mode === 'diagnose' ? state.found : list.includes(failing);
    if (list.includes(id) || (resolved && ORDER.includes(id))) {
      const isFault = id === failing && !resolved && (found || list.includes(id));
      if (isFault) return { ring: palette.fault, pulse: true, tag: 'fault' };
      const latest = resolved ? failing : list[list.length - 1];
      if (list.includes(id) || id === failing) return { ring: palette.ok, tag: id === latest ? 'ok' : '', done: true };
      return { ring: null, tag: '' };
    }
    if (mode === 'diagnose') {
      if (flashes[id] > 0) return { ring: palette.accent, tag: 'early' };
      if (state.hint && !state.found && id === nextDevice()) return { ring: palette.accent, pulse: true, tag: 'hint' };
      if (hover === id && !state.found && ORDER.includes(id)) return { ring: palette.primary, faint: true, tag: '' };
      return { ring: null, tag: '' };
    }
    const focus = props.focus && props.focus !== 'aucun' ? props.focus : mode === 'explain' && props.reach >= 0 && props.reach < CHAIN.length - 1 ? CHAIN[props.reach] : null;
    if (focus === id) return { ring: palette.accent, pulse: true, tag: '' };
    return { ring: null, tag: '' };
  }
  // How many cables carry packets, and whether the last one ends at a blocked device.
  function pathNow() {
    const mode = props.mode;
    if (props.resolved) return { lit: CHAIN.length - 1, blocked: false };
    if (mode === 'explain') return { lit: Math.max(0, Math.min(CHAIN.length - 1, props.reach ?? 5)), blocked: false };
    const list = mode === 'diagnose' ? done() : startChecked();
    const failing = props.failingDevice;
    const found = list.includes(failing);
    const ok = list.filter((id) => id !== failing).length;
    if (found) return { lit: ORDER.indexOf(failing), blocked: true };
    return { lit: Math.max(0, ok - 1), blocked: false };
  }

  function refresh() {
    const mode = props.mode;
    for (const id of CHAIN) {
      const look = deviceLook(id);
      const r = rings[id];
      r.want = look.ring ? (look.faint ? 0.45 : 1) : 0;
      if (look.ring) r.tint.copy(look.ring);
      r.pulse = !!look.pulse;
      const c = chips[id];
      const info = deviceInfo(id);
      const key = look.tag;
      if (c.tagKey !== key) {
        c.tagKey = key;
        c.tag.className = 'nw-tag' + (key ? ' is-' + key : '');
        c.tag.textContent = key === 'ok' ? info.ok : key === 'fault' ? info.fault : key === 'early' ? t('tooEarly') : key === 'hint' ? t('hint') : '';
      }
      const dim = mode === 'explain' && !props.resolved && CHAIN.indexOf(id) > (props.reach ?? 5);
      c.chip.classList.toggle('is-dim', dim);
      c.chip.classList.toggle('is-done', !!look.done);
      c.chip.hidden = props.showLabels === false;
    }
    const diagnosing = mode === 'diagnose' && !state.found && !props.resolved;
    instruction.classList.toggle('is-shown', diagnosing && !!props.instruction && controlsShown);
    for (const z of Object.values(zoneTags)) z.classList.toggle('is-shown', !!props.showZones);
    const path = pathNow();
    pauseBtn.hidden = reduced || !controlsShown || (path.lit === 0 && !path.blocked) || mode === 'display' && !props.resolved;
    pauseBtn.setAttribute('aria-label', paused ? t('play') : t('pause'));
    pauseBtn.classList.toggle('is-paused', paused);
  }

  // ── Camera: the plate fitted to the part of the frame the layout leaves free ──
  let W = 1, H = 1;
  const basis = (() => {
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), VIEW).normalize();
    const up = new THREE.Vector3().crossVectors(VIEW, right).normalize();
    return { right, up };
  })();
  // The diorama's outline on screen: the plate's corners and the top of every device.
  function extent(narrow) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const v = new THREE.Vector3();
    const add = (x, y, z) => {
      v.set(x, y, z).sub(TARGET);
      const u = v.dot(basis.right), w = v.dot(basis.up);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, w); v1 = Math.max(v1, w);
    };
    // On a narrow frame the devices fill it and the plate's edges may run off.
    if (!narrow) for (const x of PLATE_BOX.x) for (const y of PLATE_BOX.y) for (const z of PLATE_BOX.z) add(x, y, z);
    for (const id of CHAIN) {
      const d = devices[id].position, r = narrow ? 0.75 : 0;
      add(d.x, TOP[id] + 0.12, d.z);
      if (narrow) for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) add(d.x + dx, 0, d.z + dz);
    }
    return { u0, u1, v0, v1 };
  }
  function frameGoal() {
    const narrow = W < 640;
    const rem = parseFloat(getComputedStyle(container).fontSize) || 16;
    const m = Math.max(12, Math.min(W, H) * 0.035);
    const left = narrow ? 0 : Math.min(safe.left || 0, W * 0.55);
    const right = narrow ? 0 : Math.min(safe.right || 0, W * 0.4);
    const top = narrow ? 0 : Math.min(safe.top || 0, H * 0.4);
    const bottom = narrow ? 0 : Math.min(safe.bottom || 0, H * 0.4);
    const chipRoom = rem * (narrow ? 2.2 : 3.4);
    const footRoom = props.mode === 'diagnose' ? rem * (narrow ? 4.2 : 5.2) : m;
    const ax0 = left + m, ax1 = W - right - m;
    const ay0 = top + chipRoom, ay1 = H - Math.max(bottom, footRoom);
    const aw = Math.max(40, ax1 - ax0), ah = Math.max(40, ay1 - ay0);
    const e = extent(narrow);
    const s = Math.max((e.u1 - e.u0) / aw, (e.v1 - e.v0) / ah);
    const uc = (e.u0 + e.u1) / 2, vc = (e.v0 + e.v1) / 2;
    const cx = (ax0 + ax1) / 2, cy = (ay0 + ay1) / 2;
    const l = uc - cx * s, tp = vc + cy * s;
    return { left: l, right: l + W * s, top: tp, bottom: tp - H * s };
  }
  let frustum = null;
  let passage = null; // { from, t, duration }
  function applyCamera(dt) {
    const goal = frameGoal();
    if (passage) {
      passage.t = Math.min(1, passage.t + dt / Math.max(0.001, passage.duration));
      const e = easeInOut(passage.t);
      frustum = {};
      for (const f of ['left', 'right', 'top', 'bottom']) frustum[f] = passage.from[f] + (goal[f] - passage.from[f]) * e;
      if (passage.t >= 0.6 && !controlsShown) { controlsShown = true; refresh(); }
      if (passage.t >= 1) passage = null;
    } else frustum = goal;
    camera.position.copy(TARGET).addScaledVector(VIEW, 40);
    camera.lookAt(TARGET);
    Object.assign(camera, frustum);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  let controlsShown = true;

  // Chips and zone names follow their device on screen.
  const tmp = new THREE.Vector3();
  function place(elm, x, y, z) {
    tmp.set(x, y, z).project(camera);
    const px = (tmp.x + 1) / 2 * W, py = (1 - tmp.y) / 2 * H;
    elm.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
  }
  // A chip that would cover a nearer device's chip rises above it (eased, so it never jumps).
  const lift = Object.fromEntries(CHAIN.map((id) => [id, 0]));
  function placeChips(dt = 0) {
    const items = [];
    for (const id of CHAIN) {
      const c = chips[id];
      const d = devices[id].position;
      tmp.set(d.x, TOP[id] + 0.12, d.z).project(camera);
      const shown = !c.chip.hidden;
      const w = shown ? c.inner.offsetWidth : 0, h = shown ? c.inner.offsetHeight : 0;
      // Kept inside the frame, sideways.
      const x = Math.min(Math.max((tmp.x + 1) / 2 * W, w / 2 + 6), W - w / 2 - 6), y = (1 - tmp.y) / 2 * H;
      items.push({ id, x, y, depth: tmp.z, w, h });
    }
    items.sort((a, b) => a.depth - b.depth);
    const placed = [];
    const gap = 4;
    for (const item of items) {
      let want = 0;
      if (item.w) {
        for (let round = 0; round < 6; round++) {
          const l = item.x - item.w / 2, r = item.x + item.w / 2, b = item.y - want, t = b - item.h;
          // Chips that only brush sideways stay where they are.
          const hit = placed.find((p) => l < p.r - 8 && r > p.l + 8 && t < p.b + gap && b > p.t - gap);
          if (!hit) break;
          want = item.y - (hit.t - gap);
        }
        placed.push({ l: item.x - item.w / 2, r: item.x + item.w / 2, b: item.y - want, t: item.y - want - item.h });
      }
      const k = reduced || !dt ? 1 : 1 - Math.exp(-dt * 10);
      lift[item.id] += (want - lift[item.id]) * k;
      chips[item.id].chip.style.transform = `translate(${item.x.toFixed(1)}px, ${(item.y - lift[item.id]).toFixed(1)}px)`;
    }
    place(zoneTags.floor, zones.floor.label[0], 0, zones.floor.label[1]);
    place(zoneTags.server, zones.server.label[0], 0, zones.server.label[1]);
  }

  // ── Frames ──
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  let printClock = 0;
  function animate(dt) {
    const run = !paused;
    if (run) clock += dt;
    for (const id of Object.keys(flashes)) { flashes[id] -= dt; if (flashes[id] <= 0) { delete flashes[id]; refresh(); } }
    const k = reduced ? 1 : 1 - Math.exp(-dt * 7);
    // Rings and halos ease to what they say.
    for (const id of CHAIN) {
      const r = rings[id];
      r.shown += ((r.want || 0) - r.shown) * (reduced ? 1 : k);
      const pulse = r.pulse && !reduced ? 0.5 + 0.5 * Math.sin(clock * 4.2) : 0;
      r.ring.material.color.copy(r.tint); r.halo.material.color.copy(r.tint);
      r.ring.material.opacity = r.shown * (0.85 - 0.25 * pulse);
      r.halo.material.opacity = r.shown * (0.13 + 0.07 * pulse);
      const grow = RING[id] * (1 + 0.05 * pulse);
      r.ring.scale.setScalar(grow); r.halo.scale.setScalar(grow);
      r.ring.visible = r.halo.visible = r.shown > 0.01;
    }
    // Zones fade in and out.
    for (const z of Object.values(zones)) {
      z.shown += ((props.showZones ? 1 : 0) - z.shown) * (reduced ? 1 : k * 0.6);
      z.mesh.material.opacity = z.shown * 0.12;
      z.mesh.visible = z.shown > 0.005;
    }
    // The lit path grows along the cables, one after the other, and packets ride on it.
    const path = pathNow();
    const growRate = reduced ? 99 : 2.2 * (props.packetSpeed || 1);
    links.forEach((l, i) => {
      const want = i < path.lit ? 1 : i === path.lit && path.blocked ? 1 : 0;
      const ready = i === 0 || links[i - 1].grow >= 0.98 || want === 0;
      if (want > l.grow && ready) l.grow = Math.min(want, l.grow + dt * growRate);
      else if (want < l.grow) l.grow = Math.max(want, l.grow - dt * growRate * 1.6);
      const n = Math.floor(l.grow * l.total / 6) * 6;
      l.lit.geometry.setDrawRange(0, n);
      l.lit.visible = n > 0;
      const blocked = path.blocked && i === path.lit;
      for (let p = 0; p < PACKETS; p++) {
        const index = i * PACKETS + p;
        const phase = p / PACKETS + i * 0.13;
        const u = reduced ? (phase % 1) : (((clock * FLOW * (props.packetSpeed || 1)) + phase) % 1);
        let s = 0;
        if (u <= l.grow - 0.02) {
          s = 1;
          if (blocked && u > 0.78) s = Math.max(0, 1 - (u - 0.78) / 0.12);
        }
        l.curve.getPoint(u, pos); pos.y = 0.16;
        sc.setScalar(Math.max(s, 0.0001));
        packets.setMatrixAt(index, m4.compose(pos, q, sc));
      }
    });
    packets.instanceMatrix.needsUpdate = true;
    // The printer prints once the path is clear to it.
    const printing = links[links.length - 1].grow >= 0.98 && !path.blocked;
    if (printing) printClock += run ? dt : 0; else printClock = 0;
    const cycle = 2.4;
    const printed = reduced ? (printing ? 3 : 0) : Math.min(3, Math.floor(printClock / cycle));
    const f = reduced ? 1 : (printClock % cycle) / cycle;
    sheets.forEach((s, i) => {
      if (i < printed) { s.visible = true; s.position.set(0, 0.2 + i * 0.012, 0.64); }
      else if (i === printed && printing && !reduced && printed < 3) {
        s.visible = true;
        const e = easeInOut(Math.min(1, f * 1.4));
        s.position.set(0, 0.45 - 0.25 * e + i * 0.012, 0.05 + 0.59 * e);
      } else if (i === 3 && printing && !reduced && printed >= 3) {
        s.visible = true;
        const e = easeInOut(Math.min(1, f * 1.4));
        s.position.set(0, 0.45 - 0.2 * e, 0.05 + 0.59 * e);
      } else s.visible = false;
    });
  }

  const offFrame = host.onFrame((dt) => {
    applyCamera(dt);
    animate(dt);
    placeChips(dt);
    renderer.render(scene, camera);
  });

  // ── Input ──
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(ORDER.map((id) => devices[id]), true)[0];
    return hit ? hit.object.userData.id : null;
  }
  const onClick = (e) => { const id = pick(e); if (id) check(id); };
  const onMove = (e) => {
    if (props.mode !== 'diagnose') return;
    const id = pick(e);
    if (id !== hover) { hover = id; refresh(); }
    renderer.domElement.style.cursor = id && !state.found ? 'pointer' : '';
  };
  renderer.domElement.addEventListener('click', onClick);
  renderer.domElement.addEventListener('pointermove', onMove);
  function setPaused(v) { paused = v; refresh(); }

  // ── Size ──
  function resize() {
    W = Math.max(1, container.clientWidth);
    H = Math.max(1, container.clientHeight);
    renderer.setSize(W, H, false);
    container.classList.toggle('is-narrow', W < 640);
    // Resizing clears the canvas: draw again at once rather than leave it blank until the next frame.
    if (frustum) { applyCamera(0); placeChips(); renderer.render(scene, camera); }
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  const offSafe = host.onSafeArea?.((area) => { safe = { ...safe, ...area }; });

  // ── Start ──
  applyColors();
  placeRouter();
  applyText();
  if (ctx.savedState) setState(ctx.savedState);
  resize();
  refresh();
  // The path of a scene that arrives already lit is drawn at once.
  { const path = pathNow(); links.forEach((l, i) => { l.grow = i < path.lit || (i === path.lit && path.blocked) ? 1 : 0; }); }

  function setState(s) {
    state.checked = Array.isArray(s?.checked) ? s.checked.filter((d) => ORDER.includes(d)) : [];
    state.attempts = Number(s?.attempts) || 0;
    state.found = !!s?.found;
    state.hint = !!s?.hint;
    refresh();
  }

  return {
    update(next, transition) {
      const before = props;
      props = { ...props, ...next };
      if (transition && frustum) {
        passage = { from: { ...frustum }, t: 0, duration: reduced ? 0 : (transition.duration || 0) / 1000 };
        if (passage.duration > 0) controlsShown = false; else passage = null;
      }
      const changed = (k) => JSON.stringify(before[k]) !== JSON.stringify(props[k]);
      if (['primaryColor', 'accentColor', 'okColor', 'faultColor', 'plateColor'].some(changed)) applyColors();
      if (changed('routerPosition')) placeRouter();
      if (['instruction', 'devices', 'printerLabel', 'floorZone', 'serverZone', 'mode'].some(changed) || chipsMode !== (props.mode === 'diagnose' ? 'diagnose' : 'plain')) applyText();
      if (props.mode === 'diagnose' && before.mode !== 'diagnose' && state.found) {
        host.emit('completed', { score: Math.max(0, 1 - 0.25 * state.attempts), attempts: state.attempts });
      }
      if (changed('resolved') && props.resolved) status.textContent = t('statusResolved');
      refresh();
    },
    getState() { return { checked: [...state.checked], attempts: state.attempts, found: state.found, hint: state.hint }; },
    setState,
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    dispose() {
      offFrame();
      offSafe?.();
      ro.disconnect();
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('pointermove', onMove);
      for (const l of links) { l.cable.geometry.dispose(); l.lit.geometry.dispose(); }
      gridMat.map?.dispose();
      for (const d of disposables) d.dispose?.();
      packets.dispose();
      renderer.dispose();
      container.innerHTML = '';
    }
  };
}

// ── Helpers ──
function el(tag, className) { const e = document.createElement(tag); e.className = className; return e; }
function at(mesh, x, y, z) { mesh.position.set(x, y, z); return mesh; }
// Mixes two colours as the eye sees them (in sRGB), not in the linear space of the renderer.
function mix(a, b, t) {
  const x = {}, y = {};
  a.getRGB(x, THREE.SRGBColorSpace); b.getRGB(y, THREE.SRGBColorSpace);
  return new THREE.Color().setRGB(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t, THREE.SRGBColorSpace);
}
function easeInOut(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

// A box with rounded edges, centred on the origin.
function rbox(w, h, d, r) {
  r = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  const s = new THREE.Shape();
  const iw = w - 2 * r, ih = h - 2 * r, rc = Math.min(r * 0.5, iw / 2, ih / 2);
  const x = -iw / 2, y = -ih / 2;
  s.moveTo(x + rc, y); s.lineTo(x + iw - rc, y); s.quadraticCurveTo(x + iw, y, x + iw, y + rc);
  s.lineTo(x + iw, y + ih - rc); s.quadraticCurveTo(x + iw, y + ih, x + iw - rc, y + ih);
  s.lineTo(x + rc, y + ih); s.quadraticCurveTo(x, y + ih, x, y + ih - rc);
  s.lineTo(x, y + rc); s.quadraticCurveTo(x, y, x + rc, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(d - 2 * r, 0.001), bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: 4, curveSegments: 6 });
  g.center();
  return g;
}

// A flat rounded rectangle, centred on the origin.
function roundRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return new THREE.ShapeGeometry(s, 8);
}

// A printed page: a title line and a few lines of text, in greys.
function pageTexture() {
  const c = document.createElement('canvas');
  c.width = 84; c.height = 100;
  const g = c.getContext('2d');
  g.fillStyle = '#fbfbfb'; g.fillRect(0, 0, 84, 100);
  g.fillStyle = '#7a7a7a'; g.fillRect(10, 12, 40, 7);
  g.fillStyle = '#b4b4b4';
  for (let i = 0; i < 6; i++) g.fillRect(10, 30 + i * 10, i % 3 === 2 ? 44 : 64, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// The faint grid of the plate, in the brand's blue.
function gridTexture(primary) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const [r, gg, b] = [primary.r, primary.g, primary.b].map((v) => Math.round(v * 255));
  g.strokeStyle = `rgba(${r}, ${gg}, ${b}, 0.08)`;
  g.lineWidth = 2;
  for (let i = 0; i <= 512; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// The object's own interface: chips over the devices, tags, one instruction, a pause button.
const CSS = `
.nw-root{position:relative;width:100%;height:100%;overflow:hidden;font-family:var(--t-font-body);color:var(--t-text);-webkit-font-smoothing:antialiased}
.nw-view,.nw-view canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.nw-layer{position:absolute;inset:0;pointer-events:none}
.nw-chip{position:absolute;left:0;top:0;width:0;height:0;will-change:transform}
.nw-chip-in{position:absolute;left:0;bottom:0;translate:-50% 0;display:flex;flex-direction:column;align-items:center;gap:.3rem;transition:opacity .35s ease}
.nw-name{display:block;white-space:nowrap;padding:.3rem .7rem;border:0;border-radius:999px;background:var(--t-surface);color:var(--t-text);font:600 .875rem/1.2 var(--t-font-body);box-shadow:0 1px 2px rgba(0,0,0,.08),0 4px 14px rgba(0,0,0,.08)}
button.nw-name{pointer-events:auto;cursor:pointer;min-height:2rem;transition:box-shadow .2s ease,background-color .2s ease}
button.nw-name:focus-visible{outline:3px solid var(--t-focus);outline-offset:2px}
@media (hover:hover) and (pointer:fine){button.nw-name:hover{box-shadow:0 0 0 2px color-mix(in srgb,var(--t-primary) 35%,transparent),0 4px 14px rgba(0,0,0,.1)}}
.nw-tag{display:block;white-space:nowrap;padding:.15rem .55rem;border-radius:999px;font:600 .8125rem/1.3 var(--t-font-body);opacity:0;transition:opacity .3s ease}
.nw-tag:empty{display:none}
.nw-tag.is-ok,.nw-tag.is-fault,.nw-tag.is-early,.nw-tag.is-hint{opacity:1}
.nw-tag.is-ok{background:color-mix(in srgb,var(--t-success) 13%,var(--t-surface));color:var(--t-success)}
.nw-tag.is-fault{background:color-mix(in srgb,var(--t-error) 12%,var(--t-surface));color:var(--t-error)}
.nw-tag.is-early,.nw-tag.is-hint{background:color-mix(in srgb,var(--t-accent) 12%,var(--t-surface));color:var(--t-accent)}
.nw-chip.is-dim .nw-chip-in{opacity:.45}
.nw-name::before{content:"";display:inline-block;width:0;height:.5rem;margin-right:0;border-bottom:2px solid transparent;border-right:2px solid transparent;rotate:45deg;translate:0 -.15rem;transition:width .25s ease,margin .25s ease}
.nw-chip.is-done .nw-name::before{width:.25rem;margin-right:.45rem;margin-left:.1rem;border-color:var(--t-success)}
.nw-chip[hidden]{display:none}
.nw-zone{position:absolute;left:0;top:0;translate:0 -50%;white-space:nowrap;color:var(--t-muted);font:650 .875rem/1.2 var(--t-font-body);letter-spacing:.01em;opacity:0;transition:opacity .5s ease}
.nw-zone.is-shown{opacity:1}
.nw-instruction{position:absolute;left:50%;bottom:1.5rem;translate:-50% .5rem;margin:0;max-width:min(40rem,calc(100% - 7rem));padding:.75rem 1.25rem;border-radius:999px;background:var(--t-surface);color:var(--t-text);font:600 1.0625rem/1.35 var(--t-font-body);text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 30px rgba(0,0,0,.1);opacity:0;visibility:hidden;transition:opacity .35s ease,translate .35s cubic-bezier(.23,1,.32,1),visibility 0s linear .35s}
.nw-instruction.is-shown{opacity:1;visibility:visible;translate:-50% 0;transition:opacity .35s ease,translate .35s cubic-bezier(.23,1,.32,1),visibility 0s}
.nw-pause{position:absolute;right:1.25rem;bottom:1.5rem;width:2.75rem;height:2.75rem;border:0;border-radius:50%;background:var(--t-surface);box-shadow:0 1px 2px rgba(0,0,0,.08),0 4px 14px rgba(0,0,0,.08);cursor:pointer;display:grid;place-items:center}
.nw-pause::before{content:"";width:.75rem;height:.875rem;border-left:4px solid var(--t-primary);border-right:4px solid var(--t-primary);box-sizing:border-box}
.nw-pause.is-paused::before{width:0;height:0;border:0;border-left:.75rem solid var(--t-primary);border-top:.45rem solid transparent;border-bottom:.45rem solid transparent;margin-left:.2rem}
.nw-pause:focus-visible{outline:3px solid var(--t-focus);outline-offset:2px}
.nw-pause[hidden]{display:none}
.nw-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.nw-root.is-narrow .nw-name{font-size:.6875rem;padding:.15rem .45rem;min-height:0}
.nw-root.is-narrow .nw-chip-in{gap:.15rem}
.nw-root.is-narrow .nw-tag{font-size:.625rem;padding:.05rem .4rem}
.nw-root.is-narrow .nw-instruction{bottom:.5rem;max-width:calc(100% - 4.5rem);font-size:.8125rem;border-radius:.75rem;padding:.45rem .75rem}
.nw-root.is-narrow .nw-pause{right:.75rem;bottom:.75rem}
@media (prefers-reduced-motion:reduce){.nw-chip,.nw-tag,.nw-zone,.nw-instruction{transition:none}}
`;
