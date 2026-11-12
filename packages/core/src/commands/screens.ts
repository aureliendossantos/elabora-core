import { schemaId } from '@elabora/format';
import type { Block, Course, CourseSection, Screen } from '../project/model.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import { pathsUnder } from '../project/files.ts';
import { parseJSON } from '../util/json.ts';
import { NARRATION_DIR } from '../narration/narration.ts';
import type { Op } from '../ops/types.ts';
import { keyedKind } from '../ops/path.ts';
import { renameReferences } from './references.ts';
import { getRegistry } from '../components/registry.ts';
import { copyTranslations } from './translation.ts';
import { applySet, type PathEdit } from './set-paths.ts';
import { CommandError, Draft, allIds, anchorFor, assignFields, derivedId, insertAt, listIn, screenFile, type CommandContext, type CommandOutput, type Placement } from './context.ts';

// The sections of course.json, and whether one lists a screen (a section whose list is broken
// lists none; editing it is refused).
const sectionsOf = (course: Course): CourseSection[] => objectsIn(listIn<CourseSection>(course, 'sections', 'course.json'));
const lists = (section: CourseSection, id: string | null | undefined): boolean => Array.isArray(section.screens) && section.screens.some((screen) => screen === id);
const screensOf = (section: CourseSection): string[] => listIn<string>(section, 'screens', 'course.json');

export interface CreateScreenArgs extends Placement {
  id: string;
  title: string;
  covers: string[];
  section?: string | null;
  completeWhen?: Screen['completeWhen'];
  blocks?: Block[];
  layout?: string | null; // a screen component of the course, and its props
  layoutProps?: Record<string, unknown> | null;
}

export function createScreen(context: CommandContext, args: CreateScreenArgs): CommandOutput<{ screen: string; section: string }> {
  const { id, title, covers, section, after, position, completeWhen, blocks, layout, layoutProps } = args;
  const draft = new Draft(context.files);
  if (draft.exists(screenFile(id))) throw new CommandError(`${screenFile(id)} already exists`);
  const course = draft.json<Course>('course.json');
  const sections = sectionsOf(course);
  const target = sections.find((s) => s.id === section) || (after ? sections.find((s) => lists(s, after)) : sections[sections.length - 1]);
  if (!target) throw new CommandError(`Unknown section "${section}"`);
  insertAt(screensOf(target), id, { after, position });
  draft.writeJson('course.json', course);
  const screen = {
    $schema: schemaId('screen'), id, title, covers, ...(completeWhen ? { completeWhen } : {}),
    ...(layout ? { layout, ...(layoutProps && Object.keys(layoutProps).length ? { layoutProps } : {}) } : {}),
    blocks: blocks?.length ? blocks : [{ id: `${id}-text`, type: 'text', props: { markdown: title } }]
  };
  draft.writeJson(screenFile(id), screen);
  return { files: draft.files(), result: { screen: id, section: target.id } };
}

export interface DuplicateScreenArgs {
  id: string;
  newId?: string | null; // the copy's id; otherwise <id>-copy-<random suffix> (D77)
  title?: string | null; // the copy's title; otherwise the original's
}

// A copy of a screen, after it in its section: its blocks, layers and events get new ids (those
// named after the screen follow its new id: chemin-intro → chemin-copy-intro), and the copy's
// events point at its own blocks and layers. What they name elsewhere (screens, blocks of other
// screens, variables, objects, the plan) stays as it is.
export function duplicateScreen(context: CommandContext, { id, newId, title }: DuplicateScreenArgs): CommandOutput<{ screen: string; section: string; renamed: Record<string, string> }> {
  const project = context.project();
  const ids = allIds(project);
  const draft = new Draft(context.files);
  const source = draft.json<Screen>(screenFile(id));
  if (newId && (ids.has(newId) || draft.exists(screenFile(newId)))) throw new CommandError(`Id "${newId}" is already used`);
  // One random suffix for the copy and what it renames (D77): its blocks, layers and events read with it.
  const tag = context.suffix();
  const copyId = newId || derivedId(ids, `${id.slice(0, 48 - 10)}-copy-${tag}`, context);
  ids.add(copyId);
  const renamed = new Map<string, string>([[id, copyId]]);
  const rename = (old: string): string => {
    const known = renamed.get(old);
    if (known) return known;
    const next = derivedId(ids, old.startsWith(`${id}-`) ? `${copyId}-${old.slice(id.length + 1)}` : `${old.slice(0, 48 - 10)}-copy-${tag}`, context);
    renamed.set(old, next);
    return next;
  };
  const copy = structuredClone(source);
  copy.id = copyId;
  if (title) copy.title = title;
  const walk = (blocks: unknown) => {
    for (const block of objectsIn(blocks as Block[] | undefined)) {
      if (typeof block.id === 'string') block.id = rename(block.id);
      walk(block.blocks);
    }
  };
  walk(copy.blocks);
  for (const layer of objectsIn(copy.layers)) {
    if (typeof layer.id === 'string') layer.id = rename(layer.id);
    walk(layer.blocks);
  }
  for (const event of objectsIn(copy.events)) if (typeof event.id === 'string') event.id = rename(event.id);
  // What the copy names of its own (its events, its dialogues' cues and options) names the copy's.
  const registry = getRegistry(project);
  renameReferences(copy, { local: (value) => (value !== id && renamed.get(value)) || value, dialogue: (type) => registry.get(type)?.behavior === 'dialogue' });
  const course = draft.json<Course>('course.json');
  const section = sectionsOf(course).find((candidate) => lists(candidate, id));
  if (!section) throw new CommandError(`Screen "${id}" is in no section of course.json`);
  insertAt(screensOf(section), copyId, { after: id });
  // A glossary term whose link was removed from the original is not linked in the copy either.
  for (const entry of objectsIn(course.glossary)) if (Array.isArray(entry.unlinked) && entry.unlinked.includes(id)) entry.unlinked.push(copyId);
  draft.writeJson('course.json', course);
  draft.writeJson(screenFile(copyId), copy);
  copyNarration(draft, id, copyId);
  copyTranslations(draft, renamed, { screen: [id, copyId] });
  return { files: draft.files(), result: { screen: copyId, section: section.id, renamed: Object.fromEntries([...renamed].filter(([old]) => old !== id)) } };
}

