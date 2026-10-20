// The timeline of a timed screen (docs/decisions.md D24, D28): its steps laid end to end, the
// narration's lines in them with the time of each word, and the moments anchored to them, all
// resolved to seconds. Pure: the build gives the durations it measured and the silences it wrote,
// the canvas and the validator those of the sidecars, or estimates while a line has no audio.
//
// A screen is timed when it is narrated, or when its blocks or its events are timed in seconds (a
// screen without narration). Anchors name lines and words (or seconds from a step's start without
// narration); each falls in the stretch of one step. A step's stretch runs from the end of the
// previous one to its last line, or longer when an effect anchored in it ends later (an effect is
// never cut by the stop at the end of a step), or for as long as steps[n].duration says without
// narration. The next step's first line keeps its pause after that.

import type { Anchor, Block, Moment, Screen } from '@elabora/format';
import { getRegistry } from '../components/registry.ts';
import type { Project } from '../project/model.ts';
import { objectsIn, isRecord } from '../util/values.ts';
import { lineWordTimes, findPhrase, narrationWords } from './words.ts';
import type { TimedWord } from './words.ts';
import { narrationLines, screenSteps } from './narration.ts';
import type { NarrationLineInfo } from './narration.ts';
import { captionChunks, estimatedDuration, pauseOf, STEP_GAP } from './timing.ts';
import type { CaptionCue, Segment } from './timing.ts';
import { translatedLineAnchors, translateAnchor } from '../i18n/anchors.ts';

// The effects of the player (block timing effect); a theme adds its own (course.json theme.effects).
export const EFFECTS = ['none', 'fade', 'rise', 'slide', 'zoom', 'wipe', 'draw'] as const;
export type BuiltinEffect = (typeof EFFECTS)[number];
export const EFFECT_SECONDS: Readonly<Record<BuiltinEffect, number>> = { none: 0, fade: 0.4, rise: 0.5, slide: 0.5, zoom: 0.4, wipe: 0.6, draw: 1.2 };
export const THEME_EFFECT_SECONDS = 0.4;
export const isBuiltinEffect = (name: unknown): name is BuiltinEffect => typeof name === 'string' && (EFFECTS as readonly string[]).includes(name);
export type Direction = 'left' | 'right' | 'up' | 'down';

// The effects a block's timing can take: the built-in presets and the course theme's (theme.effects),
// each with its default duration, the directions it takes, and what it does (editors show their own
// words for the built-in ones, by name).
export interface EffectInfo {
  name: string;
  builtin: boolean;
  duration: number;
  directions?: Direction[];
  description: string;
}

const EFFECT_DESCRIPTIONS: Readonly<Record<BuiltinEffect, string>> = {
  none: 'appears and goes at once',
  fade: 'fades in or out (the default)',
  rise: 'fades in rising a little from below',
  slide: 'slides in from a side, or out towards it',
  zoom: 'grows in from a little smaller',
  wipe: 'is uncovered from a side, or covered back towards it',
  draw: 'its drawing\'s strokes are drawn (a block without a drawing is wiped)'
};

export function effectsOf(project: Pick<Project, 'course'>): EffectInfo[] {
  const builtin = EFFECTS.map((name): EffectInfo => ({ name, builtin: true, duration: EFFECT_SECONDS[name], ...(name === 'slide' || name === 'wipe' ? { directions: ['left', 'right', 'up', 'down'] as Direction[] } : {}), description: EFFECT_DESCRIPTIONS[name] }));
  const theme = isRecord(project.course?.theme) && isRecord(project.course.theme.effects) ? project.course.theme.effects : {};
  const own = Object.entries(theme).filter(([name]) => !isBuiltinEffect(name)).map(([name, description]): EffectInfo => ({ name, builtin: false, duration: THEME_EFFECT_SECONDS, description: typeof description === 'string' ? description : '' }));
  return [...builtin, ...own];
}

