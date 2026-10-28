// The player's sounds (docs/decisions.md D67): one AudioContext for the page, three layers on it.
//   - interface sounds: short, always after a learner's gesture (a choice, a feedback, going back),
//     on when the module has sound (`when: auto`), switched off in « Affichage » ;
//   - sounds of the story: part of the content, like the voice (play-sound, a sound line);
//   - music and ambiences: long loops, lowered under the voice, switched off in « Affichage ».
// The player's volume and mute (the narration's controls) apply to all of them. The narration and
// the dialogues' lines keep their own <audio>: they are the clock of their timelines (D24, D61).
//
// Browsers let a page sound only after a gesture: an AudioContext made before one stays suspended.
// The context is made at the learner's first pointer or key press (an LMS frame gets the gesture in
// its own document), never at load; what asked to sound before (an ambience at the start of a
// screen) starts then. Nothing here goes to the network: the files are the package's own.

import type { SoundsData, InterfaceRole } from './course-data.ts';

export type { InterfaceRole };

// The learner's choices for the sounds (kept with the display choices, display.ts).
export interface SoundPrefs {
  interfaceSounds: boolean;
}

// The player's volume, as the narration's controls set it (timeline.ts TimelinePrefs).
export interface PlayerVolume {
  volume: number;
  muted: boolean;
}

// What was played, for tests and the review (the last 50).
export interface PlayedSound {
  kind: 'interface';
  role: InterfaceRole;
  src: string;
  at: number; // performance.now()
  heard: boolean; // started on a running context (false: no gesture yet, no Web Audio, or too late)
}

export interface SoundsState {
  context: 'none' | AudioContextState;
  interface: boolean; // interface sounds on for this course and this learner
  played: PlayedSound[];
}

type Context = AudioContext;

export interface SoundsOptions {
  data: SoundsData | undefined;
  prefs: SoundPrefs;
  volume(): PlayerVolume;
  // The page's document, where the first gesture is listened for.
  document?: Document;
}

export function createSounds(options: SoundsOptions) {
  let data = options.data;
  const prefs = options.prefs;
  const doc = options.document ?? document;
  const AudioContextClass: typeof AudioContext | undefined = typeof window !== 'undefined' ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined;
  let context: Context | null = null;
  let master: GainNode | null = null;
  let interfaceBus: GainNode | null = null;
  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  const played: PlayedSound[] = [];

  const interfaceOn = () => !!data?.interface && prefs.interfaceSounds;

  // The context, made once, at a gesture (or when asked from inside one).
  function ensureContext(): Context | null {
    if (context || !AudioContextClass) return context;
    try {
      context = new AudioContextClass({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
    master = context.createGain();
    master.connect(context.destination);
    interfaceBus = context.createGain();
    interfaceBus.connect(master);
    applyGains();
    preloadInterface();
    return context;
  }
  // A module without sounds never makes one.
  const onGesture = () => {
    if (!data) return;
    const made = ensureContext();
    if (made && made.state === 'suspended') void made.resume().catch(() => {});
  };
  // Capture: the context exists before the click's own handler asks for a sound.
  const gestures = ['pointerdown', 'keydown', 'touchend'] as const;
  for (const type of gestures) doc.addEventListener(type, onGesture, { capture: true, passive: true });

  function applyGains() {
    if (!context || !master || !interfaceBus) return;
    const { volume, muted } = options.volume();
    const now = context.currentTime;
    master.gain.setTargetAtTime(muted ? 0 : Math.max(0, Math.min(1, volume)), now, 0.015);
    interfaceBus.gain.setTargetAtTime(interfaceOn() ? data?.interface?.volume ?? 0.5 : 0, now, 0.015);
  }

  function load(src: string): Promise<AudioBuffer | null> {
    const known = buffers.get(src);
    if (known) return known;
    const ctx = context;
    if (!ctx) return Promise.resolve(null);
    const loading = fetch(src)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
      .then((bytes) => ctx.decodeAudioData(bytes))
      // A failure is not kept: the next time asks again (a server that refused once may answer).
      .catch(() => { buffers.delete(src); return null; });
    buffers.set(src, loading);
    return loading;
  }
  function preloadInterface() {
    if (!interfaceOn()) return;
    for (const src of Object.values(data?.interface?.files ?? {})) if (src) void load(src);
  }

  function log(entry: PlayedSound) {
    played.push(entry);
    if (played.length > 50) played.shift();
  }

  // An interface sound, at once or not at all: a click heard late is worse than none.
  function playInterface(role: InterfaceRole) {
    const src = data?.interface?.files[role];
    if (!src || !interfaceOn()) return;
    const ctx = ensureContext();
    const entry: PlayedSound = { kind: 'interface', role, src, at: performance.now(), heard: false };
    log(entry);
    if (!ctx || !interfaceBus) return;
    const bus = interfaceBus;
    void load(src).then((buffer) => {
      if (!buffer || performance.now() - entry.at > 250 || ctx.state === 'closed') return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(bus);
      source.start();
      entry.heard = ctx.state === 'running';
    });
  }

  return {
    // The course in another language (D59): the same files, the same context.
    setData(next: SoundsData | undefined) {
      data = next;
      applyGains();
      preloadInterface();
    },
    // The learner changed a choice of « Affichage », or the player's volume.
    update() {
      applyGains();
      preloadInterface();
    },
    interface: playInterface,
    // Whether the course has interface sounds (« Sons de l'interface » shows in « Affichage »).
    get hasInterface() { return !!data?.interface; },
    state(): SoundsState {
      return { context: context ? context.state : 'none', interface: interfaceOn(), played: played.map((entry) => ({ ...entry })) };
    },
    dispose() {
      for (const type of gestures) doc.removeEventListener(type, onGesture, { capture: true });
      void context?.close().catch(() => {});
      context = null;
    }
  };
}
export type Sounds = ReturnType<typeof createSounds>;
