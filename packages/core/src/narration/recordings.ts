// Recordings of several lines at once (« Importer des enregistrements »): which line each file goes to
// by its name, the same on both hosts. A name gives a line by its id, <screen>-<line>, or, in one
// screen, the line's number in it (« 03 », « 03-a-vous »). A host with the word aligner of the
// language then places the others by what they say.

import type { Project } from '../project/model.ts';
import { narrationLines } from './narration.ts';

export interface RecordingLine { screen: string; line: string; index: number; text: string | null }

const slugOf = (name: string): string => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '');

// The lines recordings may go to: a screen's, or every narrated screen's, in the language.
export function recordingLines(project: Project, screen: string | undefined, language: string): RecordingLine[] {
  const screens = screen ? [screen] : [...project.screens.keys()];
  return screens.flatMap((id) => (narrationLines(project, id, language) ?? []).map((info, index) => ({ screen: id, line: info.id, index, text: info.text })));
}

// Each file name (without its folder) matched to a free line by its name; null: none.
export function linesByName(lines: readonly RecordingLine[], names: readonly string[], screen: string | undefined, taken = new Set<string>()): (RecordingLine | null)[] {
  const key = (line: RecordingLine) => `${line.screen}/${line.line}`;
  return names.map((file) => {
    const name = slugOf(file.replace(/\.[^.]+$/, ''));
    const number = /^(\d{1,3})(?:-|$)/.exec(name);
    const found = lines.find((line) => !taken.has(key(line)) && [slugOf(line.line), `${line.screen}-${slugOf(line.line)}`].includes(name))
      ?? (screen && number ? lines.find((line) => line.index === Number(number[1]) - 1 && !taken.has(key(line))) : undefined);
    if (!found) return null;
    taken.add(key(found));
    return found;
  });
}