// What a stack's transition gives its contents (stack props.transition).
const TRANSITIONS: Readonly<Record<string, { in: { effect: BuiltinEffect; direction?: Direction }; out: { effect: BuiltinEffect; direction?: Direction } }>> = {
  crossfade: { in: { effect: 'fade' }, out: { effect: 'fade' } },
  cut: { in: { effect: 'none' }, out: { effect: 'none' } },
  slide: { in: { effect: 'slide', direction: 'right' }, out: { effect: 'slide', direction: 'left' } }
};

const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000;
const EPSILON = 1e-6;

// Why an anchor did not resolve as written; it then falls back to the start (or end) of its line,
// or to the start of its step.
// unplaced: a word anchor whose marker the translation in this language has not placed.
export type AnchorProblemKind = 'line' | 'word' | 'step' | 'seconds' | 'no-timeline' | 'unplaced';
export interface AnchorProblem {
  kind: AnchorProblemKind;
  message: string;
}

export interface TimelineLineInput {
  id: string;
  step: number;
  text: string;
  pauseBefore?: number;
  // Seconds of audio; null: no audio yet (estimated from the text).
  duration: number | null;
  // When its words are said, from the start of its audio (an alignment of this text, or of the text
  // the audio was made from); null: none (placed in proportion to the text).
  words?: readonly TimedWord[] | null;
}

// A block's in or out, as written (or implied: a stack's next content).
export interface MomentInput {
  block: string;
  kind: 'in' | 'out';
  // The block's step (a nested block: its top block's).
  step: number;
  anchor: Anchor;
  effect: string;
  duration: number;
  direction?: Direction;
  // Implied by a stack (the next content's coming); path: where it is written, for findings.
  implied?: boolean;
  path: string;
  // Known before the layout: a word anchor the translation has not placed (anchored to its line).
  problem?: AnchorProblem;
}

export interface CueInput {
  event: string;
  anchor: Anchor;
  path: string;
  problem?: AnchorProblem;
}

export interface TimelineLine {
  id: string;
  step: number;
  // When the voice starts (after its pause) and ends, in seconds from the start of the timeline.
  start: number;
  end: number;
  pause: number;
  duration: number;
  estimated: boolean;
  // Each word of its text and when it is said, from the start of the timeline.
  words: TimedWord[];
  // Its words were timed by alignment (not placed in proportion to the text).
  aligned: boolean;
  cues: CaptionCue[];
}

export interface TimelineMoment {
  block: string;
  kind: 'in' | 'out';
  at: number;
  effect: string;
  duration: number;
  direction?: Direction;
  // The step whose stretch it falls in, and the block's own step (it shows once that one is reached).
  step: number;
  blockStep: number;
  anchor: Anchor;
  implied?: boolean;
  // Its time comes from estimates (a line without audio, or words without alignment).
  estimated: boolean;
  problem?: AnchorProblem;
  path: string;
}

export interface TimelineCue {
  event: string;
  time: number;
  step: number;
  anchor: Anchor;
  estimated: boolean;
  problem?: AnchorProblem;
  path: string;
}

export interface TimelineLayout {
  lines: TimelineLine[];
  segments: Segment[];
  duration: number;
  // Some line has no audio: its time is estimated.
  estimated: boolean;
  moments: TimelineMoment[];
  cues: TimelineCue[];
  // The silence before each line, then after the last one (what a track lays out).
  gaps: number[];
}

export interface LayoutInput {
  lines: readonly TimelineLineInput[];
  // Every step of the screen (its blocks' and its lines').
  steps: readonly number[];
  narrated: boolean;
  // Screens without narration: steps[n].duration.
  stepSeconds?: ReadonlyMap<number, number>;
  moments?: readonly MomentInput[];
  cues?: readonly CueInput[];
  language?: string;
  // The silences a build wrote (before each line, then after the last): times follow them exactly.
  gaps?: readonly number[];
}

// Where an anchor falls: the step whose stretch holds it, and how to find its time once that step's
// lines are placed. Anchors that end a step resolve once its content is known.
interface Placed {
  step: number;
  endOfStep?: boolean;
  time(layout: { lines: Map<string, TimelineLine>; start: number }): { time: number; estimated: boolean; problem?: AnchorProblem };
}

