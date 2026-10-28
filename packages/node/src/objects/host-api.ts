import type { ObjectAsset, ObjectPart, ObjectTestContext, ObjectTestView, ObjectEvent, ThemeFont } from '@elabora/format';

// The page of `elabora object test` (test-host.ts, bundled for the browser) and what the Node side
// calls on it through page.evaluate. Values the object computes (its state, its events, its
// measures) cross as unknown: they are checked where they are read.

export type SafeArea = { top: number; right: number; bottom: number; left: number };

// The free object as the host sees it (the compiled definition of the player).
export interface HostDefinition {
  id: string;
  dir: string; // objects/<id>, in the staged package
  objects: ObjectPart[];
  assets: ObjectAsset[];
  events: Record<string, { payload: ObjectEvent['payload'] | null; tracking: ObjectEvent['tracking'] | null }>;
}

export interface HostFont {
  family: string;
  src: string;
  weight: string;
  style: NonNullable<ThemeFont['style']>;
  unicodeRange?: string;
}

// What starts the object in the test page.
export interface HostStart {
  def: HostDefinition;
  props: Record<string, unknown>;
  strings: Record<string, string>;
  tokens: Record<string, string | number>;
  fonts: HostFont[];
  language: string;
  seed: number;
  reducedMotion: boolean;
  savedState: unknown;
  safeArea: SafeArea | null;
  decorative: boolean;
  context: ObjectTestContext | null;
  view: ObjectTestView | null;
}

export type HostStarted = { ok: true } | { ok: false; error: string };

// A call to the object host, as the behaviour tests drive it.
export type HostCall =
  | { method: 'step'; frames: number }
  | { method: 'getState' }
  | { method: 'setState'; state: Record<string, unknown> }
  | { method: 'updateProps'; props: Record<string, unknown> }
  // set-props with a transition: the block carries on from another screen (D65).
  | { method: 'carryOn'; props: Record<string, unknown>; duration: number; direction: 'forward' | 'back'; safeArea?: Partial<SafeArea> }
  | { method: 'setContext'; context: ObjectTestContext }
  | { method: 'setSafeArea'; safeArea: SafeArea }
  | { method: 'setView'; view: ObjectTestView }
  | { method: 'testClick'; target: { object: string } | { at: [number, number] | undefined } }
  | { method: 'testKey'; key: string }
  | { method: 'testDry'; dry: boolean; drawOffscreen: boolean }
  | { method: 'perf' }
  | { method: 'dispose' };

export interface HostEvent {
  name: string;
  payload: unknown;
}

declare global {
  interface Window {
    __events: HostEvent[];
    // The events, after a round trip to the frame.
    __settle(): Promise<HostEvent[]>;
    __startHost(start: HostStart): Promise<HostStarted>;
    __call(call: HostCall): unknown;
  }
}
