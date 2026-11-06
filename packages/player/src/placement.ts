// Blocks placed by hand (docs/decisions.md D72). A placed block keeps its place in the DOM (its anchor:
// its slot and its rank, so the reading order and the focus order), and the player lifts it out of the
// flow into the placement frame:
//   - the frame is the reference window (presentation.fit.reference, 1600×900 by default) at the width
//     of #t-main, at most the reference width in rem (100rem at 1600 px: beyond, it is centred);
//   - in slides, the frame is centred in the slide; y is measured from its top, and a block that would
//     leave the slide (a slide shorter than the frame, its bars taking room) is kept inside it;
//   - in scroll presentation, y is measured from the block's anchor, the place it holds in the page (the
//     top of the next block of its list in the flow), so that it moves with the text before it.
// Below presentation.fit.minimum, on phones (and portrait tablets) and when the learner enlarges the
// text (« Affichage »), placed blocks read in the flow at their anchor. The editor's canvas places them
// at any width but a phone's (page option placing=editor).
//
// Positions are set as custom properties in px of the block's containing block (--t-place-left, -top,
// -width, -height; player.css), measured from the boxes of the page: every read first, then every
// write. A block the editor lifts (its drag) is placed the same way at a box of the viewport.

import type { BlockData, CourseData, PlaceData, ScreenData } from './course-data.ts';

export interface PlacementRect { x: number; y: number; width: number; height: number }

// A slot's places in the flow (the editor's drag): before its first block shown in the flow, then after
// each, where a block placed there would start (y, in px of the viewport).
export interface FlowAnchors {
  slot: string | null;
  rect: PlacementRect;
  // after: the block of the list the place follows (null: the start of the list).
  places: { after: string | null; y: number }[];
}

export interface Placement {
  // The blocks of the screen shown and where they are placed (the screen's own list only).
  sync(screen: ScreenData | undefined): void;
  // Measures and places again (after a render, a step, a resize, fonts).
  layout(): void;
  // Whether placed blocks are lifted out of the flow at this window.
  readonly active: boolean;
  // The frame in px of the viewport, while active.
  frame(): PlacementRect | null;
  // Where a placed block's anchor is (its place in the flow), in px of the viewport.
  anchorOf(id: string): { x: number; y: number; width: number } | null;
  // The places of the flow, slot by slot (without the blocks placed or lifted).
  anchors(): FlowAnchors[];
  // The editor's drag: the block shown at that box of the viewport, out of the flow (null: back where
  // its data puts it). A preview of a place in the frame (shares) works the same way.
  lift(id: string, at: PlacementRect | { place: PlaceData } | null): void;
  lifted(): string[];
  dispose(): void;
}

const size = (text: string | undefined, fallback: readonly [number, number]): [number, number] => {
  const match = /^(\d+)x(\d+)$/.exec(text ?? '');
  return match ? [Number(match[1]), Number(match[2])] : [fallback[0], fallback[1]];
};

