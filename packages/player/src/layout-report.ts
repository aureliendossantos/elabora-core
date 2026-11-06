// Where the blocks of the page are, and a wheel passed on by a host that lays something over the
// page: shared by the editor canvas (canvas.ts, the app's selection) and the review bridge (review.ts,
// the review page's pins and its comment mode).

import type { BlockLayout, LayoutRect, TermLayout, TextLayout } from './canvas-protocol.ts';

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

// What a block placed by hand (D72) lies over: the blocks of the screen whose lines of text it covers
// (drawn under it: the flow, or a placed block lower in the stack), and 'title' for the screen's title.
// Lines, not boxes: a short line leaves the rest of its paragraph's box free.
export function coveredTexts(node: HTMLElement): string[] {
  const main = node.closest('#t-main');
  if (!main) return [];
  const box = node.getBoundingClientRect();
  const z = (element: Element) => Number(getComputedStyle(element).zIndex) || 0;
  const meets = (rect: DOMRect) => Math.min(rect.right, box.right) - Math.max(rect.left, box.left) > 4 && Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top) > 4;
  const lines = (root: Element) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent?.trim() || node.contains(text)) continue;
      const parent = text.parentElement;
      if (!parent || getComputedStyle(parent).visibility === 'hidden' || parent.closest('[aria-hidden="true"], .t-sr-only')) continue;
      range.selectNodeContents(text);
      for (const rect of range.getClientRects()) if (meets(rect)) return true;
    }
    return false;
  };
  const out: string[] = [];
  const title = [...main.querySelectorAll<HTMLElement>('article.t-screen h1')].find((heading) => !heading.closest('.t-block'));
  if (title && title.getClientRects().length && lines(title)) out.push('title');
  for (const other of main.querySelectorAll<HTMLElement>('.t-block[data-block]')) {
    if (other === node || other.contains(node) || node.contains(other) || other.parentElement?.closest('.t-block[data-block]') || !other.getClientRects().length) continue;
    if (other.hasAttribute('data-t-place') && z(other) >= z(node)) continue;
    if (other.closest('[data-t-pending], [data-t-concealed], [data-t-timed]')) continue;
    if (lines(other)) out.push(other.dataset.block ?? '');
  }
  return out;
}

// The texts of the screen and of the open layers outside their blocks, in the order of the page: the
// title of the screen (or of a layer), the texts and pictures of its layout. Their place among the
// blocks is the first block after them.
export function textLayouts(): TextLayout[] {
  const texts: TextLayout[] = [];
  const blocks = [...document.querySelectorAll<HTMLElement>('#t-main .t-block[data-block], dialog.t-layer[open] .t-block[data-block]')];
  const nodes = document.querySelectorAll<HTMLElement>([
    '#t-main > article.t-screen h1', '#t-main > article.t-screen :is([data-t-field], [data-t-duration], img)',
    'dialog.t-layer[open] > .t-dialog-title'
  ].join(', '));
  for (const node of nodes) {
    // Within a block, within another text, or not drawn (display: none) and so not read either.
    if (node.closest('.t-block[data-block]') || node.parentElement?.closest('[data-t-field], [data-t-duration]') || !node.getClientRects().length) continue;
    const image = node instanceof HTMLImageElement;
    const kind: TextLayout['kind'] = node.matches('h1, .t-dialog-title') ? 'title' : image ? 'image' : 'field';
    if (kind === 'field' && node.closest('[data-t-duration]') && !node.textContent?.trim()) continue;
    // A text said with a player label before it (« Partie » before a part's number) is read with it.
    const label = !image && node.previousElementSibling?.matches('[data-t-label]') ? `${node.previousElementSibling.textContent ?? ''} ` : '';
    const text = (image ? node.getAttribute('alt') ?? '' : label + (node.textContent ?? '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    const before = blocks.find((block) => node.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING && !node.contains(block));
    texts.push({
      kind, path: kind === 'field' ? node.dataset.tField ?? 'duration' : null, text, rect: rectOf(node),
      layer: node.closest<HTMLElement>('dialog.t-layer')?.dataset.layer ?? null,
      read: !node.closest('[aria-hidden="true"]') && text !== '',
      before: before?.dataset.block ?? null
    });
  }
  return texts;
}

// The words linked to the glossary that are drawn, in the screen and its open layers, in the order of
// the page.
export function termLayouts(): TermLayout[] {
  const terms: TermLayout[] = [];
  for (const node of document.querySelectorAll<HTMLElement>('#t-main a.t-term[data-term], dialog.t-layer[open] a.t-term[data-term]')) {
    const block = node.closest<HTMLElement>('.t-block[data-block]')?.dataset.block;
    const rects = [...node.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => ({ x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }));
    if (!block || !rects.length || node.closest('[data-t-pending], [data-t-concealed], [data-t-timed]')) continue;
    terms.push({ term: node.dataset.term ?? '', block, words: (node.textContent ?? '').replace(/\s+/g, ' ').trim(), rects });
  }
  return terms;
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
