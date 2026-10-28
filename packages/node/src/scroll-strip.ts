import type { Page } from 'playwright-core';
import type { ShotFrame } from './capture.ts';

// Down a page: where the window goes for a scroll position, and a filmstrip of the window at several
// (elabora screenshot --scroll, elabora look --scroll and --sheet). In the player and in the canvas
// the window scrolls.

// px from the top ("1800" or 1800), a percentage of the scrollable length ("40%"), or a block's id:
// the block in view, centred when it fits between the bars, else its top under the top bar.
export type ScrollPosition = string | number;

export interface ScrollStop {
  top: number;
  label: string;
}

// The positions resolved against the page as it is, clamped to its scrollable length.
export async function scrollStops(page: Page, positions: readonly ScrollPosition[]): Promise<ScrollStop[]> {
  const found = await page.evaluate((wanted) => {
    const end = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const stops: { top: number; label: string }[] = [];
    for (const position of wanted) {
      const text = String(position).trim();
      let px: number;
      let named = '';
      if (/^\d+(\.\d+)?%$/.test(text)) px = end * (parseFloat(text) / 100);
      else if (/^\d+(\.\d+)?$/.test(text)) px = Number(text);
      else {
        const node = document.querySelector<HTMLElement>(`.t-block[data-block="${CSS.escape(text)}"]`);
        if (!node) {
          const ids = [...document.querySelectorAll<HTMLElement>('#t-main .t-block[data-block]')].map((block) => block.dataset.block);
          return { error: `Scroll position "${text}": give px, a percentage of the page ("40%") or the id of a block of the screen (${ids.join(', ')}).` };
        }
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const above = parseFloat(style.scrollMarginTop) || 0;
        const room = innerHeight - above - (parseFloat(style.scrollMarginBottom) || 0);
        px = box.top + scrollY - above - (box.height <= room ? (room - box.height) / 2 : 0);
        named = `${text}: `;
      }
      const top = Math.round(Math.min(end, Math.max(0, px)));
      stops.push({ top, label: `${named}${top} px${end ? ` (${Math.round((top / end) * 100)} %)` : ''}` });
    }
    return { stops };
  }, positions.map(String));
  if ('error' in found) throw new Error(found.error);
  return found.stops;
}

// The window at top, once scroll-driven animations follow (they move on the next frames); returns
// where it stands.
export function scrollWindow(page: Page, top: number): Promise<number> {
  return page.evaluate((y) => new Promise<number>((resolve) => {
    scrollTo({ top: y, behavior: 'instant' });
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(scrollY))));
  }), top);
}

// One capture per stop: the window by default. settleMs: the time objects that follow the scroll
// take to hear where they are and draw.
export async function scrollFilmstrip(page: Page, stops: readonly ScrollStop[], { settleMs, capture }: { settleMs: number; capture?: () => Promise<Buffer> }): Promise<ShotFrame[]> {
  const frames: ShotFrame[] = [];
  for (const stop of stops) {
    await scrollWindow(page, stop.top);
    if (settleMs) await page.waitForTimeout(settleMs);
    frames.push({ ms: 0, png: capture ? await capture() : await page.screenshot({ fullPage: false }), label: stop.label });
  }
  return frames;
}
