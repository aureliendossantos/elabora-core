// Starter interactions of D63 that show items: a steps block (« Étapes », not the screen's steps) and an
// interactive picture (« Image interactive »). What their schemas cannot say: unique item ids (and the
// carousel's intro and summary kept apart), pictures named, a scroll figure that has what it follows,
// how many items one form shows well, markers that overlap on a phone, and a scroll in slides.

import { getFile } from '../project/files.ts';
import type { Block, Project } from '../project/model.ts';
import type { CourseCheckContext } from './context.ts';
import { list, fieldsOf, text } from './guards.ts';

// Item counts past which one form of a block shows its items badly (D63): a carousel's steps (its intro
// and summary aside), an interactive picture's markers. (Other blocks' limits are theirs.)
export const ITEMS_MANY = { carousel: 7, markers: 8 } as const;
// A marker is 44 px wide; on a phone of 375 px the picture is about 337 px wide (the page's margins).
export const MARKER_SIZE = 44;
export const PHONE_PICTURE_WIDTH = 337;

interface Where { block: Block; path: string; file: string }

function uniqueIds(ctx: CourseCheckContext, { block, path, file }: Where, items: Record<string, unknown>[], what: string, reserved: readonly string[] = []): void {
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    const id = item.id;
    if (typeof id !== 'string') return;
    if (reserved.includes(id)) ctx.reporter.emit('E_BLOCK_ITEM_DUPLICATE', { file, path: `${path}/props/items/${index}/id`, target: block.id, message: `${what} "${block.id}": step ${index + 1} is "${id}", the id of the carousel's ${id}: rename the step.` });
    else if (seen.has(id)) ctx.reporter.emit('E_BLOCK_ITEM_DUPLICATE', { file, path: `${path}/props/items/${index}/id`, target: block.id, message: `${what} "${block.id}": items ${seen.get(id)! + 1} and ${index + 1} are both "${id}".` });
    else seen.set(id, index);
  });
}

export function checkSteps(ctx: CourseCheckContext, where: Where): void {
  const { reporter } = ctx;
  const { block, path, file } = where;
  const props = fieldsOf(block.props);
  const id = block.id;
  const presentation = typeof props.presentation === 'string' ? props.presentation : 'carousel';
  const items = list(props.items).map(fieldsOf);
  const at = (sub: string) => `${path}/props/${sub}`;
  const ends = presentation === 'carousel' ? (['intro', 'summary'] as const).filter((end) => props[end]) : [];
  uniqueIds(ctx, where, items, 'Steps block', ends);
  items.forEach((item, i) => {
    if (item.image && !item.decorative && !text(item.alt).trim()) reporter.emit('E_IMAGE_ALT_MISSING', { file, path: at(`items/${i}/alt`), target: id, message: `The picture of step "${String(item.id)}" of steps block "${id}" has no alt text and is not marked decorative.` });
  });
  if (presentation === 'carousel' && items.length > ITEMS_MANY.carousel) reporter.emit('W_ITEMS_MANY', { file, path: at('items'), target: id, measured: items.length, limit: ITEMS_MANY.carousel, message: `Steps block "${id}" shows ${items.length} steps one at a time (more than ${ITEMS_MANY.carousel}, its intro and summary aside).` });
  if (presentation !== 'scroll') return;
  const figure = typeof props.figure === 'string' ? props.figure : 'replace';
  if (props.figureImage && !text(props.figureAlt).trim()) reporter.emit('E_IMAGE_ALT_MISSING', { file, path: at('figureAlt'), target: id, message: `The figure of steps block "${id}" (figureImage) has no alt text (figureAlt).` });
  if (figure === 'focus' && !props.figureImage) reporter.emit('E_STEPS_FIGURE', { file, path: at('figureImage'), target: id, message: `Steps block "${id}" follows its steps with figure focus but has no figureImage to outline them on.` });
  else if (figure === 'focus' && !items.some((item) => item.region)) reporter.emit('E_STEPS_FIGURE', { file, path: at('items'), target: id, message: `Steps block "${id}" follows its steps with figure focus but no step has a region of figureImage.` });
  else if (figure !== 'focus' && !items.some((item) => item.image)) reporter.emit('E_STEPS_FIGURE', { file, path: at('items'), target: id, message: `Steps block "${id}" follows its steps with figure ${figure} but no step has an image.` });
  if (ctx.course.presentation?.mode === 'slides') reporter.emit('W_STEPS_SCROLL_SLIDES', { file, path: at('presentation'), target: id, message: `Steps block "${id}" is a scroll (« Défilé ») in a course in slides: its steps show one under the other, each with its picture.` });
}

