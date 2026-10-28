// The player's sounds (docs/decisions.md D67): one AudioContext for the page, three layers on it.
//   - interface sounds: short, always after a learner's gesture (a choice, a feedback, going back),
//     on when the module has sound (`when: auto`), switched off in « Affichage » ;
//   - sounds of the story: part of the content, like the voice (play-sound, a sound line);
//   - music and ambiences: long loops with a crossfade, lowered under the voice, switched off in
//     « Affichage » (a course's background tracks over a range of screens, a play-sound with loop).
// The player's volume and mute (the narration's controls) apply to all of them. The narration and
// the dialogues' lines keep their own <audio>: they are the clock of their timelines (D24, D61).
//
// Browsers let a page sound only after a gesture: an AudioContext made before one stays suspended.
// The context is made at the learner's first pointer or key press (an LMS frame gets the gesture in
// its own document), never at load; music and ambiences asked for before start then, a sound of the
// story asked for more than a moment before is dropped. Nothing here goes to the network: the files
// are the package's own.

import type { SoundsData, InterfaceRole, SoundFileData } from './course-data.ts';

export type { InterfaceRole };

// The learner's choices for the sounds (kept with the display choices, display.ts).
export interface SoundPrefs {
  interfaceSounds: boolean;
  music: boolean;
}

// The player's volume, as the narration's controls set it (timeline.ts TimelinePrefs).
export interface PlayerVolume {
  volume: number;
  muted: boolean;
}

// What was played, for tests and the review (the last 50).
export interface PlayedSound {
  kind: 'interface' | 'story' | 'ambience' | 'background';
  role?: InterfaceRole;
  sound?: string;
  src: string;
  at: number; // performance.now()
  heard: boolean; // started on a running context (false: no gesture yet, no Web Audio, or too late)
}

export interface SoundsState {
  context: 'none' | AudioContextState;
  interface: boolean; // interface sounds on for this course and this learner
  music: boolean; // music and ambiences on for this learner
  ducked: boolean; // a voice speaks: music and ambiences lowered
  playing: { sound: string; kind: 'story' | 'ambience' | 'background' }[];
  played: PlayedSound[];
}

// What a play-sound action or a sound line asks.
export interface SoundRequest {
  sound: string;
  volume?: number;
  loop?: boolean;
  fade?: number;
  caption?: string;
}

// Lowered by this much under a voice: 20 dB (WCAG 1.4.7), a tenth of the amplitude.
export const DUCK_GAIN = 0.1;
const DUCK_ATTACK = 0.25;
const DUCK_RELEASE = 0.8;
// A sound of the story asked before the first gesture still plays if the gesture comes this soon.
const STORY_LATE = 1.5;
const AMBIENCE_VOLUME = 0.3;
const BACKGROUND_VOLUME = 0.25;
const DEFAULT_FADE = 2;
const STOP_FADE = 0.3;

type Context = AudioContext;

export interface SoundsOptions {
  data: SoundsData | undefined;
  prefs: SoundPrefs;
  volume(): PlayerVolume;
  // A sound with a caption started: the player shows and announces it (seconds: how long it lasts).
  caption?(text: string, seconds: number): void;
  // The page's document, where the first gesture is listened for.
  document?: Document;
}

// A looped sound: copies of its buffer that cross into each other, scheduled on the context's clock.
interface Loop {
  sound: string;
  kind: 'ambience' | 'background';
  volume: number;
  stop(fade: number): void;
}
interface OneShot {
  sound: string;
  gain: GainNode;
  source: AudioBufferSourceNode;
}

