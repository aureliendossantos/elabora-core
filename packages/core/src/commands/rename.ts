import type { Action, Course, CourseSection, Plan, Screen, Variable } from '../project/model.ts';
import { filesIn, pathsUnder } from '../project/files.ts';
import { screenBlocks } from '../project/load.ts';
import { LOCK_FILE, type StateLock } from '../compile/state-model.ts';
import { parseJSON } from '../util/json.ts';
import { CommandError, Draft, allIds, listIn, screenFile, type CommandContext, type CommandOutput } from './context.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import { NARRATION_DIR } from '../narration/narration.ts';

// Renaming an element of the course (docs/architecture/operations.md, Identifiers and format version): ids are
// permanent, so tools never re-identify a node, and renaming is this one explicit change. The node
// gets its new id (a screen, its new file name); every reference follows: sections, events
// (triggers, conditions, actions), translation units, stylesheet selectors; the state lock keeps
// the element's key under its new id, so learners' progress stays theirs. A waiver of the plan that
// names the id follows too: the plan is written directly (D52), and its diff shows the change.

export type RenamedKind = 'section' | 'screen' | 'layer' | 'block' | 'event' | 'variable';

export interface RenameArgs {
  from: string;
  to: string;
}

export interface RenameResult {
  renamed: { kind: RenamedKind; from: string; to: string; screen?: string; references: number };
  waivers?: number; // waivers of the plan that named the id, which name the new one now
}

const SLUG = /^[a-z][a-z0-9-]{0,47}$/;

interface Place {
  kind: RenamedKind;
  screen?: string; // the screen holding a layer, block or event (its file name)
}

// Every element the id names (more than one is a duplicate id: E_DUPLICATE_ID).
function placesOf(course: Course | null, screens: ReadonlyMap<string, Screen>, id: string): Place[] {
  const places: Place[] = [];
  for (const section of objectsIn(course?.sections)) if (section.id === id) places.push({ kind: 'section' });
  for (const [screenId, screen] of screens) {
    if (screenId === id) places.push({ kind: 'screen', screen: screenId });
    for (const layer of objectsIn(screen.layers)) if (layer.id === id) places.push({ kind: 'layer', screen: screenId });
    for (const event of objectsIn(screen.events)) if (event.id === id) places.push({ kind: 'event', screen: screenId });
    for (const { block } of screenBlocks(screen)) if (block?.id === id) places.push({ kind: 'block', screen: screenId });
  }
  return places;
}

// The audio of a renamed screen's narration lines follows it, in every language, and their
// sidecars name it (docs/decisions.md D24).
function moveNarration(draft: Draft, from: string, to: string): void {
  for (const path of pathsUnder(draft.files(), NARRATION_DIR)) {
    const match = /^assets\/narration\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    const file = match && match[2] === from ? draft.file(path) : undefined;
    if (!match || !file) continue;
    const moved = `${NARRATION_DIR}/${match[1]}/${to}/${match[3]}`;
    const value = file.kind === 'text' && path.endsWith('.json') ? parseJSON(file.text).value : undefined;
    if (isRecord(value) && value.screen === from) draft.writeJson(moved, { ...value, screen: to });
    else draft.writeFile(moved, file);
    draft.remove(path);
  }
}

