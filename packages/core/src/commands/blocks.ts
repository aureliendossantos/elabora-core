import type { Block, Screen } from '../project/model.ts';
import type { Op, Segment } from '../ops/types.ts';
import { planIndex, resolveBlockProps, screenBlocks } from '../project/load.ts';
import { getRegistry } from '../components/registry.ts';
import { fallbackBlocks } from '../components/fallback.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import {
  CommandError, Draft, allIds, anchorFor, findBlock, freshId, insertAt, listAt, pruneEmptyBlocks, screenFile, segmentsOf, targetList,
  type BlockTarget, type CommandContext, type CommandOutput, type Placement
} from './context.ts';

type Props = Record<string, unknown>;

export interface AddBlockArgs extends Placement {
  screen: string;
  // Without an id, the block gets a free one: <screen>-<type>, then -2, -3…
  block: Omit<Block, 'props' | 'id'> & { id?: string; props?: Props };
  layer?: string | null;
  parent?: string | null; // a component instance: the block goes in one of its slots (block.slot)
}

export function addBlock(context: CommandContext, args: AddBlockArgs): CommandOutput<{ block: string }> {
  const { screen: screenId, block, layer, parent, after, position } = args;
  const ids = allIds(context.project());
  if (block.id && ids.has(block.id)) throw new CommandError(`Id "${block.id}" is already used`);
  const id = block.id || freshId(ids, `${screenId}-${block.type}`);
  const draft = new Draft(context.files);
  const screen = draft.json<Screen>(screenFile(screenId));
  insertAt(targetList(screen, { layer, parent, screen: screenId }), { props: {}, ...block, id } as Block, { after, position });
  draft.writeJson(screenFile(screenId), screen);
  return { files: draft.files(), result: { block: id } };
}

export interface UpdateBlockArgs {
  block: string;
  props?: Props;        // merged: keys set to null are removed
  replaceProps?: Props;
  hidden?: boolean;
  width?: Block['width'];
  note?: string;
  // Extra the learner may skip (D63): not waited for by steps that open once explored nor by interactions-done.
  optional?: boolean;
  slot?: string | null;
  style?: string | null;
  // The step of the screen that reveals it (null or 1: shown from the start); only for a block of
  // the screen itself, not one in a layer or a component instance.
  step?: number | null;
}

export function updateBlock(context: CommandContext, args: UpdateBlockArgs): CommandOutput<{ screen: string }> {
  const place = findBlock(context.project(), args.block);
  if (args.step !== undefined && (place.list.length !== 1 || place.list[0] !== 'blocks')) throw new CommandError(`Block "${args.block}" is in a layer or a component instance: only blocks of the screen itself have a step.`);
  const draft = new Draft(context.files);
  const screen = draft.json<Screen>(place.file);
  const block = listAt(screen, place.list)[place.index];
  if (args.replaceProps) block.props = args.replaceProps;
  if (args.props) block.props = mergeProps(isRecord(block.props) ? block.props : {}, args.props);
  if (args.hidden !== undefined) block.hidden = args.hidden;
  if (args.width !== undefined) block.width = args.width;
  if (args.note !== undefined) block.note = args.note;
  if (args.optional === true) block.optional = true;
  else if (args.optional === false) delete block.optional;
  for (const key of ['slot', 'style'] as const) {
    const value = args[key];
    if (value === null) delete block[key];
    else if (value !== undefined) block[key] = value;
  }
  if (args.step === null || args.step === 1) delete block.step;
  else if (args.step !== undefined) block.step = args.step;
  draft.writeJson(place.file, screen);
  return { files: draft.files(), result: { screen: place.screenId } };
}

