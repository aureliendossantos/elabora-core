import type { Anchor } from '@elabora/format';
import type { Block, Project } from '../project/model.ts';
import { getRegistry } from '../components/registry.ts';
import { objectsIn } from '../util/values.ts';
import { readNarrationSidecar, screenTiming } from './narration.ts';
import type { NarrationLineInfo } from './narration.ts';
import type { Segment, TimedLine } from './timing.ts';
import { screenTimeline, blockTimings, BEAT_SETTLE } from './timeline.ts';
import type { TimelineMoment } from './timeline.ts';
import { narrationWords } from './words.ts';
import { formatAnchor } from './anchor-text.ts';
import { clockTime } from './timing.ts';

// A narrated screen as an editor shows it (docs/decisions.md D24): how it advances and how far
// learners may seek, as they apply (the screen's own setting, else the course's, else the default)
// and as the screen itself sets them; each line in a language, with its text there, whether its
// audio is there and up to date, and where it falls on the timeline (estimated from its text while it
// has no audio); the segment of each step and the whole length. null: the screen is not narrated.
// Each function takes { layer } for the timeline of a layer of the screen (D62): its lines, one
// segment from its opening, its timed blocks and cues; a layer plays through (advance auto).

export type Advance = 'learner' | 'auto' | 'next-screen';
export type Seek = 'seen' | 'free' | 'none';

export interface NarrationLineView extends NarrationLineInfo {
  timing: Omit<TimedLine, 'id' | 'step' | 'cues'>;
  // The exchange its take was cut from, when lines were said as one dialogue (D29): filled by an
  // engine, which reads the takes kept on the computer.
  dialogue?: string;
}

export interface NarrationView {
  screen: string;
  // The layer whose narration it is (D62); null: the screen's.
  layer: string | null;
  language: string;
  source: boolean; // the course's own language
  advance: Advance;
  seek: Seek;
  own: { advance: Advance | null; seek: Seek | null }; // the screen's own settings (null: the course's)
  lines: NarrationLineView[];
  segments: Segment[];
  duration: number;
  estimated: boolean; // a line has no audio: its time is estimated
}

const ADVANCES: readonly string[] = ['learner', 'auto', 'next-screen'];
const SEEKS: readonly string[] = ['seen', 'free', 'none'];

export function narrationView(project: Project, screenId: string, language = project.course?.language ?? '', { layer = null }: { layer?: string | null } = {}): NarrationView | null {
  const timing = screenTiming(project, screenId, { language, layer });
  const screen = project.screens.get(screenId)?.data;
  const narration = layer === null ? screen?.narration : objectsIn(screen?.layers).find((candidate) => candidate.id === layer)?.narration;
  if (!timing || !narration) return null;
  const course = project.course?.narration;
  const own = {
    advance: layer === null && ADVANCES.includes((narration as { advance?: string }).advance as string) ? (narration as { advance?: string }).advance as Advance : null,
    seek: SEEKS.includes(narration.seek as string) ? narration.seek as Seek : null
  };
  const advance = layer !== null ? 'auto' : own.advance ?? (ADVANCES.includes(course?.advance as string) ? course!.advance as Advance : 'learner');
  const seek = own.seek ?? (SEEKS.includes(course?.seek as string) ? course!.seek as Seek : 'seen');
  return {
    screen: screenId, layer, language, source: language === project.course?.language, advance, seek, own,
    lines: timing.lines.map(({ info, start, end, pause, duration, estimated }) => ({ ...info, timing: { start, end, pause, duration, estimated } })),
    segments: timing.segments, duration: timing.duration, estimated: timing.estimated
  };
}

// ── The timeline as an editor's Chronologie view shows it (docs/decisions.md D28) ──────────

export interface TimelineViewWord {
  text: string;
  start: number;
  end: number;
  // Placed in proportion to the text (no word times for this line yet, or a word the audio does not say).
  estimated: boolean;
  score?: number;
  // Offsets in the line's text, end excluded: where the editor underlines it.
  from: number;
  to: number;
}

