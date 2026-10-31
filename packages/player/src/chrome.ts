// The player's two bars around the screen (docs/decisions.md D58), from course.player as the
// compiler resolved it: the items that show, in order. Shared by the player (player.ts, which runs
// them) and the canvas with ?chrome=player (canvas.ts: inert, so a screen has the room it has in a
// package; elabora look).
//
// Items keep the author's order. The room left goes to the title or the controls; without either,
// before the first of Resources, Glossary, « IA et crédits », Quitter, Previous and Next that follows
// another item (all of them to the end when the bar holds nothing else). Nothing in a bar changes
// size while learners use it: Next is as wide as its longest label, Previous and Next unavailable
// stay in place, greyed, and what they would say goes into the tooltip.
//
// The progress of a course in parts (two sections or more) is one segment per part, as wide as its
// share of the screens: a part fills as its screens are completed, the one the learner is in is
// marked, and each segment is a button to the part's first screen (D58, revised on 29 Oct 2026).
// One stop for Tab (the part shown), the arrows between parts, the part's name and progress in the
// tooltip.

import { element } from './dom.ts';
import { icon } from './icons.ts';
import type { IconName } from './icons.ts';
import { formatLabel } from './labels.ts';
import type { Labels } from './labels.ts';
import type { CourseData, PlayerBarData, PlayerItemData, PlayerItemId } from './course-data.ts';
import type { Tooltip } from './tooltip.ts';

// A language's name in that language, capitalised (« Français », « English », « Deutsch »).
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}

export type SheetName = 'resources' | 'glossary' | 'about';

// A part of the course (a section) as the progress shows it.
export interface PartView {
  title: string;
  // Its screens: the segment's share of the bar.
  screens: number;
  // Of its screens that count (the required ones, else all of them), how many are completed.
  done: number;
  total: number;
  // The screen shown is in it.
  current: boolean;
  // Its first screen cannot be opened yet (course.json navigation).
  locked: boolean;
}

// A share in the course's language (« 40 % », « 40% »).
export function percentText(percent: number, language: string): string {
  try { return new Intl.NumberFormat(language, { style: 'percent' }).format(percent / 100); } catch { return `${percent} %`; }
}

// The parts at a screen of the outline, as a learner who completed every screen before it sees
// them (the editor's canvases), and the share of the screens done.
export function partsAt(outline: { sections: readonly { title: string; screens: readonly { id: string }[] }[] } | null, screen: string | null): { parts: PartView[]; percent: number } {
  const sections = outline?.sections ?? [];
  const order = sections.flatMap((section) => section.screens.map((entry) => entry.id));
  const at = screen === null ? -1 : order.indexOf(screen);
  let before = 0;
  const parts = sections.map((section) => {
    const done = Math.max(0, Math.min(section.screens.length, at - before));
    const current = at >= before && at < before + section.screens.length;
    before += section.screens.length;
    return { title: section.title, screens: section.screens.length, done, total: section.screens.length, current, locked: false };
  });
  return { parts, percent: order.length && at > 0 ? Math.round((100 * at) / order.length) : 0 };
}

export interface ChromeActions {
  previous(): void;
  next(): void;
  quit(): void;
  outline(): void;
  // A part of the progress, clicked or activated with the keyboard; touch: by a finger.
  part(index: number, button: HTMLElement, how: { touch: boolean }): void;
  sheet(name: SheetName, button: HTMLElement): void;
  // « Langue » and « Affichage »: their menus, from their buttons.
  language(button: HTMLElement): void;
  display(button: HTMLElement): void;
}

// Items that take the room left, and items that go after it.
const FILL: ReadonlySet<PlayerItemId> = new Set(['title', 'controls']);
const END: ReadonlySet<PlayerItemId> = new Set(['resources', 'glossary', 'language', 'display', 'credits', 'exit', 'previous', 'next']);

export type Chrome = ReturnType<typeof createChrome>;

