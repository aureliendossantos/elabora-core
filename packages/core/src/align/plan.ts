// Which lines an alignment of a narration times, and why the others are left (D27): the same on both
// hosts. A line is timed when its audio says its text and it is not timed yet by this aligner (unless
// force); without an aligner in the language, its words stay placed in proportion to its text.

import { narrationLines } from '../narration/narration.ts';
import type { NarrationAudio } from '../narration/narration.ts';
import { doubtfulWords, swallowedKey } from '../narration/words.ts';
import { fileHash } from '../project/files.ts';
import type { Project } from '../project/model.ts';
import { ignoredOf } from '../validate/index.ts';
import { AlignmentError } from './ctc.ts';
import type { AlignedLine, AlignResult } from './types.ts';

export interface AlignPlanOptions {
  screen?: string;           // default: every narrated screen
  lines?: string[];          // with screen
  language?: string;         // default: the course's
  force?: boolean;           // lines already timed by this aligner too
}

export interface LineToAlign { screen: string; line: string; text: string; audio: string }

export function planAlignment<Model extends { model: string }>(project: Project, options: AlignPlanOptions, alignerOf: (language: string) => Model | null): { result: AlignResult; todo: LineToAlign[]; model: Model | null; language: string } {
  const language = options.language || project.course?.language || '';
  if (options.screen && !project.screens.has(options.screen)) throw new AlignmentError('E_ALIGN_SCREEN', `Unknown screen "${options.screen}".`);
  if (options.lines?.length && !options.screen) throw new AlignmentError('E_ALIGN_SCREEN', 'Lines are lines of a screen: give the screen too.');
  const model = alignerOf(language);
  const result: AlignResult = { language, aligner: model?.model ?? null, lines: [], changes: [] };
  const screens = options.screen ? [options.screen] : [...project.screens.keys()];
  const todo: LineToAlign[] = [];
  for (const screen of screens) {
    const infos = narrationLines(project, screen, language);
    if (!infos) { if (options.screen) throw new AlignmentError('E_ALIGN_SCREEN', `Screen "${screen}" has no narration.`); continue; }
    for (const id of options.lines ?? []) if (!infos.some((info) => info.id === id)) throw new AlignmentError('E_ALIGN_LINE', `Screen "${screen}" has no narration line "${id}" (its lines: ${infos.map((info) => info.id).join(', ')}).`);
    for (const info of infos) {
      if (options.lines && !options.lines.includes(info.id)) continue;
      if (info.status !== 'ok' || !info.text) { result.lines.push({ screen, line: info.id, status: 'skipped', reason: info.status === 'untranslated' ? `not translated into ${language} yet` : info.status === 'missing' ? 'no audio' : 'its audio says an older text: make or import it again first' }); continue; }
      if (!options.force && info.words?.length && info.aligner === model?.model) { result.lines.push({ screen, line: info.id, status: 'skipped', reason: 'already timed', words: info.words.length }); continue; }
      todo.push({ screen, line: info.id, text: info.text, audio: info.audio });
    }
  }
  if (!todo.length) return { result, todo, model, language };
  if (!model) {
    for (const line of todo) result.lines.push({ screen: line.screen, line: line.line, status: 'skipped', reason: `no word aligner in ${language} yet: its words are placed in proportion to the text` });
    return { result, todo: [], model, language };
  }
  return { result, todo, model, language };
}

// A line once timed: its words, and those the voice may have swallowed, but for the ones the author
// heard and ignored for this take (D31).
export function alignedLine(project: Project, line: LineToAlign, language: string, words: NonNullable<NarrationAudio['words']>): AlignedLine {
  const sidecar = narrationLines(project, line.screen, language)?.find((info) => info.id === line.line);
  const take = sidecar ? fileHash(project.files, sidecar.audio) : null;
  const ignored = new Set(ignoredOf(project.course).filter((entry) => entry.code === 'W_NARRATION_WORD_SWALLOWED').map((entry) => entry.key));
  const doubtful = doubtfulWords(words).filter((word) => !take || !ignored.has(swallowedKey(line.screen, line.line, language, word, take))).map(({ word, score }) => ({ word, score }));
  return { screen: line.screen, line: line.line, status: 'aligned', words: words.length, ...(doubtful.length ? { doubtful } : {}) };
}

// The audio a line's sidecar says its words are timed on: set_narration_words refuses them when the
// line's audio changed since.
export function sidecarAudioHash(project: Project, sidecar: string | undefined): `sha256:${string}` | null {
  if (!sidecar) return null;
  const entry = project.files.get(sidecar);
  if (entry?.kind !== 'text') return null;
  try {
    const hash = (JSON.parse(entry.text) as { audioHash?: unknown }).audioHash;
    return typeof hash === 'string' && hash.startsWith('sha256:') ? hash as `sha256:${string}` : null;
  } catch { return null; }
}