export interface TimelineViewLine {
  id: string;
  step: number;
  speaker: string | null;
  speakerName: string | null;
  text: string;
  start: number;
  end: number;
  estimated: boolean;
  // Its words were timed by alignment.
  aligned: boolean;
  words: TimelineViewWord[];
  // The text the audio says when it is out of date (its sidecar's), to quote its old words.
  said: string | null;
}

export interface TimelineViewMoment {
  at: number;
  anchor: Anchor;
  effect: string;
  duration: number;
  direction?: 'left' | 'right' | 'up' | 'down';
  estimated: boolean;
  implied?: boolean;
  // Why it falls back (a word the line does not say: kind "word"…).
  problem?: { kind: string; message: string };
}

export interface TimelineViewBlock {
  block: string;
  type: string;
  // The block's step, and the stack it is a content of.
  step: number;
  stack?: string;
  in?: TimelineViewMoment;
  out?: TimelineViewMoment;
}

export interface TimelineView {
  screen: string;
  // The layer whose timeline it is (D62); null: the screen's.
  layer: string | null;
  language: string;
  narrated: boolean;
  duration: number;
  estimated: boolean;
  segments: Segment[];
  lines: TimelineViewLine[];
  blocks: TimelineViewBlock[];
  cues: { event: string; time: number; anchor: Anchor; estimated: boolean; problem?: { kind: string; message: string } }[];
}

// A timed screen's timeline: each line with its words and their times, each timed block with its
// moments, the events on it. null: the screen is not timed.
export function timelineView(project: Project, screenId: string, language = project.course?.language ?? '', { layer = null }: { layer?: string | null } = {}): TimelineView | null {
  const timeline = screenTimeline(project, screenId, { language, layer });
  const screen = project.screens.get(screenId)?.data;
  if (!timeline || !screen) return null;
  const blocks = new Map<string, { block: Block; stack?: string }>();
  const walk = (list: readonly Block[] | undefined, stack?: string) => {
    for (const block of objectsIn(list)) {
      blocks.set(block.id, { block, ...(stack ? { stack } : {}) });
      walk(block.blocks, getRegistry(project).get(block.type)?.root === 'stack' ? block.id : undefined);
    }
  };
  walk(layer === null ? screen.blocks : objectsIn(screen.layers).find((candidate) => candidate.id === layer)?.blocks);
  const moment = (found: TimelineMoment): TimelineViewMoment => ({
    at: found.at, anchor: found.anchor, effect: found.effect, duration: found.duration, ...(found.direction ? { direction: found.direction } : {}),
    estimated: found.estimated, ...(found.implied ? { implied: true } : {}), ...(found.problem ? { problem: { ...found.problem } } : {})
  });
  return {
    screen: screenId, layer, language: timeline.language, narrated: timeline.narrated, duration: timeline.duration, estimated: timeline.estimated, segments: timeline.segments,
    lines: timeline.lines.map((line) => {
      const info = timeline.infos.get(line.id);
      const text = info?.text ?? '';
      const offsets = narrationWords(text, timeline.language);
      const sidecar = info ? readNarrationSidecar(project.files, info.sidecar).sidecar : null;
      return {
        id: line.id, step: line.step, speaker: info?.speaker ?? null, speakerName: info?.speakerName ?? null, text, start: line.start, end: line.end, estimated: line.estimated, aligned: line.aligned,
        words: line.words.map((word, index) => ({ text: word.text, start: word.start, end: word.end, estimated: !!word.estimated, ...(typeof word.score === 'number' ? { score: word.score } : {}), from: offsets[index]?.start ?? 0, to: offsets[index]?.end ?? 0 })),
        said: info?.status === 'stale' && sidecar?.text && sidecar.text !== text ? sidecar.text : null
      };
    }),
    blocks: [...blockTimings(timeline)].map(([id, timing]) => ({
      block: id, type: blocks.get(id)?.block.type ?? '', step: timing.in?.blockStep ?? timing.out?.blockStep ?? 1, ...(blocks.get(id)?.stack ? { stack: blocks.get(id)!.stack } : {}),
      ...(timing.in ? { in: moment(timing.in) } : {}), ...(timing.out ? { out: moment(timing.out) } : {})
    })),
    cues: timeline.cues.map((cue) => ({ event: cue.event, time: cue.time, anchor: cue.anchor, estimated: cue.estimated, ...(cue.problem ? { problem: { ...cue.problem } } : {}) }))
  };
}

