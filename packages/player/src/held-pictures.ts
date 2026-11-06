// The lazy pictures of a scroll page, loaded as the learner comes to them. Chrome loads a lazy
// picture when it is within 1 250 px of the window on a 4G network, and up to 8 000 px on a slow one or
// on a network it does not know yet (5 000 px: a learner's first visit): a long page then loads every
// picture at once. The page holds the address of each lazy picture and gives it back when the picture
// comes within a window and a half of the view (above or below), or when something needs every
// picture (ready(): previews, screenshots, fit checks). Its room is kept meanwhile: the build writes
// each picture's width and height (core/render/image-sizes.ts).
//
// Slides keep the browser's own lazy loading: a slide is in the window, and the next screen's pictures
// load ahead (preload.ts).

const NEAR = '150% 0px 150% 0px';

export function holdPictures(root: HTMLElement): { releaseAll(): void; dispose(): void } {
  const held = [...root.querySelectorAll<HTMLImageElement>('img[loading="lazy"][src]')].filter((image) => !image.closest('picture'));
  if (!held.length || typeof IntersectionObserver !== 'function') return { releaseAll() {}, dispose() {} };
  const release = (image: HTMLImageElement) => {
    observer.unobserve(image);
    const src = image.getAttribute('data-t-src');
    if (src === null) return;
    image.removeAttribute('data-t-src');
    image.setAttribute('src', src);
  };
  const seen = (entries: IntersectionObserverEntry[]) => { for (const entry of entries) if (entry.isIntersecting) release(entry.target as HTMLImageElement); };
  // A browser without a document root (before Safari 14.1) observes the top window.
  let observer: IntersectionObserver;
  try { observer = new IntersectionObserver(seen, { root: document, rootMargin: NEAR }); } catch { observer = new IntersectionObserver(seen, { rootMargin: NEAR }); }
  for (const image of held) {
    image.setAttribute('data-t-src', image.getAttribute('src')!);
    image.removeAttribute('src');
    observer.observe(image);
  }
  return {
    releaseAll() { for (const image of held) release(image); },
    dispose() { observer.disconnect(); }
  };
}