function mergeProps(base: Props, patch: Props): Props {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

export function removeBlock(context: CommandContext, { block }: { block: string }): CommandOutput<{ screen: string }> {
  const place = findBlock(context.project(), block);
  const draft = new Draft(context.files);
  const screen = draft.json<Screen>(place.file);
  listAt(screen, place.list).splice(place.index, 1);
  pruneEmptyBlocks(screen, place.list);
  draft.writeJson(place.file, screen);
  return { files: draft.files(), result: { screen: place.screenId } };
}

export interface MoveBlockArgs extends Placement, BlockTarget {
  block: string;
  slot?: string | null; // the slot in the target component instance; null clears it
}

// Moves a block within its screen, to another screen, into a layer or into the slots of a
// component instance: one move operation, then the slot it takes, so that the journal says what
// moved (a reorder computed by a diff could move the neighbours instead).
export function moveBlock(context: CommandContext, args: MoveBlockArgs): CommandOutput<Record<string, never>> {
  const { block: blockId, layer, parent, slot, after, position } = args;
  const place = findBlock(context.project(), blockId);
  const draft = new Draft(context.files);
  // The move on copies of the screens finds the target list and its anchor, and the errors.
  const source = draft.json<Screen>(place.file);
  const [moved] = listAt(source, place.list).splice(place.index, 1);
  const targetFile = args.screen ? screenFile(args.screen) : place.file;
  const target = targetFile === place.file ? source : draft.json<Screen>(targetFile);
  if (parent && (parent === moved.id || [...screenBlocks({ blocks: [moved] } as Screen)].some((l) => l.block.id === parent))) {
    throw new CommandError('A block cannot move into itself.');
  }
  const ops: Op[] = [];
  let toPath: Segment[];
  if (parent) {
    const host = [...screenBlocks(target)].find((l) => l.block.id === parent);
    if (!host) throw new CommandError(`No block "${parent}" on screen "${args.screen || target.id}"`);
    const hostPath = segmentsOf(target, host.path.split('/').slice(1).map((k) => (/^\d+$/.test(k) ? Number(k) : k)));
    if (!Array.isArray(host.block.blocks)) ops.push({ op: 'set', file: targetFile, path: [...hostPath, 'blocks'], value: [] });
    toPath = [...hostPath, 'blocks'];
  } else if (layer) {
    if (!objectsIn(target.layers).some((l) => l.id === layer)) throw new CommandError(`No layer "${layer}" on screen "${args.screen || target.id}"`);
    toPath = ['layers', { id: layer }, 'blocks'];
  } else toPath = ['blocks'];
  const list = targetList(target, { layer, parent, screen: args.screen });
  ops.push({ op: 'move', file: place.file, path: [...place.path, { id: blockId }], to: { file: targetFile, path: toPath }, after: anchorFor(list, { after, position }) });
  const at = [...toPath, { id: blockId }];
  if (slot === null && moved.slot !== undefined) ops.push({ op: 'unset', file: targetFile, path: [...at, 'slot'] });
  else if (slot !== undefined && slot !== null && slot !== moved.slot) ops.push({ op: 'set', file: targetFile, path: [...at, 'slot'], value: slot });
  // The component instance it leaves keeps no empty "blocks".
  const sourceList = listAt(source, place.list);
  if (!sourceList.length && sourceList !== list && place.list.length >= 2 && typeof place.list[place.list.length - 2] === 'number') {
    ops.push({ op: 'unset', file: place.file, path: place.path });
  }
  return { ops, result: {} };
}

export interface DuplicateBlockArgs extends Placement, BlockTarget {
  block: string;
  id?: string | null; // the copy's id; otherwise <id>-copy
}

// Copy of a block (a component instance with the blocks of its slots): new ids, same content,
// inserted after the original unless screen/layer/parent/after/position say otherwise.
export function duplicateBlock(context: CommandContext, args: DuplicateBlockArgs): CommandOutput<{ block: string; screen: string; renamed: Record<string, string> }> {
  const { block: blockId, id, screen: screenId, layer, parent, after, position } = args;
  const project = context.project();
  const place = findBlock(project, blockId);
  const ids = allIds(project);
  if (id && ids.has(id)) throw new CommandError(`Id "${id}" is already used`);
  const draft = new Draft(context.files);
  const source = draft.json<Screen>(place.file);
  const original = listAt(source, place.list)[place.index];
  const renamed = new Map<string, string>();
  const copy = (block: Block, root: boolean): Block => {
    const duplicate = structuredClone(block);
    duplicate.id = root && id ? (ids.add(id), id) : freshId(ids, `${block.id}-copy`);
    renamed.set(block.id, duplicate.id);
    if (Array.isArray(block.blocks)) duplicate.blocks = block.blocks.map((child) => (isRecord(child) ? copy(child, false) : child));
    return duplicate;
  };
  const duplicate = copy(original, true);
  const targetFile = screenId ? screenFile(screenId) : place.file;
  const target = targetFile === place.file ? source : draft.json<Screen>(targetFile);
  if (!screenId && !layer && !parent && !after && position === undefined) listAt(target, place.list).splice(place.index + 1, 0, duplicate);
  else insertAt(targetList(target, { layer, parent, screen: screenId }), duplicate, { after, position });
  draft.writeJson(place.file, source);
  if (targetFile !== place.file) draft.writeJson(targetFile, target);
  return { files: draft.files(), result: { block: duplicate.id, screen: screenId || place.screenId, renamed: Object.fromEntries(renamed) } };
}

// Replaces a component instance by its fallback: native blocks carrying the same content (plan
// links kept), followed by the blocks of its slots. The first block keeps the instance id, so
// events and learner state that pointed at it still do (a fork of quiz becomes a quiz).
export function detachBlock(context: CommandContext, { block: blockId }: { block: string }): CommandOutput<{ screen: string; blocks: string[] }> {
  const project = context.project();
  const place = findBlock(project, blockId);
  const registry = getRegistry(project);
  const descriptor = registry.get(place.block.type);
  if (!descriptor || descriptor.builtin) throw new CommandError(`"${blockId}" is a native ${place.block.type} block: nothing to detach.`);
  const index = planIndex(project.plan);
  const natives = fallbackBlocks(registry, place.block, { resolve: (b) => resolveBlockProps(b, index, registry) });
  const draft = new Draft(context.files);
  const screen = draft.json<Screen>(place.file);
  const slot = place.block.slot && !place.parent ? place.block.slot : undefined;
  listAt(screen, place.list).splice(place.index, 1, ...natives.map((b) => (slot ? { ...b, slot } : b)));
  draft.writeJson(place.file, screen);
  return { files: draft.files(), result: { screen: place.screenId, blocks: natives.map((b) => `${b.type}:${b.id}`) } };
}