// The proportions of a picture (width ÷ height), when the project knows them: an SVG's viewBox or
// size, a raster picture's probe. null otherwise.
export function pictureRatio(project: Project, asset: unknown): number | null {
  if (typeof asset !== 'string') return null;
  const file = getFile(project.files, `assets/${asset}`);
  if (!file) return null;
  if (file.kind === 'binary') return file.media?.width && file.media.height ? file.media.width / file.media.height : null;
  const root = /<svg\b[^>]*>/i.exec(file.text)?.[0] ?? '';
  const box = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(root);
  if (box && Number(box[1]) > 0 && Number(box[2]) > 0) return Number(box[1]) / Number(box[2]);
  const width = /\bwidth\s*=\s*["']([\d.]+)(px)?["']/i.exec(root);
  const height = /\bheight\s*=\s*["']([\d.]+)(px)?["']/i.exec(root);
  return width && height && Number(height[1]) > 0 ? Number(width[1]) / Number(height[1]) : null;
}

export function checkHotspots(ctx: CourseCheckContext, where: Where): void {
  const { reporter } = ctx;
  const { block, path, file } = where;
  const props = fieldsOf(block.props);
  const id = block.id;
  const at = (sub: string) => `${path}/props/${sub}`;
  const items = list(props.items).map(fieldsOf);
  uniqueIds(ctx, where, items, 'Interactive picture');
  if (props.image && !props.decorative && !text(props.alt).trim()) reporter.emit('E_IMAGE_ALT_MISSING', { file, path: at('alt'), target: id, message: `The picture of interactive picture "${id}" has no alt text and is not marked decorative.` });
  if (props.generated) reporter.emit('I_GENERATED_MEDIA', { file, path, target: id, message: `Interactive picture "${id}" shows an AI-generated picture.` });
  if (items.length > ITEMS_MANY.markers) reporter.emit('W_ITEMS_MANY', { file, path: at('items'), target: id, measured: items.length, limit: ITEMS_MANY.markers, message: `Interactive picture "${id}" has ${items.length} markers (more than ${ITEMS_MANY.markers}).` });
  // Markers that overlap on a phone: centres closer than a marker's width, on the picture as a phone
  // shows it (half as large again with a focal point). Without the picture's proportions, 4:3.
  const known = pictureRatio(ctx.project, props.image);
  const width = PHONE_PICTURE_WIDTH * (props.focus ? 1.5 : 1);
  const height = width / (known ?? 4 / 3);
  const placed = items.map((item, index) => ({ index, x: Number(item.x), y: Number(item.y) })).filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
  const close: string[] = [];
  for (let a = 0; a < placed.length; a++) {
    for (let b = a + 1; b < placed.length; b++) {
      const distance = Math.hypot((placed[a].x - placed[b].x) * width, (placed[a].y - placed[b].y) * height);
      if (distance < MARKER_SIZE) close.push(`${placed[a].index + 1} and ${placed[b].index + 1} (${Math.round(distance)} px)`);
    }
  }
  if (close.length) reporter.emit('W_HOTSPOTS_CLOSE', { file, path: at('items'), target: id, measured: close.length, message: `Interactive picture "${id}": on a phone 375 px wide, markers ${close.slice(0, 4).join(', ')}${close.length > 4 ? '…' : ''} are closer than their ${MARKER_SIZE} px and overlap${known === null ? ' (the picture taken as 4:3)' : ''}.` });
}