export function layoutTimeline(input: LayoutInput): TimelineLayout {
  const { narrated, language } = input;
  const steps = [...new Set([...input.steps, ...input.lines.map((line) => line.step)])].sort((a, b) => a - b);
  if (!steps.length) steps.push(1);
  const lineById = new Map(input.lines.map((line) => [line.id, line]));
  const hasStep = (step: unknown): step is number => typeof step === 'number' && steps.includes(step);

  const place = (anchor: Anchor, defaultStep: number): Placed => {
    const offset = typeof anchor.offset === 'number' ? anchor.offset : 0;
    const edge = anchor.edge === 'end' ? 'end' : 'start';
    if (typeof anchor.line === 'string') {
      const line = lineById.get(anchor.line);
      if (!line) {
        const problem: AnchorProblem = { kind: narrated ? 'line' : 'no-timeline', message: narrated ? `no line "${anchor.line}" in the narration (lines: ${input.lines.map((candidate) => candidate.id).join(', ')})` : `the screen has no narration, so no line "${anchor.line}"` };
        return { step: hasStep(defaultStep) ? defaultStep : steps[0], time: ({ start }) => ({ time: start, estimated: false, problem }) };
      }
      return {
        step: line.step,
        time: ({ lines }) => {
          const timed = lines.get(line.id)!;
          if (typeof anchor.word !== 'string') return { time: (edge === 'end' ? timed.end : timed.start) + offset, estimated: timed.estimated };
          const found = findPhrase(timed.words, anchor.word, { occurrence: anchor.occurrence, language });
          if (!found) {
            const count = anchor.occurrence && anchor.occurrence > 1 ? ` (${ordinal(anchor.occurrence)} time)` : '';
            return { time: (edge === 'end' ? timed.end : timed.start) + offset, estimated: timed.estimated, problem: { kind: 'word', message: `line "${line.id}" does not say "${anchor.word}"${count}: ${quote(line.text)}` } };
          }
          const first = timed.words[found.index];
          const last = timed.words[found.index + found.count - 1];
          const words = timed.words.slice(found.index, found.index + found.count);
          return { time: (edge === 'end' ? last.end : first.start) + offset, estimated: timed.estimated || words.some((word) => word.estimated) };
        }
      };
    }
    if (typeof anchor.seconds === 'number') {
      const step = typeof anchor.step === 'number' ? anchor.step : defaultStep;
      const known = hasStep(step);
      const problem: AnchorProblem | undefined = narrated
        ? { kind: 'seconds', message: `${anchor.seconds} s: a narrated screen anchors to its lines and words, not to seconds` }
        : known ? undefined : { kind: 'step', message: `the screen has no step ${step}` };
      return { step: known ? step : steps[0], time: ({ start }) => ({ time: start + anchor.seconds!, estimated: false, ...(problem ? { problem } : {}) }) };
    }
    const step = typeof anchor.step === 'number' ? anchor.step : defaultStep;
    if (!hasStep(step)) return { step: steps[0], time: ({ start }) => ({ time: start, estimated: false, problem: { kind: 'step', message: `the screen has no step ${step}` } }) };
    if (edge === 'end') return { step, endOfStep: true, time: ({ start }) => ({ time: start, estimated: false }) };
    return { step, time: ({ start }) => ({ time: start, estimated: false }) };
  };

  const moments = (input.moments ?? []).map((moment) => ({ moment, placed: place(moment.anchor, moment.step) }));
  const cues = (input.cues ?? []).map((cue) => ({ cue, placed: place(cue.anchor, steps[0]) }));
  const resolvedMoments: TimelineMoment[] = [];
  const resolvedCues: TimelineCue[] = [];
  const lines = new Map<string, TimelineLine>();
  const segments: Segment[] = [];
  const gaps: number[] = [];
  const forced = input.gaps && input.gaps.length === input.lines.length + 1 ? input.gaps : null;
  let t = 0;
  let previousEnd = 0;
  let lineIndex = 0;
  for (const [stepIndex, step] of steps.entries()) {
    const start = t;
    const own = input.lines.filter((line) => line.step === step);
    for (const line of own) {
      const index = lineIndex++;
      // After the previous line, or after the end of the previous step's stretch (which an effect
      // may have made longer), with its pause; the silences a build wrote, as they are.
      const lineStart = ms(forced ? previousEnd + forced[index] : t + pauseOf(line, index, input.lines[index - 1]));
      const estimated = line.duration == null;
      const duration = ms(estimated ? estimatedDuration(line.text) : line.duration ?? 0);
      const end = ms(lineStart + duration);
      const words = lineWordTimes(line.text, duration, line.words, language).map((word) => ({ ...word, start: ms(lineStart + word.start), end: ms(lineStart + word.end), ...(estimated ? { estimated: true } : {}) }));
      lines.set(line.id, {
        id: line.id, step: line.step, start: lineStart, end, pause: ms(lineStart - previousEnd), duration, estimated, words,
        aligned: !estimated && !!line.words?.length && words.every((word) => !word.estimated), cues: captionCuesOf(line.text, lineStart, end, words, language)
      });
      gaps.push(ms(lineStart - previousEnd));
      previousEnd = end;
      t = end;
    }
    const linesEnd = own.length ? lines.get(own[own.length - 1].id)!.end : start;
    const layout = { lines, start };
    // What is anchored in this step, then what ends it.
    let contentEnd = narrated ? linesEnd : Math.max(linesEnd, start + (input.stepSeconds?.get(step) ?? 0));
    const endings: typeof moments = [];
    for (const entry of moments) {
      if (entry.placed.step !== step) continue;
      if (entry.placed.endOfStep) { endings.push(entry); continue; }
      const moment = resolveMoment(entry.moment, entry.placed.time(layout), step);
      resolvedMoments.push(moment);
      if (moment.at >= start - EPSILON) contentEnd = Math.max(contentEnd, moment.at + moment.duration);
    }
    const cueEndings: typeof cues = [];
    for (const entry of cues) {
      if (entry.placed.step !== step) continue;
      if (entry.placed.endOfStep) { cueEndings.push(entry); continue; }
      const found = entry.placed.time(layout);
      const problem = found.problem ?? entry.cue.problem;
      const cue: TimelineCue = { event: entry.cue.event, time: ms(Math.max(0, found.time)), step, anchor: entry.cue.anchor, estimated: found.estimated, path: entry.cue.path, ...(problem ? { problem } : {}) };
      resolvedCues.push(cue);
      contentEnd = Math.max(contentEnd, cue.time);
    }
    let end = contentEnd;
    for (const entry of endings) {
      const moment = resolveMoment(entry.moment, { time: contentEnd, estimated: false }, step);
      resolvedMoments.push(moment);
      end = Math.max(end, moment.at + moment.duration);
    }
    for (const entry of cueEndings) resolvedCues.push({ event: entry.cue.event, time: ms(contentEnd), step, anchor: entry.cue.anchor, estimated: false, path: entry.cue.path });
    if (forced) {
      // The silences a build wrote decide: the stretch ends before the next step's first line (a
      // few milliseconds apart at most from what the durations measured since would give).
      const nextIndex = input.lines.findIndex((line) => steps.indexOf(line.step) > stepIndex);
      if (nextIndex >= 0) {
        const nextStart = previousEnd + forced[nextIndex];
        end = Math.min(end, nextStart - pauseOf(input.lines[nextIndex], nextIndex, input.lines[nextIndex - 1]));
      }
      end = Math.max(end, linesEnd);
    }
    end = ms(end);
    segments.push({ step, start: ms(start), end });
    t = end;
  }
  if (forced) {
    // The track ends with the silence the build wrote after the last line.
    const trackEnd = ms(previousEnd + forced[forced.length - 1]);
    const last = segments[segments.length - 1];
    if (last) last.end = ms(Math.max(last.start, trackEnd));
    t = trackEnd;
  }
  const duration = ms(t);
  gaps.push(ms(duration - previousEnd));
  const timed = [...lines.values()];
  return {
    lines: timed, segments, duration, estimated: timed.some((line) => line.estimated),
    moments: resolvedMoments.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'out' ? -1 : 1)),
    cues: resolvedCues.sort((a, b) => a.time - b.time), gaps
  };
}

