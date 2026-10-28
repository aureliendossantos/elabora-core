// The free objects of the screen view (screen-view.ts): a block's frame, its host (object-host.ts),
// its size, safe area and view, and what its declared events do (interactions, completion, saved
// state, the screen's events).
//
// A block with a continuity key (docs/decisions.md D65) has its frame in the keep layer of #t-main
// (.t-keep, after the screen), placed over the block's own frame: when the learner goes to another
// screen whose block has the same key, the frame never leaves the page, so the object keeps running.
// The arriving block adopts it: its events, words, title, description, text version and safe area
// are the arriving block's, and the object receives its props with the hint of the passage.

import { createObjectHost } from './object-host.ts';
import type { ObjectHost } from './object-host.ts';
import type { CourseState, TriggerInfo } from './course-state.ts';
import type { Labels } from './labels.ts';
import type { Interaction } from './scorm12.ts';
import { element, uniqueId } from './dom.ts';
import { objectFrame } from './frames.ts';
import { fieldOf } from './json.ts';
import type { CourseData, ObjectBlock, ObjectDefinition, ObjectEventDeclaration, TriggerType } from './course-data.ts';
import type { ObjectTransition, ObjectView, SafeArea } from './object-protocol.ts';
import { cssPx } from './screen-rooms.ts';

export interface ObjectsContext {
  main: HTMLElement;
  course: CourseData;
  courseState: CourseState;
  labels: Labels;
  // The port free objects' frames load from (frames.ts; null: as in a package).
  framesPort: number | null;
  recordInteraction(interaction: Interaction): void;
  // The course state changed (an object's state saved): the page syncs soon.
  syncSoon(): void;
  // Runs the screen's events.
  trigger(type: TriggerType, info: TriggerInfo): void;
  // Undone when the block leaves the page.
  cleanup(blockId: string, undo: () => void): void;
}

// The host of a block's object, and whether it failed to load (shown with its text version).
export type BlockObjectHost = ObjectHost & { failed?: () => boolean };

// Frames follow the size class of the page (1rem): sent at initialize and when the window crosses one.
export const rootSize = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

// The passage of a block that carries on (D65): what the departing screen showed of it.
export interface Departure {
  screen: string;
  index: number;
  // By key: the departing block and its box in the window.
  blocks: Map<string, { block: string; box: DOMRect }>;
}

// player.css --t-ease-in-out: what moves on screen.
export const EASE_IN_OUT = 'cubic-bezier(.77, 0, .175, 1)';
// The id of a passage's glides: the canvas measures blocks again once they have landed.
export const GLIDE = 't-glide';

// One object running in the page, and the block it is shown for.
interface Running {
  host: BlockObjectHost;
  iframe: HTMLIFrameElement;
  loading: HTMLElement;
  definition: ObjectDefinition;
  block: ObjectBlock;
  failed: boolean;
  timedOut: boolean;
  // Its frame in the keep layer (a block with a continuity key), or null: in the block's frame.
  keep: HTMLElement | null;
  place: Place | null;
  // The height the object asked for (host.requestHeight), kept from block to block.
  requested: number | null;
  // The block of the departing screen it carried on from, until settle() tells it where it is now.
  adoptedFrom?: string;
  // The departing box of a passage, until its frame glides from it.
  arriving?: { box: DOMRect; duration: number };
}
// The block's figure an object is shown in.
interface Place {
  figure: HTMLElement;
  frame: HTMLElement;
  safeProbe: HTMLElement;
  error: HTMLElement;
  textAlternative: HTMLDetailsElement;
  descriptionId: string;
  safe: SafeArea | null;
  readSafe(): SafeArea;
  queueView(): void;
  view(): ObjectView | null;
  applySize(): void;
  // Timers of a frame that has not answered yet.
  arm(): void;
}

export type ScreenObjects = ReturnType<typeof createObjects>;

