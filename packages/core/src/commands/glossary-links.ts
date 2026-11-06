import type { Project } from '../project/model.ts';
import { extractUnits, setAt } from '../i18n/units.ts';
import { readXliff } from '../i18n/xliff.ts';
import { translateUnits, translationPath } from '../i18n/translate.ts';
import { unlinkText } from '../compile/glossary-links.ts';
import { readText } from '../project/files.ts';
import { loadProject, screenBlocks } from '../project/load.ts';
import type { Screen } from '../project/model.ts';
import { isRecord } from '../util/values.ts';
import type { Draft } from './context.ts';

// The links written by hand to the glossary, removed (docs/decisions.md D58; the links the compiler
// computes are in compile/glossary-links.ts). Removing an entry removes every link to it: each
// becomes its words, inline or by reference (its definition goes), and the same links leave the
// translations that had those texts up to date. « Retirer ce lien » does the same in one screen.

// A link removed: the words it kept, where.
export interface RemovedLink {
  // The screen, and the translation unit of the text (null for a text that is not translated).
  screen: string;
  term: string;
  text: string;
  unit: string | null;
}

export interface UnlinkedTranslation {
  language: string;
  // Units whose translation lost the same links (still up to date).
  unlinked: string[];
  // Units whose translation must be redone (its word anchors would move).
  stale: string[];
}

export interface UnlinkResult {
  removed: RemovedLink[];
  translations: UnlinkedTranslation[];
}

// Removes the links to the entries named from the draft's screens (every string of their blocks'
// properties, where E_GLOSSARY_TERM_UNKNOWN looks), then from the translations that had those texts
// up to date.
export function unlinkGlossaryTerms(project: Project, draft: Draft, terms: readonly string[], { screens }: { screens?: readonly string[] } = {}): UnlinkResult {
  const removedTerms = new Set(terms);
  if (!removedTerms.size) return { removed: [], translations: [] };
  const units = new Map(extractUnits(project).map((unit) => [`${unit.file}#${unit.pointer}`, unit.id]));
  const removed: RemovedLink[] = [];
  const changed = new Map<string, string>();
  const files = [...project.screens].filter(([id]) => !screens || screens.includes(id)).map(([, entry]) => entry.file);
  for (const file of files.filter((name): name is string => typeof name === 'string').sort()) {
    if (!draft.exists(file)) continue;
    const screen = draft.json<Screen>(file);
    const id = typeof screen.id === 'string' ? screen.id : file;
    let edited = false;
    for (const { block, path } of [...screenBlocks(screen)]) {
      for (const [pointer, text] of [...glossaryStrings(block.props, `${path}/props`)]) {
        const result = unlinkText(text, removedTerms);
        if (result.text === text) continue;
        setAt(screen, pointer, result.text);
        const unit = units.get(`${file}#${pointer}`) ?? null;
        if (unit) changed.set(unit, text);
        for (const link of result.removed) removed.push({ screen: id, term: link.term, text: link.words, unit });
        edited = true;
      }
    }
    if (edited) draft.writeJson(file, screen);
  }
  if (!changed.size) return { removed, translations: [] };
  const after = loadProject(draft.files(), { root: project.root });
  const translations: UnlinkedTranslation[] = [];
  for (const language of [...project.translations.keys()].sort()) {
    const source = readText(draft.files(), translationPath(language));
    if (source === null) continue;
    let doc: ReturnType<typeof readXliff>;
    try { doc = readXliff(source); } catch { continue; }
    const candidates: Candidate[] = [];
    const stale: string[] = [];
    for (const [id, before] of changed) {
      const unit = doc.units.get(id);
      if (!unit?.target || unit.source !== before || unit.state === 'initial') continue;
      if (unit.targetMarks?.length) { stale.push(id); continue; }
      candidates.push({ unit: id, target: unlinkText(unit.target, removedTerms).text, state: unit.state === 'reviewed' || unit.state === 'final' ? unit.state : 'translated' });
    }
    const accepted = writeTranslations(after, draft, language, candidates, stale);
    if (accepted.length || stale.length) translations.push({ language, unlinked: accepted, stale: stale.sort() });
  }
  return { removed, translations };
}

// The strings of a value that may hold a link to the glossary, with their JSON pointers.
function* glossaryStrings(value: unknown, pointer: string): Generator<[string, string]> {
  if (typeof value === 'string') { if (value.includes('glossary:')) yield [pointer, value]; return; }
  if (Array.isArray(value)) { for (const [index, item] of value.entries()) yield* glossaryStrings(item, `${pointer}/${index}`); return; }
  if (isRecord(value)) for (const [key, item] of Object.entries(value)) yield* glossaryStrings(item, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
}

type Candidate = { unit: string; target: string; state: 'translated' | 'reviewed' | 'final' };

// Translated texts written as translate_text writes them, so their units stay up to date; a text the
// rules of translations refuse (one checked at a time only when the whole set is refused) is added to
// stale. Returns the units written.
function writeTranslations(after: Project, draft: Draft, language: string, candidates: readonly Candidate[], stale: string[]): string[] {
  let accepted = [...candidates];
  if (candidates.length) {
    try { translateUnits(after, { language, texts: candidates }); } catch {
      accepted = candidates.filter((candidate) => {
        try { translateUnits(after, { language, texts: [candidate] }); return true; } catch { stale.push(candidate.unit); return false; }
      });
    }
  }
  if (accepted.length) {
    const { file, text } = translateUnits(after, { language, texts: accepted });
    draft.writeText(file, text);
  }
  return accepted.map((candidate) => candidate.unit);
}
