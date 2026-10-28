// Continuity between screens (docs/decisions.md D65): blocks of different screens that share a key
// are one thing to the learner, so they are the same kind of block, once per screen, on the screens
// themselves.

import type { CourseCheckContext } from './context.ts';
import { continuityChains, continuityKind } from '../project/continuity.ts';
import { iterateBlocks } from '../project/load.ts';

export function checkContinuity(ctx: CourseCheckContext): void {
  for (const [key, links] of continuityChains(iterateBlocks(ctx.project))) {
    const screens = new Map<string, string>();
    const first = links[0];
    const firstKind = continuityKind(first.block);
    for (const { screen, file, layer, block, path } of links) {
      const at = { file, path: `${path}/continuity/key`, target: block.id };
      if (layer) { ctx.reporter.emit('E_CONTINUITY_PLACE', { ...at, message: `"${block.id}" is in the layer "${layer.id}": a block of a layer does not carry on to another screen (continuity "${key}").` }); continue; }
      if (block.type === 'free-object' && block.timing) { ctx.reporter.emit('E_CONTINUITY_PLACE', { ...at, path: `${path}/timing`, message: `"${block.id}" carries on as "${key}" and has a timing: a free object that carries on stays on the screen from one screen to the next.` }); continue; }
      const other = screens.get(screen.id);
      if (other) ctx.reporter.emit('E_CONTINUITY_DUPLICATE', { ...at, message: `"${other}" and "${block.id}" both carry the continuity key "${key}" on the screen "${screen.id}".` });
      else screens.set(screen.id, block.id);
      const blockKind = continuityKind(block);
      if (block !== first.block && blockKind !== firstKind) ctx.reporter.emit('E_CONTINUITY_MISMATCH', { ...at, message: `"${block.id}" (${blockKind}) shares the continuity key "${key}" with "${first.block.id}" (${firstKind}).` });
    }
    if (screens.size === 1 && links.length === 1) ctx.reporter.emit('W_CONTINUITY_ALONE', { file: first.file, path: `${first.path}/continuity/key`, target: first.block.id, message: `No block of another screen has the continuity key "${key}": "${first.block.id}" has nothing to carry on to.` });
  }
}