export function createSounds(options: SoundsOptions) {
  let data = options.data;
  const prefs = options.prefs;
  const doc = options.document ?? document;
  const AudioContextClass: typeof AudioContext | undefined = typeof window !== 'undefined' ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined;
  let context: Context | null = null;
  let master: GainNode | null = null;
  let interfaceBus: GainNode | null = null;
  let storyBus: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let duckBus: GainNode | null = null;
  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  const played: PlayedSound[] = [];
  const loops = new Map<string, Loop>(); // by sound id
  const shots = new Set<OneShot>();
  const voices = new Set<string>();
  // What waits for the context to run: started with the first gesture.
  let pending: (() => void)[] = [];
  // The background tracks of the screen shown (D67), by sound id.
  let screen: string | null = null;
  // Moves on when every sound of the story stops: one asked before the first gesture is dropped.
  let generation = 0;

  const interfaceOn = () => !!data?.interface && prefs.interfaceSounds;
  const fileOf = (sound: string): SoundFileData | undefined => data?.files?.[sound];

  // The context, made once, at a gesture (or when asked from inside one).
  function ensureContext(): Context | null {
    if (context || !AudioContextClass) return context;
    try {
      context = new AudioContextClass({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
    const ctx = context;
    master = ctx.createGain();
    master.connect(ctx.destination);
    interfaceBus = ctx.createGain();
    interfaceBus.connect(master);
    storyBus = ctx.createGain();
    storyBus.connect(master);
    duckBus = ctx.createGain();
    duckBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.connect(duckBus);
    ctx.addEventListener('statechange', () => { if (ctx.state === 'running') flush(); });
    applyGains();
    preloadInterface();
    if (ctx.state === 'running') flush();
    return ctx;
  }
  function flush() {
    const waiting = pending;
    pending = [];
    for (const run of waiting) run();
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
    if (!context || !master || !interfaceBus || !musicBus || !duckBus) return;
    const { volume, muted } = options.volume();
    const now = context.currentTime;
    master.gain.setTargetAtTime(muted ? 0 : Math.max(0, Math.min(1, volume)), now, 0.015);
    interfaceBus.gain.setTargetAtTime(interfaceOn() ? data?.interface?.volume ?? 0.5 : 0, now, 0.015);
    musicBus.gain.setTargetAtTime(prefs.music ? 1 : 0, now, 0.05);
    duckBus.gain.setTargetAtTime(voices.size ? DUCK_GAIN : 1, now, voices.size ? DUCK_ATTACK / 3 : DUCK_RELEASE / 3);
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

  function log(entry: PlayedSound): PlayedSound {
    played.push(entry);
    if (played.length > 50) played.shift();
    return entry;
  }

  // An interface sound, at once or not at all: a click heard late is worse than none.
  function playInterface(role: InterfaceRole) {
    const src = data?.interface?.files[role];
    if (!src || !interfaceOn()) return;
    const ctx = ensureContext();
    const entry = log({ kind: 'interface', role, src, at: performance.now(), heard: false });
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

  // Runs now when the context runs, else at the first gesture (late: only if still wanted).
  function whenRunning(run: () => void) {
    if (context?.state === 'running') run();
    else pending.push(run);
  }

  // A gain that fades from 0 to volume over fade seconds (or is at volume at once).
  function fadedGain(ctx: Context, volume: number, fade: number, into: AudioNode): GainNode {
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(fade > 0 ? 0 : volume, now);
    if (fade > 0) gain.gain.linearRampToValueAtTime(volume, now + fade);
    gain.connect(into);
    return gain;
  }
  function fadeOut(ctx: Context, gain: GainNode, fade: number): number {
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + Math.max(0.01, fade));
    return now + Math.max(0.01, fade);
  }

  // A sound of the story, once.
  function playOnce(request: SoundRequest, file: SoundFileData) {
    const entry = log({ kind: 'story', sound: request.sound, src: file.src, at: performance.now(), heard: false });
    if (request.caption) options.caption?.(request.caption, file.duration ?? 2);
    const asked = generation;
    whenRunning(() => {
      const ctx = context;
      if (!ctx || !storyBus || asked !== generation || performance.now() - entry.at > STORY_LATE * 1000) return;
      const bus = storyBus;
      void load(file.src).then((buffer) => {
        if (!buffer || ctx.state === 'closed') return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const shot: OneShot = { sound: request.sound, source, gain: fadedGain(ctx, request.volume ?? 1, request.fade ?? 0, bus) };
        source.connect(shot.gain);
        source.addEventListener('ended', () => { shots.delete(shot); shot.gain.disconnect(); });
        shots.add(shot);
        source.start();
        entry.heard = ctx.state === 'running';
      });
    });
  }

  // A looped sound (an ambience of the screen, a background track): copies of the buffer, each
  // starting as the one before begins its crossfade out, scheduled a little ahead on the clock.
  function playLoop(sound: string, kind: Loop['kind'], file: SoundFileData, volume: number, fade: number) {
    if (loops.has(sound)) return;
    const entry = log({ kind, sound, src: file.src, at: performance.now(), heard: false });
    let stopped = false;
    let timer = 0;
    const live = new Set<AudioBufferSourceNode>();
    let gain: GainNode | null = null;
    const loop: Loop = {
      sound, kind, volume,
      stop(out: number) {
        stopped = true;
        clearTimeout(timer);
        loops.delete(sound);
        if (!context || !gain) return;
        const end = fadeOut(context, gain, out);
        for (const source of live) { try { source.stop(end + 0.05); } catch { /* not started */ } }
      }
    };
    loops.set(sound, loop);
    // Nothing is made before the first gesture: the loop starts with it.
    whenRunning(() => {
      if (stopped || !context || !musicBus) return;
      const running = context;
      const own = running.createGain();
      own.gain.value = 0;
      own.connect(musicBus);
      gain = own;
      void load(file.src).then((buffer) => {
        if (!buffer || stopped || running.state === 'closed') return;
        const now = running.currentTime;
        own.gain.cancelScheduledValues(now);
        own.gain.setValueAtTime(0, now);
        own.gain.linearRampToValueAtTime(volume, now + Math.max(0.01, fade));
        entry.heard = running.state === 'running';
        const cross = Math.min(Math.max(fade, 0.05), buffer.duration / 3);
        let next = now + 0.02;
        const schedule = () => {
          if (stopped) return;
          while (next < running.currentTime + 2) {
            const start = next;
            const source = running.createBufferSource();
            source.buffer = buffer;
            const copy = running.createGain();
            // Each copy fades in over the crossfade (but the first, which the loop's gain fades in)
            // and out over the crossfade before its end, as the next one fades in.
            copy.gain.setValueAtTime(start === now + 0.02 ? 1 : 0, start);
            if (start !== now + 0.02) copy.gain.linearRampToValueAtTime(1, start + cross);
            copy.gain.setValueAtTime(1, start + buffer.duration - cross);
            copy.gain.linearRampToValueAtTime(0, start + buffer.duration);
            source.connect(copy);
            copy.connect(own);
            source.addEventListener('ended', () => { live.delete(source); copy.disconnect(); });
            live.add(source);
            source.start(start);
            source.stop(start + buffer.duration);
            next = start + buffer.duration - cross;
          }
          timer = window.setTimeout(schedule, 1000);
        };
        schedule();
      });
    });
  }

  function play(request: SoundRequest) {
    const file = fileOf(request.sound);
    if (!file) return;
    if (request.loop) {
      if (request.caption) options.caption?.(request.caption, 3);
      playLoop(request.sound, 'ambience', file, request.volume ?? AMBIENCE_VOLUME, request.fade ?? DEFAULT_FADE);
    } else playOnce(request, file);
  }
  function stop(sound?: string, fade = STOP_FADE) {
    const ctx = context;
    for (const [id, loop] of loops) if (loop.kind === 'ambience' && (sound === undefined || id === sound)) loop.stop(fade);
    for (const shot of shots) {
      if (sound !== undefined && shot.sound !== sound) continue;
      shots.delete(shot);
      if (ctx) { const end = fadeOut(ctx, shot.gain, fade); try { shot.source.stop(end + 0.05); } catch { /* ended */ } }
    }
    if (sound === undefined) generation++;
  }

  // A screen is shown: the sounds of the screen left stop (its sounds of the story, its ambiences);
  // the background tracks of this screen play on, start or stop.
  function enterScreen(id: string | null) {
    if (id === screen) return;
    screen = id;
    stop(undefined, STOP_FADE);
    const wanted = new Map((data?.background ?? []).filter((track) => id !== null && track.screens.includes(id)).map((track) => [track.sound, track]));
    for (const [sound, loop] of loops) if (loop.kind === 'background' && !wanted.has(sound)) loop.stop(data?.background?.find((track) => track.sound === sound)?.fade ?? DEFAULT_FADE);
    for (const [sound, track] of wanted) {
      const file = fileOf(sound);
      if (file && !loops.has(sound)) playLoop(sound, 'background', file, track.volume, track.fade);
    }
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
    play,
    stop,
    enterScreen,
    // A voice speaks (the narration, a layer's, a dialogue's line, an audio or video block): music
    // and ambiences go 20 dB down until every voice is done.
    voice(reason: string, speaking: boolean) {
      const before = voices.size;
      if (speaking) voices.add(reason); else voices.delete(reason);
      if (voices.size !== before) applyGains();
    },
    // Whether the course has interface sounds, music or ambiences (their switches in « Affichage »).
    get hasInterface() { return !!data?.interface; },
    get hasMusic() { return !!data?.music; },
    state(): SoundsState {
      return {
        context: context ? context.state : 'none', interface: interfaceOn(), music: prefs.music, ducked: voices.size > 0,
        playing: [...[...shots].map((shot) => ({ sound: shot.sound, kind: 'story' as const })), ...[...loops.values()].map((loop) => ({ sound: loop.sound, kind: loop.kind }))],
        played: played.map((entry) => ({ ...entry }))
      };
    },
    dispose() {
      for (const type of gestures) doc.removeEventListener(type, onGesture, { capture: true });
      for (const loop of loops.values()) loop.stop(0);
      void context?.close().catch(() => {});
      context = null;
    }
  };
}
export type Sounds = ReturnType<typeof createSounds>;
