// Free object "__TITLE__" — Elabora free-object contract 0.1 (see skill elabora-free-objects).
// Read every setting from props, time from host.onFrame, randomness from host.random.
import * as THREE from 'three';

export function mount(container, ctx) {
  const { host } = ctx;
  let props = { ...ctx.props };
  const state = { done: false, clicks: 0 };

  const instruction = document.createElement('p');
  instruction.style.cssText = `margin:0;padding:10px 14px;font:600 15px/1.4 ${ctx.tokens['font.body']};color:${ctx.tokens['color.text']}`;
  const view = document.createElement('div');
  view.style.cssText = 'position:absolute;inset:44px 0 56px 0';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'OK';
  button.style.cssText = `position:absolute;left:14px;bottom:8px;min-height:44px;padding:0 16px;border-radius:${ctx.tokens.radius}px;border:0;background:${ctx.tokens['color.primary']};color:${ctx.tokens['color.onPrimary']};font:inherit`;
  container.append(instruction, view, button);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: !!ctx.testMode });
  view.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.registerRenderer(renderer);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(ctx.tokens['color.surface']);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 50);
  camera.position.set(0, 1.5, 5);
  camera.lookAt(0, 0, 0);
  host.registerCamera(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.5));
  const geometry = new THREE.BoxGeometry(1.2, 1.2, 1.2);
  const material = new THREE.MeshStandardMaterial();
  const target = new THREE.Mesh(geometry, material);
  target.userData.id = 'target';
  scene.add(target);
  host.registerObject('target', target);

  function apply() {
    instruction.textContent = props.instruction;
    material.color = new THREE.Color(props.accentColor);
  }
  function activate() {
    if (state.done) return;
    state.clicks++;
    state.done = true;
    host.emit('completed', { score: 1 });
  }
  button.addEventListener('click', activate);
  renderer.domElement.addEventListener('click', activate);

  const resize = () => {
    const w = Math.max(1, view.clientWidth); const h = Math.max(1, view.clientHeight);
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(view);
  resize();
  const stop = host.onFrame((dt) => {
    if (!ctx.reducedMotion) target.rotation.y += dt * 0.6;
    renderer.render(scene, camera);
  });
  apply();
  if (ctx.savedState) Object.assign(state, ctx.savedState);

  return {
    update(next) { props = { ...props, ...next }; apply(); },
    getState() { return { ...state }; },
    setState(s) { Object.assign(state, s); },
    dispose() { stop(); ro.disconnect(); geometry.dispose(); material.dispose(); renderer.dispose(); container.innerHTML = ''; }
  };
}
