// Word anchors through translation (docs/decisions.md D28). A narration line's XLIFF unit carries
// the words its anchors name as markers, <mrk id="w-imprimante" type="elabora:anchor">, one per word
// (and occurrence) anchored on the line; translators put each marker on the words of their language
// that say the same thing (« imprimante » on « printer »). The translated course anchors to those
// words, and a voice in that language gives them their own times. A marker the translation has not
// placed yet is an anchor to place: the translated course falls back to the start of its line.

import type { Anchor, Block, Screen } from '@elabora/format';
import type { Project } from '../project/model.ts';
import { narrationWords, findPhrase, normalizeWord } from '../narration/words.ts';
import { voiceLinesOf } from '../narration/voice-lines.ts';
import { objectsIn, isRecord } from '../util/values.ts';
import { CHART_TYPE_NAMES } from '../charts/names.ts';
import { readXliff } from './xliff.ts';
import type { XliffDocument, XliffMark } from './xliff.ts';

export interface WordAnchor {
  word: string;
  occurrence: number;
}

// The id of an anchor's marker: the words, as anchors compare them, and the occurrence after the first.
export function anchorMarkId(word: string, occurrence = 1): string {
  const slug = normalizeWord(word).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'mot';
  return `w-${slug}${occurrence > 1 ? `-${occurrence}` : ''}`;
}

// Every anchor written on a screen (block timings, chart moments, a dialogue's cues, event cues,
// seek-timeline), with where it is. A dialogue's cue anchors to its own line without naming it
// (D61): its anchor is given with that line, which set() leaves out again.
export function screenAnchors(screen: Pick<Screen, 'blocks' | 'layers' | 'events'>): { anchor: Anchor; set(next: Anchor): void; where: string }[] {
  const out: { anchor: Anchor; set(next: Anchor): void; where: string }[] = [];
  const walk = (blocks: readonly Block[] | undefined) => {
    for (const block of objectsIn(blocks)) {
      // A chart's items brought by the voice, and the end of its spotlight (D60).
      if (CHART_TYPE_NAMES.has(String(block.type)) && isRecord(block.props)) {
        const props = block.props;
        const own = (holder: Record<string, unknown>, key: string, where: string) => { const value = holder[key]; if (isRecord(value)) out.push({ anchor: value as Anchor, set: (next) => { holder[key] = next; }, where }); };
        for (const list of ['rows', 'parts', 'items', 'points', 'beats']) for (const item of Array.isArray(props[list]) ? props[list] : []) if (isRecord(item)) own(item, 'at', `${block.id} ${String(item.id ?? item.node ?? item.x ?? '')}`);
        own(props, 'at', `${block.id}`);
        own(props, 'spotlightEnd', `${block.id} end`);
      }
      if (isRecord(block.props) && Array.isArray(block.props.nodes)) dialogueCues(block, out);
      if (isRecord(block.timing)) {
        for (const kind of ['in', 'out'] as const) {
          const moment = block.timing[kind];
          if (isRecord(moment) && isRecord(moment.at)) out.push({ anchor: moment.at, set: (next) => { moment.at = next; }, where: `${block.id} ${kind}` });
        }
      }
      walk(block.blocks);
    }
  };
  walk(screen.blocks);
  for (const layer of objectsIn(screen.layers)) walk(layer.blocks);
  for (const event of objectsIn(screen.events)) {
    const on = event.on;
    if (on?.type === 'timeline.reached' && isRecord(on.at)) out.push({ anchor: on.at, set: (next) => { on.at = next; }, where: event.id });
    for (const action of [...objectsIn(event.do), ...objectsIn(event.else)]) if (action.type === 'seek-timeline' && isRecord(action.to)) out.push({ anchor: action.to, set: (next) => { action.to = next; }, where: event.id });
  }
  return out;
}

// The cues of a dialogue's lines (nodes[].lines, nodes[].options[].reply).
function dialogueCues(block: Block, out: { anchor: Anchor; set(next: Anchor): void; where: string }[]): void {
  const props = block.props as Record<string, unknown>;
  const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
  const lines = records(props.nodes).flatMap((node) => [...records(node.lines), ...records(node.options).flatMap((option) => records(option.reply))]);
  for (const line of lines) {
    if (typeof line.id !== 'string' || !Array.isArray(line.cues)) continue;
    for (const cue of line.cues) {
      if (!isRecord(cue) || !isRecord(cue.at)) continue;
      const named = typeof cue.at.line === 'string';
      out.push({ anchor: { line: line.id, ...cue.at } as Anchor, set: (next) => { const { line: _line, ...rest } = next; cue.at = named ? next : rest; }, where: `${block.id} ${line.id}` });
    }
  }
}

// The word anchors of a screen by line, each word (and occurrence) once.
export function lineWordAnchors(screen: Pick<Screen, 'blocks' | 'layers' | 'events'>): Map<string, WordAnchor[]> {
  const out = new Map<string, WordAnchor[]>();
  for (const { anchor } of screenAnchors(screen)) {
    if (typeof anchor.line !== 'string' || typeof anchor.word !== 'string') continue;
    const list = out.get(anchor.line) ?? [];
    const occurrence = anchor.occurrence ?? 1;
    if (!list.some((known) => anchorMarkId(known.word, known.occurrence) === anchorMarkId(anchor.word!, occurrence))) list.push({ word: anchor.word, occurrence });
    out.set(anchor.line, list);
  }
  return out;
}