export function createPlacement({ app, main, course, editor = false, changed }: {
  app: HTMLElement; main: HTMLElement; course: CourseData;
  // The editor's canvas: placed at any width but a phone's.
  editor?: boolean;
  // Something moved (the canvas reports the layout again).
  changed?(): void;
}): Placement {
  const [refWidth, refHeight] = size(course.presentation?.fit?.reference, [1600, 900]);
  const [minWidth] = size(course.presentation?.fit?.minimum, [1280, 720]);
  const slides = () => app.dataset.presentation === 'slides';
  let places = new Map<string, PlaceData>();
  const lifts = new Map<string, PlacementRect | { place: PlaceData }>();
  let on = false;
  let frameBox: PlacementRect | null = null;

  function allowed(): boolean {
    if (app.dataset.textSize) return false;
    const width = innerWidth;
    if (editor) return width > 760;
    if (typeof matchMedia === 'function' && matchMedia('(orientation: portrait) and (max-width: 1100px)').matches) return false;
    return width >= minWidth;
  }

  const nodeOf = (id: string) => main.querySelector<HTMLElement>(`.t-block[data-block="${CSS.escape(id)}"]`);
  // A block of the screen itself: not in a component's slots, nor in a layer.
  const own = (node: HTMLElement) => !node.parentElement?.closest('.t-block[data-block]') && !node.closest('dialog');

  function sync(screen: ScreenData | undefined) {
    places = new Map((screen?.blocks ?? []).filter((block): block is BlockData & { place: PlaceData } => !!block.place).map((block) => [block.id, block.place]));
    for (const node of main.querySelectorAll<HTMLElement>('.t-block[data-t-place]')) if (!places.has(node.dataset.block ?? '')) unmark(node);
    for (const id of [...lifts.keys()]) if (!nodeOf(id)) lifts.delete(id);
    layout();
  }
  function unmark(node: HTMLElement) {
    node.removeAttribute('data-t-place');
    node.removeAttribute('data-t-lifted');
    node.removeAttribute('data-t-place-height');
    for (const name of ['--t-place-left', '--t-place-top', '--t-place-width', '--t-place-height', '--t-place-z']) node.style.removeProperty(name);
  }

  // Where an element is in the document, from its offsets: what moves it for a moment (a step fading
  // in, the editor's glide) is left out, so that a block is placed where things come to rest.
  function docBox(node: HTMLElement): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (let at: HTMLElement | null = node; at; at = at.offsetParent as HTMLElement | null) { x += at.offsetLeft + (at !== node ? at.clientLeft : 0); y += at.offsetTop + (at !== node ? at.clientTop : 0); }
    return { x, y };
  }
  // A node in the flow, drawn (not placed, not lifted, not display: none).
  const inFlow = (node: Element): node is HTMLElement => node instanceof HTMLElement && !node.hasAttribute('data-t-place') && !node.hasAttribute('data-t-lifted') && node.getClientRects().length > 0 && getComputedStyle(node).position !== 'absolute';
  const rowGap = (container: HTMLElement) => { const gap = parseFloat(getComputedStyle(container).rowGap); return Number.isFinite(gap) ? gap : 0; };
  // Where a block at this place in the container would start: the next block in the flow, else after
  // the one before it, else the container's content top.
  // In the document's px.
  function anchorY(container: HTMLElement, node: Element | null): number {
    const children = [...container.children];
    const index = node ? children.indexOf(node) : -1;
    const next = children.slice(index + 1).find(inFlow);
    if (next) return docBox(next).y - parseFloat(getComputedStyle(next).marginTop || '0');
    const previous = children.slice(0, Math.max(0, index)).reverse().find(inFlow);
    if (previous) return docBox(previous).y + previous.offsetHeight + parseFloat(getComputedStyle(previous).marginBottom || '0') + rowGap(container);
    return docBox(container).y + container.clientTop + parseFloat(getComputedStyle(container).paddingTop || '0');
  }

  function layout() {
    const nodes = [...main.querySelectorAll<HTMLElement>('.t-block[data-block]')].filter((node) => (places.has(node.dataset.block ?? '') || lifts.has(node.dataset.block ?? '')) && own(node));
    on = allowed();
    const placing = on && nodes.some((node) => places.has(node.dataset.block ?? ''));
    app.toggleAttribute('data-t-placing', placing);
    frameBox = null;
    // Slots that hold only placed blocks: the layout's CSS may fold them ([data-t-placed-only]).
    for (const slot of main.querySelectorAll<HTMLElement>('.t-slot')) {
      const blocks = [...slot.children].filter((child) => child.matches('.t-block[data-block]'));
      slot.toggleAttribute('data-t-placed-only', placing && blocks.length > 0 && blocks.every((child) => places.has((child as HTMLElement).dataset.block ?? '')));
    }
    // In the document's px; the frame is reported in the viewport's.
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const at = docBox(main);
    const area = { left: at.x + main.clientLeft, top: at.y + main.clientTop };
    const width = Math.min(main.clientWidth, (refWidth / 16) * rem);
    const height = (width * refHeight) / refWidth;
    const left = area.left + (main.clientWidth - width) / 2;
    const top = area.top + (slides() ? (main.clientHeight - height) / 2 : 0);
    frameBox = { x: left - scrollX, y: top - scrollY, width, height };
    // Marks first (the flow closes around them), then every read, then every write.
    const shown: { node: HTMLElement; place: PlaceData | null; at: PlacementRect | null }[] = [];
    for (const node of nodes) {
      const id = node.dataset.block ?? '';
      const lift = lifts.get(id);
      const place = lift && 'place' in lift ? lift.place : lift ? null : places.get(id) ?? null;
      const at = lift && !('place' in lift) ? lift : null;
      if (!at && (!place || !placing && !lift)) { unmark(node); continue; }
      node.setAttribute('data-t-place', '');
      node.toggleAttribute('data-t-lifted', !!lift);
      shown.push({ node, place, at });
    }
    if (!shown.length) { changed?.(); return; }
    // Widths first: a block's height follows its width.
    for (const { node, place, at } of shown) {
      const blockWidth = at ? at.width : (place?.width ?? 0) * width;
      node.style.setProperty('--t-place-width', `${round(blockWidth)}px`);
      node.toggleAttribute('data-t-place-height', !!place?.height && !at);
      if (place?.height && !at) node.style.setProperty('--t-place-height', `${round(place.height * height)}px`); else node.style.removeProperty('--t-place-height');
      resized?.observe(node);
      node.style.setProperty('--t-place-z', String(at ? 900 : place?.z ?? 0));
    }
    // Its containing block: the positioned ancestor it is placed in (#t-main, or a layout's).
    const measured = shown.flatMap((entry) => {
      const container = entry.node.offsetParent as HTMLElement | null;
      if (!container) return [];
      const box = docBox(container);
      const origin = { x: box.x + container.clientLeft - container.scrollLeft, y: box.y + container.clientTop - container.scrollTop };
      const anchor = slides() || entry.at ? 0 : anchorY(entry.node.parentElement as HTMLElement, entry.node);
      return [{ ...entry, origin, anchor, blockHeight: entry.node.offsetHeight }];
    });
    for (const { node, place, at: lifted, origin, anchor, blockHeight } of measured) {
      let x = lifted ? lifted.x + scrollX : left + (place?.x ?? 0) * width;
      let y = lifted ? lifted.y + scrollY : slides() ? top + (place?.y ?? 0) * height : anchor + (place?.y ?? 0) * height;
      // A slide keeps its placed blocks inside it (a slide shorter than the frame: its bars).
      if (slides() && !lifted) {
        const roomTop = area.top;
        const roomBottom = roomTop + main.clientHeight;
        y = Math.max(roomTop, Math.min(y, roomBottom - blockHeight));
        x = Math.max(area.left, Math.min(x, area.left + main.clientWidth - (place?.width ?? 0) * width));
      }
      node.style.setProperty('--t-place-left', `${round(x - origin.x)}px`);
      node.style.setProperty('--t-place-top', `${round(y - origin.y)}px`);
    }
    changed?.();
  }

  const round = (value: number) => Math.round(value * 100) / 100;

  function anchors(): FlowAnchors[] {
    const containers = [
      ...main.querySelectorAll<HTMLElement>(':scope > article.t-screen > .t-blocks'),
      ...[...main.querySelectorAll<HTMLElement>(':scope > article.t-screen .t-slot')].filter((slot) => !slot.parentElement?.closest('.t-block[data-block]'))
    ];
    return containers.filter((container) => container.getClientRects().length > 0).map((container) => {
      const blocks = [...container.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches('.t-block[data-block]'));
      const flow = blocks.filter(inFlow);
      const box = container.getBoundingClientRect();
      const places: FlowAnchors['places'] = [{ after: null, y: anchorY(container, null) }];
      for (const block of flow) places.push({ after: block.dataset.block ?? null, y: anchorY(container, block) });
      return { slot: container.matches('.t-slot') ? container.dataset.slot ?? null : null, rect: { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }, places: places.map((place) => ({ ...place, y: round(place.y - scrollY) })) };
    });
  }

  function anchorOf(id: string) {
    const node = nodeOf(id);
    if (!node || !node.hasAttribute('data-t-place') || !node.parentElement) return null;
    const container = node.parentElement;
    const box = container.getBoundingClientRect();
    return { x: round(box.x), y: round(anchorY(container, node) - scrollY), width: round(box.width) };
  }

  // Again when the window or what holds the screen changes size, and when the fonts arrive.
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (places.size || lifts.size) layout(); }) : null;
  resized?.observe(main);
  const watchArticle = new MutationObserver(() => {
    const article = main.querySelector(':scope > article.t-screen');
    if (article) resized?.observe(article);
  });
  watchArticle.observe(main, { childList: true });
  const textSize = new MutationObserver(() => { if (places.size) layout(); });
  textSize.observe(app, { attributes: true, attributeFilter: ['data-text-size'] });
  const scrolled = () => { if (lifts.size) layout(); };
  // A step that fades in or a theme's entrance: placed again where they rest.
  const settled = (event: Event) => { if (places.size && event.target instanceof Element && main.contains(event.target)) layout(); };
  for (const type of ['transitionend', 'animationend']) main.addEventListener(type, settled);
  addEventListener('scroll', scrolled, { passive: true });
  void document.fonts?.ready.then(() => { if (places.size) layout(); });

  return {
    sync, layout,
    get active() { return on; },
    frame: () => (on ? frameBox : null),
    anchorOf, anchors,
    lift(id, at) {
      if (at) lifts.set(id, at); else lifts.delete(id);
      const node = nodeOf(id);
      if (!at && node && !places.has(id)) unmark(node);
      layout();
    },
    lifted: () => [...lifts.keys()],
    dispose() {
      resized?.disconnect();
      watchArticle.disconnect();
      textSize.disconnect();
      removeEventListener('scroll', scrolled);
    }
  };
}
