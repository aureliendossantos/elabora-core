// The player's sounds (docs/decisions.md D67): one AudioContext for the page, three layers on it.
//   - interface sounds: short, always after a learner's gesture (a choice, a feedback, going back),
//     on when the module has sound (`when: auto`), switched off in « Affichage » ;
//   - sounds of the story: part of the content, like the voice (play-sound, a sound line);
//   - music and ambiences: long loops with a crossfade, lowered under the voice, switched off in
//     « Affichage » (a course's background tracks over a range of screens, a play-sound with loop).
// The player's volume and mute (the narration's controls) apply to all of them. The narration and
// the dialogues' lines keep their own <audio>: they are the clock of their timelines (D24, D61).
// A sound of the story may lower them, and the music, while it plays (duck): they read voiceLevel()
// at every frame. How a sound is mixed (its part, its gain, its fades, its duck) is sound-mix.ts's.
//
// Browsers let a page sound only after a gesture: an AudioContext made before one stays suspended.
// The context is made at the learner's first pointer or key press (an LMS frame gets the gesture in
// its own document), never at load; music and ambiences asked for before start then, a sound of the
// story asked for more than a moment before is dropped. Nothing here goes to the network: the files
// are the package's own.

import type { SoundsData, InterfaceRole, SoundFileData } from './course-data.ts';
import { channelsOf, duckGainAt, fadesOf, gainOf, partOf, peakOf, scheduleDucks } from './sound-mix.ts';
import type { Duck, SoundPart } from './sound-mix.ts';

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
  // A sound of the story or a loop once its file is decoded: what it plays (seconds in the file), at
  // what gain (above 1 only as far as its peak allows), with what fades and duck (dB).
  part?: SoundPart;
  gain?: number;
  fades?: { in: number; out: number };
  duck?: number;
}

export interface SoundsState {
  context: 'none' | AudioContextState;
  interface: boolean; // interface sounds on for this course and this learner
  music: boolean; // music and ambiences on for this learner
  ducked: boolean; // a voice speaks: music and ambiences lowered
  voiceLevel: number; // the voices' gain under a sound that lowers them (1: as they are)
  playing: { sound: string; kind: 'story' | 'ambience' | 'background' }[];
  played: PlayedSound[];
}

// What a play-sound action or a sound line asks (schemas 0.1.7: up to 200 %, a part, a fade out, a
// duck).
export interface SoundRequest {
  sound: string;
  volume?: number;
  loop?: boolean;
  fade?: number;
  fadeOut?: number;
  start?: number;
  end?: number;
  duck?: number;
  caption?: string;
}

// Lowered by this much under a voice: 20 dB (WCAG 1.4.7), a tenth of the amplitude.
export const DUCK_GAIN = 0.1;
const UNDER_VOICE_ATTACK = 0.25;
const UNDER_VOICE_RELEASE = 0.8;
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
  fadeOut?: number; // an ambience's own fade when it stops without one (stop-sound's, the screen's end)
  stop(fade: number): void;
}
interface OneShot {
  sound: string;
  gain: GainNode;
  source: AudioBufferSourceNode;
  duck?: Duck; // what it lowers while it plays
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
  let cueBus: GainNode | null = null;
  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  const played: PlayedSound[] = [];
  const loops = new Map<string, Loop>(); // by kind and sound id (ambience:rain, background:theme)
  const shots = new Set<OneShot>();
  const voices = new Set<string>();
  // The sounds of the story that lower the voices and the music while they play, on the context's
  // clock; forgotten once they are back up.
  let ducks: Duck[] = [];
  // The loudest sample of a decoded file over a part (a boosted sound stops below the ceiling).
  const peaks = new WeakMap<AudioBuffer, Map<string, number>>();
  // What waits for the context to run: started with the first gesture.
  let pending: (() => void)[] = [];
  // The background tracks of the screen shown (D67), by sound id.
  let screen: string | null = null;
  // Moves on when every sound of the story stops, and a sound's own when it is stopped: one asked
  // before, still waiting for the first gesture or its file, is dropped.
  let generation = 0;
  const stopsOf = new Map<string, number>();

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
    cueBus = ctx.createGain();
    cueBus.connect(master);
    duckBus = ctx.createGain();
    duckBus.connect(cueBus);
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
    duckBus.gain.setTargetAtTime(voices.size ? DUCK_GAIN : 1, now, voices.size ? UNDER_VOICE_ATTACK / 3 : UNDER_VOICE_RELEASE / 3);
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

