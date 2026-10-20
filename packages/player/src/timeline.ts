// The timeline of a narrated screen (docs/decisions.md D24): its clock, its segments and its bar.
//
// What is seen at a time t is a function of t and of the steps reached; what happens (events) only
// when playback crosses a cue, never on a seek. The clock is the narration's <audio>: its
// currentTime is read at every animation frame, so the timeline waits when the audio waits and
// follows its speed. Without a track (lines without audio yet) the clock counts performance.now();
// in tests (window.ELABORA_TEST.virtualTime) it advances only when told.
//
// Steps are segments: playback never goes past the end of the step reached; in learner mode it
// stops there and waits for Continue, in auto mode the next step opens and playback goes on. The
// screen view owns the steps and the events; this module tells it what to show and what crossed.
//
// The bar has the look of the Lin pages 27 and 36 (docs/decisions.md D58): it sits in the player's
// controls item, isolated under .t-timeline*, and the course's player says what it shows (the seek
// bar, the volume, the transcript, the speeds).

import { element, linkedText, uniqueId } from './dom.ts';
import { icon } from './icons.ts';
import type { IconName } from './icons.ts';
import { createSheet } from './sheet.ts';
import type { Labels } from './labels.ts';
import type { Tooltip } from './tooltip.ts';
import type { NarrationData, NarrationLineData, SegmentData } from './course-data.ts';

export interface TimelinePrefs {
  captions: boolean;
  muted: boolean;
  volume: number; // 0 to 1
  rate: number;
  // « M'arrêter à chaque étape »: auto screens wait for Continue at the end of each step.
  stopAtSteps: boolean;
  keep?: false; // never kept in the browser (loadTimelinePrefs)
  // What the learner chose (only that is kept: the course's captionsByDefault stays its own until
  // the learner turns captions on or off), and the course's key in the browser's storage.
  chosen: Partial<Record<'captions' | 'rate' | 'stopAtSteps' | 'volume', true>>;
  key: string;
}

// The speeds of the player's default (controls option speeds "0.75-2").
export const RATES = [0.75, 1, 1.25, 1.5, 2];
// The learner's choices, one entry per course of the origin (an LMS serves many).
const PREFS_KEY = 'elabora.timeline';
const EPSILON = 1e-3;
// Arrows move the playhead this many seconds.
const ARROW_SECONDS = 5;

// The learner's choices, kept for the session and, where the page may, in the browser, for this
// course only (course: its id). keep false (a module on the web that keeps nothing, D41): neither
// read nor written there. captions: whether they are on before the learner chose (the player's
// captionsByDefault); speeds: those the course offers. Only what the learner chose is kept.
export function loadTimelinePrefs({ keep = true, captions = false, speeds = RATES, course = '' }: { keep?: boolean; captions?: boolean; speeds?: readonly number[]; course?: string } = {}): TimelinePrefs {
  const key = course ? `${PREFS_KEY}:${course}` : PREFS_KEY;
  const prefs: TimelinePrefs = { captions, muted: false, volume: 1, rate: 1, stopAtSteps: false, chosen: {}, key, ...(keep ? {} : { keep: false }) };
  if (!keep) return prefs;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && typeof saved === 'object') {
      const record = saved as Record<string, unknown>;
      if (typeof record.captions === 'boolean') { prefs.captions = record.captions; prefs.chosen.captions = true; }
      if (typeof record.stopAtSteps === 'boolean') { prefs.stopAtSteps = record.stopAtSteps; prefs.chosen.stopAtSteps = true; }
      if (typeof record.rate === 'number' && speeds.includes(record.rate)) { prefs.rate = record.rate; prefs.chosen.rate = true; }
      if (typeof record.volume === 'number' && record.volume >= 0 && record.volume <= 1) { prefs.volume = record.volume; prefs.chosen.volume = true; }
    }
  } catch { /* storage refused (an LMS frame): the session keeps them */ }
  return prefs;
}

// The learner chose one of them: kept with what they chose before, nothing else.
function choose(prefs: TimelinePrefs, what: keyof TimelinePrefs['chosen']): void {
  prefs.chosen[what] = true;
  if (prefs.keep === false) return;
  const saved = Object.fromEntries(Object.keys(prefs.chosen).map((name) => [name, prefs[name as keyof TimelinePrefs['chosen']]]));
  try { localStorage.setItem(prefs.key, JSON.stringify(saved)); } catch { /* see above */ }
}

// What the course's player shows of the bar (its controls item, D58).
export interface TimelineControls {
  seekBar: boolean;
  volume: boolean;
  transcript: boolean;
  speeds: readonly number[];
}

export const DEFAULT_CONTROLS: TimelineControls = { seekBar: true, volume: true, transcript: true, speeds: RATES };

// What the timeline asks of the screen view.
export interface TimelineView {
  // The step reached (course state) and the last step of the screen.
  revealed(): number;
  lastStep(): number;
  // Shows the screen as it is at a step: blocks of later steps hide, nothing else changes.
  display(step: number): void;
  // Auto mode at the end of a step: opens the next one as Continue would; false when it opens
  // otherwise (once answered, by the screen's own triggers).
  chain(next: number): boolean;
  // Whether a seek may reach this step (free seeking: steps that open with Continue), and reach it.
  canReach(step: number): boolean;
  reach(step: number): void;
  // An event's cue crossed by playback (timeline.reached), the end crossed by playback.
  cue(event: string): void;
  ended(): void;
  // The playhead moved (playing, seeking): what is seen follows it (timed blocks).
  moved(time: number): void;
  // Playback stopped at the end of the step reached (steps that open once answered may open).
  segmentEnded(step: number): void;
  // advance next-screen, at the end: the next screen.
  advance(): void;
  // Play at the end of a step does what Continue does: reveals the next step (which then plays) when
  // it opens with Continue and nothing locks it; false otherwise.
  proceed(): boolean;
  // The learner paused (true) or played again (false): animations and free objects stop with the voice.
  still(paused: boolean): void;
  // Playback started or stopped (the player keeps its navigation in step).
  changed(): void;
}

