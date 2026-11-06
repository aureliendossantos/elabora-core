// Blocks placed by hand (docs/decisions.md D72): a block of the screen itself, inside the frame. What
// they cover at each window, and whether they still fit there, is measured in a browser (elabora fit:
// W_PLACED_OVERLAP, W_PLACED_OVERFLOW, W_PLACED_TARGET).

import type { CourseCheckContext, ScreenFile } from './context.ts';
import { screenBlocks } from '../project/load.ts';

export function checkScreenPlacement(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { reporter } = ctx;
  const slides = ctx.course.presentation?.mode === 'slides';
  const placed: string[] = [];
  for (const { block, path, layer, parent } of screenBlocks(screen.data, screen.file)) {
    const place = block.place;
    if (!place) continue;
    const at = { file: screen.file, path: `${path}/place`, target: block.id };
    if (layer || parent) {
      reporter.emit('E_PLACED_NESTED', { ...at, message: `"${block.id}" is ${layer ? `in the layer "${layer.id}"` : `in a slot of "${parent?.id}"`}: only blocks of the screen itself are placed by hand.` });
      continue;
    }
    placed.push(block.id);
    const right = place.x + place.width;
    const bottom = place.y + (place.height ?? 0);
    const outside = place.x < -0.001 || right > 1.001 || (slides && (place.y < -0.001 || bottom > 1.001));
    if (outside) {
      const edges = [place.x < -0.001 && 'left', right > 1.001 && 'right', slides && place.y < -0.001 && 'top', slides && bottom > 1.001 && 'bottom'].filter(Boolean).join(', ');
      reporter.emit('W_PLACED_OUTSIDE', { ...at, message: `"${block.id}" goes past the ${edges} of the frame (x ${place.x}, width ${place.width}${slides ? `, y ${place.y}${place.height !== undefined ? `, height ${place.height}` : ''}` : ''}): ${slides ? 'the slide keeps it inside, out of the place it was given' : 'its part past the edge leaves the page'}.` });
    }
  }
  if (placed.length) reporter.emit('I_BLOCK_PLACED', { file: screen.file, target: screen.id, message: `Screen "${screen.id}": ${placed.length} block${placed.length > 1 ? 's' : ''} placed by hand (${placed.join(', ')}). A layout of the course would hold them where they are at every window.` });
}
