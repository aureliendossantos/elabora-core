// Anchors as tools write them on a command line and print them (elabora timing, look --at, the
// timeline report, the contact sheet), and the time an anchor falls at on a screen.
//   l2                  the start of line l2            l2:end              its end
//   l2:imprimante       the word (or words) in l2       l2:imprimante:end   the end of the word
//   l2:imprimante#2     its second occurrence           l2:imprimante+0.3s  0.3 s after it (-0.3s: before)
//   1.5s                1.5 s from the start of step 1 (screens without narration)
//   1.5s@2              from the start of step 2        step2  step2:end    a step's start or end
//   12.5                a time in seconds on the screen's timeline (look --at only)

import type { Anchor } from '@elabora/format';
import type { Project } from '../project/model.ts';
import { screenTimeline, anchorTime } from './timeline.ts';
import type { AnchorProblem } from './timeline.ts';
import { clockTime } from './timing.ts';

export function parseAnchor(input: string): Anchor | null {
  const text = input.trim();
  let match = /^(\d+(?:\.\d+)?)s(?:@(\d+))?$/.exec(text);
  if (match) return { seconds: Number(match[1]), ...(match[2] ? { step: Number(match[2]) } : {}) };
  match = /^step(\d+)(?::(start|end))?$/.exec(text);
  if (match) return { step: Number(match[1]), ...(match[2] === 'end' ? { edge: 'end' as const } : {}) };
  match = /^([a-z][a-z0-9-]{0,47})(?::(.*))?$/su.exec(text) ?? /^([a-z][a-z0-9-]{0,47})(?=[+-]\d)/.exec(text);
  if (!match) return null;
  const anchor: Anchor = { line: match[1] };
  let rest = match[2] ?? '';
  // An offset ends with s, so that a word ending in digits (P-12) stays a word.
  const offset = /([+-]\d+(?:\.\d+)?)s$/.exec(rest);
  if (offset) { anchor.offset = Number(offset[1]); rest = rest.slice(0, -offset[0].length); }
  else {
    const lineOffset = /^([+-]\d+(?:\.\d+)?)s$/.exec(text.slice(match[1].length));
    if (lineOffset) return { line: match[1], offset: Number(lineOffset[1]) };
  }
  const edge = /(?:^|:)(start|end)$/.exec(rest);
  if (edge) { if (edge[1] === 'end') anchor.edge = 'end'; rest = rest.slice(0, -edge[0].length); }
  const occurrence = /#(\d+)$/.exec(rest);
  if (occurrence) { anchor.occurrence = Number(occurrence[1]); rest = rest.slice(0, -occurrence[0].length); }
  if (rest.trim()) anchor.word = rest.trim();
  else if (anchor.occurrence) return null;
  return anchor;
}

// An anchor as people read it: « imprimante » in l2, the end of l3, 1.5 s into step 2.
export function formatAnchor(anchor: Anchor): string {
  const offset = typeof anchor.offset === 'number' && anchor.offset ? ` ${anchor.offset > 0 ? '+' : '−'}${Math.abs(anchor.offset)} s` : '';
  if (typeof anchor.line === 'string') {
    const which = anchor.occurrence && anchor.occurrence > 1 ? ` (#${anchor.occurrence})` : '';
    const what = typeof anchor.word === 'string' ? `${anchor.line} « ${anchor.word} »${which}` : anchor.line;
    return `${anchor.edge === 'end' ? 'end of ' : ''}${what}${offset}`;
  }
  if (typeof anchor.seconds === 'number') return `${anchor.seconds} s${anchor.step ? ` into step ${anchor.step}` : ''}`;
  return `${anchor.edge === 'end' ? 'end' : 'start'} of step ${anchor.step}`;
}

// The time an anchor written on a command line falls at on a screen (a plain number: that time), and
// what to call it; an error that says what the screen has. layer: on that layer's timeline (D62).
export function resolveAt(project: Project, screenId: string, input: string, { language, layer }: { language?: string; layer?: string | null } = {}): { time: number; label: string; anchor: Anchor | null; estimated: boolean } | { error: string } {
  const timeline = screenTimeline(project, screenId, { language, layer: layer ?? null });
  if (!timeline) return { error: layer ? `Layer "${layer}" of screen "${screenId}" has no timeline (no narration, no timed block): --at names a moment of one.` : `Screen "${screenId}" has no timeline (no narration, no timed block): --at names a moment of one.` };
  const plain = /^\d+(?:\.\d+)?$/.test(input.trim()) ? Number(input) : null;
  if (plain !== null) return { time: Math.min(plain, timeline.duration), label: clockTime(plain, { tenths: true }), anchor: null, estimated: timeline.estimated };
  const anchor = parseAnchor(input);
  if (!anchor) return { error: `"${input}" is not a moment: a line (l2, l2:end), a word of it (l2:imprimante, l2:imprimante:end, l2:imprimante#2, +0.3s for an offset), seconds (1.5s, 1.5s@2), a step (step2, step2:end), or a time (12.5).` };
  const where = layer ? `layer "${layer}" of "${screenId}"` : `"${screenId}"`;
  if (typeof anchor.line === 'string' && !timeline.lines.some((line) => line.id === anchor.line)) return { error: timeline.lines.length ? `No line "${anchor.line}" in the narration of ${where}. Lines: ${timeline.lines.map((line) => line.id).join(', ')}.` : `${layer ? `Layer "${layer}"` : `Screen "${screenId}"`} has no narration: name seconds${layer ? '' : ' or a step'}.` };
  const found = anchorTime(timeline, anchor);
  if (found.problem && found.problem.kind !== 'seconds') return { error: `${describe(found.problem)} (on screen "${screenId}").` };
  return { time: found.time, label: formatAnchor(anchor), anchor, estimated: found.estimated };
}

const describe = (problem: AnchorProblem): string => problem.message.charAt(0).toUpperCase() + problem.message.slice(1);
