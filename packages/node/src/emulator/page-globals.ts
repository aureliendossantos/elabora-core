// Globals of the pages the Node services drive. Functions given to page.evaluate run in the page,
// where the player defines window.__elabora (its debug and test hooks), the emulator harness
// window.__lms…, and the instrumentation script of the emulator the counters below. Only what the
// services use is declared: the player's hooks as the player defines them, values that come from
// course content or free objects as unknown, narrowed where they are read.

export interface PlayerBlock {
  id: string;
  type: string;
  behavior?: string;
  // Activities and blocks rendered by code carry their props; template blocks do not.
  props?: { options?: { id: string; correct?: boolean }[]; answer?: number | string; [name: string]: unknown };
  blocks?: PlayerBlock[];
}

export interface PlayerScreen {
  id: string;
  key: string; // key of the screen in the learner state
  blocks: PlayerBlock[];
  layers?: { id: string }[];
}

// What player.ready() resolves with: images decoded, free objects of the screen answered or failed.
export interface ReadyReport {
  images: number;
  objects: { block: string; ready: boolean; failed: boolean }[];
}

// One call to the SCORM API, as the player's adapter and the emulator harness log it.
export interface LmsCall {
  t: number;
  method: string;
  args: unknown[];
  result: string;
  error?: string;
}

export interface PlayerHooks {
  course: {
    presentation?: { mode?: 'scroll' | 'slides'; fit?: { reference?: string; minimum?: string } };
    completion: { reportAs: string };
  };
  engine: {
    screens: PlayerScreen[];
    screenIndex: Map<string, number>;
    // The learner state: previews and the emulator mark screens visited and complete through it.
    st: { visited: Set<string>; completed: Set<string> };
  };
  lms: { kind: string; log: LmsCall[] };
  readonly screen: string | undefined;
  go(screen: string | number): void;
  reveal(step: number): void;
  revealAll(): void;
  openLayer(id: string): void;
  // Every activity shows its tallest outcome, concealed blocks are shown: the blocks it changed.
  showAnswered(): { screen?: string; changed: (string | undefined)[] };
  // The room each quiz with full feedback reserves (slides), and what it would with compact feedback.
  feedbackRooms(): { block: string; full: number; compact: number }[];
  ready(timeout?: number): Promise<ReadyReport>;
  state(): { screen?: string; status: string; score: { raw: number | null }; suspendData: string };
  test: { completeObject(blockId: string, score?: number): boolean };
  // The narrated screen's timeline (docs/decisions.md D24), on the virtual clock of tests.
  timeline: PlayerTimeline;
  // The host of a free object of the screen (replays drive it as object tests do).
  objectHost(blockId: string): PlayerObjectHost | undefined;
  // The host of the backdrop's decorative object (theme.backdrop.object), if any.
  backdropHost(): PlayerObjectHost | undefined;
  // The dialogues of the screen (D61): « Suite », a choice, their virtual clock.
  dialogues: PlayerDialogues;
}

export interface DialogueViewState {
  // idle (not begun), playing, choosing, ended.
  phase: string;
  node: string | null;
  status: string;
  line: string | null;
  path: string[];
  ending: string | null;
}

export interface PlayerDialogues {
  blocks(): string[];
  state(blockId: string): DialogueViewState | null;
  advance(seconds: number): void;
  start(blockId: string): void;
  next(blockId: string): void;
  choose(blockId: string, option: string): void;
}

export interface TimelineState {
  time: number;
  reached: number;
  duration: number;
  playing: boolean;
  step: number;
  refused: boolean;
  captions: boolean;
  rate: number;
  muted: boolean;
  line: string | null;
  // The word said at that time (narration with word times).
  word: string | null;
  caption: string | null;
  // The playhead is being dragged.
  dragging: boolean;
}

export interface PlayerTimeline {
  state(): TimelineState | null;
  play(): void;
  pause(): void;
  seek(time: number): void;
  advance(seconds: number): void;
  at(line: string, options?: { edge?: 'start' | 'end'; captions?: boolean }): boolean;
  atTime(time: number, options?: { captions?: boolean }): boolean;
  hiddenByTiming(): string[];
  toEnd(): Promise<TimelineState | null>;
  // The timelines of open layers (D62).
  layers(): string[];
  layer(id: string): Omit<PlayerTimeline, 'toEnd' | 'layers' | 'layer'> | null;
}

export interface PlayerObjectHost {
  emitted: { name: string; payload: unknown }[];
  updateProps(props: Record<string, unknown>): void;
  // The block carries on from another screen (D65).
  carryOn(props: Record<string, unknown>, transition: { from: { screen: string; block: string }; to: { screen: string; block: string }; direction: 'forward' | 'back'; duration: number; reducedMotion: boolean }, extra?: { safeArea?: Record<string, number> }): void;
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<unknown>;
  testClick(target: { object?: string; at?: [number, number] }): Promise<unknown>;
  testKey(key: string): Promise<unknown>;
  // A decoration of the backdrop: where the learner is (replays of its tests).
  setContext(context: Record<string, unknown>): void;
}

declare global {
  interface Window {
    __elabora: PlayerHooks;
    // Set by the emulator harness (emulator-harness/harness.js) once the content is launched.
    __lmsReady?: boolean;
    __lmsLog?: LmsCall[];
    // Set before the player starts: narrated screens on a virtual clock (tests, the emulator).
    ELABORA_TEST?: { virtualTime?: boolean };
    // Counted by the emulator's instrumentation, injected in every frame.
    __unloadListeners: number;
    __syncXHR: number;
  }
}
