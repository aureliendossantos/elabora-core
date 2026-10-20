// `elabora timeline` (MCP elabora_timeline): a narrated screen's timeline as text an agent reads without
// a capture: its steps and their stretch of time, the lines with their speaker, time and audio, the
// blocks each step shows, and the events its cues fire. Times are resolved from the lines' audio,
// estimated from their text while a line has none.

import type { Project } from '../project/model.ts';
import { screenOrder } from '../project/load.ts';
import { objectsIn } from '../util/values.ts';
import { narrationLines, screenTiming } from './narration.ts';
import type { NarrationLineStatus } from './narration.ts';
import { clockTime } from './timing.ts';
import { screenTimeline, blockTimings } from './timeline.ts';
import type { TimelineMoment } from './timeline.ts';
import { formatAnchor } from './anchor-text.ts';

export interface TimelineLine {
  id: string;
  speaker: string | null;
  start: number;
  end: number;
  pause: number;
  duration: number;
  estimated: boolean;
  audio: NarrationLineStatus;
  reasons: string[];
  text: string;
}

export interface TimelineStep {
  step: number;
  start: number;
  end: number;
  blocks: string[];
  lines: TimelineLine[];
}

export interface TimelineCue {
  event: string;
  trigger: 'timeline.reached' | 'timeline.ended' | 'media.ended';
  line?: string;
  edge?: 'start' | 'end';
  // The moment as written (timeline.reached), as people read it.
  anchor?: string;
  target?: string;
  // When playback crosses it (null: a media end, not on the timeline).
  time: number | null;
  // Why it falls back to the start of its line or step (a word the line does not say…).
  problem?: string;
  actions: string[];
}

// A timed block's coming or going.
export interface TimelineBlockMoment {
  time: number;
  anchor: string;
  effect: string;
  duration: number;
  direction?: string;
  // The time is estimated (no audio, or no word times).
  estimated: boolean;
  // A stack's next content brings it.
  implied?: boolean;
  problem?: string;
}

export interface TimelineBlock {
  block: string;
  step: number;
  in?: TimelineBlockMoment;
  out?: TimelineBlockMoment;
}

export interface TimelineReport {
  screen: string;
  title: string;
  language: string;
  advance: 'learner' | 'auto' | 'next-screen';
  seek: 'seen' | 'free' | 'none';
  duration: number;
  estimated: boolean;
  // Every line has its audio in that language: the build makes the screen's track.
  voiced: boolean;
  // Narrated (false: a screen timed in seconds, without narration).
  narrated: boolean;
  steps: TimelineStep[];
  // Blocks with a timing, in the order they come.
  blocks: TimelineBlock[];
  cues: TimelineCue[];
}

const actionText = (action: Record<string, unknown>): string => {
  const { type, ...rest } = action;
  const args = Object.entries(rest).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ');
  return `${String(type)}${args ? ` ${args}` : ''}`;
};