export interface TimelineOptions {
  narration: NarrationData;
  view: TimelineView;
  labels: Labels;
  format(label: string, values: Readonly<Record<string, unknown>>): string;
  // Where the bar goes (null: no bar), and the element the large Play button covers.
  host: HTMLElement | null;
  overlay: HTMLElement;
  // What the bar shows, the player's tooltip, and where the transcript's panel goes.
  controls?: TimelineControls;
  tooltip?: Tooltip | null;
  sheetHost?: HTMLElement | null;
  prefs: TimelinePrefs;
  virtual: boolean;
  // Where playback starts and how far the learner has been (seconds).
  start: number;
  reached: number;
  autoplay: boolean;
  // Phones go step by step.
  phone(): boolean;
  // The module has screens that go on by themselves: the settings offer « M'arrêter à chaque étape ».
  offerStopAtSteps: boolean;
}

// ── Clocks ──────────────────────────────────────────────────────────
interface Clock {
  time(): number;
  // Rejects when the browser refuses sound before a gesture.
  play(): Promise<void>;
  pause(): void;
  seek(time: number): void;
  setRate(rate: number): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  dispose(): void;
}

function audioClock(audio: HTMLAudioElement): Clock {
  return {
    time: () => audio.currentTime,
    play: () => audio.play(),
    pause: () => audio.pause(),
    seek: (time) => { try { audio.currentTime = time; } catch { /* not loaded yet: the default position */ } },
    setRate: (rate) => { audio.playbackRate = rate; audio.defaultPlaybackRate = rate; },
    setMuted: (muted) => { audio.muted = muted; },
    setVolume: (volume) => { audio.volume = volume; },
    dispose: () => { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove(); }
  };
}

function silentClock(): Clock {
  let base = 0;
  let since: number | null = null;
  let rate = 1;
  const time = () => (since === null ? base : base + ((performance.now() - since) / 1000) * rate);
  return {
    time,
    play: () => { if (since === null) since = performance.now(); return Promise.resolve(); },
    pause: () => { base = time(); since = null; },
    seek: (t) => { base = t; if (since !== null) since = performance.now(); },
    setRate: (next) => { base = time(); if (since !== null) since = performance.now(); rate = next; },
    setMuted: () => {},
    setVolume: () => {},
    dispose: () => {}
  };
}

// Tests: time moves only by advance().
function virtualClock(): Clock & { advance(seconds: number): void } {
  let t = 0;
  let running = false;
  let rate = 1;
  return {
    time: () => t,
    play: () => { running = true; return Promise.resolve(); },
    pause: () => { running = false; },
    seek: (time) => { t = time; },
    setRate: (next) => { rate = next; },
    setMuted: () => {},
    setVolume: () => {},
    dispose: () => {},
    advance: (seconds) => { if (running) t += seconds * rate; }
  };
}

export type Timeline = ReturnType<typeof createTimeline>;

