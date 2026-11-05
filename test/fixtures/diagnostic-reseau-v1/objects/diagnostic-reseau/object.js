// Free object « Diagnostic réseau » — three.js r186, Elabora free-object contract 0.1.
// Everything an author may change is a declared prop (object.manifest.json); colours come from
// props bound to theme tokens or from ctx.tokens. Time, randomness and frames come from the host.
import * as THREE from 'three';

const ORDER = ['poste', 'commutateur', 'routeur', 'parefeu', 'serveur'];
const TEXT = {
  fr: {
    inspect: (l) => `Contrôler : ${l}`,
    ok: (l) => `${l} : fonctionne, les paquets passent.`,
    faulty: (l) => `${l} : en panne ! Les paquets s'arrêtent ici.`,
    outOfOrder: (l, next) => `Hors procédure : contrôlez d'abord ${next} avant ${l}.`,
    hint: 'Indice : partez du poste de Marc et suivez le chemin, équipement par équipement.',
    pause: 'Pause', play: 'Reprendre', done: 'Panne trouvée.'
  },
  en: {
    inspect: (l) => `Check: ${l}`,
    ok: (l) => `${l}: working, packets go through.`,
    faulty: (l) => `${l}: failing! Packets stop here.`,
    outOfOrder: (l, next) => `Out of procedure: check ${next} before ${l}.`,
    hint: 'Hint: start from the user workstation and follow the path, device by device.',
    pause: 'Pause', play: 'Resume', done: 'Failure found.'
  }
};

