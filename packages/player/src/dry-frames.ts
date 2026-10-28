// Object tests only (test mode of the frame). Software WebGL, which the gates use so that snapshots
// have the same pixels on every machine, spends nearly all its time drawing frames, and a test
// looks at very few of them: the last frame before each snapshot. The host runs the others dry:
// their draws, clears and blits are skipped, everything else runs (the object's code, uploads,
// shaders and their errors). What a skipped operation would have drawn is tracked as stale (the
// canvas, the textures and renderbuffers of framebuffers), and anything that would show it or use
// it makes the run unsafe: a draw on a stale framebuffer or sampling a stale texture, a read of a
// stale drawing (readPixels, a copy, a WebGL canvas drawn into a 2D canvas or uploaded…), a query
// or getError after a skipped draw, transform feedback. The host then runs the test again with
// every frame drawn, as do snapshots of a canvas left stale. When only the drawing of a framebuffer
// other than the canvas was at fault (a texture baked over the first frames, a render target drawn
// over), it first tries again skipping only the draws on the canvas.

import type { DryReport } from './object-protocol.ts';

const COLOR_BUFFER_BIT = 0x4000;
const DEPTH_BUFFER_BIT = 0x100;
const STENCIL_BUFFER_BIT = 0x400;
const FRAMEBUFFER = 0x8d40;
const READ_FRAMEBUFFER = 0x8ca8;
const DRAW_FRAMEBUFFER = 0x8ca9;
const SCISSOR_TEST = 0x0c11;
const TEXTURE0 = 0x84c0;
const COLOR_ATTACHMENT0 = 0x8ce0;
const DEPTH_ATTACHMENT = 0x8d00;
const STENCIL_ATTACHMENT = 0x8d20;
const DEPTH_STENCIL_ATTACHMENT = 0x821a;
const COLOR = 0x1800;
const DEPTH = 0x1801;
const STENCIL = 0x1802;
const DEPTH_STENCIL = 0x84f9;
const BACK = 0x0405;
const ACTIVE_UNIFORMS = 0x8b86;
// Sampler uniform types by the texture target they read.
const TEXTURE_2D = 0x0de1;
const TEXTURE_CUBE_MAP = 0x8513;
const TEXTURE_3D = 0x806f;
const TEXTURE_2D_ARRAY = 0x8c1a;
const SAMPLERS = new Map<number, number>([
  [0x8b5e, TEXTURE_2D], [0x8b62, TEXTURE_2D], [0x8dca, TEXTURE_2D], [0x8dd2, TEXTURE_2D],
  [0x8b60, TEXTURE_CUBE_MAP], [0x8dc5, TEXTURE_CUBE_MAP], [0x8dcc, TEXTURE_CUBE_MAP], [0x8dd4, TEXTURE_CUBE_MAP],
  [0x8b5f, TEXTURE_3D], [0x8dcb, TEXTURE_3D], [0x8dd3, TEXTURE_3D],
  [0x8dc1, TEXTURE_2D_ARRAY], [0x8dc4, TEXTURE_2D_ARRAY], [0x8dcf, TEXTURE_2D_ARRAY], [0x8dd7, TEXTURE_2D_ARRAY]
]);
const FRONT = 0x0404;
const FRONT_AND_BACK = 0x0408;

type Method = (this: unknown, ...args: unknown[]) => unknown;
type Gl = WebGLRenderingContextBase;
// What a framebuffer draws into: textures and renderbuffers by attachment point (the default
// framebuffer's own buffers are tokens of its context).
type Surfaces = Map<number, object>;

interface Tracked {
  gl: Gl;
  canvas: object;
  surfaces: Surfaces; // of the default framebuffer
  draw: Surfaces;
  read: Surfaces;
  unit: number;
  bound: Map<string, WebGLTexture>; // "unit:target" → texture
  program: object | null;
  scissor: boolean;
  colorMask: boolean; // all four channels written
  depthMask: boolean;
  stencilMask: boolean; // all bits of the front face written
  feedback: boolean; // transform feedback running
}

export interface DryFrames {
  // Wraps getContext: WebGL contexts the object creates from now on are counted and tracked.
  install(): void;
  contexts(): number;
  // Whether a WebGL context the object made was lost (the browser's GPU process gave way): it draws nothing more.
  lost(): boolean;
  // Frames from now on: drawn (false), dry ('all'), or dry on the canvas only ('canvas').
  setDry(dry: false | 'all' | 'canvas'): void;
  report(): DryReport;
  // Waits until the frames drawn so far are on the canvas.
  settle(): Promise<void>;
}