export function timelineReport(project: Project, screenId: string, { language }: { language?: string } = {}): TimelineReport | null {
  const screen = project.screens.get(screenId)?.data;
  const lang = language || project.course?.language || '';
  const timeline = screenTimeline(project, screenId, { language: lang });
  if (!screen || !timeline) return null;
  const timing = screenTiming(project, screenId, { language: lang });
  const blocksOf = (step: number) => objectsIn(screen.blocks).filter((block) => (typeof block.step === 'number' ? block.step : 1) === step).map((block) => block.id);
  const steps = timeline.segments.map((segment) => ({
    step: segment.step, start: segment.start, end: segment.end, blocks: blocksOf(segment.step),
    lines: (timing?.lines ?? []).filter((line) => line.step === segment.step).map((line) => ({
      id: line.id, speaker: line.info.speakerName, start: line.start, end: line.end, pause: line.pause, duration: line.duration, estimated: line.estimated,
      audio: line.info.status, reasons: line.info.reasons, text: line.info.text ?? ''
    }))
  }));
  const momentOf = (moment: TimelineMoment): TimelineBlockMoment => ({
    time: moment.at, anchor: formatAnchor(moment.anchor), effect: moment.effect, duration: moment.duration, ...(moment.direction ? { direction: moment.direction } : {}),
    estimated: moment.estimated, ...(moment.implied ? { implied: true } : {}), ...(moment.problem ? { problem: moment.problem.message } : {})
  });
  const blocks: TimelineBlock[] = [...blockTimings(timeline)].map(([block, entry]) => ({ block, step: entry.in?.blockStep ?? entry.out?.blockStep ?? 1, ...(entry.in ? { in: momentOf(entry.in) } : {}), ...(entry.out ? { out: momentOf(entry.out) } : {}) }))
    .sort((a, b) => (a.in?.time ?? timeline.segments.find((segment) => segment.step === a.step)?.start ?? 0) - (b.in?.time ?? timeline.segments.find((segment) => segment.step === b.step)?.start ?? 0));
  const resolved = new Map(timeline.cues.map((cue) => [cue.event, cue]));
  const cues: TimelineCue[] = [];
  for (const event of objectsIn(screen.events)) {
    const on = event.on;
    const actions = [...objectsIn(event.do), ...objectsIn(event.else)].map((action) => actionText(action as unknown as Record<string, unknown>));
    if (on?.type === 'timeline.reached') {
      const cue = resolved.get(event.id);
      cues.push({
        event: event.id, trigger: 'timeline.reached', ...(on.at?.line ? { line: on.at.line, edge: on.at.edge || 'start' } : {}), ...(on.at ? { anchor: formatAnchor(on.at) } : {}),
        time: cue && !(cue.problem && cue.problem.kind === 'line') ? cue.time : null, ...(cue?.problem ? { problem: cue.problem.message } : {}), actions
      });
    } else if (on?.type === 'timeline.ended') cues.push({ event: event.id, trigger: 'timeline.ended', time: timeline.duration, actions });
    else if (on?.type === 'media.ended') cues.push({ event: event.id, trigger: 'media.ended', target: on.target, time: null, actions });
  }
  cues.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  return {
    screen: screenId, title: screen.title, language: lang, advance: screen.narration?.advance || project.course?.narration?.advance || 'learner', seek: screen.narration?.seek || project.course?.narration?.seek || 'seen',
    duration: timeline.duration, estimated: timeline.estimated, voiced: timeline.narrated && (timing?.lines ?? []).every((line) => line.info.status === 'ok' || line.info.status === 'stale'),
    narrated: timeline.narrated, steps, blocks, cues
  };
}

const time = (seconds: number) => clockTime(seconds, { tenths: true });
const cut = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);

