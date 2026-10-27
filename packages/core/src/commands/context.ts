import { getFile, textFile } from '../project/files.ts';
import type { ProjectFiles, SourceFile } from '../project/files.ts';
import { loadProject, screenBlocks } from '../project/load.ts';
import type { Project, Screen, Block, ScreenLayer } from '../project/model.ts';
import type { Author, Op, Segment } from '../ops/types.ts';
import { parseJSON, stringifyJSON } from '../util/json.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import { fieldOf } from '@elabora/player/json';

// Commands: the vocabulary of the CLI and the MCP server (add_block, move_screen…) as pure
// functions. A command reads a files snapshot and returns the files it would leave, or the
// operations it means (a move is a move, not a removal and an insertion somewhere else). It never
// touches a disk: @elabora/node runs it under the project lock, turns its output into operations,
// checks and writes them, and journals the change (docs/architecture/operations.md).

export interface CommandDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  file?: string;
  path?: string;
  message: string;
}

// A refused command: nothing is written. code: the catalogue code, when the refusal has one.
export class CommandError extends Error {
  readonly diagnostics: CommandDiagnostic[];
  readonly code: string | undefined;

  constructor(message: string, diagnostics: CommandDiagnostic[] = [], code?: string) {
    super(message);
    this.name = 'EditError';
    this.diagnostics = diagnostics;
    this.code = code;
  }
}

export interface CommandContext {
  readonly files: ProjectFiles;
  // The snapshot loaded as a project, for commands that need the model (loaded once).
  project(): Project;
  readonly now: Date;
  // Who runs it, when the runner knows: a few commands are a person's alone (a version of the plan,
  // its validation) or refuse an agent what the author must decide (a text kept « à l'identique »).
  readonly author?: Author;
}

// files: the project after the command; ops: the operations it means instead. result: what the
// caller gets back (the ids it created, the screen it touched…).
export type CommandOutput<Result> = { files: ProjectFiles; ops?: undefined; result: Result } | { ops: Op[]; files?: undefined; result: Result };

export function commandContext(files: ProjectFiles, options: { root?: string; now?: Date; author?: Author } = {}): CommandContext {
  let project: Project | null = null;
  return { files, now: options.now ?? new Date(), ...(options.author ? { author: options.author } : {}), project: () => (project ??= loadProject(files, { root: options.root })) };
}

// Edits of a snapshot, for commands that compute files: reads see earlier writes, JSON documents
// are written with Elabora's formatting.
export class Draft {
  private readonly before: ProjectFiles;
  private readonly written = new Map<string, SourceFile | null>();

  constructor(files: ProjectFiles) {
    this.before = files;
  }

  file(path: string): SourceFile | undefined {
    if (this.written.has(path)) return this.written.get(path) ?? undefined;
    return getFile(this.before, path);
  }

  exists(path: string): boolean {
    return this.file(path) !== undefined;
  }

  text(path: string): string | null {
    const file = this.file(path);
    return file?.kind === 'text' ? file.text : null;
  }

  // A fresh copy of a JSON document: change it, then write it back with writeJson. The document is
  // an object; its parts may still break the schema (listIn refuses to edit those).
  json<T>(path: string): T {
    const text = this.text(path);
    if (text === null) throw new CommandError(`${path} does not exist`);
    const parsed = parseJSON(text);
    if (parsed.error !== undefined) throw new CommandError(`${path} is not valid JSON: ${parsed.error}`);
    if (!isRecord(parsed.value)) throw new CommandError(`${path} is not a JSON object. ${FIX_FIRST}`);
    return parsed.value as T;
  }

  writeJson(path: string, value: unknown): void {
    this.written.set(path, textFile(stringifyJSON(value)));
  }

  writeText(path: string, text: string): void {
    this.written.set(path, textFile(text));
  }

  writeFile(path: string, file: SourceFile): void {
    this.written.set(path, file);
  }

  remove(path: string): void {
    this.written.set(path, null);
  }

  files(): ProjectFiles {
    const out = new Map(this.before);
    for (const [path, file] of this.written) {
      if (file) out.set(path, file);
      else out.delete(path);
    }
    return out;
  }
}

export const screenFile = (id: string): string => `screens/${id}.json`;

const FIX_FIRST = 'Fix the file first: elabora validate reports what breaks its schema.';

// A list of a document that a command edits; with create, an absent list is created. A command
// refuses to edit a list the file holds as something else.
export function listIn<T>(owner: Record<string, unknown>, key: string, file: string, { create = false }: { create?: boolean } = {}): T[] {
  const value = owner[key];
  if (Array.isArray(value)) return value;
  if (create && (value === undefined || value === null)) {
    const list: T[] = [];
    owner[key] = list;
    return list;
  }
  throw new CommandError(`${file}: "${key}" is not a list. ${FIX_FIRST}`);
}

// Where a new element goes: after an element (id), at a position, or last.
export interface Placement {
  after?: string | null;
  position?: number | null;
}

// The keyed-array element ids or strings of a list, for anchors.
const idOf = (element: unknown): unknown => (element !== null && typeof element === 'object' ? (element as { id?: unknown }).id : element);