export function createObjects({ main, course, courseState, labels, framesPort, recordInteraction, syncSoon, trigger, cleanup }: ObjectsContext) {
  const hosts = new Map<string, BlockObjectHost>();
  const running = new Map<string, Running>();
  // Objects of the departing screen that may carry on, by continuity key (park, then adopt or end).
  const parked = new Map<string, Running>();
  const SIDES = ['top', 'right', 'bottom', 'left'] as const;
  // Frames also move without a scroll, when content above them changes size (an image decoded, a
  // disclosure opened, a step revealed): the screen's size changes, and every frame measures again.
  const viewSyncs = new Set<() => void>();
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { for (const sync of viewSyncs) sync(); placeKept(); }).observe(main);

  // ── The keep layer (D65) ──────────────────────────────────────────────
  // After the screen in #t-main, never removed while the view lives. Not a stacking context: its
  // frames are drawn above what the layout draws without a z-index, below what it places over them.
  let keepLayer: HTMLElement | null = null;
  const layer = (): HTMLElement => {
    if (!keepLayer) keepLayer = element('div', { class: 't-keep' });
    if (keepLayer.parentElement !== main) main.append(keepLayer);
    return keepLayer;
  };
  // The look of the block's frame (its background, border, corners, shadow) goes to the kept frame;
  // the block's frame keeps the size and becomes see-through (.t-object-frame--kept).
  const LOOK = ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius', 'boxShadow'] as const;
  function lendLook(place: Place, keep: HTMLElement) {
    place.frame.classList.remove('t-object-frame--kept');
    const style = getComputedStyle(place.frame);
    for (const name of LOOK) keep.style[name] = style[name];
    place.frame.classList.add('t-object-frame--kept');
  }
  // The block's ancestors up to the screen let clicks through to the kept frame (.t-keep-path);
  // their other children keep their own behaviour (player.css).
  function markPath(place: Place, on: boolean) {
    const article = place.frame.closest('article.t-screen');
    for (let node: HTMLElement | null = place.frame; node && node !== main; node = node.parentElement) {
      node.classList.toggle('t-keep-path', on);
      if (node === article) break;
    }
  }
  // A box of the window in the keep layer's own px (#t-main may be zoomed by the learner's text size).
  function inLayer(box: DOMRect) {
    const origin = layer().getBoundingClientRect();
    const zoom = cssPx(layer(), 1);
    return { left: (box.left - origin.left) * zoom, top: (box.top - origin.top) * zoom, width: box.width * zoom, height: box.height * zoom };
  }
  const px = (box: { left: number; top: number; width: number; height: number }) => ({ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  // Every kept frame over its block's frame, hidden while the block is (a pending step, an event, its
  // timing), at most once a frame.
  let placing = 0;
  function placeKept() {
    if (placing || !keepLayer) return;
    placing = requestAnimationFrame(() => { placing = 0; placeKeptNow(); });
  }
  function placeKeptNow() {
    for (const entry of running.values()) {
      const keep = entry.keep;
      const place = entry.place;
      if (!keep || !place) continue;
      const block = place.figure.closest<HTMLElement>('.t-block[data-block]');
      const shown = place.frame.isConnected && place.frame.getClientRects().length > 0 && !block?.closest('[inert]');
      keep.style.visibility = shown ? '' : 'hidden';
      keep.inert = !shown;
      if (!shown) continue;
      Object.assign(keep.style, px(inLayer(place.frame.getBoundingClientRect())));
    }
  }

  // ── A block's figure ──────────────────────────────────────────────────
  function render(block: ObjectBlock) {
    const props = block.props;
    const definition = course.objects[props.object];
    const key = block.continuity?.key ?? null;
    // The departing screen's object with the same key carries on in this block (another block: the
    // same block shown again starts over).
    const carried = key ? parked.get(key) : undefined;
    const adopted = carried && carried.block.id !== block.id && carried.definition.id === definition.id ? carried : null;
    if (key && carried) parked.delete(key);
    if (carried && !adopted) endRunning(carried);
    if (adopted) adopted.adoptedFrom = adopted.block.id;
    const descriptionId = uniqueId('desc');
    const error = element('p', { class: 't-object-error', role: 'alert', hidden: true, text: labels.objectError });
    // Safe area: the layout declares, with --t-safe-top/right/bottom/left, the part of the frame its
    // own content covers (a title floating over a stage); a hidden probe resolves it to px for the object.
    const safeProbe = element('div', { class: 't-object-safe', 'aria-hidden': 'true' });
    const frame = element('div', { class: 't-object-frame' }, safeProbe);
    const textAlternative = element('details', { class: 't-text-alt' }, element('summary', { text: labels.textVersion }), element('div', { class: 't-text', html: props.textAlternativeHtml }));
    const figure = element('figure', { class: 't-object' }, frame, element('p', { id: descriptionId, class: 't-sr-only', text: props.a11y?.description || definition.a11y?.description || '' }), error, textAlternative);
    const entry: Running = adopted ?? newRunning(block, definition, descriptionId, key !== null);
    entry.block = block;
    entry.iframe.title = props.title;
    entry.iframe.setAttribute('aria-describedby', descriptionId);
    if (entry.keep) {
      // Read in the block's place by screen readers.
      frame.setAttribute('aria-owns', entry.iframe.id);
      entry.keep.dataset.block = block.id;
    } else frame.prepend(entry.iframe, entry.loading);
    // Size: aspect ratio on wide containers, narrowAspectRatio under 640 px; auto = height requested
    // by the object (host.requestHeight), fill = height of the layout slot; min/max clamp.
    const clampHeight = (height: number) => Math.max(props.minHeight || 120, Math.min(props.maxHeight || 4000, Math.round(height)));
    const place: Place = {
      figure, frame, safeProbe, error, textAlternative, descriptionId, safe: null,
      readSafe: () => {
        const style = getComputedStyle(safeProbe);
        return { top: Math.round(parseFloat(style.paddingTop) || 0), right: Math.round(parseFloat(style.paddingRight) || 0), bottom: Math.round(parseFloat(style.paddingBottom) || 0), left: Math.round(parseFloat(style.paddingLeft) || 0) };
      },
      applySize: () => {
        const width = frame.clientWidth || figure.clientWidth;
        const ratio = (width > 0 && width < 640 && props.narrowAspectRatio) || props.aspectRatio || '16:9';
        frame.dataset.ratio = ratio;
        frame.style.aspectRatio = /^\d+:\d+$/.test(ratio) ? ratio.replace(':', ' / ') : 'auto';
        frame.style.height = ratio === 'auto' ? `${clampHeight(entry.requested ?? props.minHeight ?? 420)}px` : ratio === 'fill' ? '100%' : '';
        frame.style.minHeight = props.minHeight ? `${props.minHeight}px` : ratio === 'fill' ? '320px' : '';
        frame.style.maxHeight = props.maxHeight ? `${props.maxHeight}px` : '';
      },
      queueView: () => {},
      view: () => { if (!frame.isConnected) return null; const now = viewOf(frame); lastView = JSON.stringify(now); return now; },
      arm: () => {}
    };
    const syncSafe = () => {
      if (!safeProbe.isConnected) return;
      const next = place.readSafe();
      const previous = place.safe;
      if (previous && SIDES.every((side) => next[side] === previous[side])) return;
      place.safe = next;
      entry.host.setSafeArea(next);
    };
    place.applySize();
    // Where the frame is in the window: sent when it changes (scroll, resize, a step revealed), at
    // most once a frame. Scroll events of inner scrollers reach the window in the capture phase.
    let lastView = '';
    let viewFrame = 0;
    const syncView = () => {
      viewFrame = 0;
      if (!frame.isConnected || !entry.host.ready) return;
      const next = viewOf(frame);
      const json = JSON.stringify(next);
      if (json === lastView) return;
      lastView = json;
      entry.host.setView(next);
    };
    place.queueView = () => { if (!viewFrame) viewFrame = requestAnimationFrame(syncView); };
    window.addEventListener('scroll', place.queueView, { passive: true, capture: true });
    // A kept frame follows its block when a container of it scrolls.
    if (entry.keep) window.addEventListener('scroll', placeKept, { passive: true, capture: true });
    window.addEventListener('resize', place.queueView);
    viewSyncs.add(place.queueView);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { place.applySize(); syncSafe(); place.queueView(); placeKept(); }) : null;
    observer?.observe(figure);
    if (entry.keep) observer?.observe(frame);
    // Without a GPU, an object may take seconds to start: after a moment, say it is loading.
    let loadingTimer = 0;
    let loadTimer = 0;
    place.arm = () => {
      if (entry.host.ready || entry.failed) return;
      loadingTimer = setTimeout(() => { if (!entry.host.ready && !entry.failed) { entry.loading.hidden = false; figure.setAttribute('aria-busy', 'true'); } }, 400) as unknown as number;
      loadTimer = setTimeout(() => { if (!entry.host.ready) { entry.timedOut = true; fail(entry, 'no answer from the object frame after 15 s'); } }, 15000) as unknown as number;
    };
    cleanup(block.id, () => {
      observer?.disconnect(); clearTimeout(loadTimer); clearTimeout(loadingTimer);
      window.removeEventListener('scroll', place.queueView, { capture: true }); window.removeEventListener('resize', place.queueView); viewSyncs.delete(place.queueView); cancelAnimationFrame(viewFrame);
      window.removeEventListener('scroll', placeKept, { capture: true });
      if (entry.keep) markPath(place, false);
      if (entry.place === place) entry.place = null;
    });
    entry.place = place;
    if (entry.failed) { error.hidden = false; textAlternative.open = true; }
    place.arm();
    hosts.set(block.id, entry.host);
    running.set(block.id, entry);
    return figure;
  }

  // A new object: its frame (in the keep layer for a block with a continuity key) and its host.
  function newRunning(block: ObjectBlock, definition: ObjectDefinition, descriptionId: string, kept: boolean): Running {
    const props = block.props;
    const iframe = element('iframe', {
      id: uniqueId('object'), title: props.title, ...objectFrame(definition.dir, definition.permissions || [], framesPort, document.baseURI),
      allow: '', referrerpolicy: 'no-referrer', 'aria-describedby': descriptionId, loading: 'eager'
    });
    const loading = element('div', { class: 't-object-loading', role: 'status', hidden: true }, element('span', { class: 't-object-spinner', 'aria-hidden': 'true' }), element('span', { text: labels.objectLoading }));
    const keep = kept ? element('div', { class: 't-keep-frame', 'data-key': block.continuity?.key }, iframe, loading) : null;
    // The keep layer takes the frame before the host listens to it: the frame loads once.
    if (keep) layer().append(keep);
    const entry = { iframe, loading, definition, block, failed: false, timedOut: false, keep, place: null, requested: null } as unknown as Running;
    const place = () => entry.place;
    entry.host = createObjectHost({
      iframe, def: definition, props: props.props, strings: props.strings || {}, tokens: course.tokens, locale: course.language, fonts: course.fonts || [], rootSize: rootSize(),
      safeArea: () => { const shown = place(); const safe = shown?.safeProbe.isConnected ? shown.readSafe() : { top: 0, right: 0, bottom: 0, left: 0 }; if (shown) shown.safe = safe; return safe; },
      view: () => place()?.view() ?? null,
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false,
      savedState: courseState.objectSavedState(block.id), seed: 1,
      onEvent: (name, payload, declaration) => onObjectEvent(entry.block, entry.definition, entry.host, name, payload, declaration),
      // Before the object answers, an error means it could not load: the text version opens. Once it
      // runs, errors are logged; the text version stays one click away.
      onError: (message) => (entry.host.ready ? console.warn(`[elabora] free object ${definition.id}: ${message}`) : fail(entry, message)),
      // An object slower than the timeout (a GPU-less machine) recovers when it finally answers.
      onReady: () => {
        stopLoading(entry);
        place()?.queueView();
        if (entry.timedOut) { entry.timedOut = false; entry.failed = false; const shown = place(); if (shown) { shown.error.hidden = true; shown.textAlternative.open = false; } }
      },
      onResize: (height) => { entry.requested = height; place()?.applySize(); },
      onLog: (message) => console.info(`[elabora] free object ${definition.id}:`, message.message)
    });
    entry.host.failed = () => entry.failed;
    return entry;
  }
  function stopLoading(entry: Running) { entry.loading.hidden = true; entry.place?.figure.removeAttribute('aria-busy'); }
  function fail(entry: Running, message: string) {
    entry.failed = true;
    stopLoading(entry);
    const shown = entry.place;
    if (shown) { shown.error.hidden = false; shown.textAlternative.open = true; }
    if (message) console.warn(`[elabora] free object ${entry.definition.id}: ${message}`);
  }
  function endRunning(entry: Running) {
    entry.host.dispose();
    entry.keep?.remove();
  }

  function onObjectEvent(block: ObjectBlock, definition: ObjectDefinition, host: ObjectHost, name: string, payload: unknown, declaration: ObjectEventDeclaration) {
    const tracking = declaration.tracking || {};
    const interaction = tracking.interaction;
    if (interaction) {
      const response = interaction.responseField ? fieldOf(payload, interaction.responseField) : name;
      const correct = interaction.correctField ? fieldOf(payload, interaction.correctField) : undefined;
      const single = typeof response === 'string' && /^[0-9a-z]$/.test(response);
      const type = interaction.type === 'choice' && !single ? 'performance' : interaction.type;
      recordInteraction({
        id: `${block.id}-${name}`.replace(/[^A-Za-z0-9_.-]/g, '-'), type, objective: interaction.objective, weight: block.props.weight || 1,
        response: typeof response === 'string' ? response : JSON.stringify(response), result: correct === undefined ? 'neutral' : correct ? 'correct' : 'wrong'
      });
    }
    if (tracking.completion) courseState.completeObject(block.id, tracking.score ? fieldOf(payload, tracking.score.field) : undefined);
    if (definition.persistMax) host.getState().then((state) => { courseState.saveObjectState(block.id, state, definition.persistMax); syncSoon(); }, () => {});
    trigger('object.event', { target: block.id, name, payload });
  }

  // ── Carrying on (D65) ─────────────────────────────────────────────────
  // The departing screen's objects with a continuity key wait for the arriving screen (render adopts
  // them); the others stop.
  function park() {
    for (const [id, entry] of running) {
      const key = entry.block.continuity?.key;
      // (Two blocks of one screen with a key, E_CONTINUITY_DUPLICATE: the first carries on.)
      if (key && entry.keep && !parked.has(key)) parked.set(key, entry); else endRunning(entry);
      running.delete(id);
    }
    hosts.clear();
  }
  // Once the arriving screen is in the page: the objects it did not adopt stop; the ones it adopted
  // glide from their departing box to their block's and receive the arriving block's props, with the
  // hint of the passage (duration 0 under less motion, or when the departing block was not shown).
  function settle(arrival: { screen: string; index: number }, departure: Departure | null, reducedMotion: boolean) {
    for (const entry of parked.values()) endRunning(entry);
    parked.clear();
    for (const entry of running.values()) {
      const place = entry.place;
      if (!entry.keep || !place) continue;
      lendLook(place, entry.keep);
      markPath(place, true);
    }
    placeKeptNow();
    for (const entry of running.values()) {
      const previous = entry.adoptedFrom;
      entry.adoptedFrom = undefined;
      if (!previous || !entry.keep || !entry.place) continue;
      // A passage still on its way (the learner went on quickly) gives way to this one, from where it is.
      for (const animation of entry.keep.getAnimations?.() ?? []) if (animation.id === GLIDE) animation.cancel();
      const key = entry.block.continuity?.key;
      const from = key ? departure?.blocks.get(key) : undefined;
      const duration = reducedMotion || !from ? 0 : entry.block.continuity?.duration ?? 0;
      if (from && duration > 0) entry.arriving = { box: from.box, duration };
      const index = departure?.index ?? arrival.index;
      const transition: ObjectTransition = { from: { screen: departure?.screen ?? arrival.screen, block: previous }, to: { screen: arrival.screen, block: entry.block.id }, direction: arrival.index < index ? 'back' : 'forward', duration, reducedMotion };
      const safe = entry.place.readSafe();
      entry.place.safe = safe;
      entry.host.carryOn(entry.block.props.props, transition, { strings: entry.block.props.strings || {}, safeArea: safe });
    }
  }
  // The kept frames that arrived glide from their departing box to their block's (once the page is
  // where it will be shown).
  function glide() {
    placeKeptNow();
    for (const entry of running.values()) {
      const arriving = entry.arriving;
      entry.arriving = undefined;
      if (!arriving || !entry.keep || !entry.place || entry.keep.style.visibility === 'hidden' || !entry.keep.animate) continue;
      const start = inLayer(arriving.box);
      const target = inLayer(entry.place.frame.getBoundingClientRect());
      const moves = Math.max(Math.abs(start.left - target.left), Math.abs(start.top - target.top), Math.abs(start.width - target.width), Math.abs(start.height - target.height)) > 0.5;
      if (moves) entry.keep.animate([px(start), px(target)], { id: GLIDE, duration: arriving.duration, easing: EASE_IN_OUT });
    }
  }
  // The boxes of the kept frames of the screen shown, by key (the departure of a passage).
  function keptBoxes(): Map<string, { block: string; box: DOMRect }> {
    const boxes = new Map<string, { block: string; box: DOMRect }>();
    for (const entry of running.values()) {
      const key = entry.block.continuity?.key;
      if (key && entry.keep && entry.keep.style.visibility !== 'hidden') boxes.set(key, { block: entry.block.id, box: entry.keep.getBoundingClientRect() });
    }
    return boxes;
  }

  return {
    hosts, render, park, settle, glide, keptBoxes,
    // Kept frames follow their blocks (a step revealed, a block shown or hidden).
    place: placeKept,
    // A block's object stops.
    dispose(blockId: string) {
      const entry = running.get(blockId);
      if (entry) { running.delete(blockId); endRunning(entry); }
      hosts.delete(blockId);
    },
    disposeAll() {
      for (const entry of [...running.values(), ...parked.values()]) endRunning(entry);
      running.clear();
      parked.clear();
      hosts.clear();
    },
    // Everything this view put in the page goes (the canvas mounts a course again).
    destroy() { keepLayer?.remove(); keepLayer = null; cancelAnimationFrame(placing); placing = 0; }
  };
}