// The copy says its lines with the same audio, in every language: each file copied under its id,
// its sidecar naming it (docs/decisions.md D24).
function copyNarration(draft: Draft, from: string, to: string): void {
  for (const path of pathsUnder(draft.files(), NARRATION_DIR)) {
    const match = /^assets\/narration\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    const file = match && match[2] === from ? draft.file(path) : undefined;
    if (!match || !file) continue;
    const copied = `${NARRATION_DIR}/${match[1]}/${to}/${match[3]}`;
    const value = file.kind === 'text' && path.endsWith('.json') ? parseJSON(file.text).value : undefined;
    if (isRecord(value) && value.screen === from) draft.writeJson(copied, { ...value, screen: to });
    else draft.writeFile(copied, file);
  }
}

// Fields of a screen that update_screen changes; null removes one.
export const SCREEN_FIELDS = ['title', 'covers', 'completeWhen', 'required', 'showTitle', 'layout', 'layoutProps', 'style', 'backdrop', 'continueRevealsSteps', 'steps', 'narration'] as const;
export type UpdateScreenArgs = { id: string } & { [K in (typeof SCREEN_FIELDS)[number]]?: Screen[K] | null } & {
  // Fields and entries of those fields changed by their path, after them (D89).
  set?: PathEdit[];
};

export function updateScreen(context: CommandContext, args: UpdateScreenArgs): CommandOutput<Record<string, never>> {
  const draft = new Draft(context.files);
  const screen = draft.json<Screen>(screenFile(args.id));
  assignFields(screen, args, SCREEN_FIELDS);
  applySet(screen as unknown as Record<string, unknown>, args.set, { what: `screen "${args.id}"`, fields: SCREEN_FIELDS });
  draft.writeJson(screenFile(args.id), screen);
  return { files: draft.files(), result: {} };
}

export function deleteScreen(context: CommandContext, { id }: { id: string }): CommandOutput<Record<string, never>> {
  const draft = new Draft(context.files);
  draft.json<Screen>(screenFile(id));
  const course = draft.json<Course>('course.json');
  const sections = sectionsOf(course);
  for (const s of sections) s.screens = screensOf(s).filter((x) => x !== id);
  if (sections.some((s) => !s.screens.length)) throw new CommandError('Deleting this screen would leave a section empty: remove or merge the section first.');
  // A glossary term no longer unlinked in a screen that is gone (a new screen of that id is linked).
  for (const entry of Array.isArray(course.glossary) ? course.glossary : []) {
    if (!Array.isArray(entry.unlinked) || !entry.unlinked.includes(id)) continue;
    entry.unlinked = entry.unlinked.filter((screen) => screen !== id);
    if (!entry.unlinked.length) delete entry.unlinked;
  }
  draft.writeJson('course.json', course);
  draft.remove(screenFile(id));
  return { files: draft.files(), result: {} };
}

export interface MoveScreenArgs extends Placement {
  id: string;
  section?: string | null;
}

// A move of the screen's id in course.json, between sections or within one.
export function moveScreen(context: CommandContext, args: MoveScreenArgs): CommandOutput<Record<string, never>> {
  const { id, section, after, position } = args;
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  const sections = sectionsOf(course);
  const from = sections.filter((s) => lists(s, id));
  for (const s of sections) s.screens = screensOf(s).filter((x) => x !== id);
  const target = sections.find((s) => s.id === section) || sections.find((s) => lists(s, after));
  if (!target) throw new CommandError('Give a section id or an existing screen id in after');
  // Listed once, in keyed lists: one move. Otherwise (listed twice, a damaged list) the lists are rewritten.
  const keyed = from.length === 1 && sections.length === course.sections.length && sections.every((s) => keyedKind(s.screens) !== null);
  if (keyed) {
    const op: Op = { op: 'move', file: 'course.json', path: ['sections', { id: from[0].id }, 'screens', { id }], to: { file: 'course.json', path: ['sections', { id: target.id }, 'screens'] }, after: anchorFor(target.screens, { after, position }) };
    return { ops: [op], result: {} };
  }
  insertAt(target.screens, id, { after, position });
  draft.writeJson('course.json', course);
  return { files: draft.files(), result: {} };
}