export function insertAt<T>(list: T[], item: T, { after, position }: Placement): void {
  if (after) {
    const i = list.findIndex((x) => idOf(x) === after);
    if (i < 0) throw new CommandError(`"${after}" not found`);
    list.splice(i + 1, 0, item);
  } else if (Number.isInteger(position)) list.splice(Math.max(0, Math.min(list.length, position as number)), 0, item);
  else list.push(item);
}

// The anchor (after) that gives the same place as insertAt in a list that does not hold the
// element: an operation's after, never a position.
export function anchorFor(list: readonly unknown[], { after, position }: Placement): string | null {
  if (after) {
    if (!list.some((x) => idOf(x) === after)) throw new CommandError(`"${after}" not found`);
    return after;
  }
  const at = Number.isInteger(position) ? Math.max(0, Math.min(list.length, position as number)) : list.length;
  return at ? String(idOf(list[at - 1])) : null;
}

// Removes the given keys whose value is null, and sets those that are defined.
export function assignFields<T extends object>(target: T, fields: Partial<Record<keyof T, unknown>>, keys: readonly (keyof T)[]): void {
  const record = target as Record<keyof T, unknown>;
  for (const key of keys) {
    const value = fields[key];
    if (value === null) delete record[key];
    else if (value !== undefined) record[key] = value;
  }
}


// A block anywhere: on a screen, in a layer, or in the slots of a component instance. list: the
// keys and indexes from the screen to the array holding it; path: the same with { id } selectors.
export interface BlockPlace {
  screenId: string;
  file: string;
  list: (string | number)[];
  path: Segment[];
  index: number;
  block: Block;
  parent: Block | null;
}

export function findBlock(project: Project, blockId: string): BlockPlace {
  for (const [screenId, { file, data }] of project.screens) {
    for (const location of screenBlocks(data, file)) {
      if (location.block.id !== blockId) continue;
      const parts = location.path.split('/').slice(1);
      const list = parts.slice(0, -1).map((k) => (/^\d+$/.test(k) ? Number(k) : k));
      return { screenId, file, list, path: segmentsOf(data, list), index: Number(parts[parts.length - 1]), block: location.block, parent: location.parent };
    }
  }
  throw new CommandError(`No block "${blockId}" in the course`);
}

// Indexes of a list path as { id } selectors, for operations.
export function segmentsOf(root: unknown, list: readonly (string | number)[]): Segment[] {
  const segments: Segment[] = [];
  let node = root;
  for (const key of list) {
    node = fieldOf(node, String(key));
    segments.push(typeof key === 'number' ? { id: String(fieldOf(node, 'id')) } : key);
  }
  return segments;
}

// The value at a list path (keys and indexes) of a document.
const nodeAt = (root: unknown, list: readonly (string | number)[]): unknown => list.reduce<unknown>((node, key) => fieldOf(node, String(key)), root);

// The list at a path that findBlock gave for the same file.
export function listAt(screen: Screen, list: readonly (string | number)[]): Block[] {
  const node = nodeAt(screen, list);
  if (!Array.isArray(node)) throw new CommandError(`No list at /${list.join('/')} of screen "${screen.id}". ${FIX_FIRST}`);
  return node;
}

// A component instance whose last slotted block went away keeps no empty "blocks".
export function pruneEmptyBlocks(screen: Screen, list: readonly (string | number)[]): void {
  if (list.length >= 2 && list[list.length - 1] === 'blocks' && typeof list[list.length - 2] === 'number') {
    const host = nodeAt(screen, list.slice(0, -1));
    if (isRecord(host) && Array.isArray(host.blocks) && !host.blocks.length) delete host.blocks;
  }
}

export interface BlockTarget {
  layer?: string | null;
  parent?: string | null; // a component instance: the block goes in its slots
  screen?: string | null;
}

// The list that receives a new or moved block: a layer, the slots of a component instance (parent),
// or the screen.
export function targetList(screen: Screen, { layer, parent, screen: screenId }: BlockTarget): Block[] {
  const file = screenFile(screenId || screen.id);
  if (parent) {
    const host = [...screenBlocks(screen)].find((l) => l.block.id === parent)?.block;
    if (!host) throw new CommandError(`No block "${parent}" on screen "${screenId || screen.id}"`);
    return listIn<Block>(host, 'blocks', file, { create: true });
  }
  if (!layer) return listIn<Block>(screen, 'blocks', file);
  const found = objectsIn(screen.layers).find((l: ScreenLayer) => l.id === layer);
  if (!found) throw new CommandError(`No layer "${layer}" on screen "${screenId || screen.id}"`);
  return listIn<Block>(found, 'blocks', file);
}

// Ids of sections, screens, layers, events and blocks: unique in the course.
export function allIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const { data } of project.screens.values()) {
    ids.add(data.id);
    for (const layer of objectsIn(data.layers)) ids.add(layer.id);
    for (const event of objectsIn(data.events)) ids.add(event.id);
    for (const { block } of screenBlocks(data)) ids.add(block.id);
  }
  for (const section of objectsIn(project.course?.sections)) ids.add(section.id);
  return ids;
}

export function freshId(ids: Set<string>, base: string): string {
  let id = base.slice(0, 48);
  for (let n = 2; ids.has(id); n++) id = `${base.slice(0, 44)}-${n}`;
  ids.add(id);
  return id;
}
