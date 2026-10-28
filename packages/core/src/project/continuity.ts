// Continuity between screens (docs/decisions.md D65): blocks of different screens that share a key
// are one thing to the learner. The player carries the block on from one of those screens to another
// (a free object keeps running, another block glides); a free object's saved state is the chain's.

import type { Block } from './model.ts';
import type { BlockLocation } from './load.ts';
import { isRecord } from '../util/values.ts';

// How long the passage to a block lasts when it does not say (ms).
export const CONTINUITY_DURATION = 700;

// The lock entity of a chain's saved state (a free object's).
export const continuityEntity = (key: string): string => `continuity:${key}`;

// The key a block carries on with, or null.
export function continuityKey(block: Pick<Block, 'continuity'>): string | null {
  const continuity: unknown = block.continuity;
  return isRecord(continuity) && typeof continuity.key === 'string' && continuity.key ? continuity.key : null;
}

// Blocks that share a key are of one kind: the same type, and free objects the same object.
export function continuityKind(block: Pick<Block, 'type' | 'props'>): string {
  return block.type === 'free-object' && isRecord(block.props) ? `free-object ${String(block.props.object)}` : block.type;
}

export function continuityDuration(block: Pick<Block, 'continuity'>): number {
  const duration: unknown = isRecord(block.continuity) ? block.continuity.duration : undefined;
  return typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, Math.min(3000, Math.round(duration))) : CONTINUITY_DURATION;
}

// Every key of the course and the blocks that carry it, in course order (with their screen, file,
// layer and path): the blocks are iterateBlocks(project)'s (the module itself stays light, for the
// desktop app's inspector).
export function continuityChains(blocks: Iterable<BlockLocation>): Map<string, BlockLocation[]> {
  const chains = new Map<string, BlockLocation[]>();
  for (const location of blocks) {
    const key = continuityKey(location.block);
    if (!key) continue;
    const links = chains.get(key) ?? [];
    links.push(location);
    chains.set(key, links);
  }
  return chains;
}
