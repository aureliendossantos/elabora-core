// Runs inside the sandboxed iframe of a free object. Loaded after the vendored libraries and the
// compiled object (self.__elaboraObject.mount). Provides the `host` API of the contract:
//   emit, random, now, onFrame, asset, registerRenderer, registerCamera, registerObject, onSafeArea,
//   onContext, onView, requestHeight, log
// Time is driven by requestAnimationFrame normally, and only by object/step in test mode.
// At initialize the frame also receives the course theme: --t-* CSS variables, the UI kit
// (t-ui-* classes) and the embedded fonts (ArrayBuffers sent by the host: no network here).

import { cssVarsRule } from './tokens.ts';
import { OBJECT_UI_CSS } from './object-ui.css.ts';
import { formatMessage } from './message.ts';
import { fieldOf, isRecord, rpcError } from './json.ts';
import { createDryFrames } from './dry-frames.ts';
import type {
  DryReport, FrameCallback, FrameMethod, FrameMethods, ObjectApi, ObjectContext, ObjectHostApi, ObjectModule, ObjectView, RegisteredObject, RegisteredRenderer, SafeArea
} from './object-protocol.ts';

declare global {
  interface Window {
    // The compiled object.js (an esbuild bundle with this global name).
    __elaboraObject?: unknown;
  }
}

// What mount() and object.js export are checked: they come from the object code.
function isObjectModule(value: unknown): value is ObjectModule {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && 'mount' in value && typeof value.mount === 'function';
}
function isObjectApi(value: unknown): value is ObjectApi {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && 'getState' in value && typeof value.getState === 'function' && 'dispose' in value && typeof value.dispose === 'function';
}