// ── The screen at a time ──────────────────────────────────────────────

export type TimedBlockState = 'before' | 'entering' | 'shown' | 'leaving' | 'after';

export interface ScreenAt {
  screen: string;
  // The layer whose timeline it is (D62); null: the screen's.
  layer: string | null;
  time: number;
  // The step whose stretch holds the time (shown once reached).
  step: number;
  // The line said then and its word, with the caption shown.
  line: string | null;
  word: { index: number; text: string } | null;
  caption: string | null;
  // Every timed block: where it is then; progress through its effect (0 to 1) while it comes or goes.
  blocks: { block: string; state: TimedBlockState; progress?: number }[];
}

// What is seen of a timed screen at a time: the same function of t as the player's. null: not timed.
export function screenAt(project: Project, screenId: string, time: number, language?: string, { layer = null }: { layer?: string | null } = {}): ScreenAt | null {
  const timeline = screenTimeline(project, screenId, { language, layer });
  if (!timeline) return null;
  const t = Math.max(0, Math.min(time, timeline.duration));
  const segment = [...timeline.segments].reverse().find((candidate) => candidate.start <= t + 1e-6) ?? timeline.segments[0];
  const line = timeline.lines.find((candidate) => candidate.start <= t + 1e-6 && t < candidate.end - 1e-4) ?? null;
  let word = -1;
  if (line) for (const [index, candidate] of line.words.entries()) { if (candidate.start <= t + 1e-6) word = index; else break; }
  const caption = line?.cues.find((cue) => cue.start <= t + 1e-6 && t < cue.end)?.text ?? null;
  const blocks = [...blockTimings(timeline)].map(([block, timing]) => {
    const inStart = timing.in ? timing.in.at : -Infinity;
    const inEnd = timing.in ? timing.in.at + timing.in.duration : -Infinity;
    const outStart = timing.out ? timing.out.at : Infinity;
    const outEnd = timing.out ? timing.out.at + timing.out.duration : Infinity;
    if (t >= outEnd - 1e-6) return { block, state: 'after' as const };
    if (t >= outStart) return { block, state: 'leaving' as const, progress: round((t - outStart) / Math.max(1e-6, timing.out!.duration)) };
    if (t < inStart - 1e-6) return { block, state: 'before' as const };
    if (timing.in && timing.in.duration > 0 && t < inEnd) return { block, state: 'entering' as const, progress: round((t - inStart) / timing.in.duration) };
    return { block, state: 'shown' as const };
  });
  return { screen: screenId, layer, time: t, step: segment?.step ?? 1, line: line?.id ?? null, word: line && word >= 0 ? { index: word, text: line.words[word].text } : null, caption, blocks };
}

const round = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;

// ── Marks: a storyboard of a timed screen ────────────────────────────

export interface TimelineMarkEvent {
  kind: 'start' | 'in' | 'out' | 'cue' | 'step-end' | 'beat';
  block?: string;
  // A chart's item the voice brings (beat), null at the end of its spotlight.
  item?: string | null;
  event?: string;
  effect?: string;
  step?: number;
}

export interface TimelineMark {
  // When what it shows has settled (an effect played to its end): the time to capture.
  time: number;
  // When it happens (the anchor's time), and the anchor, as people read it.
  at: number;
  anchor: Anchor | null;
  label: string;
  step: number;
  line: string | null;
  events: TimelineMarkEvent[];
}