export function renameId(context: CommandContext, { from, to }: RenameArgs): CommandOutput<RenameResult> {
  if (!SLUG.test(to)) throw new CommandError(`"${to}" is not a valid id: lowercase letters, digits and hyphens, starting with a letter, 48 characters at most.`);
  if (from === to) throw new CommandError(`"${from}" already has this id.`);
  const draft = new Draft(context.files);
  const project = context.project();
  const screens = new Map([...project.screens].map(([id, entry]) => [id, entry.data]));
  const places = placesOf(project.course, screens, from);
  if (!places.length) throw new CommandError(`No section, screen, layer, block or event "${from}" in the course.`);
  if (places.length > 1) throw new CommandError(`"${from}" names ${places.length} elements (${places.map((p) => p.kind).join(', ')}): fix the duplicate id first (E_DUPLICATE_ID), then rename.`, [], 'E_DUPLICATE_ID');
  if (allIds(project).has(to) || screens.has(to) || draft.exists(screenFile(to))) {
    throw new CommandError(`Id "${to}" is already used in the course: choose another one.`, [], 'E_DUPLICATE_ID');
  }
  const [{ kind, screen: owner }] = places;
  let references = 0;
  const rename = (value: string | undefined): string | undefined => (value === from ? (references++, to) : value);

  // course.json: the section, or the screen in its section.
  if (kind === 'section' || kind === 'screen') {
    const course = draft.json<Course>('course.json');
    // A section whose screens are not a list names none of them.
    for (const section of objectsIn(listIn<CourseSection>(course, 'sections', 'course.json'))) {
      if (kind === 'section' && section.id === from) section.id = to;
      if (kind === 'screen' && Array.isArray(section.screens)) section.screens = section.screens.map((id) => rename(id) ?? id);
    }
    // The glossary's terms gathered from the screen (their source).
    if (kind === 'screen') for (const entry of objectsIn(course.glossary)) if (isRecord(entry.source) && entry.source.kind === 'screen') entry.source.id = rename(entry.source.id) ?? entry.source.id;
    draft.writeJson('course.json', course);
  }

  // Screens: the element itself, and the events that name it.
  for (const name of filesIn(context.files, 'screens').filter((n) => n.endsWith('.json'))) {
    const screenId = name.slice(0, -'.json'.length);
    const file = `screens/${name}`;
    const parsed = parseJSON(draft.text(file) ?? '');
    if (parsed.error !== undefined || !parsed.value || typeof parsed.value !== 'object') continue;
    const screen = parsed.value as Screen;
    const before = JSON.stringify(screen);
    if (screenId === owner) {
      if (kind === 'layer') for (const layer of objectsIn(screen.layers)) if (layer.id === from) layer.id = to;
      if (kind === 'event') for (const event of objectsIn(screen.events)) if (event.id === from) event.id = to;
      if (kind === 'block') for (const { block } of screenBlocks(screen)) if (block.id === from) block.id = to;
    }
    // Triggers name blocks and layers (layers of their own screen), conditions name blocks of any
    // screen, actions name screens, layers and blocks.
    const layers = kind === 'layer' && screenId === owner;
    const action = (a: Action) => {
      if (kind === 'screen' && a.type === 'go-to') a.screen = rename(a.screen);
      if (layers && (a.type === 'show-layer' || a.type === 'hide-layer')) a.layer = rename(a.layer);
      if (kind === 'block' && (a.type === 'show-block' || a.type === 'hide-block' || a.type === 'set-object-props' || a.type === 'play-media' || a.type === 'pause-media' || a.type === 'start-dialogue' || a.type === 'goto-dialogue' || a.type === 'restart-dialogue')) a.block = rename(a.block);
    };
    // A dialogue's options and cues act on blocks and layers of its screen (D61).
    for (const { block } of screenBlocks(screen)) {
      if (block.type !== 'dialogue' || !isRecord(block.props)) continue;
      for (const node of objectsIn(block.props.nodes as Record<string, unknown>[] | undefined)) {
        const lines = (list: unknown) => objectsIn(list as Record<string, unknown>[] | undefined);
        const cuesOf = (list: unknown) => lines(list).flatMap((line) => lines(line.cues));
        const options = lines(node.options);
        for (const holder of [...cuesOf(node.lines), ...options, ...options.flatMap((option) => cuesOf(option.reply))]) for (const a of lines(holder.do)) action(a as Action);
      }
    }
    for (const event of objectsIn(screen.events)) {
      if (isRecord(event.on) && (kind === 'block' || layers)) event.on.target = rename(event.on.target);
      if (kind === 'block') for (const condition of objectsIn(event.if)) {
        if ('visited' in condition) condition.visited = rename(condition.visited);
        if ('dialogue' in condition) condition.dialogue = rename(condition.dialogue);
      }
      for (const a of [...objectsIn(event.do), ...objectsIn(event.else)]) action(a);
    }
    if (kind === 'screen' && screenId === from) {
      screen.id = to;
      draft.remove(file);
      draft.writeJson(screenFile(to), screen);
      moveNarration(draft, from, to);
    } else if (JSON.stringify(screen) !== before) draft.writeJson(file, screen);
  }

  // The state lock: the element keeps its key under its new id (learner progress).
  const lockText = draft.text(LOCK_FILE);
  const lock = lockText === null ? undefined : parseJSON(lockText).value as StateLock | undefined;
  if (lock && typeof lock === 'object' && lock.keys && typeof lock.keys === 'object') {
    const renamedEntity = (entity: string): string => {
      const [, prefix, id, name] = /^([a-z]+):([^#]*)(#.*)?$/.exec(entity) ?? [];
      const ofScreen = kind === 'screen' && prefix === 'screen';
      const ofBlock = kind === 'block' && ['quiz', 'numeric', 'fillin', 'sort', 'reflection', 'decision', 'dialogue', 'choice', 'ending', 'object', 'block', 'visit'].includes(prefix);
      return (ofScreen || ofBlock) && id === from ? (references++, `${prefix}:${to}${name ?? ''}`) : entity;
    };
    const keys = Object.fromEntries(Object.entries(lock.keys).map(([entity, key]) => [renamedEntity(entity), key]));
    if (JSON.stringify(keys) !== JSON.stringify(lock.keys)) draft.writeJson(LOCK_FILE, { ...lock, keys });
  }

  // Translations: unit ids carry section, screen, layer and block ids; screens' files appear in notes.
  const units: [string, string][] = kind === 'section' ? [[`course.section.${from}.`, `course.section.${to}.`]]
    : kind === 'screen' ? [[`screen.${from}.`, `screen.${to}.`]]
      : kind === 'layer' ? [[`screen.${owner}.layer.${from}.`, `screen.${owner}.layer.${to}.`]]
        : kind === 'block' ? [[`block.${from}.`, `block.${to}.`]] : [];
  for (const name of filesIn(context.files, 'translations').filter((n) => n.endsWith('.xlf'))) {
    const file = `translations/${name}`;
    let text = draft.text(file) ?? '';
    for (const [old, renamed] of units) text = replaceCounting(text, `<unit id="${old}`, `<unit id="${renamed}`);
    if (kind === 'screen') text = text.replaceAll(`<note category="location">screens/${from}.json `, `<note category="location">screens/${to}.json `);
    if (text !== draft.text(file)) draft.writeText(file, text);
  }

  // Stylesheets of the theme and of components: attribute selectors on the course's DOM hooks.
  const attribute = { section: 'data-section', screen: 'data-screen', layer: 'data-layer', block: 'data-block', event: null, variable: null }[kind];
  // data-layer also names the backdrop's layers: a backdrop layer of the same name keeps its selectors.
  const backdropLayers: unknown = project.course?.theme?.backdrop?.layers;
  const shared = kind === 'layer' && Array.isArray(backdropLayers) && backdropLayers.includes(from);
  if (attribute && !shared) {
    const selector = new RegExp(`\\[\\s*${attribute}\\s*=\\s*(["']?)${from}\\1\\s*\\]`, 'g');
    for (const file of [...pathsUnder(context.files, 'theme'), ...pathsUnder(context.files, 'components')].filter((f) => f.endsWith('.css'))) {
      const text = draft.text(file) ?? '';
      const renamed = text.replace(selector, (_, quote: string) => (references++, `[${attribute}=${quote}${to}${quote}]`));
      if (renamed !== text) draft.writeText(file, renamed);
    }
  }

  // Plan waivers that name a screen or a block follow it.
  let waivers = 0;
  const plan = (kind === 'screen' || kind === 'block') && draft.exists('plan.json') ? parseJSON(draft.text('plan.json') ?? '').value as Plan | undefined : undefined;
  if (isRecord(plan) && Array.isArray(plan.waivers)) {
    for (const waiver of plan.waivers) if (isRecord(waiver) && waiver.target === from) { waiver.target = to; waivers++; }
    if (waivers) draft.writeJson('plan.json', plan);
  }

  return { files: draft.files(), result: { renamed: { kind, from, to, ...(owner && kind !== 'screen' ? { screen: owner } : {}), references }, ...(waivers ? { waivers } : {}) } };

  function replaceCounting(text: string, search: string, replacement: string): string {
    const parts = text.split(search);
    references += parts.length - 1;
    return parts.join(replacement);
  }
}

const VARIABLE_ID = /^[a-z][a-zA-Z0-9_]{0,31}$/;

// Renaming a variable (ids of variables are a namespace of their own): course.json, the events
// that read or write it (triggers, conditions, actions), and its key in the state lock, so that the
// value saved for learners stays theirs.
export function renameVariable(context: CommandContext, { from, to }: RenameArgs): CommandOutput<RenameResult> {
  if (!VARIABLE_ID.test(to)) throw new CommandError(`"${to}" is not a valid variable name: a lowercase letter, then letters, digits or underscores, 32 characters at most.`);
  if (from === to) throw new CommandError(`"${from}" already has this name.`);
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  const variables = listIn<Variable>(course, 'variables', 'course.json', { create: true });
  const variable = objectsIn(variables).find((candidate) => candidate.id === from);
  if (!variable) throw new CommandError(`No variable "${from}" in the course.`);
  if (objectsIn(variables).some((candidate) => candidate.id === to)) throw new CommandError(`Variable "${to}" already exists: choose another name.`);
  variable.id = to;
  draft.writeJson('course.json', course);
  let references = 0;
  const rename = (value: string | undefined): string | undefined => (value === from ? (references++, to) : value);
  for (const name of filesIn(context.files, 'screens').filter((n) => n.endsWith('.json'))) {
    const file = `screens/${name}`;
    const parsed = parseJSON(draft.text(file) ?? '');
    if (parsed.error !== undefined || !parsed.value || typeof parsed.value !== 'object') continue;
    const screen = parsed.value as Screen;
    const before = JSON.stringify(screen);
    for (const event of objectsIn(screen.events)) {
      if (isRecord(event.on) && event.on.type === 'variable.changed') event.on.variable = rename(event.on.variable);
      for (const condition of objectsIn(event.if)) if ('variable' in condition) condition.variable = rename(condition.variable);
      for (const action of [...objectsIn(event.do), ...objectsIn(event.else)]) if (action.type === 'set-variable' || action.type === 'increment-variable') action.variable = rename(action.variable);
    }
    if (JSON.stringify(screen) !== before) draft.writeJson(file, screen);
  }
  const lockText = draft.text(LOCK_FILE);
  const lock = lockText === null ? undefined : parseJSON(lockText).value as StateLock | undefined;
  if (lock && typeof lock === 'object' && lock.keys && typeof lock.keys === 'object' && Object.hasOwn(lock.keys, `var:${from}`)) {
    const keys = Object.fromEntries(Object.entries(lock.keys).map(([entity, key]) => [entity === `var:${from}` ? (references++, `var:${to}`) : entity, key]));
    draft.writeJson(LOCK_FILE, { ...lock, keys });
  }
  return { files: draft.files(), result: { renamed: { kind: 'variable', from, to, references } } };
}
