// A dialogue's clock and the voice of one line, in the page (D61). Not part of the pure walk: the
// core never imports this file.
//
// A line is played on its own: its audio when it has one (the clock is the audio's currentTime, read
// at every frame, and its end is the audio's ended event: a browser decodes a track a few
// milliseconds shorter than its sidecar says, so currentTime may never reach the duration), else a
// silent clock that counts the line's estimated duration. Tests run every clock virtually: time moves
// only when told (window.ELABORA_TEST.virtualTime, __elabora.dialogues.advance).

import type { LineVoiceData } from './types.ts';

// The dialogue's own clock, in seconds: what waits between lines count. Paused, it stands still.
export interface DialogueClock {
  now(): number;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  // Virtual clocks only: moves time on (nothing happens for a real clock).
  advance(seconds: number): void;
}

export function createClock(virtual: boolean): DialogueClock {
  let base = 0;
  let since: number | null = virtual ? null : performance.now();
  let virtualTime = 0;
  let paused = false;
  const real = () => (since === null ? base : base + (performance.now() - since) / 1000);
  return {
    now: () => (virtual ? virtualTime : real()),
    pause() { if (paused) return; paused = true; if (!virtual) { base = real(); since = null; } },
    resume() { if (!paused) return; paused = false; if (!virtual) since = performance.now(); },
    get paused() { return paused; },
    advance(seconds: number) { if (virtual && !paused) virtualTime += seconds; }
  };
}

export interface LinePlaybackOptions {
  voice: LineVoiceData;
  clock: DialogueClock;
  // No audio element at all (tests, the editor's canvas): the line runs on the clock.
  silent: boolean;
  // The text is shown whole at once and a line without audio takes no time (reduced motion, « Texte :
  // tout de suite », the canvas).
  instant: boolean;
  rate(): number;
  volume(): number;
  muted(): boolean;
  // Where the audio element goes (hidden; tests find it there).
  host: HTMLElement;
  // The browser refused to play before a gesture: the line goes on silently, a play button shows.
  onRefused(): void;
  // The audio could play again after a gesture (its play button): it started.
  onPlaying(): void;
}

export type LinePlayback = ReturnType<typeof createLinePlayback>;

export function createLinePlayback(options: LinePlaybackOptions) {
  const { voice, clock } = options;
  const duration = options.instant && !voice.src ? 0 : Math.max(0, voice.duration);
  let audio: HTMLAudioElement | null = null;
  // The silent part: where the line was when the clock took over, and when (clock time).
  let silentFrom = 0;
  let silentSince = clock.now();
  let audioEnded = false;
  let stopped = false;
  let refused = false;
  let paused = false;

  const rate = () => options.rate() || 1;
  if (voice.src && !options.silent) {
    audio = document.createElement('audio');
    audio.className = 't-dialogue-audio';
    audio.preload = 'auto';
    audio.hidden = true;
    audio.setAttribute('aria-hidden', 'true');
    audio.src = voice.src;
    audio.preservesPitch = true;
    audio.addEventListener('ended', () => { audioEnded = true; });
    // An audio that cannot play (missing, unsupported) leaves the line to the silent clock.
    audio.addEventListener('error', () => { if (audio && !audioEnded) useSilence(audio.currentTime || 0); });
    options.host.append(audio);
    sync();
    play();
  }

  function sync() {
    if (!audio) return;
    if (audio.playbackRate !== rate()) { audio.playbackRate = rate(); audio.defaultPlaybackRate = rate(); }
    const volume = Math.max(0, Math.min(1, options.volume()));
    if (audio.volume !== volume) audio.volume = volume;
    if (audio.muted !== options.muted()) audio.muted = options.muted();
  }
  function useSilence(from: number) {
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove(); audio = null; }
    silentFrom = from;
    silentSince = clock.now();
  }
  function play() {
    if (!audio || paused || stopped) return;
    const current = audio;
    void current.play().then(() => {
      if (refused) { refused = false; options.onPlaying(); }
    }, (error: unknown) => {
      if (current !== audio || stopped) return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        // Without a gesture: the text and the line go on, on the clock, from where it is.
        refused = true;
        silentFrom = current.currentTime || 0;
        silentSince = clock.now();
        options.onRefused();
      } else useSilence(current.currentTime || 0);
    });
  }

  const time = (): number => {
    if (stopped) return duration;
    if (paused && (!audio || refused)) return silentFrom;
    if (audio && !refused) return audio.currentTime;
    return Math.min(duration, silentFrom + Math.max(0, clock.now() - silentSince) * rate());
  };

  return {
    voice,
    duration,
    get audio() { return audio; },
    get refused() { return refused; },
    // Seconds from the line's start.
    time,
    // The voice has said the whole line: its audio ended (or could not play), or the clock passed its duration.
    get ended(): boolean {
      if (stopped) return true;
      if (audio && !refused) return audioEnded;
      return time() >= duration - 1e-6;
    },
    // Every frame: the learner's speed, volume and « couper les voix » follow at once.
    sync,
    pause() {
      if (paused) return;
      paused = true;
      if (audio && !refused) audio.pause();
      else { silentFrom = time(); silentSince = clock.now(); }
    },
    resume() {
      if (!paused) return;
      paused = false;
      silentSince = clock.now();
      if (audio && !refused && !audioEnded) play();
    },
    // The bubble's play button after a refusal: the audio from where the line is.
    playAudio() {
      if (!audio) return;
      try { audio.currentTime = Math.min(time(), Math.max(0, (audio.duration || duration) - 0.05)); } catch { /* not loaded yet */ }
      refused = false;
      play();
    },
    // « Suite »: the line is over now (its audio stops).
    stop() {
      stopped = true;
      if (audio) audio.pause();
    },
    dispose() {
      stopped = true;
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove(); audio = null; }
    }
  };
}

// The time of a cue in its line: the compiler's (cue.time), else from the words of the line's voice
// (the anchor's word, its occurrence, its edge and offset), else its start.
export function cueTime(cue: { time?: number; at: { word?: string; occurrence?: number; edge?: 'start' | 'end'; offset?: number } }, voice: LineVoiceData): number {
  if (typeof cue.time === 'number') return cue.time;
  const { word, occurrence = 1, edge = 'start', offset = 0 } = cue.at;
  if (!word) return Math.max(0, offset);
  const wanted = normalize(word);
  let seen = 0;
  for (const [text, start, end] of voice.words) {
    if (normalize(text) !== wanted) continue;
    if (++seen === occurrence) return Math.max(0, (edge === 'end' ? end : start) + offset);
  }
  return 0;
}
const normalize = (text: string) => text.normalize('NFC').toLocaleLowerCase().replace(/[’‘]/g, '\'');
