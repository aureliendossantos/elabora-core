// The room of answers (slides) and of what shows one thing at a time, for the screen view
// (screen-view.ts). In slides, answering must not move the slide: every activity reserves from the
// start the height of its tallest outcome (feedback, flags, messages), measured on hidden copies at
// the same width, and grows inside that room. A template whose feedback floats over its content opts
// out with data-t-reserve="off". Blocks concealed by events keep their place the same way (CSS).

import { behaviorOf } from './course-state.ts';
import type { CourseState } from './course-state.ts';
import type { Behaviors } from './behaviors.ts';
import type { Behavior, BlockData, QuizBlock } from './course-data.ts';

export const ROOM_BEHAVIORS = new Set<Behavior | null>(['quiz', 'numeric', 'fill-in', 'sort', 'reflection', 'decision', 'results', 'predict']);

export interface RoomsContext {
  main: HTMLElement;
  courseState: CourseState;
  behaviors: Behaviors;
  slides(): boolean;
  // Undone when the block leaves the page.
  cleanup(blockId: string, undo: () => void): void;
}

export type Rooms = ReturnType<typeof createRooms>;

export function createRooms({ main, courseState, behaviors, slides, cleanup }: RoomsContext) {
  const roomQueue: [HTMLElement, BlockData][] = [];
  // The reserved rooms of the screen, measured again by ready() (fit checks and captures measure the
  // final room, whatever was still loading when the screen was shown).
  const roomFits = new Set<() => void>();
  const blockOf = (node: HTMLElement) => courseState.blockIndex.get(node.dataset.block ?? '')?.block;
  // What shows one thing at a time (a sequence, D63) reserves the room of its tallest item, in every
  // presentation and in layers too: moving through it never moves what is around it. (A flip card
  // needs no measure: its faces share one cell, player.css.)
  const itemRoomQueue: [HTMLElement, BlockData][] = [];

  // A block just rendered: its rooms are measured once it is in the page (flush).
  function queue(wrap: HTMLElement, block: BlockData) {
    if (ROOM_BEHAVIORS.has(behaviorOf(block))) roomQueue.push([wrap, block]);
    if (behaviors.rooms(wrap).length) itemRoomQueue.push([wrap, block]);
  }
  // Rooms are measured once the blocks are in the page.
  function flush() {
    for (const [wrap, block] of roomQueue.splice(0)) reserveRoom(wrap, block);
    for (const [wrap, block] of itemRoomQueue.splice(0)) reserveItemRooms(wrap, block);
  }
  function reserveItemRooms(wrap: HTMLElement, block: BlockData) {
    for (const { host, measure } of behaviors.rooms(wrap)) {
      // Measured again when the width changes, and when the content may have (images and fonts
      // loading): at a given width the room only grows.
      let width = 0;
      let room = 0;
      const fit = (force = false) => {
        if (!host.isConnected) return;
        const measuredWidth = Math.round(cssPx(host, host.getBoundingClientRect().width));
        if (!measuredWidth || (!force && measuredWidth === width)) return;
        if (measuredWidth !== width) room = 0;
        width = measuredWidth;
        room = Math.max(room, cssPx(host, measure()));
        host.style.minHeight = `${Math.ceil(room)}px`;
      };
      fit();
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
      observer?.observe(host);
      const refit = () => fit(true);
      host.addEventListener('load', refit, true); // images of the items (load does not bubble)
      document.fonts?.ready.then(refit);
      document.fonts?.addEventListener?.('loadingdone', refit);
      const later = setTimeout(refit, 700);
      roomFits.add(refit);
      cleanup(block.id, () => { observer?.disconnect(); document.fonts?.removeEventListener?.('loadingdone', refit); clearTimeout(later); roomFits.delete(refit); });
    }
  }
  // compact: measured as if the quiz's feedback were compact (feedbackRooms).
  function outcomeRooms(wrap: HTMLElement, block: BlockData, compact = false) {
    const width = cssPx(wrap, wrap.getBoundingClientRect().width);
    const ghost = () => {
      const copy = wrap.cloneNode(true) as HTMLElement;
      for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
      // A copy in the same radio group would uncheck the learner's choice when it enters the page.
      for (const node of copy.querySelectorAll('input[name]')) node.removeAttribute('name');
      copy.setAttribute('aria-hidden', 'true');
      copy.inert = true;
      Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: '0', top: '0', width: `${width}px`, minHeight: '0' });
      wrap.parentElement!.append(copy); // same containers: container queries resolve as for the block
      return copy;
    };
    const measure = (index: number | null) => {
      const copy = ghost();
      const outcomes = behaviors.outcomes(copy, block);
      if (compact) for (const node of [copy, ...copy.querySelectorAll('[data-t-group]')]) node.setAttribute('data-t-feedback-style', 'compact');
      if (index !== null) outcomes[index]?.();
      const height = cssPx(copy, copy.getBoundingClientRect().height);
      copy.remove();
      return { height, count: outcomes.length };
    };
    const first = measure(null);
    const rooms = [first.height];
    for (let index = 0; index < first.count; index++) rooms.push(measure(index).height);
    return rooms; // [as it is now, outcome 0, outcome 1, …]
  }
  function reserveRoom(wrap: HTMLElement, block: BlockData) {
    if (!slides() || wrap.querySelector('[data-t-reserve="off"]')) return;
    // Measured again when the width changes and when the content does (images and fonts loading,
    // an answer): the room only grows at a given width, so answering never makes it shrink either.
    let width = 0;
    let content = -1;
    let room = 0;
    const fit = (force = false) => {
      if (!wrap.isConnected) return;
      const measuredWidth = Math.round(cssPx(wrap, wrap.getBoundingClientRect().width));
      const measuredContent = Math.round(cssPx(wrap, [...wrap.children].reduce((height, node) => height + node.getBoundingClientRect().height, 0)));
      if (!measuredWidth || (!force && measuredWidth === width && measuredContent === content)) return;
      if (measuredWidth !== width) room = 0;
      width = measuredWidth;
      content = measuredContent;
      room = Math.max(room, ...outcomeRooms(wrap, block));
      wrap.style.minHeight = `${Math.ceil(room)}px`;
    };
    fit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    if (observer) for (const node of [wrap, ...wrap.children]) observer.observe(node);
    wrap.addEventListener('load', () => fit(), true); // images inside the activity (load does not bubble)
    // Text only the outcomes show (feedback) may wait for a font or a fallback glyph that the activity
    // as shown does not need: measured again once fonts are loaded, and once more shortly after.
    const refit = () => fit(true);
    document.fonts?.ready.then(refit);
    document.fonts?.addEventListener?.('loadingdone', refit);
    const later = setTimeout(refit, 700);
    roomFits.add(refit);
    cleanup(block.id, () => { observer?.disconnect(); document.fonts?.removeEventListener?.('loadingdone', refit); clearTimeout(later); roomFits.delete(refit); });
  }
  // Renders the tallest outcome of every activity among nodes, and the tallest item of what shows one
  // thing at a time: the slide as it looks once everything is answered (fit, screenshots, the canvas).
  // Returns the blocks changed.
  function showTallest(nodes: Iterable<HTMLElement>): string[] {
    const changed: string[] = [];
    for (const node of nodes) {
      const block = blockOf(node);
      // A sequence shows its tallest item (D63): the room it reserves, filled.
      if (block && behaviors.rooms(node).length) { behaviors.showTallest(node); changed.push(block.id); }
      if (!block || !ROOM_BEHAVIORS.has(behaviorOf(block))) continue;
      const rooms = outcomeRooms(node, block).slice(1);
      if (!rooms.length) continue;
      const index = rooms.indexOf(Math.max(...rooms));
      behaviors.outcomes(node, block)[index]();
      changed.push(block.id);
    }
    return changed;
  }
  // The room the quizzes among nodes with full feedback reserve for their tallest outcome, and the
  // room they would reserve with compact feedback (fit says what feedbackStyle "compact" saves).
  function feedbackRooms(nodes: Iterable<HTMLElement> = main.querySelectorAll<HTMLElement>('.t-block[data-block]')) {
    const rooms: { block: string; full: number; compact: number }[] = [];
    for (const node of nodes) {
      const block = blockOf(node);
      if (!block || behaviorOf(block) !== 'quiz' || (block as QuizBlock).props.feedbackStyle === 'compact') continue;
      const full = Math.max(0, ...outcomeRooms(node, block).slice(1));
      const compact = Math.max(0, ...outcomeRooms(node, block, true).slice(1));
      rooms.push({ block: block.id, full: Math.ceil(full), compact: Math.ceil(compact) });
    }
    return rooms;
  }

  return {
    queue, flush, outcomeRooms, showTallest, feedbackRooms,
    // A layer scrolls inside: its activities need no reserved room (what is queued now, or what is
    // queued inside layers).
    skipActivities() { roomQueue.length = 0; },
    skipInLayers() { roomQueue.splice(0, roomQueue.length, ...roomQueue.filter(([wrap]) => !wrap.closest('dialog'))); },
    // Every reserved room measured again (ready()).
    refit() { for (const fit of roomFits) fit(); }
  };
}

// Boxes in the CSS px of the block: under the learner's text size (a CSS zoom on #t-main,
// « Affichage »), getBoundingClientRect gives zoomed px, which written back as CSS px would be
// zoomed again.
export const cssPx = (node: HTMLElement, px: number) => px / ((node as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1);