export function createChrome(course: CourseData, labels: Labels, { actions, tooltip }: { actions: ChromeActions | null; tooltip: Tooltip | null }) {
  const run = (action: () => void) => () => { if (actions) action(); };
  const hint = (node: HTMLElement, text: string | (() => string | null)) => { tooltip?.attach(node, text); };
  const format = (label: string, values: Readonly<Record<string, unknown>>) => formatLabel(label, values, course.language);

  let progressItem = null as HTMLElement | null;
  let progress = null as HTMLElement | null;
  let progressBar = null as HTMLElement | null;
  let progressValue = null as HTMLElement | null;
  let progressPercent = 0;
  let progressText = '';
  // Its options: in parts (one per section), or one bar in one piece; its percentage shown or not.
  let progressParts = true;
  let progressShowsPercent = true;
  // The parts of the progress: their buttons and what they last showed.
  let partButtons: HTMLButtonElement[] = [];
  let parts: PartView[] = [];
  // The pointer that pressed a part (a click from the keyboard has none).
  let pressedBy: string | null = null;
  let outlineButton = null as HTMLButtonElement | null;
  let outlineLabel = null as HTMLElement | null;
  let menu = null as HTMLElement | null;
  let controls = null as HTMLElement | null;
  let previousButton = null as HTMLButtonElement | null;
  let nextButton = null as HTMLButtonElement | null;
  let quitButton = null as HTMLButtonElement | null;
  let languageButton = null as HTMLButtonElement | null;
  let displayButton = null as HTMLButtonElement | null;
  const sheetButtons = new Map<SheetName, HTMLButtonElement>();
  // What a greyed Previous or Next would say (the tooltip reads it when it shows).
  const why: { previous: string | null; next: string | null } = { previous: null, next: null };

  // A labelled button of a bar: an icon and its label (Ressources, Glossaire, Quitter).
  const chip = (name: IconName, label: string, className: string, onclick: () => void) =>
    element('button', { type: 'button', class: `t-bar-btn t-chip ${className}`, onclick }, icon(name), element('span', { class: 't-chip-label', text: label }));

  function item(data: PlayerItemData): HTMLElement {
    const node = element('div', { class: `t-item t-item--${data.id}`, 'data-item': data.id });
    switch (data.id) {
      case 'logo':
        node.append(element('img', { class: 't-logo', src: data.src, alt: data.alt, decoding: 'async' }));
        // On a light plate, for a dark logo on a dark bar.
        if (data.plate) node.classList.add('t-item--plate');
        break;
      case 'spacer':
        // « Espace flexible »: what is before it at the start of the line, what is after it at the end.
        node.setAttribute('aria-hidden', 'true');
        break;
      case 'language': {
        const button = element('button', { type: 'button', class: 't-bar-btn t-chip t-language-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `${labels.language}${labels.colon}${languageName(course.language)}`, onclick: run(() => actions?.language(button)) },
          icon('languages'), element('span', { class: 't-chip-label', text: languageName(course.language) }), icon('chevronDown'));
        languageButton = button;
        node.append(button);
        break;
      }
      case 'display': {
        const button = element('button', { type: 'button', class: 't-icon-btn t-display-btn', 'aria-label': labels.display, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: run(() => actions?.display(button)) }, icon('textSize'));
        hint(button, labels.display);
        displayButton = button;
        node.append(button);
        break;
      }
      case 'title':
        node.append(element('p', { class: 't-course-title', text: course.title }));
        break;
      case 'progress':
        progressItem = node;
        progressParts = data.parts;
        progressShowsPercent = data.percent;
        progressValue = element('span', { class: 't-progress-value', 'aria-hidden': 'true' });
        // The course's parts, nothing done yet: the player says where the learner is once a screen shows.
        setParts(course.sections.map((section, index) => ({ title: section.title, screens: section.screens.length, done: 0, total: section.screens.length, current: index === 0, locked: index > 0 })));
        break;
      case 'outline':
        outlineLabel = element('span', { class: 't-outline-label', text: labels.menu });
        outlineButton = element('button', { type: 'button', class: 't-bar-btn t-outline-btn', 'aria-expanded': 'false', 'aria-controls': 't-menu', 'data-label': data.label === 'outline' ? undefined : data.label, onclick: run(() => actions?.outline()) }, icon('menu'), outlineLabel);
        // The part's or the screen's title, cut to the button's width: the whole of it in the tooltip.
        if (data.label !== 'outline') { const label = outlineLabel; hint(outlineButton, () => (label.scrollWidth > label.clientWidth + 1 ? label.textContent : null)); }
        // The outline follows its button so that Tab moves into it; it floats over the screen.
        menu = element('nav', { id: 't-menu', class: 't-menu', 'aria-label': labels.menu, hidden: true });
        node.append(outlineButton, menu);
        break;
      case 'controls':
        controls = element('div', { class: 't-controls' });
        node.append(controls);
        break;
      case 'resources': case 'glossary': {
        const button = chip(data.id === 'resources' ? 'folder' : 'book', labels[data.id], `t-${data.id}-btn`, run(() => actions?.sheet(data.id as SheetName, button)));
        button.setAttribute('aria-expanded', 'false');
        sheetButtons.set(data.id, button);
        node.append(button);
        break;
      }
      case 'credits': {
        // « IA » when the course has a generated voice or generated media (the Commission's code of
        // practice on AI-generated content suggests an « AI » mark), else « i ».
        const mark = course.about?.ai ? element('span', { class: 't-ai-mark', 'aria-hidden': 'true', text: labels.aiMark }) : icon('info');
        const button = element('button', { type: 'button', class: 't-icon-btn t-about-btn', 'aria-label': labels.about, 'aria-expanded': 'false', 'data-ai': course.about?.ai ? '' : undefined, onclick: run(() => actions?.sheet('about', button)) }, mark);
        hint(button, labels.about);
        sheetButtons.set('about', button);
        node.append(button);
        break;
      }
      case 'previous':
        previousButton = element('button', { type: 'button', class: 't-nav-btn t-nav-btn--previous', onclick: run(() => actions?.previous()) }, icon('chevronLeft'), element('span', { class: 't-nav-label', text: labels.previous }));
        hint(previousButton, () => why.previous);
        node.append(previousButton);
        break;
      case 'next':
        // Both labels in one cell: the button is as wide as the longer, whichever it reads.
        nextButton = element('button', { type: 'button', class: 't-nav-btn t-nav-btn--next', 'data-label': 'next', onclick: run(() => actions?.next()) },
          element('span', { class: 't-nav-labels' }, element('span', { class: 't-nav-label', 'data-for': 'next', text: labels.next }), element('span', { class: 't-nav-label', 'data-for': 'continue', 'aria-hidden': 'true', text: labels.continue })),
          icon('chevronRight'));
        hint(nextButton, () => why.next);
        node.append(nextButton);
        break;
      case 'exit':
        quitButton = chip('exit', labels.quit, 't-quit', run(() => actions?.quit()));
        node.append(quitButton);
        break;
    }
    return node;
  }

  function bar(name: 'top' | 'bottom', data: PlayerBarData | null): HTMLElement | null {
    if (!data) return null;
    const root = element(name === 'top' ? 'header' : 'footer', { class: `t-bar t-bar--${name}`, 'data-bar': name, 'data-position': data.position });
    const nodes = data.items.map(item);
    root.append(...nodes);
    // With a spacer, it takes the room left (after the controls). Without one, the end of the line
    // starts before the first item that goes to the end: with the title or the controls in the bar,
    // they take the room and this margin gets none, until the controls go to their own row on a phone.
    if (data.items.some((entry) => entry.id === 'spacer')) root.dataset.spacer = '';
    else {
      const after = data.items.findIndex((entry, index) => END.has(entry.id) && data.items.slice(0, index).some((before) => !END.has(before.id)));
      const pushed = after >= 0 ? after : data.items.every((entry) => END.has(entry.id)) ? 0 : -1;
      if (pushed >= 0) nodes[pushed].classList.add('t-item--push');
    }
    return root;
  }

  const top = bar('top', course.player?.top ?? null);
  const bottom = bar('bottom', course.player?.bottom ?? null);

  // Previous and Next: available or greyed in place; Next reads Continue while steps remain.
  function setNav({ previous, next, nextLabel, previousWhy = null, nextWhy = null }: { previous: boolean; next: boolean; nextLabel: 'next' | 'continue'; previousWhy?: string | null; nextWhy?: string | null }) {
    why.previous = previous ? null : previousWhy;
    why.next = next ? null : nextWhy;
    if (previousButton) previousButton.setAttribute('aria-disabled', String(!previous));
    // A refusal that no longer holds goes at once.
    if (tooltip && ((previous && tooltip.owner === previousButton) || (next && tooltip.owner === nextButton))) tooltip.hide();
    if (nextButton) {
      nextButton.setAttribute('aria-disabled', String(!next));
      if (nextButton.dataset.label !== nextLabel) {
        nextButton.dataset.label = nextLabel;
        for (const label of nextButton.querySelectorAll<HTMLElement>('.t-nav-label')) {
          if (label.dataset.for === nextLabel) label.removeAttribute('aria-hidden'); else label.setAttribute('aria-hidden', 'true');
        }
      }
    }
  }

  // The share of the required screens completed: the bar's fill (one piece), or the toolbar's name (in parts).
  function setProgress(percent: number, text: string) {
    if (!progress || !progressValue) return;
    progressPercent = percent;
    progressText = text;
    progressValue.textContent = text;
    if (progressBar) {
      progressBar.style.setProperty('--t-progress', String(percent));
      progress.setAttribute('aria-valuenow', String(percent));
      progress.setAttribute('aria-valuetext', text);
    } else progress.setAttribute('aria-label', `${labels.progress}${labels.colon}${text}`);
  }

  // Where a part stands, in words: « en cours, 2 écrans terminés sur 5 », « terminée », « pas commencée ».
  function partState(part: PartView): string {
    const count = format(labels.partScreens, { done: part.done, total: part.total });
    if (part.current) return part.done > 0 ? `${labels.partCurrent}, ${count}` : labels.partCurrent;
    if (part.total > 0 && part.done >= part.total) return labels.partDone;
    if (part.locked) return labels.menuLocked;
    return part.done > 0 ? count : labels.partNew;
  }
  // The part of the toolbar that Tab reaches: the one focus is on, else the part shown.
  function rove(index: number) {
    partButtons.forEach((button, at) => { button.tabIndex = at === index ? 0 : -1; });
  }
  function onPartsKey(event: Event) {
    if (!(event instanceof KeyboardEvent)) return;
    const index = partButtons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || !progress) return;
    const forward = getComputedStyle(progress).direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = forward === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? partButtons.length - 1
      : event.key === forward ? Math.min(index + 1, partButtons.length - 1) : event.key === backward ? Math.max(index - 1, 0) : -1;
    if (target < 0) return;
    event.preventDefault();
    rove(target);
    partButtons[target].focus();
  }
  function partButton(index: number): HTMLButtonElement {
    const button = element('button', {
      type: 'button', class: 't-part', tabindex: '-1',
      // A click says its pointer (empty from the keyboard); a browser whose click does not is told by the
      // press before it, forgotten when the press comes to nothing.
      onpointerdown: (event: Event) => { pressedBy = (event as PointerEvent).pointerType; },
      onpointercancel: () => { pressedBy = null; },
      onclick: (event: Event) => {
        const by = typeof (event as PointerEvent).pointerType === 'string' ? (event as PointerEvent).pointerType : pressedBy;
        pressedBy = null;
        actions?.part(index, button, { touch: by === 'touch' });
      }
    }, element('span', { class: 't-part-track' }, element('span', { class: 't-part-fill' })));
    // The tooltip names the part; where it stands is said to screen readers (its name, setParts).
    hint(button, () => parts[index]?.title ?? null);
    return button;
  }
  // The progress in one piece (a course without parts), or one segment per part.
  function buildProgress(count: number) {
    if (!progressItem || !progressValue) return;
    // A tooltip shown over a segment that goes, goes with it.
    if (tooltip && partButtons.includes(tooltip.owner as HTMLButtonElement)) tooltip.hide();
    if (count < 2) {
      progressBar = element('div', { class: 't-progress-bar' });
      progress = element('div', { class: 't-progress', role: 'progressbar', 'aria-label': labels.progress, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, progressBar);
      partButtons = [];
      delete progressItem.dataset.parts;
      progressItem.style.removeProperty('--t-parts');
    } else {
      progressBar = null;
      partButtons = Array.from({ length: count }, (_, index) => partButton(index));
      progress = element('div', { class: 't-progress t-progress--parts', role: 'toolbar', 'aria-label': labels.progress, onkeydown: onPartsKey }, ...partButtons);
      progressItem.dataset.parts = String(count);
      progressItem.style.setProperty('--t-parts', String(count));
    }
    // The percentage hidden, screen readers still hear it (the bar's value, the toolbar's name).
    if (progressShowsPercent) progressItem.replaceChildren(progress, progressValue); else progressItem.replaceChildren(progress);
  }
  // What each part shows: its share of the bar, its fill, whether the learner is in it, its name and
  // where it stands for screen readers. The segments are made again only when the parts are not as many.
  function setParts(next: readonly PartView[]) {
    if (!progressItem) return;
    const count = progressParts && next.length >= 2 ? next.length : 0;
    if (!progress || count !== partButtons.length) { buildProgress(count); if (progressText) setProgress(progressPercent, progressText); }
    parts = count ? next.map((part) => ({ ...part })) : [];
    parts.forEach((part, index) => {
      const button = partButtons[index];
      button.style.flexGrow = String(Math.max(1, part.screens));
      button.style.setProperty('--t-part', String(part.total ? Math.round((100 * Math.min(part.done, part.total)) / part.total) : 0));
      button.toggleAttribute('data-current', part.current);
      button.toggleAttribute('data-done', part.total > 0 && part.done >= part.total);
      if (part.locked && !part.current) button.setAttribute('aria-disabled', 'true'); else button.removeAttribute('aria-disabled');
      button.setAttribute('aria-label', `${format(labels.partOf, { n: index + 1, total: parts.length })}${labels.colon}${part.title}, ${partState(part)}`);
    });
    // Tab comes to the part shown, unless focus is already on one.
    if (count && !partButtons.includes(document.activeElement as HTMLButtonElement)) rove(Math.max(0, parts.findIndex((part) => part.current)));
  }

  // The outline's button reads « Sommaire », or the title of the part or of the screen shown (option label).
  function setPlace(screen: string, section: string | null) {
    const option = [...(course.player?.top?.items ?? []), ...(course.player?.bottom?.items ?? [])].find((entry) => entry.id === 'outline');
    if (!outlineButton || !outlineLabel || !option || option.id !== 'outline' || option.label === 'outline') return;
    const title = option.label === 'section' ? section ?? screen : screen;
    outlineLabel.textContent = title;
    outlineButton.setAttribute('aria-label', `${labels.menu}${labels.colon}${title}`);
  }

  return {
    top, bottom, menu, controls, sheetButtons, setNav, setProgress, setParts, setPlace,
    get progress() { return progress; },
    get partButtons() { return partButtons; },
    get outlineButton() { return outlineButton; },
    get previousButton() { return previousButton; },
    get nextButton() { return nextButton; },
    get quitButton() { return quitButton; },
    get languageButton() { return languageButton; },
    get displayButton() { return displayButton; }
  };
}