// One mark per moment something changes on a timed screen (its start, a block that comes or goes,
// a cue, the end of a step), those less than 50 ms apart together: the contact sheet of elabora look
// --sheet, and the Revue's storyboard of a narrated slide. null: not timed.
export function timelineMarks(project: Project, screenId: string, language?: string, { layer = null }: { layer?: string | null } = {}): TimelineMark[] | null {
  const timeline = screenTimeline(project, screenId, { language, layer });
  if (!timeline) return null;
  const raw: { at: number; time: number; anchor: Anchor | null; text: string; event: TimelineMarkEvent }[] = [];
  const first = timeline.segments[0];
  raw.push({ at: first?.start ?? 0, time: first?.start ?? 0, anchor: null, text: 'start', event: { kind: 'start', step: first?.step ?? 1 } });
  for (const moment of timeline.moments) {
    const settled = Math.min(timeline.duration, moment.at + moment.duration);
    const effect = moment.effect === 'none' ? '' : ` (${moment.effect})`;
    raw.push({ at: moment.at, time: settled, anchor: moment.anchor, text: `${moment.block} ${moment.kind === 'in' ? 'comes' : 'goes'}${effect}`, event: { kind: moment.kind, block: moment.block, effect: moment.effect } });
  }
  for (const cue of timeline.cues) raw.push({ at: cue.time, time: cue.time, anchor: cue.anchor, text: `${cue.event} fires`, event: { kind: 'cue', event: cue.event } });
  // A chart's item said by the voice, seen once it has arrived (the slowest, a trend's head, takes
  // 1.2 s) and before the chart's next beat. The spotlight's end has its own mark only before its step
  // ends (that end is seen just before it comes).
  for (const [index, beat] of timeline.beats.entries()) {
    const next = timeline.beats.slice(index + 1).find((other) => other.block === beat.block);
    const stepEnd = timeline.segments.find((segment) => segment.step === beat.step)?.end ?? timeline.duration;
    if (beat.item === null && beat.time > stepEnd - 0.1) continue;
    const settled = Math.min(timeline.duration, beat.time + (beat.item === null ? 0.3 : BEAT_SETTLE), next ? next.time - 0.05 : Infinity, stepEnd - 0.05);
    raw.push({ at: beat.time, time: Math.max(beat.time, settled), anchor: beat.anchor, text: beat.item === null ? `${beat.block} spotlight ends` : `${beat.block} ${beat.item} said`, event: { kind: 'beat', block: beat.block, item: beat.item } });
  }
  // A step's end is seen just before the next step starts.
  for (const segment of timeline.segments) raw.push({ at: segment.end, time: Math.max(segment.start, segment.end - 0.05), anchor: { step: segment.step, edge: 'end' }, text: `end of step ${segment.step}`, event: { kind: 'step-end', step: segment.step } });
  raw.sort((a, b) => a.time - b.time || a.at - b.at);
  const marks: TimelineMark[] = [];
  for (const item of raw) {
    const previous = marks.at(-1);
    if (previous && item.time - previous.time < 0.05) {
      previous.events.push(item.event);
      previous.label += ` + ${item.anchor && item.event.kind !== 'step-end' && JSON.stringify(item.anchor) !== JSON.stringify(previous.anchor) ? `${formatAnchor(item.anchor)} · ` : ''}${item.text}`;
      continue;
    }
    const at = screenAt(project, screenId, item.time, language, { layer });
    marks.push({
      time: round3(item.time), at: round3(item.at), anchor: item.anchor, step: at?.step ?? item.event.step ?? 1, line: at?.line ?? null, events: [item.event],
      label: `${clockTime(item.at, { tenths: true })}${item.anchor && item.event.kind !== 'step-end' ? ` · ${formatAnchor(item.anchor)}` : ''} · ${item.text}`
    });
  }
  return marks;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