// The markers of a line's text: where each anchored word is (an anchor the line no longer says has
// none; markers do not overlap).
export function anchorMarks(text: string, anchors: readonly WordAnchor[], language: string): (XliffMark & { word: string })[] {
  const words = narrationWords(text, language);
  const marks: (XliffMark & { word: string })[] = [];
  for (const anchor of anchors) {
    const found = findPhrase(words, anchor.word, { occurrence: anchor.occurrence, language });
    if (!found) continue;
    const mark = { id: anchorMarkId(anchor.word, anchor.occurrence), start: words[found.index].start, end: words[found.index + found.count - 1].end, word: anchor.word };
    if (!marks.some((other) => other.id === mark.id || (mark.start < other.end && other.start < mark.end))) marks.push(mark);
  }
  return marks.sort((a, b) => a.start - b.start);
}

// The words of a translation its markers are placed on, by marker id: the words as written, and
// which time the translation says them.
export function placedAnchors(target: string, marks: readonly XliffMark[] | undefined, language: string): Map<string, WordAnchor> {
  const out = new Map<string, WordAnchor>();
  const words = narrationWords(target, language);
  for (const mark of marks ?? []) {
    const phrase = target.slice(mark.start, mark.end).trim();
    const first = words.findIndex((word) => word.end > mark.start);
    if (!phrase || first < 0) continue;
    for (let occurrence = 1; ; occurrence++) {
      const found = findPhrase(words, phrase, { occurrence, language });
      if (!found || found.index > first) break;
      if (found.index === first) { out.set(mark.id, { word: phrase, occurrence }); break; }
    }
  }
  return out;
}

// Markers written in a text as agents and CAT tools write them (<mrk id="w-…">printer</mrk>), or
// placed by naming the words (an editor's « Accrocher »): the plain text and its markers.
export function markersOf(text: string, language: string, placed: readonly { id: string; word: string; occurrence?: number }[] = []): { text: string; marks: XliffMark[] } {
  let plain = text;
  const marks: XliffMark[] = [];
  if (/<mrk\b/.test(text)) {
    const open: { id: string; start: number }[] = [];
    let out = '';
    for (const match of text.matchAll(/<mrk\b([^>]*)>|<\/mrk>|[^<]+|</g)) {
      if (match[0].startsWith('<mrk')) { open.push({ id: /\bid="([^"]*)"/.exec(match[1] ?? '')?.[1] ?? '', start: out.length }); continue; }
      if (match[0] === '</mrk>') { const element = open.pop(); if (element?.id && out.length > element.start) marks.push({ id: element.id, start: element.start, end: out.length }); continue; }
      out += match[0];
    }
    plain = out;
  }
  const words = narrationWords(plain, language);
  for (const { id, word, occurrence } of placed) {
    const found = findPhrase(words, word, { occurrence, language });
    if (!found) throw new Error(`"${word}" is not in the translation « ${plain} »: anchor ${id} needs words it says.`);
    const mark = { id, start: words[found.index].start, end: words[found.index + found.count - 1].end };
    const kept = marks.filter((other) => other.id !== id && !(mark.start < other.end && other.start < mark.end));
    marks.splice(0, marks.length, ...kept, mark);
  }
  return { text: plain, marks: marks.sort((a, b) => a.start - b.start) };
}

// ── A language's anchors ─────────────────────────────────────────────

const parsed = new WeakMap<object, XliffDocument | null>();
function xliffOf(project: Project, language: string): XliffDocument | null {
  const entry = project.translations.get(language);
  if (!entry) return null;
  if (!parsed.has(entry)) { try { parsed.set(entry, readXliff(entry.xliff)); } catch { parsed.set(entry, null); } }
  return parsed.get(entry) ?? null;
}

// For each voice line of a screen (every track: the screen's narration, its layers') translated into a language: the words its anchors are placed
// on (a line not translated, or translated from another text, keeps its source words: absent).
export function translatedLineAnchors(project: Project, screenId: string, language: string): Map<string, Map<string, WordAnchor>> {
  const out = new Map<string, Map<string, WordAnchor>>();
  const screen = project.screens.get(screenId)?.data;
  if (!screen || !project.course || language === project.course.language) return out;
  const xliff = xliffOf(project, language);
  if (!xliff) return out;
  for (const { line, unit: id } of voiceLinesOf(screen, screenId, project)) {
    const unit = xliff.units.get(id);
    if (!unit?.target || unit.source !== line.text) continue;
    out.set(line.id, placedAnchors(unit.target, unit.targetMarks, language));
  }
  return out;
}

// An anchor in a language: its words there, or null while the translation has not placed them (the
// anchor's line is translated, its marker is not in the translation).
export function translateAnchor(anchor: Anchor, lines: ReadonlyMap<string, ReadonlyMap<string, WordAnchor>>): Anchor | null {
  if (typeof anchor.line !== 'string' || typeof anchor.word !== 'string') return anchor;
  const placed = lines.get(anchor.line);
  if (!placed) return anchor;
  const found = placed.get(anchorMarkId(anchor.word, anchor.occurrence ?? 1));
  if (!found) return null;
  const { occurrence: _occurrence, ...rest } = anchor;
  return { ...rest, word: found.word, ...(found.occurrence > 1 ? { occurrence: found.occurrence } : {}) };
}
