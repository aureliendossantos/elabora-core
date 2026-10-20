import { extractUnits, invariants, setAt, valueAt } from '../i18n/units.ts';
import type { Project } from '../project/model.ts';
import { CommandError, Draft } from './context.ts';
import type { CommandContext, CommandOutput } from './context.ts';

// The course's words found and replaced (the app's « Rechercher »): every string a learner reads in
// course.json and the screens, as translation sees them (extractUnits: titles, blocks' words, layers,
// steps' buttons, free objects' wording). Not the plan's validated texts (a block shows them by
// reference; they change in the plan, set_plan_text or write_plan), nor what is not words (ids, files, the
// values of a choice), nor the words of the editor (how those values read to authors). A replacement
// keeps what translation keeps: maths, links and code of a Markdown text (their insides are not
// words), the placeholders of an object's string, its length.

export interface TextMatch {
  unit: string; // the translation unit: course.title, screen.<id>.title, block.<id>.<path>…
  file: string;
  pointer: string;
  text: string;
  count: number; // occurrences in it
  screen: string | null; // the screen it is on
  block: string | null; // the block it belongs to
}

export interface FindTextOptions {
  caseSensitive?: boolean;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patternOf = (query: string, caseSensitive = false): RegExp => new RegExp(escape(query), caseSensitive ? 'gu' : 'giu');

// In Markdown, a link's address, maths and code are not words: never found, never replaced.
const NOT_WORDS = /(\]\([^)]*\)|\$\$[\s\S]+?\$\$|\$(?!\s)[^$\n]+?\$|`[^`]+`)/;

function replaceWords(text: string, format: string, pattern: RegExp, replacement: string): { text: string; count: number } {
  let count = 0;
  const parts = format === 'markdown' ? text.split(NOT_WORDS) : [text];
  const replaced = parts.map((part, index) => (index % 2 === 1 ? part : part.replace(pattern, () => { count++; return replacement; })));
  return { text: replaced.join(''), count };
}

export function findText(project: Project, query: string, { caseSensitive = false }: FindTextOptions = {}): TextMatch[] {
  if (!query) return [];
  const pattern = patternOf(query, caseSensitive);
  const matches: TextMatch[] = [];
  for (const unit of extractUnits(project)) {
    if (unit.file === 'plan.json' || unit.editor) continue;
    const { count } = replaceWords(unit.text, unit.format, pattern, query);
    if (!count) continue;
    const screen = /^screens\/(.+)\.json$/.exec(unit.file)?.[1] ?? null;
    const block = unit.id.startsWith('block.') ? unit.id.split('.')[1] ?? null : null;
    matches.push({ unit: unit.id, file: unit.file, pointer: unit.pointer, text: unit.text, count, screen, block });
  }
  return matches;
}

export interface ReplaceTextArgs {
  find: string;
  replace: string;
  caseSensitive?: boolean;
  units?: string[] | null; // only these matches (findText's unit ids); otherwise all of them
}

export interface ReplaceTextResult {
  replaced: number; // occurrences replaced
  units: string[];
  skipped: { unit: string; reason: string }[];
}

// One command, one step to undo, whatever the number of screens it changes.
export function replaceText(context: CommandContext, { find, replace, caseSensitive = false, units }: ReplaceTextArgs): CommandOutput<ReplaceTextResult> {
  if (!find) throw new CommandError('Nothing to find: give the words to replace.');
  const project = context.project();
  const wanted = units ? new Set(units) : null;
  const matches = findText(project, find, { caseSensitive }).filter((match) => !wanted || wanted.has(match.unit));
  if (!matches.length) throw new CommandError(`"${find}" is not in the words of the course${wanted ? ' chosen' : ''}.`);
  const byId = new Map(extractUnits(project).map((unit) => [unit.id, unit]));
  const draft = new Draft(context.files);
  const documents = new Map<string, object>();
  const done: string[] = [];
  const skipped: ReplaceTextResult['skipped'] = [];
  let replaced = 0;
  for (const match of matches) {
    const unit = byId.get(match.unit);
    if (!unit) continue;
    const { text: next } = replaceWords(unit.text, unit.format, patternOf(find, caseSensitive), replace);
    if (JSON.stringify(invariants(unit.text, unit.format)) !== JSON.stringify(invariants(next, unit.format))) {
      skipped.push({ unit: unit.id, reason: unit.format === 'icu' ? 'it would change the values the object puts in it' : 'it would change maths, a link or code' });
      continue;
    }
    if (unit.maxLength && next.length > unit.maxLength) {
      skipped.push({ unit: unit.id, reason: `it would be longer than ${unit.maxLength} characters` });
      continue;
    }
    if (!next.trim()) {
      skipped.push({ unit: unit.id, reason: 'it would be empty' });
      continue;
    }
    const document = documents.get(unit.file) ?? draft.json<object>(unit.file);
    documents.set(unit.file, document);
    if (unit.base && valueAt(document, unit.base.pointer) == null) setAt(document, unit.base.pointer, structuredClone(unit.base.value));
    setAt(document, unit.pointer, next);
    replaced += match.count;
    done.push(unit.id);
  }
  if (!done.length) throw new CommandError(`Nothing replaced: ${skipped.map((entry) => `${entry.unit} (${entry.reason})`).join('; ')}.`);
  for (const [file, document] of documents) draft.writeJson(file, document);
  return { files: draft.files(), result: { replaced, units: done, skipped } };
}
