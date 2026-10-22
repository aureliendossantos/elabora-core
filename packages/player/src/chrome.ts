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

import { element } from './dom.ts';
import { icon } from './icons.ts';
import type { IconName } from './icons.ts';
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

export interface ChromeActions {
  previous(): void;
  next(): void;
  quit(): void;
  outline(): void;
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

  let progress = null as HTMLElement | null;
  let progressBar = null as HTMLElement | null;
  let progressValue = null as HTMLElement | null;
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
        progressBar = element('div', { class: 't-progress-bar' });
        progress = element('div', { class: 't-progress', role: 'progressbar', 'aria-label': labels.progress, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, progressBar);
        progressValue = element('span', { class: 't-progress-value', 'aria-hidden': 'true' });
        node.append(progress, progressValue);
        break;
      case 'outline':
        outlineLabel = element('span', { class: 't-outline-label', text: labels.menu });
        outlineButton = element('button', { type: 'button', class: 't-bar-btn t-outline-btn', 'aria-expanded': 'false', 'aria-controls': 't-menu', 'data-screen-title': data.screenTitle ? '' : undefined, onclick: run(() => actions?.outline()) }, icon('menu'), outlineLabel);
        // The screen's title, cut to the button's width: the whole of it in the tooltip.
        if (data.screenTitle) { const label = outlineLabel; hint(outlineButton, () => (label.scrollWidth > label.clientWidth + 1 ? label.textContent : null)); }
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

  function setProgress(percent: number, text: string) {
    if (!progress || !progressBar || !progressValue) return;
    progressBar.style.setProperty('--t-progress', String(percent));
    progress.setAttribute('aria-valuenow', String(percent));
    progress.setAttribute('aria-valuetext', text);
    progressValue.textContent = text;
  }

  // The outline's button reads « Sommaire », or the title of the screen shown (option screenTitle).
  function setScreen(title: string) {
    const option = [...(course.player?.top?.items ?? []), ...(course.player?.bottom?.items ?? [])].find((entry) => entry.id === 'outline');
    if (!outlineButton || !outlineLabel || !option || option.id !== 'outline' || !option.screenTitle) return;
    outlineLabel.textContent = title;
    outlineButton.setAttribute('aria-label', `${labels.menu}${labels.colon}${title}`);
  }

  return {
    top, bottom, menu, controls, sheetButtons, setNav, setProgress, setScreen,
    get progress() { return progress; },
    get outlineButton() { return outlineButton; },
    get previousButton() { return previousButton; },
    get nextButton() { return nextButton; },
    get quitButton() { return quitButton; },
    get languageButton() { return languageButton; },
    get displayButton() { return displayButton; }
  };
}
