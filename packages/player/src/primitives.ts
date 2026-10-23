// The primitives of D63, for any template: hooks the player gives their behaviour, so that a block
// made of items, cards, images or disclosures stays accessible, keyboard-operable, saved and still
// (docs/components.md §3).
//
//   data-t-sequence           one item at a time: data-t-item="<k>" (each item), data-t-prev and
//                             data-t-next (buttons), data-t-goto="<k>" (buttons, optional) and
//                             data-t-position (receives "2 / 5"). Arrow keys inside it, a swipe on
//                             touch; it never moves by itself. data-t-selected on an item shows it first.
//   data-t-card="<k>"         a flip card: data-t-face="front" and data-t-face="back" inside it, a
//                             data-t-flip="<k>" button (on a face, on the card or next to it).
//   data-t-zoom               a button holding an <img>: the image at full size in the lightbox, with
//                             its data-t-caption (inside the button or next to it); previous and next
//                             between the zoom buttons of the block.
//   data-t-exclusive          opening one data-t-toggle part closes the others; Escape closes it;
//                             ="popover" also closes it on a click outside.
//   data-t-details="<k>"      on <details>: a native disclosure, visited once opened.
//   data-t-reveal="<k>"       visited once it has been in view.
//
// Items, cards, details and reveals are controls: visited once used (an item once shown, a card once
// turned over, details once opened, a reveal once seen), saved with the learner's progress and read by
// conditions and by steps that open once explored. Motion follows the player's rules: soothing, brief,
// on the ease-out curve, a fade alone when the learner asks for less motion; nothing moves by itself.

import type { Labels } from './labels.ts';
import { element, uniqueId } from './dom.ts';
import { icon } from './icons.ts';

export type PrimitiveHook = 'item' | 'flip' | 'details' | 'reveal';

// A control a primitive adds to the block: the element that gets data-t-visited, and others that
// show it too (a sequence's goto button, a card's flip buttons).
export interface PrimitiveControl {
  node: HTMLElement;
  hook: PrimitiveHook;
  name: string;
  also: HTMLElement[];
}

export interface PrimitiveContext {
  labels: Labels;
  formatLabel(label: string, values: Readonly<Record<string, unknown>>): string;
  // The learner used a control: it is visited, saved, and fires "click" with its name.
  use(name: string): void;
  visited(name: string): boolean;
  // Disclosures of the template (data-t-toggle): whether a part is open, and opening or closing it.
  disclosure(button: HTMLElement): { open(): boolean; set(open: boolean): void } | undefined;
  // The editor's canvas: nothing moves.
  still: boolean;
}

// What the player keeps of the primitives of one template.
export interface BoundPrimitives {
  controls: PrimitiveControl[];
  // Room of what shows one thing at a time (the tallest item of each sequence): measured by the view.
  rooms: { host: HTMLElement; measure(): number }[];
  // Elements brought into view are visited (called when blocks come into view: a step revealed).
  refresh(): void;
  // Every sequence shows its tallest item (fit checks and captures), without visiting it.
  showTallest(): void;
  dispose(): void;
}

const NO_PRIMITIVES: BoundPrimitives = { controls: [], rooms: [], refresh() {}, showTallest() {}, dispose() {} };

const SEQUENCE_SWIPE = 40; // px: a horizontal movement longer than this, mostly horizontal, is a swipe
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Words come from the player's labels: an empty button gets its text, a button with only an icon its
// aria-label; a button the template filled keeps its words.
function labelButton(button: HTMLElement, text: string) {
  if (button.textContent?.trim()) return;
  if (button.children.length) button.setAttribute('aria-label', text);
  else button.textContent = text;
}
const makeButton = (node: HTMLElement) => { if ('type' in node) (node as HTMLButtonElement).type = 'button'; };
// A button the learner cannot use now stays in the tab order (focus is never lost under it).
const setDisabled = (button: HTMLElement, disabled: boolean) => { if (disabled) button.setAttribute('aria-disabled', 'true'); else button.removeAttribute('aria-disabled'); };
const disabled = (button: HTMLElement) => button.getAttribute('aria-disabled') === 'true';
// The motion of the player: its duration and curve tokens (player.css), at rest in the canvas.
function motion(node: HTMLElement) {
  const style = getComputedStyle(node);
  return { duration: parseFloat(style.getPropertyValue('--t-dur-item')) || 220, easing: style.getPropertyValue('--t-ease-out').trim() || 'ease-out' };
}

