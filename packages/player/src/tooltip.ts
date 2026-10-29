// The player's one tooltip (docs/decisions.md D58): the name of an icon button, a refusal (a Next
// that cannot go on yet), the words said at a point of the seek bar, a glossary definition. One
// element for the page, fixed over everything, so that nothing it says ever moves the layout.
//
// WCAG 1.4.13: it stays while the pointer is over its anchor or over itself, Escape dismisses it,
// and it never hides on its own while hovered or focused (only a flash, said in the live region
// too, goes after a while).

import { element } from './dom.ts';

export type TipText = string | (() => string | null);

export interface TipOptions {
  // Where it goes: above or below the anchor; auto: away from the nearer edge of the window.
  placement?: 'above' | 'below' | 'auto';
  // A definition: wraps over several lines.
  wrap?: boolean;
  // Shown as soon as the pointer comes (the seek bar's quote), not after a short wait.
  immediate?: boolean;
}

export type Tooltip = ReturnType<typeof createTooltip>;

const HOVER_DELAY = 350;
const LEAVE_DELAY = 120;
const GAP = 8;
const MARGIN = 8;

export function createTooltip(root: HTMLElement = document.body) {
  const tip = element('div', { class: 't-tip', role: 'tooltip', id: 't-tip', hidden: true });
  root.append(tip);
  let owner: HTMLElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  // A flash (a refusal, the AI mention) goes after its time, not when the pointer leaves; anything
  // else shown replaces it.
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let flashing = false;
  let hovered = false;

  function place(anchor: HTMLElement, placement: TipOptions['placement'] = 'auto', x?: number) {
    const box = anchor.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const viewWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewHeight = document.documentElement.clientHeight || window.innerHeight;
    const above = placement === 'above' || (placement === 'auto' && box.top + box.height / 2 > viewHeight / 2);
    let top = above ? box.top - height - GAP : box.bottom + GAP;
    if (above && top < MARGIN) top = box.bottom + GAP;
    if (!above && top + height > viewHeight - MARGIN) top = Math.max(MARGIN, box.top - height - GAP);
    const centre = x ?? box.left + box.width / 2;
    const left = Math.min(Math.max(MARGIN, centre - width / 2), Math.max(MARGIN, viewWidth - width - MARGIN));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.dataset.side = top < box.top ? 'above' : 'below';
    // It grows from its element, wherever the window's edges pushed it (player.css, « Motion »).
    tip.style.transformOrigin = `${Math.round(Math.min(Math.max(0, centre - left), width))}px ${top < box.top ? height : 0}px`;
  }

  function show(anchor: HTMLElement, text: string, options: TipOptions & { x?: number } = {}) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    clearTimeout(flashTimer);
    flashing = false;
    if (owner && owner !== anchor && owner.getAttribute('aria-describedby') === tip.id) owner.removeAttribute('aria-describedby');
    // Over a modal dialog (a layer, the PDF preview), the tooltip goes into it: the page under a modal
    // dialog is painted below it.
    const host = anchor.closest<HTMLDialogElement>('dialog[open]')?.matches(':modal') ? anchor.closest<HTMLDialogElement>('dialog[open]')! : root;
    // A dialog still growing in (player.css, « Motion ») is, while it scales, what a fixed element in it
    // is placed against: the tooltip waits for it to stand still.
    const moving = host === root ? [] : host.getAnimations();
    if (moving.length) {
      owner = anchor;
      void Promise.allSettled(moving.map((animation) => animation.finished)).then(() => { if (owner === anchor) show(anchor, text, options); });
      return;
    }
    if (tip.parentElement !== host) host.append(tip);
    owner = anchor;
    tip.textContent = text;
    tip.classList.toggle('t-tip--wrap', !!options.wrap);
    tip.hidden = false;
    place(anchor, options.placement, options.x);
  }

  // Hidden, and what was about to show with it (Escape, a scroll, the bars changing).
  function hide() {
    clearTimeout(showTimer);
    conceal();
  }
  // The pointer gone from it: the tooltip goes, not what the anchor the pointer moved on to is about to
  // show.
  function conceal() {
    clearTimeout(hideTimer);
    clearTimeout(flashTimer);
    flashing = false;
    if (owner?.getAttribute('aria-describedby') === tip.id) owner.removeAttribute('aria-describedby');
    owner = null;
    tip.hidden = true;
  }

  const resolve = (text: TipText): string | null => (typeof text === 'function' ? text() : text);

  // A hint on hover and on keyboard focus. Returns what removes it.
  function attach(anchor: HTMLElement, text: TipText, options: TipOptions = {}): () => void {
    const open = (delay: number) => {
      if (flashing && owner === anchor) return;
      clearTimeout(showTimer);
      if (owner === anchor) clearTimeout(hideTimer);
      // Shown for a neighbour (the pointer going along the progress's parts or the bar's buttons), it
      // follows at once rather than going and coming back.
      const shown = owner !== null && owner !== anchor && !tip.hidden && !flashing;
      showTimer = setTimeout(() => { const value = resolve(text); if (value) show(anchor, value, options); else if (owner === anchor) hide(); }, shown ? 0 : delay);
    };
    const leave = () => {
      clearTimeout(showTimer);
      if (owner !== anchor || flashing) return;
      hideTimer = setTimeout(conceal, LEAVE_DELAY);
    };
    const onEnter = (event: PointerEvent) => { if (event.pointerType !== 'touch') open(options.immediate ? 0 : HOVER_DELAY); };
    const onFocus = () => { if (anchor.matches(':focus-visible')) open(0); };
    anchor.addEventListener('pointerenter', onEnter);
    anchor.addEventListener('pointerleave', leave);
    anchor.addEventListener('focus', onFocus);
    anchor.addEventListener('blur', leave);
    return () => {
      anchor.removeEventListener('pointerenter', onEnter);
      anchor.removeEventListener('pointerleave', leave);
      anchor.removeEventListener('focus', onFocus);
      anchor.removeEventListener('blur', leave);
      if (owner === anchor) hide();
    };
  }

  // Says something at once, next to its anchor, for a while (a refusal); the anchor is described by
  // it meanwhile. The caller says it in the live region too.
  function flash(anchor: HTMLElement, text: string, { duration = 5000, placement = 'auto' as TipOptions['placement'] } = {}) {
    show(anchor, text, { placement, wrap: text.length > 48 });
    flashing = true;
    anchor.setAttribute('aria-describedby', tip.id);
    // Its time over, it goes, unless the pointer is on it: then it goes when the pointer leaves.
    flashTimer = setTimeout(() => { if (owner !== anchor) return; if (hovered) flashing = false; else conceal(); }, duration);
  }

  // Follows a point along an anchor (the seek bar): the text, or nothing.
  function at(anchor: HTMLElement, x: number, text: string | null) {
    if (!text) { if (owner === anchor) hide(); return; }
    show(anchor, text, { placement: 'above', x });
  }

  // The pointer may go onto the tooltip without losing it (WCAG 1.4.13, hoverable).
  tip.addEventListener('pointerenter', () => { hovered = true; clearTimeout(hideTimer); });
  tip.addEventListener('pointerleave', () => { hovered = false; if (!flashing) hideTimer = setTimeout(conceal, LEAVE_DELAY); });
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !tip.hidden) hide(); };
  const onScroll = () => { if (!tip.hidden && owner && !flashing) hide(); };
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });

  return {
    element: tip, attach, flash, at, hide,
    get owner() { return owner; },
    dispose() { hide(); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll, { capture: true }); tip.remove(); }
  };
}
