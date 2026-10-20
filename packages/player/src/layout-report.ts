// Where the blocks of the page are, and a wheel passed on by a host that lays something over the
// page: shared by the editor canvas (canvas.ts, the app's selection) and the review bridge (review.ts,
// the review page's pins and its comment mode).

import type { BlockLayout, LayoutRect } from './canvas-protocol.ts';

export const round = (value: number): number => Math.round(value * 100) / 100;
export const rectOf = (node: Element): LayoutRect => { const box = node.getBoundingClientRect(); return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }; };

// The blocks of the screen and of the open layers, in the order of the page (the reading order), in
// CSS px of the viewport. timedOf: a timed block's state at the time shown (the canvas has it).
export function blockLayouts(timedOf: (id: string) => Pick<BlockLayout, 'timed'> = () => ({})): BlockLayout[] {
  const blocks: BlockLayout[] = [];
  for (const node of document.querySelectorAll<HTMLElement>('#t-main .t-block[data-block], dialog.t-layer[open] .t-block[data-block]')) {
    const holder = node.parentElement?.closest<HTMLElement>('[data-slot], .t-block[data-block], article, dialog');
    const fields = [...node.querySelectorAll<HTMLElement>('[data-t-field]')]
      .filter((field) => field.closest('.t-block[data-block]') === node)
      .map((field) => ({ path: field.dataset.tField ?? '', rect: rectOf(field) }));
    blocks.push({
      id: node.dataset.block ?? '', rect: rectOf(node),
      slot: holder?.matches('[data-slot]') ? holder.dataset.slot ?? null : null,
      layer: node.closest<HTMLElement>('dialog.t-layer')?.dataset.layer ?? null,
      parent: node.parentElement?.closest<HTMLElement>('.t-block[data-block]')?.dataset.block ?? null,
      hidden: !!node.closest('[data-t-pending], [data-t-concealed], [data-t-timed]'),
      ...timedOf(node.dataset.block ?? ''),
      ...(fields.length ? { fields } : {})
    });
  }
  return blocks;
}

// What a wheel at that point would scroll: the nearest box under it that can still go that way,
// else the page. At once: a trackpad sends many small distances, smooth scrolling would lag them.
export function scrollFrom(by: { x: number; y: number }, at?: { x: number; y: number }): void {
  for (let node = at ? document.elementFromPoint(at.x, at.y) : null; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (canScroll(node, by)) { node.scrollBy({ left: by.x, top: by.y, behavior: 'instant' }); return; }
  }
  scrollBy({ left: by.x, top: by.y, behavior: 'instant' });
}
function canScroll(node: Element, by: { x: number; y: number }): boolean {
  const style = getComputedStyle(node);
  const along = (delta: number, overflow: string, position: number, room: number) => delta !== 0 && /auto|scroll/.test(overflow) && (delta > 0 ? position < room - 1 : position > 0);
  return along(by.y, style.overflowY, node.scrollTop, node.scrollHeight - node.clientHeight) || along(by.x, style.overflowX, node.scrollLeft, node.scrollWidth - node.clientWidth);
}