// A block that carries on and is not a free object (D65) glides from where its counterpart was: its
// box from the departing one's (translate and scale from its top left corner, in its own px), the
// departing block gone at once.
export function glideFrom(node: HTMLElement, from: DOMRect, duration: number) {
  const to = node.getBoundingClientRect();
  if (!to.width || !to.height || !node.animate) return;
  const zoom = cssPx(node, 1);
  const dx = (from.left - to.left) * zoom;
  const dy = (from.top - to.top) * zoom;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return;
  node.animate([
    { transformOrigin: '0 0', translate: `${dx}px ${dy}px`, scale: `${sx} ${sy}` },
    { transformOrigin: '0 0', translate: '0 0', scale: '1 1' }
  ], { id: GLIDE, duration, easing: EASE_IN_OUT });
}

// Where a frame is in the window, for objects that follow the scroll: the CSS view() timeline of
// its box (object-protocol.ts, ObjectView). Rounded so that a still page sends nothing.
function viewOf(node: HTMLElement): ObjectView {
  const box = node.getBoundingClientRect();
  const windowHeight = window.innerHeight || document.documentElement.clientHeight || 1;
  const height = Math.max(1, box.height);
  const contained = Math.min(height, windowHeight);
  const share = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return {
    visible: box.height > 0 && box.bottom > 0 && box.top < windowHeight,
    ratio: share((Math.min(box.bottom, windowHeight) - Math.max(box.top, 0)) / height),
    progress: share((windowHeight - box.top) / (windowHeight + height)),
    entry: share((windowHeight - box.top) / contained),
    exit: share((contained - box.bottom) / contained)
  };
}