function resolveMoment(moment: MomentInput, found: { time: number; estimated: boolean; problem?: AnchorProblem }, step: number): TimelineMoment {
  return {
    block: moment.block, kind: moment.kind, at: ms(Math.max(0, found.time)), effect: moment.effect, duration: moment.duration,
    ...(moment.direction ? { direction: moment.direction } : {}), step, blockStep: moment.step, anchor: moment.anchor, ...(moment.implied ? { implied: true } : {}),
    estimated: found.estimated, ...(found.problem ?? moment.problem ? { problem: found.problem ?? moment.problem } : {}), path: moment.path
  };
}

// The captions of a line: its sentences, cut again where one is longer than two caption lines, each
// from the time its first word is said (in proportion to its length without word times).
function captionCuesOf(text: string, start: number, end: number, words: readonly TimedWord[], language?: string): CaptionCue[] {
  const chunks = captionChunks(text);
  if (!chunks.length) return [];
  const cues: CaptionCue[] = [];
  let wordIndex = 0;
  const starts: number[] = [];
  for (const chunk of chunks) {
    starts.push(wordIndex === 0 ? start : words[wordIndex]?.start ?? end);
    wordIndex += narrationWords(chunk, language).length;
  }
  chunks.forEach((chunk, index) => {
    const from = ms(Math.min(Math.max(starts[index], start), end));
    const to = index === chunks.length - 1 ? end : ms(Math.min(Math.max(starts[index + 1], from), end));
    cues.push({ start: from, end: to, text: chunk });
  });
  return cues;
}