export function createTimeline(options: TimelineOptions) {
  const { narration, view, labels, prefs } = options;
  const segments = narration.segments;
  const duration = narration.duration;
  const lastSegment = segments[segments.length - 1];
  // The events on the timeline, in time order (the compiler resolved their anchors).
  const cues = [...(narration.cues ?? [])].sort((a, b) => a.time - b.time);
  // A screen timed in seconds has no voice: no captions, no transcript.
  const voiced = narration.lines.length > 0;
  const speakers = new Set(narration.lines.map((line) => line.speaker).filter(Boolean));

  let t = Math.min(duration, Math.max(0, options.start));
  let reachedTime = Math.max(t, Math.min(duration, options.reached));
  let playing = false;
  // Why playback is held (a modal layer open): it resumes when nothing holds it.
  const holds = new Set<string>();
  let resumeAfterHold = false;
  let shownStep = displayStepAt(t);
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let advanceTimer: ReturnType<typeof setTimeout> | undefined;
  let refused = false;
  let disposed = false;

  // ── The clock ─────────────────────────────────────────────────────
  const audio = narration.src && !options.virtual
    ? element('audio', { class: 't-timeline-audio', preload: 'auto', src: narration.src, 'aria-hidden': 'true' },
      narration.captions ? element('track', { kind: 'captions', src: narration.captions, default: false }) : null)
    : null;
  const virtual = options.virtual ? virtualClock() : null;
  const clock: Clock = virtual ?? (audio ? audioClock(audio) : silentClock());
  if (audio) {
    audio.preservesPitch = true;
    audio.hidden = true;
    // The track ends a little after the last line (encoder padding): the timeline ends at its own end.
    audio.addEventListener('ended', () => { if (playing) tick(); });
    // A page in the background gets no animation frames, but its audio plays on: the audio's own
    // clock events (4 to 66 a second) and a timer at the end of the step keep the timeline with it.
    audio.addEventListener('timeupdate', () => { if (playing) tick(); });
    (options.host ?? options.overlay).append(audio);
  }
  clock.seek(t);
  const controls = options.controls ?? DEFAULT_CONTROLS;
  if (!controls.speeds.includes(prefs.rate)) prefs.rate = 1;
  clock.setRate(prefs.rate);
  clock.setMuted(prefs.muted);
  clock.setVolume(prefs.volume);

  // ── Segments ──────────────────────────────────────────────────────
  const segmentOf = (step: number): SegmentData | undefined => segments.find((segment) => segment.step === step);
  // The step shown at a time: the last step reached whose segment has started.
  function displayStepAt(time: number): number {
    let step = segments[0]?.step ?? 1;
    const reached = view.revealed();
    for (const segment of segments) {
      if (segment.step > reached) break;
      if (segment.start <= time + EPSILON) step = segment.step;
    }
    return step;
  }
  // Playback stops at the end of the step reached.
  const frontierEnd = () => segmentOf(view.revealed())?.end ?? duration;
  // auto and next-screen chain the steps, unless the learner asked to stop at each step or reads on a phone.
  const chains = () => narration.advance !== 'learner' && !prefs.stopAtSteps && !options.phone();
  // How far the learner may seek.
  function seekLimit(): number {
    if (narration.seek === 'free') {
      let limit = frontierEnd();
      for (const segment of segments) if (segment.step > view.revealed()) { if (!view.canReach(segment.step)) break; limit = segment.end; }
      return Math.max(limit, reachedTime);
    }
    return reachedTime;
  }

  // ── Playing ───────────────────────────────────────────────────────
  function play(): void {
    if (disposed) return;
    clearTimeout(advanceTimer);
    // At the end of the step reached, Play does what Continue does (the next step plays), else replays
    // the step; at the end of the screen, it plays the screen again.
    if (t >= frontierEnd() - EPSILON) {
      const step = view.revealed();
      const atEnd = step === lastSegment?.step;
      if (!atEnd && view.proceed()) return;
      seekTo(atEnd && t >= duration - EPSILON ? 0 : segmentOf(step)?.start ?? 0, { user: false });
    }
    playing = true;
    if (holds.size) { resumeAfterHold = true; playing = false; render(); return; }
    clock.seek(t);
    clock.play().then(() => {
      if (!playing || disposed) return;
      refused = false;
      hideStart();
      loop();
    }, (error: unknown) => {
      // The browser refuses sound before a gesture in the page: a large Play button waits for one.
      if (disposed) return;
      playing = false;
      if (error instanceof DOMException && error.name === 'NotAllowedError') { refused = true; showStart(); }
      render();
      view.changed();
    });
    render();
    view.changed();
  }
  function pause(): void {
    clearTimeout(advanceTimer);
    resumeAfterHold = false;
    if (!playing) return;
    playing = false;
    clock.pause();
    tick(false);
    render();
    view.changed();
  }
  const toggle = () => (playing ? pause() : play());

  function loop(): void {
    cancelAnimationFrame(frame);
    if (!playing || virtual) return;
    frame = requestAnimationFrame(() => { tick(); loop(); });
    if (audio) {
      // Woken shortly before the end of the step even without frames (a page in the background).
      clearTimeout(stopTimer);
      const left = (frontierEnd() - t) / (prefs.rate || 1);
      stopTimer = setTimeout(() => { if (playing) tick(); }, Math.max(0, (left - 0.2) * 1000));
    }
  }

  // Reads the clock and moves the timeline to it: cues crossed fire, playback stops at the end of the
  // step reached. advancing false: only read where the clock is (a pause).
  function tick(advancing = true): void {
    if (disposed) return;
    let now = Math.min(duration, Math.max(0, clock.time()));
    if (!advancing || now < t) { if (!advancing) { t = Math.min(now, frontierEnd()); afterMove(); } return; }
    const stop = frontierEnd();
    let stopped = false;
    if (now >= stop - EPSILON) { now = stop; stopped = true; }
    const from = t;
    t = now;
    reachedTime = Math.max(reachedTime, t);
    for (const cue of cues) {
      if (cue.time <= from + EPSILON / 10 || cue.time > now + EPSILON / 10) continue;
      view.cue(cue.event);
      // An event moved the playhead (seek-timeline): what lies past the cue was not crossed.
      if (disposed || t !== now) return;
    }
    if (disposed) return;
    afterMove();
    if (stopped && playing) atStop(stop);
    else if (playing && !virtual && audio) {
      // Close to the end of the step: a timer stops it within a few milliseconds of the boundary.
      const left = (stop - t) / (prefs.rate || 1);
      if (left < 0.25) { clearTimeout(timer); timer = setTimeout(() => tick(), Math.max(0, left * 1000)); }
    }
  }

  function atStop(stop: number): void {
    playing = false;
    clock.pause();
    clock.seek(stop);
    const step = view.revealed();
    const last = step === lastSegment?.step;
    render();
    view.changed();
    if (last) {
      view.ended();
      if (narration.advance === 'next-screen' && chains() && !disposed) advanceTimer = setTimeout(() => view.advance(), options.virtual ? 0 : 900);
      return;
    }
    const next = segments[segments.findIndex((segment) => segment.step === step) + 1]?.step;
    if (chains() && next !== undefined && view.chain(next)) return; // the view revealed it: onReveal plays it
    view.segmentEnded(step);
  }

  // The view revealed a step (Continue, reveal-step, a step that opens once answered, auto mode):
  // its segment plays from its start.
  function onReveal(step: number, { autoplay = true }: { autoplay?: boolean } = {}): void {
    const segment = segmentOf(step);
    if (!segment) return;
    if (segment.start > reachedTime) reachedTime = segment.start;
    seekTo(segment.start, { user: false });
    if (autoplay) play();
  }

  // ── Seeking: what is seen is recomputed, nothing fires ──────────────
  function seekTo(time: number, { user = true }: { user?: boolean } = {}): void {
    if (user && narration.seek === 'none') return;
    let target = Math.max(0, Math.min(duration, time));
    if (user) {
      target = Math.min(target, seekLimit());
      // Free seeking into a step not reached yet reaches it (no event fires).
      if (target > frontierEnd() + EPSILON) {
        const into = [...segments].reverse().find((segment) => segment.start <= target + EPSILON && segment.step > view.revealed());
        if (into) view.reach(into.step);
      }
      reachedTime = Math.max(reachedTime, target);
    }
    t = target;
    clock.seek(t);
    afterMove();
  }
  const seekBy = (seconds: number) => seekTo(t + seconds);
  // seek-timeline (an event of the screen): to a time, as a seek (nothing crossed fires) whatever the
  // seek mode; a time in a step not reached yet reaches it; playback goes on if it was playing.
  function jump(time: number): void {
    const target = Math.max(0, Math.min(duration, time));
    if (target > frontierEnd() + EPSILON) {
      const into = [...segments].reverse().find((segment) => segment.start <= target + EPSILON && segment.step > view.revealed());
      if (into) view.reach(into.step);
    }
    reachedTime = Math.max(reachedTime, target);
    seekTo(target, { user: false });
    if (playing) clock.seek(t);
  }
  // Page Up/Down: the start of the next step, or of this one (the previous one from its start).
  function stepBy(direction: 1 | -1): void {
    const index = segments.findIndex((segment) => segment.step === shownStep);
    if (direction > 0) {
      const next = segments.slice(index + 1).find((segment) => segment.end > segment.start || segment.step === lastSegment?.step);
      seekTo(next ? next.start : seekLimit());
    } else {
      const current = segments[index];
      const target = current && t > current.start + 1 ? current : segments[Math.max(0, index - 1)];
      seekTo(target?.start ?? 0);
    }
  }
  // Replay the step shown: back to its start, playing.
  function replayStep(): void {
    const segment = segmentOf(shownStep) ?? segments[0];
    seekTo(segment?.start ?? 0, { user: false });
    play();
  }

  function afterMove(): void {
    const step = displayStepAt(t);
    if (step !== shownStep) { shownStep = step; view.display(step); }
    view.moved(t);
    render();
  }

  // ── Holds (modal layers) ──────────────────────────────────────────
  function hold(reason: string): void {
    const wasPlaying = playing;
    holds.add(reason);
    if (wasPlaying) { pause(); resumeAfterHold = true; }
  }
  function release(reason: string): void {
    holds.delete(reason);
    if (!holds.size && resumeAfterHold) { resumeAfterHold = false; play(); }
  }

  // ── The bar ───────────────────────────────────────────────────────
  // In the player's controls item (docs/decisions.md D58), as the Lin pages 27 and 36 draw it: Play,
  // Replay the step, the seek bar (the part not heard yet dotted), the time, then Captions, the
  // settings (speeds, « M'arrêter à chaque étape », shortcuts), the volume and the transcript; in a
  // narrower window the volume and the transcript go into « … », on phones the settings too. Without
  // a seek bar (the course's seekBar false, or the screen's seek none): the time and the step in words.
  const time = (seconds: number) => {
    const whole = Math.floor(seconds + EPSILON);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  };
  const spokenTime = (seconds: number) => {
    const whole = Math.round(seconds);
    return options.format(labels.timelineTime, { m: Math.floor(whole / 60), s: whole % 60 }).trim();
  };
  const stepCount = () => segments.length;
  const stepIndex = () => Math.max(1, segments.findIndex((segment) => segment.step === shownStep) + 1);
  const rateText = (rate: number) => `${options.format('{rate}', { rate })}×`;
  const tooltip = options.tooltip ?? null;
  const hint = (node: HTMLElement, text: string | (() => string | null)) => tooltip?.attach(node, text);
  const button = (className: string, name: IconName, label: string, onclick: () => void, attributes: Record<string, string> = {}) => {
    const node = element('button', { type: 'button', class: `t-timeline-btn ${className}`, 'aria-label': label, onclick, ...attributes }, icon(name));
    hint(node, () => node.getAttribute('aria-label'));
    return node;
  };

  const playButton = element('button', { type: 'button', class: 't-timeline-btn t-timeline-play', 'aria-keyshortcuts': 'Control+Alt+P', onclick: () => { toggle(); view.still(!playing); } });
  hint(playButton, () => playButton.getAttribute('aria-label'));
  const replayButton = button('t-timeline-replay', 'replay', labels.replayStep, () => { replayStep(); view.still(false); }, { 'aria-keyshortcuts': 'Control+Alt+R' });
  const seen = element('div', { class: 't-timeline-seen' });
  const played = element('div', { class: 't-timeline-played' });
  const thumb = element('div', { class: 't-timeline-thumb' });
  const marks = segments.slice(1).filter(() => duration > 0).map((segment) => element('span', { class: 't-timeline-mark', 'data-step': String(segment.step), style: `left: ${(100 * segment.start) / duration}%` }));
  const track = element('div', { class: 't-timeline-track' }, seen, played, marks, thumb);
  const seekable = narration.seek !== 'none' && controls.seekBar;
  const seek = seekable ? element('div', { class: 't-timeline-seek', role: 'slider', tabindex: '0', 'aria-label': labels.seek, 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(duration)) }, track) : null;
  const clockText = element('span', { class: 't-timeline-time', 'aria-hidden': seekable ? 'true' : undefined });
  const captionsButton = button('t-timeline-captions', 'captions', labels.captions, () => setCaptions(!prefs.captions), { 'aria-keyshortcuts': 'Control+Alt+C' });
  // The settings: the speeds the course offers, the module's « M'arrêter à chaque étape » when it has
  // screens that go on by themselves, and the keyboard shortcuts.
  const speeds = controls.speeds.length > 1 ? controls.speeds : [];
  const ratesName = uniqueId('rate');
  const rateInputs = speeds.map((rate) => element('input', { type: 'radio', name: ratesName, value: String(rate), checked: rate === prefs.rate, onchange: () => { prefs.rate = rate; clock.setRate(rate); choose(prefs, 'rate'); render(); } }));
  const stopInput = options.offerStopAtSteps ? element('input', { type: 'checkbox', checked: prefs.stopAtSteps, onchange: () => { prefs.stopAtSteps = stopInput?.checked ?? false; choose(prefs, 'stopAtSteps'); render(); } }) : null;
  const settingsId = uniqueId('settings');
  const settingsButton = button('t-timeline-settings-btn', 'settings', labels.settings, () => togglePopup(settings, settingsButton), { 'aria-expanded': 'false', 'aria-controls': settingsId });
  const rateBadge = element('span', { class: 't-timeline-rate-badge', 'aria-hidden': 'true' });
  settingsButton.append(rateBadge);
  const keysButton = element('button', { type: 'button', class: 't-timeline-option t-timeline-keys-btn', 'aria-keyshortcuts': 'Shift+?', onclick: () => { togglePopup(settings, settingsButton, false); toggleKeys(true); } }, element('span', { class: 't-timeline-option-text', text: labels.shortcuts }));
  const settings = element('div', { id: settingsId, class: 't-timeline-popup t-timeline-settings', hidden: true },
    speeds.length ? element('fieldset', { class: 't-timeline-speeds' }, element('legend', { text: labels.speed }), speeds.map((rate, index) => element('label', { class: 't-timeline-option' }, rateInputs[index], element('span', { class: 't-timeline-option-text', text: rate === 1 ? `${rateText(rate)} (${labels.normalSpeed})` : rateText(rate) }), icon('check', 't-timeline-option-check')))) : null,
    stopInput ? element('label', { class: 't-timeline-option t-timeline-stop' }, stopInput, element('span', { class: 't-timeline-option-text' }, element('span', { text: labels.stopAtSteps }), element('small', { text: labels.stopAtStepsHint }))) : null,
    keysButton);
  // The keyboard shortcuts (Shift+? on the bar, or from the settings): a list that Escape closes.
  const keyRows: [string, string][] = [
    ['Ctrl+Alt+P', labels.shortcutPlay], ['Ctrl+Alt+R', labels.shortcutReplay], ...(voiced ? [['Ctrl+Alt+C', labels.shortcutCaptions] as [string, string]] : []),
    ...(seekable ? [['← →', labels.shortcutSeek], ['Page ↑ Page ↓', labels.shortcutStep], ['Home End', labels.shortcutEnds]] as [string, string][] : []), ['Shift+?', labels.shortcutList]
  ];
  const keysId = uniqueId('keys');
  const keysTitle = element('h2', { class: 't-timeline-keys-title', tabindex: '-1', text: labels.shortcuts });
  const closeKeys = button('t-timeline-keys-close', 'close', labels.close, () => { toggleKeys(false); playButton.focus(); });
  const keysPanel = element('section', { id: keysId, class: 't-timeline-popup t-timeline-keys', 'aria-label': labels.shortcuts, hidden: true },
    element('div', { class: 't-timeline-popup-head' }, keysTitle, closeKeys),
    element('dl', {}, keyRows.flatMap(([keys, what]) => [element('dt', {}, keys.split(' ').map((key) => element('kbd', { text: key }))), element('dd', { text: what })])));
  keysPanel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); toggleKeys(false); playButton.focus(); } });
  function toggleKeys(open = keysPanel.hidden): void {
    keysPanel.hidden = !open;
    if (open) keysTitle.focus({ preventScroll: true });
  }
  // The volume: Mute, and its slider above it while the pointer or the focus is on it (nothing moves).
  // No tooltip: the slider comes above it on hover, and the button says what it does to screen readers.
  const muteButton = element('button', { type: 'button', class: 't-timeline-btn t-timeline-mute', 'aria-label': labels.mute, onclick: () => { prefs.muted = !prefs.muted; clock.setMuted(prefs.muted); render(); } }, icon('volume'));
  const volumeInput = element('input', { type: 'range', class: 't-timeline-volume-range', min: '0', max: '100', step: '5', value: String(Math.round(prefs.volume * 100)), 'aria-label': labels.volume });
  volumeInput.addEventListener('input', () => {
    prefs.volume = Number(volumeInput.value) / 100;
    if (prefs.muted && prefs.volume > 0) { prefs.muted = false; clock.setMuted(false); }
    clock.setVolume(prefs.volume);
    choose(prefs, 'volume');
    render();
  });
  const volume = element('span', { class: 't-timeline-volume' }, muteButton, element('span', { class: 't-timeline-volume-pop' }, volumeInput));
  const transcriptButton = button('t-timeline-transcript-btn', 'transcript', labels.transcript, () => toggleTranscript(), { 'aria-expanded': 'false' });
  // « … »: the volume and the transcript in a narrower window, and the settings on a phone.
  const moreId = uniqueId('more');
  const moreButton = button('t-timeline-more', 'more', labels.more, () => togglePopup(more, moreButton), { 'aria-expanded': 'false', 'aria-controls': moreId });
  const more = element('div', { id: moreId, class: 't-timeline-popup t-timeline-more-menu', hidden: true });
  const tools = element('span', { class: 't-timeline-tools' }, captionsButton, element('span', { class: 't-timeline-anchor' }, settingsButton, settings), controls.volume ? volume : null, controls.transcript ? transcriptButton : null, element('span', { class: 't-timeline-anchor' }, moreButton, more));
  // Without a voice (a screen timed in seconds), nothing to caption, hear or transcribe.
  if (!voiced) { captionsButton.hidden = true; volume.hidden = true; transcriptButton.hidden = true; }
  const bar = element('div', { class: 't-timeline', role: 'group', 'aria-label': labels.narration, 'data-seek': seekable ? narration.seek : 'none' },
    playButton, replayButton, seek, clockText, tools);

  // Narrower windows: the volume and the transcript into « … »; phones: the settings too.
  const narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 1023px)') : null;
  const small = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : null;
  const anchorOf = (node: HTMLElement) => node.parentElement?.classList.contains('t-timeline-anchor') ? node.parentElement : node;
  function arrangeTools(): void {
    const movable: HTMLElement[] = [anchorOf(settingsButton), ...(controls.volume ? [volume] : []), ...(controls.transcript ? [transcriptButton] : [])];
    const intoMore: HTMLElement[] = [];
    if (narrow?.matches && voiced) intoMore.push(...movable.slice(1));
    if (small?.matches) intoMore.unshift(anchorOf(settingsButton));
    for (const node of movable) {
      if (intoMore.includes(node)) more.append(node);
      else tools.insertBefore(node, anchorOf(moreButton));
    }
    anchorOf(moreButton).hidden = !intoMore.length;
  }
  narrow?.addEventListener('change', arrangeTools);
  small?.addEventListener('change', arrangeTools);

  // A popup menu of the bar: Escape or a click outside closes it.
  function togglePopup(popup: HTMLElement, opener: HTMLElement, open = popup.hidden): void {
    for (const other of [settings, more]) if (other !== popup && !other.hidden) togglePopup(other, other === settings ? settingsButton : moreButton, false);
    popup.hidden = !open;
    opener.setAttribute('aria-expanded', String(open));
    tooltip?.hide();
    if (open) (popup.querySelector<HTMLElement>('input:checked, input, button') ?? popup).focus({ preventScroll: true });
  }
  const closePopups = (event: Event) => {
    for (const [popup, opener] of [[settings, settingsButton], [more, moreButton]] as const) {
      if (popup.hidden) continue;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' && popup.contains(document.activeElement) : !anchorOf(opener).contains(event.target as Node)) {
        togglePopup(popup, opener, false);
        if (event instanceof KeyboardEvent) { event.preventDefault(); opener.focus(); }
      }
    }
  };

  // Captions: a band over the bottom of the screen, which moves nothing; the speaker is named when it
  // changes. Hidden from screen readers: they hear the voice, and the transcript gives the words.
  const captionText = element('p', { class: 't-timeline-caption' });
  const band = element('div', { class: 't-timeline-band', 'aria-hidden': 'true', hidden: true }, captionText);
  // The transcript: the script by step with its speakers, in a side panel of the player; the line
  // spoken is marked, and a line already heard takes the playhead there.
  const transcriptLines = narration.lines.map((line) => {
    // The speaker above the words; screen readers and a copy read « Marc : … ».
    const content = [line.speaker ? element('strong', { class: 't-timeline-speaker', text: line.speaker }) : null, line.speaker ? element('span', { class: 't-sr-only', text: labels.colon }) : null, element('span', { class: 't-timeline-line-text', text: line.text })];
    return seekable
      ? element('button', { type: 'button', class: 't-timeline-line', 'data-line': line.id, onclick: () => { seekTo(line.start + EPSILON); render({ spoken: true }); } }, content)
      : element('p', { class: 't-timeline-line', 'data-line': line.id }, content);
  });
  const transcriptSteps = segments.filter((segment) => narration.lines.some((line) => line.step === segment.step)).map((segment, _index, all) => element('section', { class: 't-timeline-transcript-step' },
    all.length > 1 ? element('h3', { text: options.format(labels.stepHeading, { n: segments.indexOf(segment) + 1 }) }) : null,
    transcriptLines.filter((_, lineIndex) => narration.lines[lineIndex].step === segment.step)));
  const sheet = options.host && voiced && controls.transcript ? createSheet({
    name: 'transcript', title: labels.transcript, closeLabel: labels.close, tooltip, host: options.sheetHost ?? options.overlay,
    onToggle: (open) => transcriptButton.setAttribute('aria-expanded', String(open))
  }) : null;
  if (sheet) {
    // The voice's AI mention (AI Act, art. 50) and the credits its voices ask for (CC-BY voices) stay
    // with the words, whatever « IA et crédits » shows.
    sheet.element.classList.add('t-timeline-transcript');
    sheet.body.append(
      ...(narration.generated ? [element('p', { class: 't-timeline-generated' }, icon('spark'), element('span', { text: labels.generatedVoice }))] : []),
      ...transcriptSteps,
      ...(narration.credits?.length ? [element('section', { class: 't-timeline-credits' }, element('h3', { text: labels.credits }), narration.credits.map((credit) => linkedText('p', credit)))] : []));
  }
  // When the browser refused sound: one large Play button over the screen, inviting and nothing else
  // (its click is the gesture the browser waits for). First in the screen, so that Tab reaches it.
  const startButton = element('button', { type: 'button', class: 't-timeline-start', onclick: () => { hideStart(); play(); } },
    element('span', { class: 't-timeline-start-circle' }, icon('play')), element('span', { class: 't-timeline-start-label', text: labels.playNarration }));

  if (options.host) {
    options.host.append(bar, band, keysPanel);
    arrangeTools();
    document.addEventListener('pointerdown', closePopups);
    document.addEventListener('keydown', closePopups);
  }

  function setCaptions(on: boolean): void { prefs.captions = on; choose(prefs, 'captions'); render(); }
  function toggleTranscript(open = !sheet?.isOpen): void {
    if (!sheet) return;
    if (open) sheet.open(transcriptButton); else sheet.close();
  }
  function showStart(): void { if (!startButton.isConnected) options.overlay.prepend(startButton); }
  function hideStart(): void { startButton.remove(); }

  const lineAt = (at: number): NarrationLineData | undefined => narration.lines.find((line) => line.start <= at + EPSILON && at < line.end - EPSILON / 10);
  // The word said at a time (the last one started), and a few words around it.
  const wordAt = (line: NarrationLineData | undefined, at: number): number => {
    const words = line?.words ?? [];
    let index = -1;
    for (const [i, word] of words.entries()) { if (word[1] <= at + EPSILON) index = i; else break; }
    return index;
  };
  // The words from..to of a line as its text writes them (punctuation and apostrophes kept), found in
  // order in the text; joined with spaces when the text does not have them.
  function span(text: string, words: readonly [string, number, number][], from: number, to: number): string {
    let at = 0;
    let start = -1;
    let end = -1;
    for (const [index, [word]] of words.entries()) {
      const found = text.indexOf(word, at);
      if (found < 0) return words.slice(from, to).map((entry) => entry[0]).join(' ');
      if (index === from) start = found;
      at = found + word.length;
      if (index === to - 1) { end = at; break; }
    }
    return start >= 0 && end > start ? text.slice(start, end).replace(/\s+/g, ' ') : words.slice(from, to).map((entry) => entry[0]).join(' ');
  }
  // What is said at a time, as the seek bar's tooltip quotes it: the speaker, then a few words around
  // the one said (« Marc : « …et mes collègues ont… » »), never the time; nothing in a silence.
  function quoteAt(at: number): string | null {
    const line = lineAt(at);
    if (!line) return null;
    const index = wordAt(line, at);
    const words = line.words ?? [];
    let said = '';
    if (index >= 0) {
      const from = Math.max(0, index - 2);
      const to = Math.min(words.length, index + 3);
      said = `${from > 0 ? '…' : ''}${span(line.text, words, from, to)}${to < words.length ? '…' : ''}`;
    } else said = line.cues.find((cue) => cue.start <= at + EPSILON && at < cue.end)?.text ?? '';
    if (!said) return null;
    const quoted = options.format(labels.quote, { text: said });
    return line.speaker ? `${line.speaker}${labels.colon}${quoted}` : quoted;
  }
  let dragging = false;
  let lastValueText = '';
  let lastSpoken = 0;
  let shownPlaying: boolean | null = null;
  let shownMuted: string | null = null;
  let currentLine: string | null | undefined;
  // spoken: the learner moved the playhead (its value is said at once, even while it plays).
  function render({ spoken = false }: { spoken?: boolean } = {}): void {
    if (!options.host || disposed) return;
    const fraction = duration > 0 ? t / duration : 0;
    if (shownPlaying !== playing) {
      shownPlaying = playing;
      playButton.setAttribute('aria-label', playing ? labels.pause : labels.play);
      playButton.replaceChildren(icon(playing ? 'pause' : 'play'));
      playButton.dataset.state = playing ? 'playing' : 'paused';
    }
    const loudness = prefs.muted || prefs.volume === 0 ? 'muted' : prefs.volume < 0.5 ? 'volumeLow' : 'volume';
    if (shownMuted !== loudness) {
      shownMuted = loudness;
      muteButton.replaceChildren(icon(loudness));
      muteButton.setAttribute('aria-label', prefs.muted ? labels.unmute : labels.mute);
    }
    // The part heard is solid, the rest dotted (not yet); the playhead anywhere in what may be reached.
    const heard = duration > 0 ? reachedTime / duration : 0;
    track.style.setProperty('--t-timeline-at', String(fraction));
    track.style.setProperty('--t-timeline-seen', String(heard));
    played.style.width = `${100 * fraction}%`;
    seen.style.width = `${100 * heard}%`;
    thumb.style.left = `${100 * fraction}%`;
    clockText.textContent = seekable ? `${time(t)} / ${time(duration)}` : `${time(t)} / ${time(duration)} · ${options.format(labels.stepOf, { step: stepIndex(), steps: stepCount() })}`;
    // The value is said when the learner moves it; while it plays, not every frame.
    if (seek) {
      seek.setAttribute('aria-valuenow', String(Math.round(t)));
      const focused = document.activeElement === seek;
      const now = performance.now();
      if (spoken || !playing || !focused || now - lastSpoken > 10000) {
        const text = options.format(labels.timelineValue, { time: spokenTime(t), total: spokenTime(duration), step: stepIndex(), steps: stepCount() });
        if (text !== lastValueText) { seek.setAttribute('aria-valuetext', text); lastValueText = text; lastSpoken = now; }
      }
    }
    captionsButton.setAttribute('aria-pressed', String(prefs.captions));
    muteButton.setAttribute('aria-pressed', String(prefs.muted));
    volumeInput.value = String(prefs.muted ? 0 : Math.round(prefs.volume * 100));
    rateBadge.textContent = prefs.rate === 1 ? '' : rateText(prefs.rate);
    for (const input of rateInputs) input.checked = Number(input.value) === prefs.rate;
    if (stopInput) stopInput.checked = prefs.stopAtSteps;
    const index = narration.lines.findIndex((candidate) => candidate.start <= t + EPSILON && t < candidate.end - EPSILON / 10);
    const line = narration.lines[index];
    const cue = line?.cues.find((candidate) => candidate.start <= t + EPSILON && t < candidate.end - EPSILON / 10);
    band.hidden = !prefs.captions || !cue;
    const named = speakers.size > 1 && !!line?.speaker && (index === 0 || narration.lines[index - 1].speaker !== line.speaker || line.cues[0] !== cue);
    if (cue && line) captionText.replaceChildren(...(named && line.cues[0] === cue ? [element('span', { class: 't-timeline-speaker', text: `${line.speaker}${labels.colon}` })] : []), cue.text);
    if (currentLine !== (line?.id ?? null)) {
      currentLine = line?.id ?? null;
      for (const node of transcriptLines) node.toggleAttribute('aria-current', node.dataset.line === currentLine);
    }
    // A line not heard yet cannot be reached from the transcript (seek seen).
    if (seekable) for (const [lineIndex, node] of transcriptLines.entries()) (node as HTMLButtonElement).disabled = narration.lines[lineIndex].start > seekLimit() + EPSILON;
  }

  // Keys on the seek bar (WAI-ARIA APG seek slider): arrows ±5 s, Page Up/Down a step, Home, End.
  if (seek) {
    seek.addEventListener('keydown', (event) => {
      const keys: Record<string, () => void> = {
        ArrowRight: () => seekBy(ARROW_SECONDS), ArrowUp: () => seekBy(ARROW_SECONDS), ArrowLeft: () => seekBy(-ARROW_SECONDS), ArrowDown: () => seekBy(-ARROW_SECONDS),
        PageUp: () => stepBy(1), PageDown: () => stepBy(-1), Home: () => seekTo(0), End: () => seekTo(seekLimit())
      };
      const run = keys[event.key];
      if (!run) return;
      event.preventDefault();
      run();
      render({ spoken: true });
    });
    // The time under the pointer, within what may be reached.
    const timeAt = (clientX: number) => {
      const box = track.getBoundingClientRect();
      return Math.max(0, Math.min(duration, ((clientX - box.left) / Math.max(1, box.width)) * duration));
    };
    const xOf = (at: number) => { const box = track.getBoundingClientRect(); return box.left + (duration > 0 ? (at / duration) * box.width : 0); };
    // Hovering: the words said there, in the player's tooltip (Lin 27), only where the playhead may go.
    seek.addEventListener('pointermove', (event) => {
      if (dragging || event.pointerType === 'touch') return;
      const at = timeAt(event.clientX);
      tooltip?.at(seek, event.clientX, at <= seekLimit() + EPSILON ? quoteAt(at) : null);
    });
    seek.addEventListener('pointerleave', () => { if (!dragging && tooltip?.owner === seek) tooltip.hide(); });
    // Pointer: press and drag along the bar. The screen follows the playhead (nothing fires), the
    // tooltip says the words said there; playback goes on from where it is let go.
    const fromPointer = (event: PointerEvent) => {
      seekTo(timeAt(event.clientX));
      tooltip?.at(seek, xOf(t), quoteAt(t));
    };
    seek.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      seek.setPointerCapture?.(event.pointerId);
      const resume = playing;
      if (playing) { playing = false; clock.pause(); }
      dragging = true;
      fromPointer(event);
      const move = (next: PointerEvent) => fromPointer(next);
      const up = () => {
        seek.removeEventListener('pointermove', move); seek.removeEventListener('pointerup', up); seek.removeEventListener('pointercancel', up);
        dragging = false;
        if (tooltip?.owner === seek) tooltip.hide();
        if (resume) play(); else render();
      };
      seek.addEventListener('pointermove', move);
      seek.addEventListener('pointerup', up);
      seek.addEventListener('pointercancel', up);
    });
  }
  // Shortcuts take modifiers (WCAG 2.1.4), as Storyline's: Ctrl+Alt+P, R, C (by key position: Alt
  // changes the character on a Mac).
  // Shift+? lists them, on the bar only (a character key acts only where it has the focus, WCAG 2.1.4).
  bar.addEventListener('keydown', (event) => {
    if (event.key !== '?' || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    toggleKeys(true);
  });
  const onKey = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return;
    const actions: Record<string, () => void> = { KeyP: () => { toggle(); view.still(!playing); }, KeyR: () => { replayStep(); view.still(false); }, ...(voiced ? { KeyC: () => setCaptions(!prefs.captions) } : {}) };
    const run = actions[event.code];
    if (!run) return;
    event.preventDefault();
    run();
  };
  if (options.host) document.addEventListener('keydown', onKey);

  render();
  if (options.autoplay && t < frontierEnd() - EPSILON) play();

  return {
    get time() { return t; },
    get reachedTime() { return reachedTime; },
    get playing() { return playing; },
    get refused() { return refused; },
    get duration() { return duration; },
    displayStep: () => shownStep,
    // The step shown has been heard to its end (Continue may wait for it).
    segmentHeard: (step: number) => reachedTime >= (segmentOf(step)?.end ?? 0) - EPSILON,
    play, pause, toggle, replayStep, seek: (time: number) => seekTo(time), jump, onReveal, hold, release,
    // Shows a time without playing or firing, whatever the seek mode (captures, the editor).
    showAt(time: number) { pause(); seekTo(time, { user: false }); },
    // Test mode: moves the virtual clock (in small steps, so that the order of cues holds).
    advance(seconds: number) {
      if (!virtual) return;
      let left = seconds;
      while (left > EPSILON && playing && !disposed) {
        const stepSize = Math.min(left, 0.05);
        virtual.advance(stepSize);
        tick();
        left -= stepSize;
      }
    },
    focusSeek: () => (seek ?? playButton).focus({ preventScroll: true }),
    // The transcript's panel opened or closed (the editor's preview).
    transcript: (open: boolean) => toggleTranscript(open),
    get prefs() { return prefs; },
    lineAt: (line: string, edge: 'start' | 'end' = 'start') => { const found = narration.lines.find((candidate) => candidate.id === line); return found ? (edge === 'end' ? found.end : found.start) : null; },
    state() {
      const line = lineAt(t);
      const word = wordAt(line, t);
      return { time: t, reached: reachedTime, duration, playing, step: shownStep, refused, captions: prefs.captions, rate: prefs.rate, muted: prefs.muted, volume: prefs.volume, line: line?.id ?? null, word: word >= 0 ? line?.words?.[word][0] ?? null : null, caption: band.hidden ? null : captionText.textContent, dragging };
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      clearTimeout(stopTimer);
      clearTimeout(advanceTimer);
      clock.pause();
      clock.dispose();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', closePopups);
      document.removeEventListener('keydown', closePopups);
      narrow?.removeEventListener('change', arrangeTools);
      small?.removeEventListener('change', arrangeTools);
      bar.remove(); band.remove(); sheet?.dispose(); keysPanel.remove(); startButton.remove();
      if (tooltip && bar.contains(tooltip.owner)) tooltip.hide();
    }
  };
}