export function createDryFrames(): DryFrames {
  let dry: false | 'all' | 'canvas' = false;
  let skipped = 0;
  let unsafe: string | null = null;
  let offscreen = false;
  const tracked: Tracked[] = [];
  const byCanvas = new WeakMap<object, Tracked>();
  const stale = new WeakSet<object>();
  const framebuffers = new WeakMap<object, Surfaces>();
  const customDrawBuffers = new WeakSet<Surfaces>();
  const instrumented = new WeakSet<object>();
  // Integer uniforms set per program (sampler units among them), by name; the names of locations.
  const integers = new WeakMap<object, Map<string, number[]>>();
  const locations = new WeakMap<object, { program: object; name: string; index: number }>();
  const samplers = new WeakMap<object, { name: string; size: number; target: number }[]>();

  const wrap = (target: object, name: string, around: (original: Method, self: unknown, args: unknown[]) => unknown) => {
    const original: unknown = Reflect.get(target, name);
    if (typeof original === 'function') Reflect.set(target, name, function (this: unknown, ...args: unknown[]) { return around(original as Method, this, args); });
  };
  // offscreen: only the drawing of a framebuffer other than the canvas is at fault.
  const flag = (reason: string, offscreenOnly = false) => { if (!unsafe) { unsafe = reason; offscreen = offscreenOnly; } };
  const anyStale = (surfaces: Surfaces) => { for (const surface of surfaces.values()) if (stale.has(surface)) return true; return false; };
  const canvasStale = (source: unknown) => {
    const track = typeof source === 'object' && source !== null ? byCanvas.get(source) : undefined;
    return !!track && anyStale(track.surfaces);
  };

  function track(gl: Gl, canvas: object) {
    const surfaces: Surfaces = new Map([[COLOR_ATTACHMENT0, {}]]);
    const attributes = gl.getContextAttributes();
    if (attributes?.depth) surfaces.set(DEPTH_ATTACHMENT, {});
    if (attributes?.stencil) surfaces.set(STENCIL_ATTACHMENT, {});
    const t: Tracked = { gl, canvas, surfaces, draw: surfaces, read: surfaces, unit: 0, bound: new Map(), program: null, scissor: false, colorMask: true, depthMask: true, stencilMask: true, feedback: false };
    tracked.push(t);
    byCanvas.set(canvas, t);
    const surfacesOf = (framebuffer: unknown): Surfaces => {
      if (typeof framebuffer !== 'object' || framebuffer === null) return surfaces;
      let found = framebuffers.get(framebuffer);
      if (!found) { found = new Map(); framebuffers.set(framebuffer, found); }
      return found;
    };
    const target = (which: unknown) => (which === READ_FRAMEBUFFER ? t.read : t.draw);

    // State that decides what a clear covers, what a draw writes to and what it samples.
    wrap(gl, 'bindFramebuffer', (original, self, args) => {
      const bound = surfacesOf(args[1]);
      if (args[0] === FRAMEBUFFER || args[0] === DRAW_FRAMEBUFFER) t.draw = bound;
      if (args[0] === FRAMEBUFFER || args[0] === READ_FRAMEBUFFER) t.read = bound;
      return original.apply(self, args);
    });
    const attach = (original: Method, self: unknown, args: unknown[], surface: unknown) => {
      const into = target(args[0]);
      const point = Number(args[1]);
      if (typeof surface === 'object' && surface !== null) into.set(point, surface); else into.delete(point);
      return original.apply(self, args);
    };
    wrap(gl, 'framebufferTexture2D', (original, self, args) => attach(original, self, args, args[3]));
    wrap(gl, 'framebufferTextureLayer', (original, self, args) => attach(original, self, args, args[2]));
    wrap(gl, 'framebufferRenderbuffer', (original, self, args) => attach(original, self, args, args[3]));
    wrap(gl, 'drawBuffers', (original, self, args) => {
      const buffers = Array.isArray(args[0]) ? args[0] : [];
      const defaults = t.draw === surfaces ? [BACK] : [COLOR_ATTACHMENT0];
      if (buffers.length !== 1 || buffers[0] !== defaults[0]) customDrawBuffers.add(t.draw); else customDrawBuffers.delete(t.draw);
      return original.apply(self, args);
    });
    // Deleting what is bound unbinds it.
    wrap(gl, 'deleteFramebuffer', (original, self, args) => {
      const deleted = typeof args[0] === 'object' && args[0] !== null ? framebuffers.get(args[0]) : undefined;
      if (deleted && t.draw === deleted) t.draw = surfaces;
      if (deleted && t.read === deleted) t.read = surfaces;
      return original.apply(self, args);
    });
    wrap(gl, 'deleteTexture', (original, self, args) => {
      for (const [key, texture] of t.bound) if (texture === args[0]) t.bound.delete(key);
      return original.apply(self, args);
    });
    wrap(gl, 'activeTexture', (original, self, args) => { t.unit = Number(args[0]) - TEXTURE0; return original.apply(self, args); });
    wrap(gl, 'bindTexture', (original, self, args) => {
      const key = `${t.unit}:${String(args[0])}`;
      if (typeof args[1] === 'object' && args[1] !== null) t.bound.set(key, args[1]); else t.bound.delete(key);
      return original.apply(self, args);
    });
    // What a program samples, to tell a stale texture it reads from one merely left bound.
    wrap(gl, 'useProgram', (original, self, args) => { t.program = typeof args[0] === 'object' ? args[0] : null; return original.apply(self, args); });
    wrap(gl, 'linkProgram', (original, self, args) => { if (typeof args[0] === 'object' && args[0] !== null) samplers.delete(args[0]); return original.apply(self, args); });
    wrap(gl, 'getUniformLocation', (original, self, args) => {
      const location = original.apply(self, args);
      const element = /^(.*)\[(\d+)\]$/.exec(String(args[1]));
      if (typeof location === 'object' && location !== null && typeof args[0] === 'object' && args[0] !== null) locations.set(location, { program: args[0], name: element ? element[1] : String(args[1]), index: element ? Number(element[2]) : 0 });
      return location;
    });
    const setIntegers = (location: unknown, values: number[]) => {
      const known = typeof location === 'object' && location !== null ? locations.get(location) : undefined;
      if (!known) return;
      let set = integers.get(known.program);
      if (!set) { set = new Map(); integers.set(known.program, set); }
      const array = set.get(known.name) || [];
      values.forEach((value, offset) => { array[known.index + offset] = value; });
      set.set(known.name, array);
    };
    wrap(gl, 'uniform1i', (original, self, args) => { setIntegers(args[0], [Number(args[1])]); return original.apply(self, args); });
    wrap(gl, 'uniform1iv', (original, self, args) => {
      const data = args[1];
      const offset = Number(args[2]) || 0;
      const values = typeof data === 'object' && data !== null && 'length' in data ? Array.from(data as ArrayLike<number>).slice(offset, args[3] ? offset + Number(args[3]) : undefined) : [];
      setIntegers(args[0], values);
      return original.apply(self, args);
    });
    // The textures the current program samples: for each of its sampler uniforms (unit 0 unless
    // set), the texture bound to that unit for its target. Without a program: every bound texture.
    const sampled = (): WebGLTexture[] => {
      const program = t.program;
      if (!program) return [...t.bound.values()];
      let list = samplers.get(program);
      if (!list) {
        list = [];
        const count = Number(gl.getProgramParameter(program as WebGLProgram, ACTIVE_UNIFORMS)) || 0;
        for (let index = 0; index < count; index++) {
          const info = gl.getActiveUniform(program as WebGLProgram, index);
          const target = info ? SAMPLERS.get(info.type) : undefined;
          if (info && target) list.push({ name: info.name.replace(/\[0\]$/, ''), size: info.size, target });
        }
        samplers.set(program, list);
      }
      const textures: WebGLTexture[] = [];
      const units = integers.get(program);
      for (const sampler of list) {
        const set = units?.get(sampler.name) || [];
        for (let index = 0; index < sampler.size; index++) {
          const texture = t.bound.get(`${set[index] ?? 0}:${sampler.target}`);
          if (texture) textures.push(texture);
        }
      }
      return textures;
    };
    const capability = (on: boolean) => (original: Method, self: unknown, args: unknown[]) => { if (args[0] === SCISSOR_TEST) t.scissor = on; return original.apply(self, args); };
    wrap(gl, 'enable', capability(true));
    wrap(gl, 'disable', capability(false));
    wrap(gl, 'colorMask', (original, self, args) => { t.colorMask = args.every(Boolean); return original.apply(self, args); });
    wrap(gl, 'depthMask', (original, self, args) => { t.depthMask = !!args[0]; return original.apply(self, args); });
    wrap(gl, 'stencilMask', (original, self, args) => { t.stencilMask = (Number(args[0]) & 0xff) === 0xff; return original.apply(self, args); });
    wrap(gl, 'stencilMaskSeparate', (original, self, args) => { if (args[0] === FRONT || args[0] === FRONT_AND_BACK) t.stencilMask = (Number(args[1]) & 0xff) === 0xff; return original.apply(self, args); });
    for (const [name, on] of [['beginTransformFeedback', true], ['resumeTransformFeedback', true], ['endTransformFeedback', false], ['pauseTransformFeedback', false]] as const) {
      wrap(gl, name, (original, self, args) => { t.feedback = on; return original.apply(self, args); });
    }

    // Skipped while dry: the framebuffer drawn into is then stale. Drawn: it must not show or use
    // a stale drawing.
    const markDrawn = () => { for (const surface of t.draw.values()) stale.add(surface); };
    const skipping = () => dry === 'all' || (dry === 'canvas' && t.draw === surfaces);
    const draw = (original: Method, self: unknown, args: unknown[]) => {
      if (skipping()) {
        if (t.feedback) flag('transform feedback in a dry frame');
        skipped++;
        markDrawn();
        return undefined;
      }
      if (anyStale(t.draw)) flag('a frame drawn over a drawing a dry frame skipped', t.draw !== surfaces);
      if ([...t.bound.values()].some((texture) => stale.has(texture)) && sampled().some((texture) => stale.has(texture))) flag('a texture drawn in a dry frame used by a later draw', true);
      return original.apply(self, args);
    };
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) wrap(gl, name, draw);
    // A clear makes fresh what it covers wholly.
    const cleared = (bits: number) => {
      if (t.scissor) return;
      for (const [point, surface] of t.draw) {
        const covered = point === DEPTH_STENCIL_ATTACHMENT ? (bits & DEPTH_BUFFER_BIT) && (bits & STENCIL_BUFFER_BIT) && t.depthMask && t.stencilMask
          : point === DEPTH_ATTACHMENT ? (bits & DEPTH_BUFFER_BIT) && t.depthMask
          : point === STENCIL_ATTACHMENT ? (bits & STENCIL_BUFFER_BIT) && t.stencilMask
          : point === COLOR_ATTACHMENT0 && (bits & COLOR_BUFFER_BIT) && t.colorMask && !customDrawBuffers.has(t.draw);
        if (covered) stale.delete(surface);
      }
    };
    wrap(gl, 'clear', (original, self, args) => {
      if (skipping()) { skipped++; markDrawn(); return undefined; }
      cleared(Number(args[0]));
      return original.apply(self, args);
    });
    for (const name of ['clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi']) {
      wrap(gl, name, (original, self, args) => {
        if (skipping()) { skipped++; markDrawn(); return undefined; }
        const buffer = args[0];
        if (buffer === COLOR && args[1] === 0) cleared(COLOR_BUFFER_BIT);
        else if (buffer === DEPTH) cleared(DEPTH_BUFFER_BIT);
        else if (buffer === STENCIL) cleared(STENCIL_BUFFER_BIT);
        else if (buffer === DEPTH_STENCIL) cleared(DEPTH_BUFFER_BIT | STENCIL_BUFFER_BIT);
        return original.apply(self, args);
      });
    }
    wrap(gl, 'blitFramebuffer', (original, self, args) => {
      if (anyStale(t.read)) flag('blitFramebuffer of a drawing a dry frame skipped', t.read !== surfaces);
      if (skipping()) { skipped++; markDrawn(); return undefined; }
      return original.apply(self, args);
    });
    // Reads of the framebuffer.
    for (const name of ['readPixels', 'copyTexImage2D', 'copyTexSubImage2D', 'copyTexSubImage3D']) {
      wrap(gl, name, (original, self, args) => { if (anyStale(t.read)) flag(`${name} of a drawing a dry frame skipped`, t.read !== surfaces); return original.apply(self, args); });
    }
    // Answers that skipped draws would change.
    for (const name of ['getQueryParameter', 'getError']) {
      wrap(gl, name, (original, self, args) => { if (skipped) flag(`${name} after a dry frame`); return original.apply(self, args); });
    }
    for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']) {
      wrap(gl, name, (original, self, args) => { if (args.some(canvasStale)) flag(`${name} of a WebGL canvas a dry frame left stale`); return original.apply(self, args); });
    }
    // Extensions draw (ANGLE_instanced_arrays, WEBGL_multi_draw…), set draw buffers and query too.
    wrap(gl, 'getExtension', (original, self, args) => {
      const extension = original.apply(self, args);
      if (typeof extension === 'object' && extension !== null && !instrumented.has(extension)) {
        instrumented.add(extension);
        for (const name in extension) {
          if (/^(multiD|d)raw(Arrays|Elements|RangeElements)/.test(name)) wrap(extension, name, draw);
          else if (/^drawBuffers/.test(name)) wrap(extension, name, (original, self, args) => { customDrawBuffers.add(t.draw); return original.apply(self, args); });
          else if (/^(getQuery|beginQuery)/.test(name)) wrap(extension, name, (original, self, args) => { if (skipped) flag(`${name} after a dry frame`); return original.apply(self, args); });
        }
      }
      return extension;
    });
  }

  return {
    install() {
      const prototypes: ({ getContext?(this: object, type: string, ...rest: unknown[]): unknown } | undefined)[] = [self.HTMLCanvasElement?.prototype, self.OffscreenCanvas?.prototype];
      for (const prototype of prototypes) {
        const getContext = prototype?.getContext;
        if (!prototype || !getContext) continue;
        prototype.getContext = function (type, ...rest) {
          const created = getContext.call(this, type, ...rest);
          if (created && /^(webgl2?|experimental-webgl)$/.test(type) && !byCanvas.has(this)) track(created as Gl, this);
          return created;
        };
      }
      // A WebGL canvas read as an image.
      const ofStaleCanvas = (name: string) => (original: Method, self: unknown, args: unknown[]) => { if (canvasStale(self)) flag(`${name} of a WebGL canvas a dry frame left stale`); return original.apply(self, args); };
      const withStaleCanvas = (name: string) => (original: Method, self: unknown, args: unknown[]) => { if (args.some(canvasStale)) flag(`${name} of a WebGL canvas a dry frame left stale`); return original.apply(self, args); };
      if (self.HTMLCanvasElement) for (const name of ['toDataURL', 'toBlob', 'captureStream']) wrap(self.HTMLCanvasElement.prototype, name, ofStaleCanvas(name));
      if (self.OffscreenCanvas) for (const name of ['convertToBlob', 'transferToImageBitmap']) wrap(self.OffscreenCanvas.prototype, name, ofStaleCanvas(name));
      for (const context of [self.CanvasRenderingContext2D, self.OffscreenCanvasRenderingContext2D]) {
        if (context) for (const name of ['drawImage', 'createPattern']) wrap(context.prototype, name, withStaleCanvas(name));
      }
      wrap(self, 'createImageBitmap', withStaleCanvas('createImageBitmap'));
      const Frame = self.VideoFrame;
      if (Frame) {
        Reflect.set(self, 'VideoFrame', new Proxy(Frame, {
          construct(target, args: unknown[], newTarget) {
            if (args.some(canvasStale)) flag('VideoFrame of a WebGL canvas a dry frame left stale');
            return Reflect.construct(target, args, newTarget);
          }
        }));
      }
    },
    contexts: () => tracked.length,
    lost: () => tracked.some(({ gl }) => gl.isContextLost()),
    setDry(next) { dry = next; },
    report() {
      // A canvas on the page that shows a drawing older than its last frame.
      const shown = tracked.some((t) => {
        const colour = t.surfaces.get(COLOR_ATTACHMENT0);
        return t.canvas instanceof HTMLCanvasElement && t.canvas.isConnected && !!colour && stale.has(colour);
      });
      return { skipped, unsafe, offscreen: unsafe !== null && offscreen, stale: shown };
    },
    async settle() {
      // A fence per WebGL 2 context: gl.finish() is only a flush in Chrome. WebGL 1 is not waited for.
      const fences: [WebGL2RenderingContext, WebGLSync][] = [];
      for (const { gl } of tracked) {
        if (!(gl instanceof WebGL2RenderingContext) || gl.isContextLost()) continue;
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (fence) { gl.flush(); fences.push([gl, fence]); }
      }
      for (const [gl, fence] of fences) {
        while (!gl.isContextLost() && gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) await new Promise((resolve) => setTimeout(resolve, 5));
        gl.deleteSync(fence);
      }
    }
  };
}
