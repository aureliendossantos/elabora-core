// Continuity between screens (docs/decisions.md D65), as the author sets it: a block carries on from
// a block of another screen (they share a key), or no longer carries on from the screens before it,
// and how long the passage to it lasts. One change, whatever blocks it touches.

import type { Block, Screen } from '../project/model.ts';
import { continuityChains, continuityKey, continuityKind } from '../project/continuity.ts';
import { iterateBlocks } from '../project/load.ts';
import { isRecord } from '../util/values.ts';
import { CommandError, Draft, findBlock, listAt, type CommandContext, type CommandOutput } from './context.ts';

export interface SetContinuityArgs {
  block: string;
  // A block of another screen it carries on from: they share its key (that block's, else this one's,
  // else a new one); null: it no longer carries on from the screens before it (it still carries on
  // to the ones after it, with a key of their own). Left out: the chain stays as it is.
  with?: string | null;
  // The passage to it, in ms (0 to 3000); null: the default (700).
  duration?: number | null;
}

export function setContinuity(context: CommandContext, args: SetContinuityArgs): CommandOutput<{ key: string | null }> {
  const project = context.project();
  const target = findBlock(project, args.block);
  if (target.list[0] === 'layers') throw new CommandError(`Block "${args.block}" is in a layer: only blocks of a screen carry on from one screen to another.`, [], 'E_CONTINUITY_PLACE');
  const draft = new Draft(context.files);
  const chains = continuityChains(iterateBlocks(project));
  const used = new Set(chains.keys());
  // The block of a location, in the draft (a block may be written more than once).
  const blockIn = (id: string): Block => {
    const place = findBlock(project, id);
    const screen = edited.get(place.file) ?? draft.json<Screen>(place.file);
    edited.set(place.file, screen);
    return listAt(screen, place.list)[place.index];
  };
  const edited = new Map<string, Screen>();
  const setKey = (id: string, key: string | null) => {
    const block = blockIn(id);
    if (key === null) { delete block.continuity; return; }
    block.continuity = { ...(isRecord(block.continuity) ? block.continuity : {}), key };
  };
  const fresh = (base: string): string => {
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
    used.add(key);
    return key;
  };
  let key = continuityKey(target.block);

  if (typeof args.with === 'string') {
    const other = findBlock(project, args.with);
    if (other.screenId === target.screenId) throw new CommandError(`"${args.with}" is on the same screen as "${args.block}": a block carries on from a block of another screen.`, [], 'E_CONTINUITY_DUPLICATE');
    if (other.list[0] === 'layers') throw new CommandError(`Block "${args.with}" is in a layer: only blocks of a screen carry on from one screen to another.`, [], 'E_CONTINUITY_PLACE');
    if (continuityKind(other.block) !== continuityKind(target.block)) throw new CommandError(`"${args.with}" (${continuityKind(other.block)}) and "${args.block}" (${continuityKind(target.block)}) are not the same kind of block.`, [], 'E_CONTINUITY_MISMATCH');
    const shared = continuityKey(other.block) ?? key ?? fresh(other.block.id);
    // The chain it makes still has one block per screen.
    const merged = new Map<string, string>();
    for (const link of [...(chains.get(shared) ?? []), ...(key ? chains.get(key) ?? [] : [])]) merged.set(link.block.id, link.screen.id);
    merged.set(other.block.id, other.screenId);
    merged.set(target.block.id, target.screenId);
    const byScreen = new Map<string, string>();
    for (const [id, screen] of merged) {
      const already = byScreen.get(screen);
      if (already) throw new CommandError(`"${already}" and "${id}" would both carry on as "${shared}" on the screen "${screen}": a key names one block per screen.`, [], 'E_CONTINUITY_DUPLICATE');
      byScreen.set(screen, id);
    }
    // This block's chain joins the other one's.
    if (key && key !== shared) for (const link of chains.get(key) ?? []) setKey(link.block.id, shared);
    setKey(other.block.id, shared);
    setKey(target.block.id, shared);
    key = shared;
  } else if (args.with === null && key) {
    // The chain is cut before this block: the blocks before it keep the key, this one and those after
    // it take a new one; a key left on one block goes.
    const links = chains.get(key) ?? [];
    const at = links.findIndex((link) => link.block.id === target.block.id);
    const before = links.slice(0, Math.max(0, at));
    const after = links.slice(Math.max(0, at));
    if (before.length) {
      const next = after.length > 1 ? fresh(target.block.id) : null;
      for (const link of after) setKey(link.block.id, next);
      if (before.length === 1) setKey(before[0].block.id, null);
      key = next;
    }
  }

  if (args.duration !== undefined && key) {
    const block = blockIn(target.block.id);
    const continuity = { ...(isRecord(block.continuity) ? block.continuity : { key }) };
    if (args.duration === null) delete continuity.duration;
    else {
      if (!Number.isInteger(args.duration) || args.duration < 0 || args.duration > 3000) throw new CommandError('duration is a whole number of milliseconds from 0 to 3000.');
      continuity.duration = args.duration;
    }
    block.continuity = continuity as Block['continuity'];
  }
  for (const [file, screen] of edited) draft.writeJson(file, screen);
  return { files: draft.files(), result: { key } };
}