export function bindPrimitives(root: HTMLElement, context: PrimitiveContext): BoundPrimitives {
  const { labels, formatLabel, use, visited, still } = context;
  // Hooks of this template only: nested blocks are bound by their own (the slots are not filled yet,
  // but a layout's article may already hold blocks).
  const ownerOf = (node: Element) => node.closest('.t-block[data-block]') ?? node.closest('article.t-screen');
  const owner = root.matches('.t-block[data-block], article.t-screen') ? root : ownerOf(root);
  const hooks = (hook: string, within: ParentNode = root) => [...within.querySelectorAll<HTMLElement>(`[data-t-${hook}]`)].filter((node) => ownerOf(node) === owner || ownerOf(node) === null);
  if (!root.querySelector('[data-t-sequence], [data-t-card], [data-t-zoom], [data-t-exclusive], [data-t-details], [data-t-reveal]')) return NO_PRIMITIVES;
  const bound: BoundPrimitives = { controls: [], rooms: [], refresh() {}, showTallest() {}, dispose() {} };
  const disposers: (() => void)[] = [];
  const refreshers: (() => void)[] = [];
  const tallest: (() => void)[] = [];

  // ── One item at a time (the APG carousel, with buttons, never moving by itself) ──
  for (const box of hooks('sequence')) {
    const own = (node: HTMLElement) => node.closest('[data-t-sequence]') === box;
    const items = hooks('item', box).filter(own);
    if (!items.length) continue;
    const names = items.map((item) => item.getAttribute('data-t-item') ?? '');
    const previous = hooks('prev', box).filter(own);
    const next = hooks('next', box).filter(own);
    const gotos = hooks('goto', box).filter(own);
    const positions = hooks('position', box).filter(own);
    const stage = items[0].parentElement ?? box;
    if (!box.hasAttribute('role')) box.setAttribute('role', 'group');
    box.setAttribute('aria-roledescription', labels.carousel);
    // The new item is read when it shows (its room holds the items only, not the buttons).
    if (stage !== box) stage.setAttribute('aria-live', 'polite');
    items.forEach((item, index) => {
      if (!item.hasAttribute('role')) item.setAttribute('role', 'group');
      item.setAttribute('aria-roledescription', labels.slide);
      item.setAttribute('aria-label', formatLabel(labels.itemOf, { n: index + 1, count: items.length }));
      // Its images load with it, so that its room is known before it shows.
      for (const image of item.querySelectorAll('img')) image.loading = 'eager';
    });
    for (const button of [...previous, ...next, ...gotos]) makeButton(button);
    for (const button of previous) labelButton(button, labels.previousItem);
    for (const button of next) labelButton(button, labels.nextItem);
    for (const node of positions) node.setAttribute('aria-hidden', 'true');
    let current = Math.max(0, items.findIndex((item) => item.hasAttribute('data-t-selected')));
    const show = (index: number, { used = false, direction = 0, animate = true }: { used?: boolean; direction?: number; animate?: boolean } = {}) => {
      if (index < 0 || index >= items.length) return;
      const changed = index !== current;
      current = index;
      items.forEach((item, position) => { item.hidden = position !== index; });
      box.setAttribute('data-t-current', names[index]);
      for (const button of gotos) { if (button.getAttribute('data-t-goto') === names[index]) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current'); }
      for (const button of previous) setDisabled(button, index === 0);
      for (const button of next) setDisabled(button, index === items.length - 1);
      for (const node of positions) node.textContent = formatLabel(labels.position, { n: index + 1, count: items.length });
      // The item that comes slides in a little from where the learner goes, and fades in; a fade alone
      // with less motion (the room is reserved: nothing around it moves).
      if (changed && animate && !still && typeof items[index].animate === 'function') {
        const { duration, easing } = motion(box);
        const shift = reducedMotion() ? 0 : direction * 24;
        items[index].animate([{ opacity: 0, translate: `${shift}px 0` }, { opacity: 1, translate: '0 0' }], { duration: reducedMotion() ? Math.min(duration, 160) : duration, easing });
      }
      if (used) use(names[index]);
    };
    show(current);
    const go = (step: number, focusGoto = false) => {
      const target = current + step;
      if (target < 0 || target >= items.length) return;
      show(target, { used: true, direction: Math.sign(step) });
      if (focusGoto) gotos.find((button) => button.getAttribute('data-t-goto') === names[target])?.focus();
    };
    for (const button of previous) button.addEventListener('click', () => { if (!disabled(button)) go(-1); });
    for (const button of next) button.addEventListener('click', () => { if (!disabled(button)) go(1); });
    for (const button of gotos) button.addEventListener('click', () => {
      const index = names.indexOf(button.getAttribute('data-t-goto') ?? '');
      if (index >= 0 && index !== current) show(index, { used: true, direction: Math.sign(index - current) });
    });
    // Arrow keys inside the sequence (not in a field, nor in a block placed in it), mirrored right to left.
    box.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (event.altKey || event.ctrlKey || event.metaKey || target.closest('input, textarea, select, [contenteditable]') || ownerOf(target) !== owner) return;
      const rtl = getComputedStyle(box).direction === 'rtl';
      const steps: Readonly<Record<string, number | undefined>> = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, Home: -current, End: items.length - 1 - current };
      const step = steps[event.key];
      if (step === undefined || step === 0) return;
      event.preventDefault();
      go(step, gotos.includes(target));
    });
    // A swipe on touch: a horizontal movement longer than 40 px that is mostly horizontal (the page
    // still scrolls vertically: touch-action pan-y in player.css).
    let start: { x: number; y: number; id: number } | null = null;
    stage.addEventListener('pointerdown', (event) => { start = event.pointerType === 'touch' ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null; });
    stage.addEventListener('pointercancel', () => { start = null; });
    stage.addEventListener('pointerup', (event) => {
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      start = null;
      if (Math.abs(dx) < SEQUENCE_SWIPE || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
      const rtl = getComputedStyle(box).direction === 'rtl';
      go((dx < 0) !== rtl ? 1 : -1);
    });
    items.forEach((item, index) => bound.controls.push({ node: item, hook: 'item', name: names[index], also: gotos.filter((button) => button.getAttribute('data-t-goto') === names[index]) }));
    // The room of the tallest item, measured in place: every item shown in turn within one task (never
    // painted), then the one shown again.
    const measure = () => {
      const shown = items.map((item) => item.hidden);
      const kept = stage.style.minHeight;
      stage.style.minHeight = '0px';
      let room = 0;
      for (const item of items) {
        for (const other of items) other.hidden = other !== item;
        room = Math.max(room, stage.getBoundingClientRect().height);
      }
      items.forEach((item, index) => { item.hidden = shown[index]; });
      stage.style.minHeight = kept;
      return room;
    };
    bound.rooms.push({ host: stage, measure });
    tallest.push(() => {
      const heights = items.map((item) => { for (const other of items) other.hidden = other !== item; return item.getBoundingClientRect().height; });
      const index = heights.indexOf(Math.max(...heights));
      show(index, { animate: false });
    });
  }

  // ── Flip cards (TPGi's pattern: a button turns it; the hidden face is out of reach) ──
  for (const card of hooks('card')) {
    const name = card.getAttribute('data-t-card') ?? '';
    const own = (node: HTMLElement) => node.closest('[data-t-card]') === card;
    const front = hooks('face', card).find((face) => own(face) && face.getAttribute('data-t-face') === 'front');
    const back = hooks('face', card).find((face) => own(face) && face.getAttribute('data-t-face') === 'back');
    const buttons = hooks('flip').filter((button) => button.getAttribute('data-t-flip') === name);
    if (!front || !back || !buttons.length) continue;
    // Its buttons are described by the front (what the card is about), whichever face shows.
    front.id ||= uniqueId('t-face');
    for (const button of buttons) { makeButton(button); if (!button.hasAttribute('aria-describedby')) button.setAttribute('aria-describedby', front.id); }
    // A button the template left empty says what it does, and changes its words when the card turns.
    const worded = buttons.filter((button) => !button.textContent?.trim());
    let flipped = false;
    const set = (turned: boolean) => {
      flipped = turned;
      card.toggleAttribute('data-t-flipped', turned);
      const hidden = turned ? front : back;
      const shown = turned ? back : front;
      const focused = document.activeElement;
      hidden.inert = true;
      hidden.setAttribute('aria-hidden', 'true');
      shown.inert = false;
      shown.removeAttribute('aria-hidden');
      for (const button of worded) {
        const text = turned ? labels.showFront : labels.flipCard;
        if (button.children.length) button.setAttribute('aria-label', text); else button.textContent = text;
      }
      // Focus on the face that turned away goes to a flip button that is still in reach.
      if (focused instanceof HTMLElement && hidden.contains(focused)) buttons.find((button) => !button.closest('[inert]'))?.focus({ preventScroll: true });
    };
    set(false);
    for (const button of buttons) button.addEventListener('click', () => { set(!flipped); use(name); });
    bound.controls.push({ node: card, hook: 'flip', name, also: buttons });
  }

  // ── Images enlarged in the lightbox ──
  const zooms = hooks('zoom');
  if (zooms.length) {
    let lightbox: HTMLDialogElement | null = null;
    const captionOf = (button: HTMLElement): HTMLElement | null => {
      const inside = button.querySelector<HTMLElement>('[data-t-caption]');
      if (inside) return inside;
      // Next to it: the caption of the nearest container that holds this zoom button and no other.
      for (let node = button.parentElement; node && node !== root.parentElement; node = node.parentElement) {
        if (hooks('zoom', node).length > 1) return null;
        const caption = hooks('caption', node).find((candidate) => !candidate.closest('[data-t-zoom]'));
        if (caption) return caption;
      }
      return null;
    };
    const open = (index: number) => {
      lightbox?.close();
      let current = index;
      const several = zooms.length > 1;
      const stage = element('div', { class: 't-lightbox-stage' });
      const caption = element('p', { class: 't-lightbox-caption', id: uniqueId('t-lightbox-caption') });
      const position = several ? element('span', { class: 't-lightbox-position', 'aria-hidden': 'true' }) : null;
      const close = element('button', { type: 'button', class: 't-icon-btn t-lightbox-close', 'aria-label': labels.close, onclick: () => dialog.close() }, icon('close'));
      const previous = several ? element('button', { type: 'button', class: 't-icon-btn t-lightbox-previous', 'aria-label': labels.previousImage, onclick: () => move(-1) }, icon('chevronLeft')) : null;
      const following = several ? element('button', { type: 'button', class: 't-icon-btn t-lightbox-next', 'aria-label': labels.nextImage, onclick: () => move(1) }, icon('chevronRight')) : null;
      const dialog: HTMLDialogElement = element('dialog', { class: 't-viewer t-lightbox', 'aria-describedby': caption.id },
        stage, element('div', { class: 't-lightbox-foot' }, caption, previous, position, following, close));
      const render = (fade: boolean) => {
        const button = zooms[current];
        const source = button.querySelector('img');
        const image = source ? element('img', { class: 't-lightbox-image', src: source.currentSrc || source.src, alt: source.alt }) : button.querySelector('svg')?.cloneNode(true) as Element | undefined;
        if (image instanceof SVGElement) image.classList.add('t-lightbox-image');
        stage.replaceChildren(...(image ? [image] : []));
        const text = captionOf(button);
        caption.replaceChildren(...(text ? [...text.cloneNode(true).childNodes] : []));
        caption.hidden = !text?.textContent?.trim();
        dialog.setAttribute('aria-label', source?.alt || text?.textContent?.trim() || labels.enlargeImage);
        if (position) position.textContent = formatLabel(labels.position, { n: current + 1, count: zooms.length });
        if (previous) setDisabled(previous, current === 0);
        if (following) setDisabled(following, current === zooms.length - 1);
        if (fade && image instanceof HTMLElement && typeof image.animate === 'function' && !still) image.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.min(motion(root).duration, 160), easing: 'ease' });
      };
      const move = (step: number) => {
        const target = current + step;
        if (target < 0 || target >= zooms.length) return;
        current = target;
        render(true);
      };
      dialog.addEventListener('keydown', (event) => {
        // Escape closes it (handled here: Chrome may drop the dialog's own close event after a key was pressed in it).
        if (event.key === 'Escape') { event.preventDefault(); dialog.close(); return; }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          const rtl = getComputedStyle(dialog).direction === 'rtl';
          event.preventDefault();
          move((event.key === 'ArrowRight') !== rtl ? 1 : -1);
          return;
        }
        // Focus stays in the lightbox (the modal dialog makes the page inert; Tab cycles here).
        if (event.key !== 'Tab') return;
        const reachable = [...dialog.querySelectorAll<HTMLElement>('button')].filter((button) => !button.hidden);
        const first = reachable[0];
        const last = reachable[reachable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      // Closed, it leaves the page; focus goes back to the button of the image shown.
      dialog.addEventListener('close', () => {
        dialog.remove();
        if (lightbox === dialog) lightbox = null;
        zooms[current]?.focus({ preventScroll: true });
      });
      render(false);
      document.body.append(dialog);
      lightbox = dialog;
      dialog.showModal();
      (following ?? close).focus({ preventScroll: true });
    };
    zooms.forEach((button, index) => {
      makeButton(button);
      button.setAttribute('aria-haspopup', 'dialog');
      // The image's alt names the button; the player says what pressing it does.
      button.append(element('span', { class: 't-sr-only', text: labels.enlargeImage }));
      button.addEventListener('click', () => open(index));
    });
    disposers.push(() => lightbox?.close());
  }

  // ── One part open at a time ──
  for (const box of hooks('exclusive')) {
    const toggles = hooks('toggle', box);
    const parts = toggles.map((button) => hooks('part').find((part) => part.getAttribute('data-t-part') === button.getAttribute('data-t-toggle'))).filter((part): part is HTMLElement => !!part);
    const closeAll = (except?: HTMLElement) => { for (const button of toggles) if (button !== except && context.disclosure(button)?.open()) context.disclosure(button)?.set(false); };
    for (const button of toggles) button.addEventListener('click', () => { if (context.disclosure(button)?.open()) closeAll(button); });
    // Escape closes the part open and gives the focus back to its toggle.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const button = toggles.find((candidate) => context.disclosure(candidate)?.open());
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      context.disclosure(button)?.set(false);
      button.focus({ preventScroll: true });
    };
    for (const node of new Set([box, ...parts])) node.addEventListener('keydown', onKey);
    if (box.getAttribute('data-t-exclusive') === 'popover') {
      const outside = (event: PointerEvent) => {
        if (!box.isConnected) { document.removeEventListener('pointerdown', outside, true); return; }
        const target = event.target as Node;
        if (!box.contains(target) && !parts.some((part) => part.contains(target))) closeAll();
      };
      document.addEventListener('pointerdown', outside, true);
      disposers.push(() => document.removeEventListener('pointerdown', outside, true));
    }
  }

  // ── Native disclosures that are visited once opened ──
  for (const details of hooks('details')) {
    if (!(details instanceof HTMLDetailsElement)) continue;
    const name = details.getAttribute('data-t-details') ?? '';
    // The toggle event also comes for a details open from the start: only the learner's changes count.
    let open = details.open;
    details.addEventListener('toggle', () => { if (details.open === open) return; open = details.open; use(name); });
    bound.controls.push({ node: details, hook: 'details', name, also: [] });
  }

  // ── What is visited once it has been in view (a timeline's event, a scrolling step) ──
  const reveals = hooks('reveal');
  if (reveals.length) {
    // In view: half of it, or half of the window for what is taller than half the window; in reach
    // (not in a pending step, not concealed, not hidden).
    const inView = (node: HTMLElement) => {
      if (node.closest('[inert], [hidden]') || !node.getClientRects().length) return false;
      const box = node.getBoundingClientRect();
      const height = window.innerHeight || document.documentElement.clientHeight;
      const seen = Math.min(box.bottom, height) - Math.max(box.top, 0);
      return seen > 0 && (seen >= box.height / 2 - 0.5 || seen >= height / 2);
    };
    // Each is used once (it fires "click" with its name the first time it is seen).
    const seen = new Set<string>();
    const check = (node: HTMLElement) => {
      const name = node.getAttribute('data-t-reveal') ?? '';
      if (seen.has(name) || !inView(node)) return;
      seen.add(name);
      if (!visited(name)) use(name);
    };
    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) check(entry.target as HTMLElement); }, { threshold: [0, 0.25, 0.5, 0.75, 1] })
      : null;
    for (const node of reveals) {
      observer?.observe(node);
      bound.controls.push({ node, hook: 'reveal', name: node.getAttribute('data-t-reveal') ?? '', also: [] });
    }
    refreshers.push(() => { for (const node of reveals) check(node); });
    disposers.push(() => observer?.disconnect());
  }

  bound.refresh = () => { for (const refresh of refreshers) refresh(); };
  bound.showTallest = () => { for (const show of tallest) show(); };
  bound.dispose = () => { for (const dispose of disposers.splice(0)) dispose(); };
  return bound;
}
