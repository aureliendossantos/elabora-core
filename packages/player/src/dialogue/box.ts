// A dialogue's thread in its box (D61): where a new row goes and how the thread follows it, the pages
// of a scene, the History over the scene, and the box's size in slides. Not part of the pure walk.
//
// In slides the box keeps its size, filling the room the slide leaves; its thread is anchored at the
// bottom and scrolled by the learner, and follows its last bubble until the learner scrolls up it
// (« Nouveau message » brings them back). In scroll pages the page follows a new bubble only when the
// learner was at the bottom of the dialogue. A scene shows two or three bubbles near its characters,
// then the page turns.

import { element } from '../dom.ts';
import { icon } from '../icons.ts';
import { closeButton, fitLines } from './thread.ts';
import { clamp, cssPx, phone, PHONE } from './view-parts.ts';
import type { Step, ViewParts } from './view-parts.ts';
import type { DialogueModal } from './modal.ts';

export type ThreadBox = ReturnType<typeof createThreadBox>;

export function createThreadBox(parts: ViewParts, { modal, reserveRoom, disposed }: {
  modal: DialogueModal;
  // The room under the thread takes the height of its tallest set of options (room.ts).
  reserveRoom(scene: boolean): void;
  disposed(): boolean;
}) {
  const { data, wrap, root, log, room, stage, measureLog, labels, still, clock } = parts;
  const reduced = parts.reduced;

  const newMessage = element('button', { type: 'button', class: 't-dialogue-new', hidden: true, onclick: () => { scrollLog(true); newMessage.hidden = true; } }, icon('chevronDown'), element('span', { text: labels.dialogueNewMessage }));
  log.after(newMessage);
  // The thread follows its last bubble until the learner scrolls up it; back at the bottom, it follows again.
  let following = true;
  const scrolledByLearner = () => { following = pinned(); if (following) newMessage.hidden = true; };
  log.addEventListener('wheel', () => requestAnimationFrame(scrolledByLearner), { passive: true });
  log.addEventListener('touchmove', () => requestAnimationFrame(scrolledByLearner), { passive: true });
  log.addEventListener('keydown', (event) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) requestAnimationFrame(scrolledByLearner); });
  log.addEventListener('scroll', () => { if (pinned()) { following = true; newMessage.hidden = true; } }, { passive: true });

  // ── « Historique » (style scene, wide): the whole thread over the scene, as messaging, in a panel ──
  const historyButton = data.style === 'scene' ? element('button', { type: 'button', class: 't-dialogue-history-btn', 'aria-expanded': 'false', 'aria-controls': log.id, onclick: () => setHistory(true) }, icon('history'), element('span', { text: labels.dialogueHistory })) : null;
  const historyClose = historyButton ? closeButton(parts.thread, () => setHistory(false)) : null;
  if (historyButton && historyClose) {
    stage!.before(historyButton);
    historyClose.classList.add('t-dialogue-history-close');
    historyClose.hidden = true;
    root.append(historyClose);
  }
  function setHistory(open: boolean) {
    if (open === root.hasAttribute('data-t-history')) return;
    root.toggleAttribute('data-t-history', open);
    historyButton?.setAttribute('aria-expanded', String(open));
    if (historyClose) historyClose.hidden = !open;
    refit();
    if (open) {
      scrollLog(false);
      log.tabIndex = 0;
      modal.show({ keep: [log, historyClose], close: () => setHistory(false), focus: log, asked: true });
    } else {
      modal.hide(historyButton);
      syncLogFocusable();
      repage();
    }
  }

  // ── The thread in its box (slides): anchored at the bottom, scrolled by the learner ──
  const pinned = () => log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  function scrollLog(smooth: boolean) {
    log.scrollTo?.({ top: log.scrollHeight, behavior: smooth && !reduced() && !still ? 'smooth' : 'auto' });
  }
  // Scroll pages: the page follows the new bubble only when the learner was at the bottom of the dialogue.
  const followingPage = () => {
    const box = room.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight;
    return box.top < height + 40;
  };
  function insert(node: HTMLElement, replace: HTMLElement | null = null) {
    const scrolls = getComputedStyle(log).overflowY === 'auto';
    const followed = !parts.host().slides() && followingPage();
    if (replace?.isConnected) replace.replaceWith(node); else log.append(node);
    if (scrolls) {
      if (following) scrollLog(true);
      else if (!root.hasAttribute('data-t-debrief-open')) newMessage.hidden = false;
    } else if (followed && !still) {
      (room.lastElementChild as HTMLElement | null ?? room).scrollIntoView?.({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    }
  }
  function syncLogFocusable() {
    // A box that scrolls is reached with the keyboard (its arrows scroll it).
    if (parts.host().slides() || root.hasAttribute('data-t-history')) log.tabIndex = 0; else log.removeAttribute('tabindex');
  }

  // Every bubble as wide as its lines again (the thread's width or its text size changed).
  function refit() {
    fitLines(...log.querySelectorAll<HTMLElement>('.t-dialogue-text'));
  }

  // ── Scene pages: two or three bubbles near the characters, then the page turns ──
  const paging = () => data.style === 'scene' && !phone() && !root.hasAttribute('data-t-history');
  const visibleRows = () => [...log.querySelectorAll<HTMLElement>(':scope > .t-dialogue-row:not([data-t-paged])')];
  function fits(node: HTMLElement): boolean {
    measureLog.style.width = `${cssPx(log, log.getBoundingClientRect().width)}px`;
    measureLog.replaceChildren(...visibleRows().map((row) => row.cloneNode(true)), node.cloneNode(true));
    const fit = measureLog.scrollHeight <= cssPx(log, log.clientHeight) + 1;
    measureLog.replaceChildren();
    return fit;
  }
  // The bubbles shown are the last ones that fit (back on the screen, a phone turned, History closed).
  function repage() {
    const rows = [...log.querySelectorAll<HTMLElement>(':scope > .t-dialogue-row')];
    if (!paging()) { for (const row of rows) row.removeAttribute('data-t-paged'); return; }
    for (const row of rows) row.removeAttribute('data-t-paged');
    const limit = log.clientHeight;
    if (!limit) return;
    let height = 0;
    let keep = rows.length;
    for (let i = rows.length - 1; i >= 0; i--) {
      height += rows[i].getBoundingClientRect().height + (i < rows.length - 1 ? 12 : 0);
      if (height > limit + 1 && i < rows.length - 1) break;
      keep = i;
    }
    rows.slice(0, keep).forEach((row) => row.setAttribute('data-t-paged', ''));
  }
  // The rows shown leave in a fade, then what comes next begins a new page.
  function turnPage(then: () => Step | null): Step {
    const leaving = visibleRows();
    for (const row of leaving) row.classList.add('is-turning');
    return { kind: 'turn', until: clock.now() + (reduced() ? 0 : 0.2), then: () => { for (const row of leaving) { row.classList.remove('is-turning'); row.setAttribute('data-t-paged', ''); } return then(); } };
  }

  // ── Slides: the box keeps its size, filling the room the slide leaves; the room keeps the
  // height of the tallest set of options ──
  const main = () => wrap.closest<HTMLElement>('.t-main');
  let sizing = false;
  function layout() {
    if (disposed() || !wrap.isConnected) return;
    syncLogFocusable();
    refit();
    const slides = parts.host().slides();
    const scene = data.style === 'scene' && !phone();
    const placeOverlays = () => {
      // Where the thread is in the dialogue: the start card, the debrief over it, « Nouveau message ».
      root.style.setProperty('--t-dl-log-top', `${log.offsetTop}px`);
      root.style.setProperty('--t-dl-log-height', `${log.offsetHeight}px`);
    };
    if (!slides) { root.style.removeProperty('--t-dialog-fill'); room.style.minHeight = ''; placeOverlays(); return; }
    const container = main();
    const article = wrap.closest<HTMLElement>('.t-screen');
    if (!container || !article || sizing) return;
    sizing = true;
    try {
      // The room first: the box takes what is left once the room has the height of the tallest options.
      reserveRoom(scene);
      // What the slide leaves: the page scrolls by what is too much, or the screen has room to spare.
      const box = scene ? stage : log;
      if (!box) return;
      const zoom = (box as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
      const page = document.documentElement;
      const overflow = page.scrollHeight - window.innerHeight;
      let delta: number;
      if (overflow > 0.5) delta = -overflow;
      else {
        const styles = getComputedStyle(container);
        const mainZoom = (container as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
        const room = container.getBoundingClientRect().height - (parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom)) * mainZoom;
        delta = room - article.getBoundingClientRect().height;
      }
      const current = box.getBoundingClientRect().height / zoom;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      // A phone's page scrolls anyway: the thread keeps at least half its height there.
      const [low, high] = scene ? [15 * rem, 60 * rem] : [phone() ? Math.max(12 * rem, Math.min(26 * rem, window.innerHeight * 0.5)) : 12 * rem, 32 * rem];
      if (Math.abs(delta) < 1 && root.style.getPropertyValue('--t-dialog-fill')) { placeOverlays(); return; }
      const fill = Math.round(clamp(low, current + delta / zoom, high));
      root.style.setProperty('--t-dialog-fill', `${fill}px`);
      placeOverlays();
    } finally { sizing = false; }
    repage();
  }
  // Sized again when the slide or the screen changes size, or a phone turns.
  const resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  let observed = false;
  function observe() {
    if (!observed && resizer) { const container = main(); if (container) { resizer.observe(container); resizer.observe(wrap.closest('.t-screen') ?? wrap); observed = true; } }
  }
  const phoneQuery = typeof matchMedia === 'function' ? matchMedia(PHONE) : null;
  // A phone shows a scene as messaging, without its History.
  const onPhone = () => { if (phone()) setHistory(false); layout(); repage(); };
  phoneQuery?.addEventListener?.('change', onPhone);

  function dispose() {
    resizer?.disconnect();
    phoneQuery?.removeEventListener?.('change', onPhone);
  }

  return { insert, scrollLog, syncLogFocusable, paging, fits, repage, turnPage, layout, observe, dispose };
}
