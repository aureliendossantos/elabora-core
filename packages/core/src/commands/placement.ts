import type { Block, Screen } from '../project/model.ts';
import type { Op } from '../ops/types.ts';
import { objectsIn } from '../util/values.ts';
import { CommandError, findBlock, screenFile, type CommandContext, type CommandOutput, type Placement } from './context.ts';
import { moveBlock, roundPlace } from './blocks.ts';

// Blocks placed by hand (D72): where a block sits in the placement frame, and its anchor (its slot and
// its rank in the screen's list), in one change ⌘Z undoes. The editor's drag writes both at once: a
// block dropped in the void takes the place its box has and the anchor nearest to it; dropped on a
// place in the flow, it leaves its place and goes there.

export interface PlaceBlockArgs extends Placement {
  block: string;
  // Where it sits; null: back in the flow, at its anchor.
  place: Block['place'] | null;
  // Its anchor's slot in the screen's layout (null: the layout's default slot); with after (null: first
  // of the screen's list) or position, its rank. Left out: the anchor stays.
  slot?: string | null;
}

export function placeBlock(context: CommandContext, args: PlaceBlockArgs): CommandOutput<{ screen: string }> {
  const found = findBlock(context.project(), args.block);
  if (found.list.length !== 1 || found.list[0] !== 'blocks') throw new CommandError(`Block "${args.block}" is in a layer or a component instance: only blocks of the screen itself are placed by hand.`);
  const ops: Op[] = [];
  const anchored = args.after !== undefined || args.position !== undefined || args.slot !== undefined;
  if (anchored) {
    // In its list already: after itself means where it is.
    const after = args.after === args.block ? undefined : args.after;
    // Without a rank, it keeps its own: after the block before it, or first (after null is the end).
    const kept = after === undefined && args.position === undefined ? previousOf(context.project().screens.get(found.screenId)!.data, args.block) : undefined;
    const rank = after ? { after } : after === null && args.position === undefined ? { position: 0 } : args.position !== undefined && args.position !== null ? { position: args.position } : kept ? { after: kept } : { position: 0 };
    const moved = moveBlock(context, { block: args.block, ...rank, ...(args.slot !== undefined ? { slot: args.slot } : {}) });
    ops.push(...(moved.ops ?? []));
  }
  const file = found.file;
  const path = ['blocks', { id: args.block }, 'place'];
  if (args.place) ops.push({ op: 'set', file, path, value: roundPlace(args.place) });
  else if (found.block.place) ops.push({ op: 'unset', file, path });
  return { ops, result: { screen: found.screenId } };
}

export interface ArrangeScreenArgs {
  screen: string;
  // The placed blocks to put back (default: every one of the screen).
  blocks?: string[];
}

// « Ranger »: the screen's placed blocks back in the flow, each at its anchor, in one change.
export function arrangeScreen(context: CommandContext, args: ArrangeScreenArgs): CommandOutput<{ screen: string; blocks: string[] }> {
  const entry = context.project().screens.get(args.screen);
  if (!entry) throw new CommandError(`No screen "${args.screen}"`);
  const placed = objectsIn(entry.data.blocks).filter((block) => block.place && (!args.blocks || args.blocks.includes(block.id)));
  const unknown = (args.blocks ?? []).filter((id) => !objectsIn(entry.data.blocks).some((block) => block.id === id && block.place));
  if (unknown.length) throw new CommandError(`Not placed by hand on screen "${args.screen}": ${unknown.join(', ')}`);
  const file = screenFile(args.screen);
  const ops: Op[] = placed.map((block) => ({ op: 'unset', file, path: ['blocks', { id: block.id }, 'place'] }));
  return { ops, result: { screen: args.screen, blocks: placed.map((block) => block.id) } };
}

// The block before it in the screen's list (null: it is first): a move to there keeps its rank.
function previousOf(screen: Screen, id: string): string | null {
  const list = objectsIn(screen.blocks);
  const index = list.findIndex((block) => block.id === id);
  return index > 0 ? list[index - 1].id : null;
}