export function mount(container, ctx) {
  const { host } = ctx;
  const t = TEXT[(ctx.locale || 'fr').slice(0, 2)] || TEXT.fr;
  const labels = Object.fromEntries((ctx.objects || []).map((o) => [o.id, o.label]));
  let props = { ...ctx.props };
  const state = { inspected: [], attempts: 0, found: false, hint: false };
  let paused = false;

  // ── DOM: instruction, 3D view, accessible device buttons, live status ──
  container.classList.add('dr-root');
  container.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = `
    .dr-root{display:flex;flex-direction:column;height:100%;font:15px/1.4 ${ctx.tokens['font.body']};color:${ctx.tokens['color.text']};background:${ctx.tokens['color.surface']}}
    .dr-instruction{margin:0;padding:10px 14px;font-weight:600}
    .dr-view{position:relative;flex:1;min-height:0}
    .dr-view canvas{display:block;width:100%;height:100%;cursor:pointer}
    .dr-bar{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px}
    .dr-bar button{min-height:44px;padding:0 12px;border-radius:${ctx.tokens.radius}px;border:2px solid ${ctx.tokens['color.primary']};background:${ctx.tokens['color.surface']};color:${ctx.tokens['color.primary']};font:inherit;cursor:pointer}
    .dr-bar button[aria-pressed="true"]{background:${ctx.tokens['color.primary']};color:${ctx.tokens['color.onPrimary']}}
    .dr-bar button:focus-visible{outline:3px solid ${ctx.tokens['color.focus']};outline-offset:2px}
    .dr-status{margin:0;padding:4px 14px 10px;min-height:1.4em}`;
  container.appendChild(style);
  const instruction = document.createElement('p');
  instruction.className = 'dr-instruction';
  container.appendChild(instruction);
  const view = document.createElement('div');
  view.className = 'dr-view';
  container.appendChild(view);
  const bar = document.createElement('div');
  bar.className = 'dr-bar';
  bar.setAttribute('role', 'group');
  container.appendChild(bar);
  const status = document.createElement('p');
  status.className = 'dr-status';
  status.setAttribute('role', 'status');
  container.appendChild(status);

  const buttons = {};
  for (const id of ORDER) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.inspect(labels[id] || id);
    b.addEventListener('click', () => inspect(id));
    bar.appendChild(b);
    buttons[id] = b;
  }
  const pauseBtn = document.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  bar.appendChild(pauseBtn);
  const onKey = (e) => { if (e.key === 'p' || e.key === 'P') setPaused(!paused); };
  container.addEventListener('keydown', onKey);

  // ── three.js scene ──
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: !!ctx.testMode });
  renderer.setPixelRatio(ctx.testMode ? 1 : Math.min(2, globalThis.devicePixelRatio || 1));
  view.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.registerRenderer(renderer);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 100);
  host.registerCamera(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(4, 10, 6);
  scene.add(sun);

  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(22, 8)), track(new THREE.MeshStandardMaterial({ roughness: 0.95 })));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const deviceGeo = track(new THREE.BoxGeometry(1.6, 1.1, 1.2));
  const devices = {};
  const baseX = [-6.4, -3.2, 0, 3.2, 6.4];
  ORDER.forEach((id, i) => {
    const mat = track(new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }));
    const mesh = new THREE.Mesh(deviceGeo, mat);
    mesh.position.set(baseX[i], 0.55, 0);
    mesh.userData.id = id;
    scene.add(mesh);
    host.registerObject(id, mesh);
    const label = makeLabel(labels[id] || id);
    label.position.set(0, 1.25, 0);
    mesh.add(label);
    devices[id] = { mesh, mat, label };
  });

  const cableMat = track(new THREE.MeshStandardMaterial({ roughness: 0.8 }));
  const cables = [];
  for (let i = 0; i < ORDER.length - 1; i++) {
    const c = new THREE.Mesh(track(new THREE.CylinderGeometry(0.06, 0.06, 1, 8)), cableMat);
    c.rotation.z = Math.PI / 2;
    scene.add(c);
    cables.push(c);
  }

  const packetGeo = track(new THREE.SphereGeometry(0.16, 16, 12));
  const packetMat = track(new THREE.MeshStandardMaterial({ emissiveIntensity: 0.9 }));
  const packets = Array.from({ length: 6 }, (_, i) => {
    const p = new THREE.Mesh(packetGeo, packetMat);
    p.userData.phase = i / 6 + host.random() * 0.05;
    scene.add(p);
    return p;
  });

  function makeLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 96;
    const g = canvas.getContext('2d');
    g.font = `600 44px ${ctx.tokens['font.body']}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = ctx.tokens['color.text'];
    g.fillText(text, 256, 50);
    const tex = track(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: tex, transparent: true })));
    sprite.scale.set(2.6, 0.49, 1);
    return sprite;
  }

  // ── props → scene ──
  const color = (v) => new THREE.Color(v);
  function applyProps() {
    instruction.textContent = props.instruction;
    floor.material.color = color(ctx.tokens['color.surface']).lerp(color(props.primaryColor), 0.06);
    scene.background = color(ctx.tokens['color.surface']);
    cableMat.color = color(props.primaryColor).lerp(color(ctx.tokens['color.surface']), 0.55);
    packetMat.color = color(props.accentColor);
    packetMat.emissive = color(props.accentColor);
    const rp = props.routerPosition || [0, 0, 0];
    devices.routeur.mesh.position.set(baseX[2] + rp[0], 0.55 + rp[1], rp[2]);
    for (let i = 0; i < cables.length; i++) {
      const a = devices[ORDER[i]].mesh.position;
      const b = devices[ORDER[i + 1]].mesh.position;
      cables[i].position.set((a.x + b.x) / 2, 0.3, (a.z + b.z) / 2);
      cables[i].scale.y = Math.max(0.1, a.distanceTo(b) - 1.6);
      cables[i].rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    }
    for (const id of ORDER) devices[id].label.visible = !!props.showLabels;
    paintDevices();
  }

  function paintDevices() {
    for (const id of ORDER) {
      const d = devices[id];
      const checked = state.inspected.includes(id);
      const faulty = checked && id === props.failingDevice;
      d.mat.color = color(faulty ? ctx.tokens['color.error'] : checked ? ctx.tokens['color.success'] : props.primaryColor);
      buttons[id].setAttribute('aria-pressed', String(checked));
    }
    pauseBtn.textContent = paused ? t.play : t.pause;
  }

  // ── behaviour ──
  function label(id) { return labels[id] || id; }
  function inspect(id) {
    if (state.found) return;
    const next = ORDER[state.inspected.length];
    if (id !== next) {
      if (state.inspected.includes(id)) return;
      state.attempts++;
      status.textContent = t.outOfOrder(label(id), label(next));
      host.emit('device_inspected', { device: id, inOrder: false, faulty: id === props.failingDevice });
      if (!state.hint && state.attempts >= props.hintAfterErrors) {
        state.hint = true;
        status.textContent += ` ${t.hint}`;
        host.emit('hint_shown', {});
      }
      return;
    }
    state.inspected.push(id);
    const faulty = id === props.failingDevice;
    status.textContent = faulty ? t.faulty(label(id)) : t.ok(label(id));
    host.emit('device_inspected', { device: id, inOrder: true, faulty });
    if (faulty) {
      state.found = true;
      status.textContent += ` ${t.done}`;
      host.emit('completed', { score: Math.max(0, 1 - 0.25 * state.attempts), attempts: state.attempts });
    }
    paintDevices();
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const onPointer = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(ORDER.map((id) => devices[id].mesh), false)[0];
    if (hit) inspect(hit.object.userData.id);
  };
  renderer.domElement.addEventListener('click', onPointer);

  function setPaused(v) { paused = v; paintDevices(); }

  // Frame the five devices whatever the aspect ratio: distance fitted to the scene width.
  const viewDir = new THREE.Vector3(0, 0.42, 1).normalize();
  function resize() {
    const w = Math.max(1, view.clientWidth);
    const h = Math.max(1, view.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
    const fitWidth = 8.6 / (Math.tan(halfV) * camera.aspect);
    const fitHeight = 2.6 / Math.tan(halfV);
    camera.position.copy(viewDir).multiplyScalar(Math.max(fitWidth, fitHeight));
    camera.lookAt(0, 0.5, 0);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(view);
  resize();

  // Packets travel from the workstation to the failing device and stop there.
  let clock = 0;
  function placePackets() {
    const stopIndex = ORDER.indexOf(props.failingDevice);
    const start = devices.poste.mesh.position;
    const end = devices[ORDER[stopIndex]].mesh.position;
    for (const p of packets) {
      const u = ctx.reducedMotion ? p.userData.phase : (p.userData.phase + clock * 0.12 * props.packetSpeed) % 1;
      p.position.lerpVectors(start, end, u);
      p.position.y = 1.05 + Math.sin(u * Math.PI) * 0.35;
      p.visible = !state.found || u < 0.98;
    }
  }

  const stop = host.onFrame((dt) => {
    if (!paused) clock += dt;
    placePackets();
    renderer.render(scene, camera);
  });

  applyProps();
  if (ctx.savedState) setState(ctx.savedState);

  function setState(s) {
    state.inspected = Array.isArray(s.inspected) ? s.inspected.filter((d) => ORDER.includes(d)) : [];
    state.attempts = Number(s.attempts) || 0;
    state.found = !!s.found;
    state.hint = !!s.hint;
    paintDevices();
  }

  return {
    update(next) { props = { ...props, ...next }; applyProps(); },
    getState() { return { inspected: [...state.inspected], attempts: state.attempts, found: state.found, hint: state.hint }; },
    setState,
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    dispose() {
      stop();
      ro.disconnect();
      renderer.domElement.removeEventListener('click', onPointer);
      container.removeEventListener('keydown', onKey);
      for (const d of disposables) d.dispose?.();
      renderer.dispose();
      container.innerHTML = '';
    }
  };
}