export function formatTimeline(report: TimelineReport): string {
  const out: string[] = [];
  const lines = report.steps.flatMap((step) => step.lines);
  if (report.narrated) {
    out.push(`${report.screen} — "${report.title}" — narration in ${report.language}: advance ${report.advance}, seek ${report.seek}`);
    out.push(`${time(report.duration)} in ${report.steps.length} step${report.steps.length > 1 ? 's' : ''}, ${lines.length} line${lines.length > 1 ? 's' : ''}${report.estimated ? ' (times estimated from the text where a line has no audio)' : ''}; ${report.voiced ? 'every line has its audio: the build makes the track' : 'the screen runs silent until every line has its audio'}`);
  } else {
    out.push(`${report.screen} — "${report.title}" — timed in seconds, without narration: advance ${report.advance}, seek ${report.seek}`);
    out.push(`${time(report.duration)} in ${report.steps.length} step${report.steps.length > 1 ? 's' : ''}, on the page's clock`);
  }
  out.push('');
  const speakerWidth = Math.max(7, ...lines.map((line) => (line.speaker ?? '').length));
  out.push(`${'Step'.padEnd(5)} ${'Line'.padEnd(6)} ${'Speaker'.padEnd(speakerWidth)} ${'Start'.padStart(7)} ${'End'.padStart(7)}  ${'Audio'.padEnd(9)} Text`);
  for (const step of report.steps) {
    out.push(`${String(step.step).padEnd(5)} ${'—'.padEnd(6)} ${''.padEnd(speakerWidth)} ${time(step.start).padStart(7)} ${time(step.end).padStart(7)}  ${''.padEnd(9)} blocks: ${step.blocks.join(', ') || 'none'}`);
    for (const line of step.lines) {
      const audio = line.audio === 'ok' ? 'ok' : line.audio;
      out.push(`${''.padEnd(5)} ${line.id.padEnd(6)} ${(line.speaker ?? '').padEnd(speakerWidth)} ${time(line.start).padStart(7)} ${time(line.end).padStart(7)}  ${`${audio}${line.estimated ? '*' : ''}`.padEnd(9)} ${cut(line.text, 70)}`);
      if (line.audio !== 'ok') for (const reason of line.reasons) out.push(`${''.padEnd(5 + 1 + 6 + 1 + speakerWidth + 1 + 7 + 1 + 7 + 2)}  ↳ ${reason}`);
    }
  }
  if (lines.some((line) => line.estimated)) out.push('', '* estimated: no audio yet (15 characters a second)');
  if (report.blocks.length) {
    out.push('', 'Timed blocks (what is seen follows the playhead; a block keeps its place while it is not there):');
    const width = Math.max(5, ...report.blocks.map((block) => block.block.length));
    const moment = (found: TimelineBlockMoment | undefined, kind: 'in' | 'out') => (found
      ? `${kind} ${time(found.time)}${found.estimated ? '*' : ''} ${found.implied ? '(the next content comes)' : found.anchor} ${found.effect}${found.direction ? ` ${found.direction}` : ''} ${found.duration} s${found.problem ? ` ⚠ ${found.problem}` : ''}`
      : kind === 'in' ? 'in  with its step' : '');
    for (const block of report.blocks) out.push(`  ${block.block.padEnd(width)}  step ${block.step}  ${moment(block.in, 'in')}${block.out ? `  ·  ${moment(block.out, 'out')}` : ''}`);
  }
  if (report.cues.length) {
    out.push('', 'Events on the timeline (they fire when playback crosses them, never on a seek):');
    for (const cue of report.cues) {
      const where = cue.trigger === 'timeline.reached' ? `${cue.anchor ?? cue.line} at ${cue.time === null ? '? (no such line)' : time(cue.time)}${cue.problem ? ` ⚠ ${cue.problem}` : ''}` : cue.trigger === 'timeline.ended' ? `end at ${time(cue.time ?? 0)}` : `${cue.target} ends`;
      out.push(`  ${cue.event}: ${cue.trigger} ${where} → ${cue.actions.join('; ') || 'nothing'}`);
    }
  }
  return out.join('\n');
}

export interface NarratedScreen {
  screen: string;
  title: string;
  lines: number;
  steps: number;
  duration: number;
  audio: Record<NarrationLineStatus, number>;
}

// Every narrated screen of the course, in order, with the audio of its lines in a language.
export function narratedScreens(project: Project, { language }: { language?: string } = {}): NarratedScreen[] {
  const out: NarratedScreen[] = [];
  for (const { id } of screenOrder(project)) {
    const screen = project.screens.get(id)?.data;
    const lines = screen?.narration ? narrationLines(project, id, language) : null;
    const timing = lines ? screenTiming(project, id, { language }) : null;
    if (!screen || !lines || !timing) continue;
    const audio: Record<NarrationLineStatus, number> = { ok: 0, missing: 0, stale: 0, untranslated: 0 };
    for (const line of lines) audio[line.status]++;
    out.push({ screen: id, title: screen.title, lines: lines.length, steps: timing.segments.length, duration: timing.duration, audio });
  }
  return out;
}

export function formatNarratedScreens(screens: readonly NarratedScreen[], language: string): string {
  if (!screens.length) return 'No narrated screen (screens/<id>.json narration).';
  const width = Math.max(6, ...screens.map((screen) => screen.screen.length));
  const out = [`Narrated screens (${language}):`, `${'Screen'.padEnd(width)} ${'Lines'.padStart(5)} ${'Steps'.padStart(5)} ${'Length'.padStart(7)}  Audio`];
  for (const screen of screens) {
    const audio = Object.entries(screen.audio).filter(([, count]) => count).map(([status, count]) => `${count} ${status}`).join(', ');
    out.push(`${screen.screen.padEnd(width)} ${String(screen.lines).padStart(5)} ${String(screen.steps).padStart(5)} ${clockTime(screen.duration, { tenths: true }).padStart(7)}  ${audio}`);
  }
  out.push('', 'elabora timeline <screen> shows one screen: its steps, lines, times and cues.');
  return out.join('\n');
}