// ── A screen of the project ─────────────────────────────────────────

export interface ScreenTimelineOptions {
  language?: string;
  // Measured by the build, by line id; and the silences it wrote (TimelineLayout.gaps).
  durations?: ReadonlyMap<string, number>;
  gaps?: readonly number[];
}

export interface ScreenTimeline extends TimelineLayout {
  screen: string;
  language: string;
  narrated: boolean;
  // The lines with what the project knows of them (text in that language, audio status, words).
  infos: Map<string, NarrationLineInfo>;
}

// A block's timing as written, with what it implies in a stack. Blocks of layers are not timed.
export function momentsOf(project: Project, screen: Pick<Screen, 'blocks'>): MomentInput[] {
  const registry = getRegistry(project);
  const themeEffects = new Set(Object.keys(isRecord(project.course?.theme?.effects) ? project.course!.theme!.effects! : {}));
  const out: MomentInput[] = [];
  const isStack = (block: Block) => registry.get(block.type)?.root === 'stack';
  const momentOf = (block: Block, kind: 'in' | 'out', written: Moment, step: number, path: string, fallback?: { effect: string; direction?: Direction; duration?: number }): MomentInput => {
    const effect = typeof written.effect === 'string' ? written.effect : fallback?.effect ?? 'fade';
    const duration = typeof written.duration === 'number' ? written.duration : fallback?.duration ?? (isBuiltinEffect(effect) ? EFFECT_SECONDS[effect] : themeEffects.has(effect) ? THEME_EFFECT_SECONDS : EFFECT_SECONDS.fade);
    const direction = (written.direction ?? fallback?.direction) as Direction | undefined;
    return { block: block.id, kind, step, anchor: written.at, effect, duration, ...(direction ? { direction } : {}), path: `${path}/timing/${kind}` };
  };
  const walk = (blocks: readonly Block[] | undefined, step: number | null, path: string, stack: Block | null) => {
    objectsIn(blocks).forEach((block, index) => {
      const own = step ?? (typeof block.step === 'number' ? block.step : 1);
      const here = `${path}/${index}`;
      const timing = isRecord(block.timing) ? block.timing : null;
      const transition = stack ? TRANSITIONS[String(stack.props?.transition ?? 'crossfade')] ?? TRANSITIONS.crossfade : null;
      const stackSeconds = stack && typeof stack.props?.duration === 'number' ? stack.props.duration : undefined;
      if (timing && isRecord(timing.in) && isRecord(timing.in.at)) out.push(momentOf(block, 'in', timing.in, own, here, transition ? { ...transition.in, duration: stackSeconds } : undefined));
      if (timing && isRecord(timing.out) && isRecord(timing.out.at)) out.push(momentOf(block, 'out', timing.out, own, here, transition ? { ...transition.out, duration: stackSeconds } : undefined));
      // A stack's content leaves when the next one comes, unless it says when.
      if (stack && transition && !(timing && isRecord(timing.out))) {
        const contents = objectsIn(stack.blocks);
        const next = contents[contents.indexOf(block) + 1];
        const nextIn = next && isRecord(next.timing) && isRecord(next.timing.in) && isRecord(next.timing.in.at) ? next.timing.in : null;
        if (nextIn) out.push({ ...momentOf(block, 'out', { at: nextIn.at, effect: transition.out.effect, ...(typeof nextIn.duration === 'number' ? { duration: nextIn.duration } : {}) }, own, here, { ...transition.out, duration: stackSeconds }), implied: true });
      }
      walk(block.blocks, own, `${here}/blocks`, isStack(block) ? block : null);
    });
  };
  walk((screen as Screen).blocks, null, '/blocks', null);
  return out;
}

