// The free-object contract (docs/free-object-contract.md), as types: the JSON-RPC 2.0 messages the
// host (object-host.ts) and the frame (object-frame.ts) exchange, and the API the frame gives to
// the object code (mount, ctx, host). Types only.

import type { JsonObject, JsonValue } from './json.ts';
import type { ObjectPart, TokenValues } from './course-data.ts';

// Px of the frame covered by the course layout, from each edge.
export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// Where the frame is in the course window, for objects that follow the scroll (an entrance as the
// learner scrolls to them). Measured on the frame's box against the window, like a CSS view()
// timeline: progress runs from 0, when its top reaches the bottom of the window, to 1, when its
// bottom leaves the top (range cover); entry from 0 to 1 while it comes in from below (1 once it
// is wholly in the window, or fills it); exit from 0 to 1 while it leaves at the top.
export interface ObjectView {
  visible: boolean; // some of the frame is in the window
  ratio: number; // share of the frame's height in the window, 0..1
  progress: number;
  entry: number;
  exit: number;
}

// Where the learner is, for decorations of the backdrop.
export interface ObjectContext {
  screen: string | null;
  section: string | null;
  step: number;
  variant: string | null;
}

// A block that carries on from one screen to another (docs/decisions.md D65): the object receives
// the arriving block's props with this hint, to move its camera, its scene and its controls over the
// same time as its frame glides. duration is in ms, 0 under less motion asked (a cut); direction
// says whether the learner went forward in the course or back.
export interface ObjectTransition {
  from: { screen: string; block: string };
  to: { screen: string; block: string };
  direction: 'forward' | 'back';
  duration: number;
  reducedMotion: boolean;
}

// An embedded font, sent as bytes: the frame has no network.
export interface FontPayload {
  family: string;
  weight: string;
  style: string;
  unicodeRange?: string;
  data: ArrayBuffer;
}

export interface LogEntry {
  level: string;
  message: string;
}

export interface InitializeParams {
  props: JsonObject;
  strings: Record<string, string>;
  seed: number;
  locale: string;
  reducedMotion: boolean;
  tokens: TokenValues;
  testMode: boolean;
  rootSize?: number;
  // What the object's getState() returned in an earlier session, or null.
  savedState: unknown;
  // Sides left out are 0 (object tests may give only some).
  safeArea: Partial<SafeArea>;
  decorative: boolean;
  context: ObjectContext | null;
  // Where the frame is in the window when it starts (default: wholly in view).
  view?: ObjectView;
  objects: ObjectPart[];
  fonts: FontPayload[];
}

// test-click: a declared object by id, or a point of the renderer in 0..1 coordinates.
export interface TestClickTarget {
  object?: string;
  at?: [number, number];
}

// Params of the methods the host sends to the frame (requests and notifications).
export interface FrameMethods {
  'object/initialize': InitializeParams;
  'object/set-root-size': { rootSize: number };
  'object/safe-area': { safeArea: Partial<SafeArea> };
  // With transition (D65): the arriving block's props, its words (strings) and its safe area, applied
  // before update(props, transition) is called.
  'object/update-props': { props: JsonObject; strings?: Record<string, string>; safeArea?: Partial<SafeArea>; transition?: ObjectTransition };
  'object/context': { context: ObjectContext };
  'object/view': { view: ObjectView };
  'object/pause': Record<string, never>;
  'object/resume': Record<string, never>;
  'object/get-state': Record<string, never>;
  'object/set-state': { state: JsonValue };
  'object/step': { frames: number };
  'object/perf': Record<string, never>;
  'object/test-click': TestClickTarget;
  'object/test-key': { key: string };
  // dry: frames from now on skip their draws; drawOffscreen: but not those on other framebuffers
  // than the canvas.
  'object/test-dry': { dry: boolean; drawOffscreen?: boolean };
  'object/dispose': Record<string, never>;
}

// What test-dry answers (dry-frames.ts): draws skipped so far; why the dry frames may have changed
// what the test sees (a stale drawing shown, read or reused), or null, and whether only drawings of
// other framebuffers than the canvas were at fault; whether a canvas on the page shows a drawing
// older than its last frame.
export interface DryReport {
  skipped: number;
  unsafe: string | null;
  offscreen: boolean;
  stale: boolean;
}

export type FrameMethod = keyof FrameMethods;

// ── What the object code sees ──

// The compiled object.js (self.__elaboraObject).
export interface ObjectModule {
  mount(root: HTMLElement, context: MountContext): unknown;
}

// What mount() returns.
export interface ObjectApi {
  // transition: the block carries on from another screen (D65); absent for a change of props.
  update?(props: JsonObject, transition?: ObjectTransition): void;
  getState(): JsonValue;
  setState?(state: JsonValue): void;
  pause?(): void;
  resume?(): void;
  dispose(): void;
}

export interface MountContext {
  // Words of the object, and t(key, values) to format them in the course language.
  strings: Record<string, string>;
  t(key: string, values?: Record<string, unknown>): string;
  props: JsonObject;
  host: ObjectHostApi;
  seed: number;
  locale: string;
  reducedMotion: boolean;
  safeArea: SafeArea;
  context: ObjectContext | null;
  view: ObjectView;
  testMode: boolean;
  tokens: TokenValues;
  objects: ObjectPart[];
  savedState: unknown;
}

export type FrameCallback = (deltaSeconds: number, frame: number) => void;

export interface ObjectHostApi {
  emit(name: string, payload?: JsonObject): void;
  // Deterministic random numbers in [0, 1), seeded by the host; set at initialize.
  random: (() => number) | null;
  now(): number;
  onFrame(callback: FrameCallback): () => boolean;
  asset(id: string): Promise<ArrayBuffer>;
  registerRenderer(renderer: RegisteredRenderer): void;
  registerCamera(camera: unknown): void;
  registerObject(id: string, object: RegisteredObject): void;
  onSafeArea(callback: (area: SafeArea) => void): () => boolean;
  onContext(callback: (context: ObjectContext | null) => void): () => boolean;
  onView(callback: (view: ObjectView) => void): () => boolean;
  requestHeight(px: number): void;
  log(...values: unknown[]): void;
}

// What the frame uses of a three.js WebGLRenderer, for tests and budgets.
export interface RegisteredRenderer {
  domElement: Element;
  info?: { render?: { calls?: number; triangles?: number }; memory?: { textures?: number; geometries?: number } };
  getContext?(): WebGLRenderingContext | WebGL2RenderingContext;
}

// What the frame uses of a three.js Object3D, to click it in tests.
export interface RegisteredObject {
  updateWorldMatrix?(updateParents: boolean, updateChildren: boolean): void;
  getWorldPosition(target: ProjectableVector): ProjectableVector;
  position: { constructor: new () => ProjectableVector };
}

export interface ProjectableVector {
  x: number;
  y: number;
  project(camera: unknown): ProjectableVector;
}