  // A gain that fades from 0 to volume over fade seconds (or is at volume at once), and, for a part
  // of length seconds, back to 0 over its last fadeOut seconds.
  function fadedGain(ctx: Context, volume: number, fades: { in: number; out: number }, into: AudioNode, at: number, length?: number): GainNode {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(fades.in > 0 ? 0 : volume, at);
    if (fades.in > 0) gain.gain.linearRampToValueAtTime(volume, at + fades.in);
    if (length !== undefined && fades.out > 0) {
      gain.gain.setValueAtTime(volume, at + length - fades.out);
      gain.gain.linearRampToValueAtTime(0, at + length);
    }
    gain.connect(into);
    return gain;
  }
  function peak(buffer: AudioBuffer, part: SoundPart): number {
    let known = peaks.get(buffer);
    if (!known) { known = new Map(); peaks.set(buffer, known); }
    const key = `${part.offset}:${part.length}`;
    let value = known.get(key);
    if (value === undefined) {
      value = peakOf(channelsOf(buffer), buffer.sampleRate, part);
      known.set(key, value);
    }
    return value;
  }
  // The gain a volume gives this part: above 100 % only as far as its peak allows (sound-mix.ts).
  const gainFor = (volume: number, buffer: AudioBuffer, part: SoundPart) => gainOf(volume, volume > 1 ? peak(buffer, part) : null);
  // A sound that lowers the voices and the music while it plays: the music bus follows the ducks on
  // the context's clock, the voices read voiceLevel() at every frame.
  function addDuck(ctx: Context, duck: Duck) {
    const now = ctx.currentTime;
    ducks = [...ducks.filter((other) => other.at + other.length + 1 > now), duck];
    if (cueBus) scheduleDucks(cueBus.gain, ducks, now);
  }
  // The voices' gain under the ducks now; as they are when the context does not run (its clock stands
  // still then, while the voices' own elements may play).
  const level = () => (context?.state === 'running' && ducks.length ? duckGainAt(ducks, context.currentTime) : 1);
  // Sounds stopped before their end: what they lowered comes back up from now.
  function endDucks(ctx: Context, ended: (duck: Duck) => boolean) {
    const now = ctx.currentTime;
    let changed = false;
    ducks = ducks.map((duck) => {
      if (!ended(duck) || duck.at + duck.length <= now) return duck;
      changed = true;
      return { ...duck, length: Math.max(0, now - duck.at) };
    });
    if (changed && cueBus) scheduleDucks(cueBus.gain, ducks, now);
  }
  function fadeOut(ctx: Context, gain: GainNode, fade: number): number {
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + Math.max(0.01, fade));
    return now + Math.max(0.01, fade);
  }

  // A sound of the story, once: its part of the file, its gain, its fades; it lowers the voices and
  // the music while it plays when it asks to (duck).
  function playOnce(request: SoundRequest, file: SoundFileData) {
    const entry = log({ kind: 'story', sound: request.sound, src: file.src, at: performance.now(), heard: false });
    if (request.caption) options.caption?.(request.caption, file.duration !== null ? partOf(request.start, request.end, file.duration).length : 2);
    const asked = generation;
    const own = stopsOf.get(request.sound) ?? 0;
    const dropped = () => asked !== generation || own !== (stopsOf.get(request.sound) ?? 0);
    whenRunning(() => {
      const ctx = context;
      if (!ctx || !storyBus || dropped() || performance.now() - entry.at > STORY_LATE * 1000) return;
      const bus = storyBus;
      void load(file.src).then((buffer) => {
        if (!buffer || ctx.state === 'closed' || dropped()) return;
        const part = partOf(request.start, request.end, buffer.duration);
        const fades = fadesOf(request.fade, request.fadeOut, part.length);
        const gain = gainFor(request.volume ?? 1, buffer, part);
        const at = ctx.currentTime;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const shot: OneShot = { sound: request.sound, source, gain: fadedGain(ctx, gain, fades, bus, at, part.length) };
        source.connect(shot.gain);
        source.addEventListener('ended', () => { shots.delete(shot); shot.gain.disconnect(); });
        shots.add(shot);
        source.start(at, part.offset, part.length);
        if (request.duck && request.duck > 0) { shot.duck = { at, length: part.length, depth: request.duck }; addDuck(ctx, shot.duck); }
        Object.assign(entry, { heard: ctx.state === 'running', part, gain, fades, ...(request.duck ? { duck: request.duck } : {}) });
      });
    });
  }

  // A looped sound (an ambience of the screen, a background track): copies of the buffer, each
  // starting as the one before begins its crossfade out, scheduled a little ahead on the clock.
  // Its part of the file only, when it names one (an ambience made from a longer recording).
  function playLoop(sound: string, kind: Loop['kind'], file: SoundFileData, volume: number, fade: number, cut: { start?: number; end?: number; fadeOut?: number } = {}) {
    const key = `${kind}:${sound}`;
    if (loops.has(key)) return;
    const entry = log({ kind, sound, src: file.src, at: performance.now(), heard: false });
    let stopped = false;
    let timer = 0;
    const live = new Set<AudioBufferSourceNode>();
    let gain: GainNode | null = null;
    const loop: Loop = {
      sound, kind, volume, ...(cut.fadeOut !== undefined ? { fadeOut: cut.fadeOut } : {}),
      stop(out: number) {
        stopped = true;
        clearTimeout(timer);
        loops.delete(key);
        if (!context || !gain) return;
        const end = fadeOut(context, gain, out);
        for (const source of live) { try { source.stop(end + 0.05); } catch { /* not started */ } }
      }
    };
    loops.set(key, loop);
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
        const part = partOf(cut.start, cut.end, buffer.duration);
        const gain = gainFor(volume, buffer, part);
        const now = running.currentTime;
        own.gain.cancelScheduledValues(now);
        own.gain.setValueAtTime(0, now);
        own.gain.linearRampToValueAtTime(gain, now + Math.max(0.01, fade));
        Object.assign(entry, { heard: running.state === 'running', part, gain, fades: { in: fade, out: kind === 'background' ? fade : cut.fadeOut ?? STOP_FADE } });
        const cross = Math.min(Math.max(fade, 0.05), part.length / 3);
        let next = now + 0.02;
        let first = true;
        const schedule = () => {
          if (stopped) return;
          while (next < running.currentTime + 2) {
            const start = next;
            const source = running.createBufferSource();
            source.buffer = buffer;
            const copy = running.createGain();
            // Each copy fades in over the crossfade (but the first, which the loop's gain fades in)
            // and out over the crossfade before its end, as the next one fades in.
            copy.gain.setValueAtTime(first ? 1 : 0, start);
            if (!first) copy.gain.linearRampToValueAtTime(1, start + cross);
            first = false;
            copy.gain.setValueAtTime(1, start + part.length - cross);
            copy.gain.linearRampToValueAtTime(0, start + part.length);
            source.connect(copy);
            copy.connect(own);
            source.addEventListener('ended', () => { live.delete(source); copy.disconnect(); });
            live.add(source);
            source.start(start, part.offset, part.length);
            source.stop(start + part.length);
            next = start + part.length - cross;
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
      playLoop(request.sound, 'ambience', file, request.volume ?? AMBIENCE_VOLUME, request.fade ?? DEFAULT_FADE, { start: request.start, end: request.end, fadeOut: request.fadeOut });
    } else playOnce(request, file);
  }
  // fade: stop-sound's own; without one, an ambience fades out as it asked (fadeOut), else quickly.
  function stop(sound?: string, fade?: number) {
    const ctx = context;
    for (const loop of [...loops.values()]) if (loop.kind === 'ambience' && (sound === undefined || loop.sound === sound)) loop.stop(fade ?? loop.fadeOut ?? STOP_FADE);
    const stopped = new Set<Duck>();
    for (const shot of shots) {
      if (sound !== undefined && shot.sound !== sound) continue;
      shots.delete(shot);
      if (shot.duck) stopped.add(shot.duck);
      if (ctx) { const end = fadeOut(ctx, shot.gain, fade ?? STOP_FADE); try { shot.source.stop(end + 0.05); } catch { /* ended */ } }
    }
    // What the stopped sounds lowered comes back up (every sound stopped: a sound asked and not yet
    // decoded too).
    if (ctx && ducks.length) endDucks(ctx, (duck) => sound === undefined || stopped.has(duck));
    if (sound === undefined) generation++;
    else stopsOf.set(sound, (stopsOf.get(sound) ?? 0) + 1);
  }

  // A screen is shown: the sounds of the screen left stop (its sounds of the story, its ambiences);
  // the background tracks of this screen play on, start or stop.
  function enterScreen(id: string | null) {
    if (id === screen) return;
    screen = id;
    stop(undefined);
    const wanted = new Map((data?.background ?? []).filter((track) => id !== null && track.screens.includes(id)).map((track) => [track.sound, track]));
    for (const loop of [...loops.values()]) if (loop.kind === 'background' && !wanted.has(loop.sound)) loop.stop(data?.background?.find((track) => track.sound === loop.sound)?.fade ?? DEFAULT_FADE);
    for (const [sound, track] of wanted) {
      const file = fileOf(sound);
      if (file) playLoop(sound, 'background', file, track.volume, track.fade, { start: track.start, end: track.end });
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
    // The voices' gain under the sounds that lower them (1: none does): the narration's and the
    // dialogues' lines multiply their volume by it at every frame.
    voiceLevel(): number {
      return level();
    },
    // Whether the course has interface sounds, music or ambiences (their switches in « Affichage »).
    get hasInterface() { return !!data?.interface; },
    get hasMusic() { return !!data?.music; },
    state(): SoundsState {
      return {
        context: context ? context.state : 'none', interface: interfaceOn(), music: prefs.music, ducked: voices.size > 0, voiceLevel: level(),
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