export function cuesOf(screen: Pick<Screen, 'events'>): CueInput[] {
  const out: CueInput[] = [];
  objectsIn(screen.events).forEach((event, index) => {
    if (event.on?.type === 'timeline.reached' && isRecord(event.on.at)) out.push({ event: event.id, anchor: event.on.at, path: `/events/${index}/on/at` });
  });
  return out;
}

// Anchors of seek-timeline actions (they move the playhead; nothing is laid out for them).
export function seekTargetsOf(screen: Pick<Screen, 'events'>): CueInput[] {
  const out: CueInput[] = [];
  objectsIn(screen.events).forEach((event, index) => {
    for (const branch of ['do', 'else'] as const) objectsIn(event[branch]).forEach((action, actionIndex) => {
      if (action.type === 'seek-timeline' && isRecord(action.to)) out.push({ event: event.id, anchor: action.to, path: `/events/${index}/${branch}/${actionIndex}/to` });
    });
  });
  return out;
}

// Whether a screen has a timeline: narrated, or timed blocks or cues without narration.
export function isTimedScreen(project: Project, screen: Screen | null | undefined): boolean {
  if (!screen) return false;
  if (objectsIn(screen.narration?.lines).length) return true;
  return momentsOf(project, screen).length > 0 || cuesOf(screen).length > 0;
}

export function screenTimeline(project: Project, screenId: string, { language, durations, gaps }: ScreenTimelineOptions = {}): ScreenTimeline | null {
  const screen = project.screens.get(screenId)?.data;
  if (!screen) return null;
  const lang = language || project.course?.language || '';
  const infos = narrationLines(project, screenId, lang) ?? [];
  // In a translation, word anchors name the words their markers are placed on (D28).
  const placed = translatedLineAnchors(project, screenId, lang);
  const translated = <T extends { anchor: Anchor; problem?: AnchorProblem }>(entry: T): T => {
    if (!placed.size) return entry;
    const anchor = translateAnchor(entry.anchor, placed);
    if (anchor) return anchor === entry.anchor ? entry : { ...entry, anchor };
    const { word: _word, occurrence: _occurrence, ...line } = entry.anchor;
    return { ...entry, anchor: line, problem: { kind: 'unplaced', message: `the ${lang} translation of line "${entry.anchor.line}" has not placed the marker of « ${entry.anchor.word} » (elabora translate status): at the start of the line` } };
  };
  const moments = momentsOf(project, screen).map(translated);
  const cues = cuesOf(screen).map(translated);
  const narrated = infos.length > 0;
  if (!narrated && !moments.length && !cues.length) return null;
  const source = objectsIn(screen.narration?.lines);
  const stepSeconds = new Map<number, number>();
  for (const [key, value] of Object.entries(isRecord(screen.steps) ? screen.steps : {})) if (isRecord(value) && typeof value.duration === 'number') stepSeconds.set(Number(key), value.duration);
  const layout = layoutTimeline({
    narrated, language: lang, steps: screenSteps(screen), stepSeconds, moments, cues, gaps,
    lines: infos.map((info, index) => ({
      id: info.id, step: info.step, text: info.text ?? source[index]?.text ?? '', pauseBefore: info.pauseBefore,
      duration: durations?.get(info.id) ?? (info.status === 'ok' || info.status === 'stale' ? info.duration : null),
      words: info.status === 'ok' || info.status === 'stale' ? info.words : null
    }))
  });
  return { ...layout, screen: screenId, language: lang, narrated, infos: new Map(infos.map((info) => [info.id, info])) };
}