(function () {
  const parentWindow = window.parent;
  const send = (message: Record<string, unknown>) => parentWindow.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const reply = (id: unknown, result: unknown) => send({ id, result: result === undefined ? null : result });
  const fail = (id: unknown, message: string) => send({ id, error: { code: -32000, message } });

  let api: ObjectApi | null = null;
  let paused = false;
  let testMode = false;
  let virtualTime = 0;
  let frame = 0;
  let animationFrame = 0;
  let lastTimestamp = 0;
  let renderer: RegisteredRenderer | null = null;
  let camera: unknown = null;
  const objects = new Map<string, RegisteredObject>();
  const frameCallbacks = new Set<FrameCallback>();
  const safeCallbacks = new Set<(area: SafeArea) => void>();
  const contextCallbacks = new Set<(context: ObjectContext | null) => void>();
  let context: ObjectContext | null = null;
  // Where the frame is in the course window (scroll-driven objects). Until the host says otherwise
  // (object tests, hosts that do not measure), the frame is wholly in view.
  const viewCallbacks = new Set<(view: ObjectView) => void>();
  let view: ObjectView = { visible: true, ratio: 1, progress: 0.5, entry: 1, exit: 0 };
  // Decorations (course backdrop) can be still: frames run for a moment after a change, then stop.
  // Still under reduced motion, or when the machine is too slow (below 24 frames per second).
  let decorative = false;
  let still = false;
  let awakeUntil = 0;
  let rateProbe: { frames: number; milliseconds: number } | null = null;
  let safeArea: SafeArea = { top: 0, right: 0, bottom: 0, left: 0 };
  // The object's words (ctx.strings), once initialised.
  let words: Record<string, string> | null = null;
  const assetRequests = new Map<string, { resolve: (data: ArrayBuffer) => void; reject: (error: Error) => void }>();
  let assetRequestCount = 0;

  // Each distinct error is reported once (a failing frame callback would repeat it 60 times a
  // second). "ResizeObserver loop …" is reported by browsers as a window error but is benign:
  // the notifications are delivered at the next frame.
  const reported = new Set<string>();
  const reportError = (message: string) => {
    if (/ResizeObserver loop/.test(message) || reported.has(message) || reported.size >= 20) return;
    reported.add(message);
    send({ method: 'object/error', params: { message } });
  };
  window.addEventListener('error', (event) => { const error: unknown = event.error; reportError(String(event.message || error)); });
  window.addEventListener('unhandledrejection', (event) => { const reason: unknown = event.reason; reportError(String(fieldOf(reason, 'message') || reason)); });

  // WebGL contexts created by the object (budget webglContexts), counted in test mode only: a 2D
  // canvas (a chart, a label texture) is not a WebGL context. Test mode also draws only the frames
  // a test looks at (dry-frames.ts).
  const dryFrames = createDryFrames();

  // mulberry32: small, fast, deterministic.
  function random(seed: number) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function runFrame(deltaSeconds: number) {
    frame++;
    for (const callback of [...frameCallbacks]) {
      try { callback(deltaSeconds, frame); } catch (e) { reportError(`onFrame: ${(e as Error).message}`); }
    }
  }

  function loop(timestamp: number) {
    animationFrame = requestAnimationFrame(loop);
    const deltaSeconds = lastTimestamp ? Math.min(0.1, (timestamp - lastTimestamp) / 1000) : 1 / 60;
    // Hidden tabs and long pauses (a tab switch) say nothing about the machine.
    if (rateProbe && lastTimestamp && !document.hidden && timestamp - lastTimestamp < 250) measureRate(timestamp - lastTimestamp);
    lastTimestamp = timestamp;
    if (document.hidden) return;
    runFrame(paused ? 0 : deltaSeconds);
    if (still && timestamp > awakeUntil) stopLoop();
  }
  // A decoration measures its frame rate once (after its first frames) and freezes if it is low.
  function measureRate(milliseconds: number) {
    if (!rateProbe) return;
    rateProbe.frames++;
    if (rateProbe.frames <= 30) return;
    rateProbe.milliseconds += milliseconds;
    if (rateProbe.frames < 120) return;
    const framesPerSecond = 1000 / (rateProbe.milliseconds / 90);
    rateProbe = null;
    if (framesPerSecond < 24) { still = true; awakeUntil = 0; send({ method: 'object/log', params: { level: 'info', message: `frozen: ${Math.round(framesPerSecond)} frames per second` } }); }
  }
  function wake(milliseconds = 1000) {
    awakeUntil = performance.now() + milliseconds;
    startLoop();
  }

  function startLoop() {
    if (!testMode && !animationFrame) { lastTimestamp = 0; animationFrame = requestAnimationFrame(loop); }
  }
  function stopLoop() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }

  const host: ObjectHostApi = {
    emit(name, payload) { send({ method: 'object/event', params: { name, payload: payload || {} } }); },
    random: null,
    now() { return testMode ? virtualTime : performance.now(); },
    onFrame(callback) { frameCallbacks.add(callback); return () => frameCallbacks.delete(callback); },
    asset(id) {
      return new Promise((resolve, reject) => {
        const requestId = `f${++assetRequestCount}`;
        assetRequests.set(requestId, { resolve, reject });
        send({ id: requestId, method: 'object/asset', params: { id } });
      });
    },
    registerRenderer(registered) { renderer = registered; },
    registerCamera(registered) { camera = registered; },
    registerObject(id, object) { objects.set(id, object); },
    // Part of the frame covered by the course layout (px from each edge): keep key content out of it.
    onSafeArea(callback) { safeCallbacks.add(callback); return () => safeCallbacks.delete(callback); },
    // Where the learner is ({ screen, section, step, variant }), for decorations of the backdrop.
    onContext(callback) { contextCallbacks.add(callback); return () => contextCallbacks.delete(callback); },
    // Where the frame is in the window ({ visible, ratio, progress, entry, exit }), when it changes.
    onView(callback) { viewCallbacks.add(callback); return () => viewCallbacks.delete(callback); },
    // Height wanted by the object when its block uses aspectRatio "auto" (ignored otherwise).
    requestHeight(px) { if (Number.isFinite(px) && px > 0) send({ method: 'object/resize', params: { height: Math.round(px) } }); },
    log(...values) { send({ method: 'object/log', params: { level: 'info', message: values.map(String).join(' ') } }); }
  };

  function objectClientPoint(id: string) {
    const object = objects.get(id);
    if (!object || !camera || !renderer) return null;
    object.updateWorldMatrix?.(true, false);
    const position = object.getWorldPosition(new object.position.constructor());
    position.project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((position.x + 1) / 2) * rect.width, y: rect.top + ((1 - position.y) / 2) * rect.height };
  }

  function dispatchClick(x: number, y: number) {
    const target = document.elementFromPoint(x, y) || renderer?.domElement || document.body;
    const options = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', options));
    target.dispatchEvent(new PointerEvent('pointerup', options));
    target.dispatchEvent(new MouseEvent('click', options));
  }

  // 1rem inside the frame is 1rem of the course page: the UI kit and objects written in rem follow
  // the size classes of the player (the frame's own media queries only see the frame).
  function setRootSize(px: number | undefined) { if (typeof px === 'number' && Number.isFinite(px) && px > 0) document.documentElement.style.fontSize = `${px}px`; }

  type Handlers = { [M in FrameMethod]: (params: FrameMethods[M]) => unknown };
  const handlers: Handlers = {
    async 'object/initialize'(params) {
      testMode = !!params.testMode;
      if (testMode) dryFrames.install();
      host.random = random(params.seed || 1);
      const module = self.__elaboraObject;
      if (!isObjectModule(module)) throw new Error('object.js does not export mount()');
      const style = document.createElement('style');
      style.id = 'elabora-theme';
      // In tests time is virtual (frames advance on object/step): CSS transitions and animations of
      // the object's DOM would run on the clock and be caught half-way by snapshots and axe. They
      // end at once (zero duration: animationend still fires).
      const settled = testMode ? '\n*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; }' : '';
      style.textContent = `${cssVarsRule(params.tokens || {})}\n${OBJECT_UI_CSS}${settled}`;
      document.head.prepend(style);
      setRootSize(params.rootSize);
      for (const font of params.fonts || []) {
        try {
          const face = new FontFace(font.family, font.data, { weight: font.weight || '400', style: font.style || 'normal', ...(font.unicodeRange ? { unicodeRange: font.unicodeRange } : {}) });
          document.fonts.add(face);
          await face.load();
        } catch (e) { send({ method: 'object/log', params: { level: 'warn', message: `font ${font.family}: ${(e as Error).message}` } }); }
      }
      // frame.html (generated with the package) always has it.
      const root = document.getElementById('root');
      if (!root) throw new Error('frame.html has no #root element');
      safeArea = { ...safeArea, ...(params.safeArea || {}) };
      decorative = !!params.decorative;
      context = params.context || null;
      if (params.view) view = { ...view, ...params.view };
      // Words of the object (manifest strings, as reworded or translated by the block; replaced in
      // place by the arriving block's when the object carries on to another screen, D65).
      const strings: Record<string, string> = { ...(params.strings || {}) };
      words = strings;
      const missing = new Set<string>();
      const t = (key: string, values?: Record<string, unknown>) => {
        if (strings[key] === undefined) {
          if (!missing.has(key)) { missing.add(key); send({ method: 'object/log', params: { level: 'warn', message: `string "${key}" is not declared in the manifest` } }); }
          return key;
        }
        return formatMessage(strings[key], values, params.locale || 'en');
      };
      const mounted = module.mount(root, {
        strings, t,
        props: params.props, host, seed: params.seed, locale: params.locale, reducedMotion: !!params.reducedMotion, safeArea: { ...safeArea }, context, view: { ...view },
        testMode, tokens: params.tokens || {}, objects: params.objects || [], savedState: params.savedState || null
      });
      if (!isObjectApi(mounted)) throw new Error('mount() must return { update, getState, setState, dispose }');
      api = mounted;
      if (decorative && !testMode) {
        if (params.reducedMotion) still = true; else rateProbe = { frames: 0, milliseconds: 0 };
      }
      if (still) wake(1500); else startLoop();
      if (testMode) runFrame(0);
      return { manifestVersion: '0.1' };
    },
    'object/set-root-size'(params) { setRootSize(params.rootSize); },
    'object/safe-area'(params) {
      safeArea = { top: 0, right: 0, bottom: 0, left: 0, ...(params.safeArea || {}) };
      for (const callback of [...safeCallbacks]) callback({ ...safeArea });
      if (testMode) runFrame(0); else if (still) wake();
    },
    'object/update-props'(params) {
      // The block carries on from another screen (D65): its words and its safe area first, so that
      // the object moves to settings that are whole.
      if (params.strings && words) { for (const key of Object.keys(words)) delete words[key]; Object.assign(words, params.strings); }
      if (params.safeArea) {
        safeArea = { top: 0, right: 0, bottom: 0, left: 0, ...params.safeArea };
        for (const callback of [...safeCallbacks]) callback({ ...safeArea });
      }
      if (params.transition) api?.update?.(params.props, params.transition); else api?.update?.(params.props);
      if (testMode) runFrame(0); else if (still) wake();
    },
    'object/context'(params) {
      context = params.context || null;
      for (const callback of [...contextCallbacks]) callback(context);
      if (testMode) runFrame(0); else if (still) wake();
    },
    'object/view'(params) {
      view = { ...view, ...(params.view || {}) };
      for (const callback of [...viewCallbacks]) callback({ ...view });
      if (testMode) runFrame(0); else if (still) wake();
    },
    // A paused decoration stops drawing altogether (screen without backdrop).
    'object/pause'() { paused = true; api?.pause?.(); if (decorative) stopLoop(); },
    'object/resume'() { paused = false; api?.resume?.(); if (decorative && !testMode) { if (still) wake(); else startLoop(); } },
    'object/get-state'() { return api?.getState(); },
    'object/set-state'(params) { api?.setState?.(params.state); if (testMode) runFrame(0); return true; },
    async 'object/step'(params) {
      const count = Math.max(1, Math.min(10000, params.frames | 0));
      for (let index = 0; index < count; index++) { virtualTime += 1000 / 60; runFrame(1 / 60); }
      if (testMode) await dryFrames.settle();
      return { frame };
    },
    'object/perf'() {
      const info = renderer?.info;
      const gl = renderer?.getContext?.();
      return {
        drawCalls: info?.render?.calls ?? null,
        triangles: info?.render?.triangles ?? null,
        textures: info?.memory?.textures ?? null,
        geometries: info?.memory?.geometries ?? null,
        maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null,
        webglContexts: dryFrames.contexts(),
        contextLost: dryFrames.lost()
      };
    },
    'object/test-click'(params) {
      let point: { x: number; y: number } | null = null;
      if (params.object) point = objectClientPoint(params.object);
      else if (params.at && renderer) {
        const rect = renderer.domElement.getBoundingClientRect();
        point = { x: rect.left + params.at[0] * rect.width, y: rect.top + params.at[1] * rect.height };
      }
      if (!point) throw new Error(`Cannot click ${params.object || JSON.stringify(params.at)}: object not registered or no renderer/camera`);
      dispatchClick(point.x, point.y);
      if (testMode) runFrame(0);
      return point;
    },
    'object/test-key'(params) {
      const target = document.activeElement || document.body;
      for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, { key: params.key, bubbles: true, cancelable: true }));
      if (params.key === 'Tab') {
        const focusables = [...document.querySelectorAll<HTMLElement>('a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]')].filter((element) => !('disabled' in element && element.disabled));
        const index = focusables.findIndex((element) => element === document.activeElement);
        focusables[(index + 1) % focusables.length]?.focus();
      }
      return { active: document.activeElement?.textContent?.trim().slice(0, 60) || document.activeElement?.tagName };
    },
    'object/test-dry'(params): DryReport {
      dryFrames.setDry(testMode && params.dry ? (params.drawOffscreen ? 'canvas' : 'all') : false);
      return dryFrames.report();
    },
    'object/dispose'() {
      stopLoop();
      frameCallbacks.clear();
      try { api?.dispose(); } catch (e) { reportError(`dispose: ${(e as Error).message}`); }
      api = null;
    }
  };
  const isFrameMethod = (method: unknown): method is FrameMethod => typeof method === 'string' && Object.prototype.hasOwnProperty.call(handlers, method);
  const run = <M extends FrameMethod>(method: M, params: FrameMethods[M]) => handlers[method](params);

  window.addEventListener('message', (event) => {
    if (event.source !== parentWindow) return;
    const message: unknown = event.data;
    if (!isRecord(message) || message.jsonrpc !== '2.0') return;
    const id = message.id;
    const asset = typeof id === 'string' ? assetRequests.get(id) : undefined;
    if (typeof id === 'string' && asset) {
      assetRequests.delete(id);
      // The host answers with the bytes of the asset.
      if (message.error) asset.reject(rpcError(message.error)); else asset.resolve(fieldOf(message.result, 'data') as ArrayBuffer);
      return;
    }
    const method = message.method;
    if (!isFrameMethod(method)) { if (id) fail(id, `Unknown method ${String(method)}`); return; }
    // Only the parent, the host, is listened to: its params follow the protocol (object-protocol.ts).
    const params = (message.params || {}) as FrameMethods[typeof method];
    Promise.resolve().then(() => run(method, params)).then(
      (result) => { if (id) reply(id, result); },
      (error: Error) => { if (id) fail(id, error.message); else reportError(error.message); }
    );
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) lastTimestamp = 0; });
  send({ method: 'object/ready' });
})();
