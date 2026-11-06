import type { ScreenData } from './course-data.ts';

// The pictures of the next screen, loaded ahead once the screen shown has its own (its pictures in the
// window loaded, then a quiet moment): the next screen then shows whole at once, without a blank or a
// shift. Its narration loads at that moment too (player.ts), so that it starts at once. In slides every picture of the next screen loads; in a scroll page, only its first ones, and
// only when the learner nears the end of the page (the others load as the learner comes to them, by
// the browser's lazy loading). Each picture is decoded and held until the screen after it is the next
// one, so the browser keeps it ready.

const SETTLE_TIMEOUT = 8000; // ms: a picture of the screen shown that never arrives does not hold the next one back
const SCROLL_FIRST = 2; // pictures of the next page loaded near the end of a scroll page

// An attribute's value as the page reads it (its character references decoded).
function decoded(value: string): string {
  const area = document.createElement('textarea');
  area.innerHTML = value;
  return area.value;
}

export function picturesOf(screen: ScreenData): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (!value.includes('<img')) return;
      for (const match of value.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/g)) found.add(match[1].includes('&') ? decoded(match[1]) : match[1]);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
  };
  walk(screen);
  return [...found].filter((src) => !src.startsWith('data:'));
}

export function createPreloader({ main, slides }: { main: () => HTMLElement; slides: () => boolean }) {
  let held = new Map<string, HTMLImageElement>();
  let generation = 0;
  let stopScroll: (() => void) | null = null;

  function load(sources: string[]) {
    const next = new Map<string, HTMLImageElement>();
    for (const src of sources) {
      const url = new URL(src, document.baseURI).href;
      let image = held.get(url);
      if (!image) {
        image = new Image();
        image.decoding = 'async';
        image.src = url;
        image.decode?.().catch(() => {});
      }
      next.set(url, image);
    }
    held = next;
  }

  // The pictures of the screen shown that are in the window, loaded (or failed), or the timeout.
  function settled(): Promise<void> {
    const pending = [...main().querySelectorAll<HTMLImageElement>('img')].filter((image) => {
      if (image.complete) return false;
      const box = image.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
    });
    const loaded = pending.map((image) => new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    }));
    return Promise.race([Promise.all(loaded).then(() => {}), new Promise<void>((resolve) => setTimeout(resolve, SETTLE_TIMEOUT))]);
  }

  const quiet = () => new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 200);
  });

  // Called each time a screen shows, with the one after it (undefined on the last screen); ahead()
  // loads what else the next screen needs (its narration), at the same moment.
  function shown(next: ScreenData | undefined, ahead?: () => void) {
    const mine = ++generation;
    stopScroll?.();
    stopScroll = null;
    if (!next) { held = new Map(); return; }
    const sources = picturesOf(next);
    requestAnimationFrame(() => {
      settled().then(quiet).then(() => {
        if (mine !== generation) return;
        ahead?.();
        if (!sources.length) return;
        if (slides()) { load(sources); return; }
        const near = () => window.scrollY + window.innerHeight * 2 >= document.documentElement.scrollHeight;
        if (near()) { load(sources.slice(0, SCROLL_FIRST)); return; }
        const onScroll = () => { if (near()) { stopScroll?.(); stopScroll = null; load(sources.slice(0, SCROLL_FIRST)); } };
        window.addEventListener('scroll', onScroll, { passive: true });
        stopScroll = () => window.removeEventListener('scroll', onScroll);
      });
    });
  }

  return { shown };
}