// The timing of each timed block: its in and out moments.
export function blockTimings(timeline: Pick<TimelineLayout, 'moments'>): Map<string, { in?: TimelineMoment; out?: TimelineMoment }> {
  const out = new Map<string, { in?: TimelineMoment; out?: TimelineMoment }>();
  for (const moment of timeline.moments) {
    const entry = out.get(moment.block) ?? {};
    entry[moment.kind] = moment;
    out.set(moment.block, entry);
  }
  return out;
}

// Where an anchor falls on a laid-out timeline (seek-timeline, look --at, the editor's playhead):
// its time, or why it falls back (as the layout resolves it). step: the step seconds count from.
export function anchorTime(timeline: Pick<ScreenTimeline, 'lines' | 'segments' | 'narrated' | 'language' | 'duration'>, anchor: Anchor, { step }: { step?: number } = {}): { time: number; estimated: boolean; problem?: AnchorProblem } {
  const offset = typeof anchor.offset === 'number' ? anchor.offset : 0;
  const edge = anchor.edge === 'end' ? 'end' : 'start';
  const clamp = (time: number) => ms(Math.max(0, Math.min(timeline.duration, time)));
  const first = timeline.segments[0];
  const segmentOf = (wanted: number | undefined) => timeline.segments.find((segment) => segment.step === wanted);
  if (typeof anchor.line === 'string') {
    const line = timeline.lines.find((candidate) => candidate.id === anchor.line);
    if (!line) return { time: first?.start ?? 0, estimated: false, problem: { kind: timeline.narrated ? 'line' : 'no-timeline', message: timeline.narrated ? `no line "${anchor.line}" in the narration` : `the screen has no narration, so no line "${anchor.line}"` } };
    if (typeof anchor.word !== 'string') return { time: clamp((edge === 'end' ? line.end : line.start) + offset), estimated: line.estimated };
    const found = findPhrase(line.words, anchor.word, { occurrence: anchor.occurrence, language: timeline.language });
    if (!found) return { time: clamp((edge === 'end' ? line.end : line.start) + offset), estimated: line.estimated, problem: { kind: 'word', message: `line "${line.id}" does not say "${anchor.word}"` } };
    const words = line.words.slice(found.index, found.index + found.count);
    return { time: clamp((edge === 'end' ? words[words.length - 1].end : words[0].start) + offset), estimated: line.estimated || words.some((word) => word.estimated) };
  }
  const wanted = typeof anchor.step === 'number' ? anchor.step : step ?? first?.step;
  const segment = segmentOf(wanted);
  if (!segment) return { time: first?.start ?? 0, estimated: false, problem: { kind: 'step', message: `the screen has no step ${wanted}` } };
  if (typeof anchor.seconds === 'number') return { time: clamp(segment.start + anchor.seconds), estimated: false, ...(timeline.narrated ? { problem: { kind: 'seconds' as const, message: `${anchor.seconds} s: a narrated screen anchors to its lines and words` } } : {}) };
  return { time: edge === 'end' ? segment.end : segment.start, estimated: false };
}

const quote = (text: string) => `« ${text.length > 80 ? `${text.slice(0, 79)}…` : text} »`;
const ordinal = (n: number) => (n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`);
