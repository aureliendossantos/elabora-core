// What of a page a block's preview shows (« Ajouter un bloc », D130): pure, for the live miniatures (canvas-thumbs.ts) and the painter's page
// (canvas-picture.ts) alike.

import type { LayoutRect } from './canvas-protocol.ts';

// « Ajouter un bloc » (Lin 34), as the desktop's capture frames it: the block with a narrow margin around it, at the window's
// proportions, centred on it (its top when even the whole window is shorter), as large as it can be read; a small block keeps some of
// what surrounds it (`PREVIEW_LEAST` of the window's width). `mini`: the block alone, a very long block its start (three times as wide
// as it is tall at most); null when it is too small to show, and the preview is shown instead.
const PREVIEW_MARGIN = 0.035;
const PREVIEW_LEAST = 0.42;
const within = (start: number, size: number, room: number): number => Math.round(Math.max(0, Math.min(start, room - size)));
export function blockPreviewFrame(block: LayoutRect, page: { width: number; height: number }): LayoutRect {
  const ratio = page.height / page.width;
  const margin = page.width * PREVIEW_MARGIN;
  const width = Math.round(Math.min(page.width, Math.max(page.width * PREVIEW_LEAST, block.width + margin * 2, (block.height + margin * 2) / ratio)));
  const height = Math.round(width * ratio);
  const top = block.height + margin * 2 <= height ? block.y + block.height / 2 - height / 2 : block.y - margin;
  return { x: within(block.x + block.width / 2 - width / 2, width, page.width), y: within(top, height, page.height), width, height };
}
export function blockMiniFrame(block: LayoutRect, page: { width: number; height: number }): LayoutRect | null {
  const x = Math.max(0, Math.round(block.x));
  const y = Math.max(0, Math.round(block.y));
  const height = Math.min(Math.round(block.height), page.height - y);
  const width = Math.min(Math.round(block.width), page.width - x, height * 3);
  return width > 4 && height > 4 ? { x, y, width, height } : null;
}
