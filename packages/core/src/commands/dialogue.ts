import type { Block, Screen } from '../project/model.ts';
import { getRegistry, rootOf } from '../components/registry.ts';
import { isRecord } from '../util/values.ts';
import { CommandError, Draft, findBlock, listAt, type CommandContext, type CommandOutput } from './context.ts';

// A node of a dialogue written whole (docs/decisions.md D61): its lines, its options, its way out.
// Adding a node, an option or a line to a long dialogue with update_block means writing every node
// again; this writes one, added (after a node, or first) or replaced in its place (moved when after
// or first is given). The validation says what it leaves to fix (a next to a node that is gone).

export interface SetDialogueNodeArgs {
  block: string;
  node: Record<string, unknown>;
  after?: string;
  first?: boolean;
}

export interface RemoveDialogueNodeArgs {
  block: string;
  node: string;
}

function dialogueAt(context: CommandContext, blockId: string): { draft: Draft; file: string; screen: Screen; block: Block; screenId: string; nodes: Record<string, unknown>[] } {
  const project = context.project();
  const place = findBlock(project, blockId);
  if (rootOf(getRegistry(project), place.block.type) !== 'dialogue') throw new CommandError(`"${blockId}" is a ${place.block.type} block, not a dialogue.`);
  const draft = new Draft(context.files);
  const screen = draft.json<Screen>(place.file);
  const block = listAt(screen, place.list)[place.index] as Block;
  const props = isRecord(block.props) ? block.props : (block.props = {} as Block['props']);
  if (!Array.isArray(props.nodes)) props.nodes = [];
  return { draft, file: place.file, screen, block, screenId: place.screenId, nodes: props.nodes as Record<string, unknown>[] };
}

export function setDialogueNode(context: CommandContext, args: SetDialogueNodeArgs): CommandOutput<{ screen: string; node: string; added: boolean; index: number }> {
  if (!isRecord(args.node) || typeof args.node.id !== 'string' || !args.node.id) throw new CommandError('node needs an id (a node of the dialogue: { "id": "ticket", "lines": […], "options": […] }).');
  if (args.after !== undefined && args.first) throw new CommandError('Give after or first, not both.');
  const { draft, file, screen, screenId, nodes } = dialogueAt(context, args.block);
  const id = args.node.id;
  const existing = nodes.findIndex((node) => isRecord(node) && node.id === id);
  const moving = args.after !== undefined || args.first === true;
  if (existing >= 0 && !moving) nodes[existing] = args.node;
  else {
    if (existing >= 0) nodes.splice(existing, 1);
    let index = nodes.length;
    if (args.first) index = 0;
    else if (args.after !== undefined) {
      const at = nodes.findIndex((node) => isRecord(node) && node.id === args.after);
      if (at < 0) throw new CommandError(`Dialogue "${args.block}" has no node "${args.after}" to add after (nodes: ${nodes.map((node) => (isRecord(node) ? node.id : '?')).join(', ') || 'none'}).`);
      index = at + 1;
    }
    nodes.splice(index, 0, args.node);
  }
  draft.writeJson(file, screen);
  return { files: draft.files(), result: { screen: screenId, node: id, added: existing < 0, index: nodes.findIndex((node) => isRecord(node) && node.id === id) } };
}

export function removeDialogueNode(context: CommandContext, args: RemoveDialogueNodeArgs): CommandOutput<{ screen: string; node: string }> {
  const { draft, file, screen, screenId, nodes } = dialogueAt(context, args.block);
  const index = nodes.findIndex((node) => isRecord(node) && node.id === args.node);
  if (index < 0) throw new CommandError(`Dialogue "${args.block}" has no node "${args.node}".`);
  if (nodes.length === 1) throw new CommandError(`"${args.node}" is the only node of dialogue "${args.block}": a dialogue keeps at least one (remove the block instead).`);
  nodes.splice(index, 1);
  draft.writeJson(file, screen);
  return { files: draft.files(), result: { screen: screenId, node: args.node } };
}
