// The live bars of the editor canvas (page option chrome=live: the app's « Lecteur » tab, Lin 44;
// docs/architecture/rendering.md, The player's preview): the player's bars as packages wire them,
// around the screen the host renders. Resources, Glossaire and « IA et crédits » open their panels,
// the resource preview and the glossary's definitions work, « Affichage » and « Langue » open their
// menus, the outline opens, and the narration's controls play. What would leave the screen is the
// host's to do: Previous, Next and the outline say where they would go (elabora/navigate), a
// language chosen says which (elabora/language). The host outlines an item (elabora/highlight),
// opens or closes a panel (elabora/open, elabora/close), and hears which item the author clicked
// (elabora/item). Protocol elabora-player-preview/1 (canvas-protocol.ts).

import { createChrome, languageName } from './chrome.ts';
import type { Chrome, SheetName } from './chrome.ts';
import { createResources, isImage, isPdf } from './resources.ts';
import { createGlossary } from './glossary.ts';
import { createAbout } from './about.ts';
import { alignToButton, applyDisplay, createDisplayMenu, createLanguageMenu } from './display.ts';
import type { DisplayPrefs, Popover } from './display.ts';
import type { Tooltip } from './tooltip.ts';
import type { Sheet } from './sheet.ts';
import type { Labels } from './labels.ts';
import { element } from './dom.ts';
import { icon } from './icons.ts';
import type { CourseData, PlayerItemId } from './course-data.ts';
import { PLAYER_PREVIEW_PROTOCOL } from './canvas-protocol.ts';
import type { CanvasMessage, PreviewPanel, RenderOutline } from './canvas-protocol.ts';

export interface LiveChromeOptions {
  app: HTMLElement;
  course: CourseData;
  labels: Labels;
  tooltip: Tooltip;
  // The course's screens in order, by section (the render's outline); null: the screen alone.
  outline: RenderOutline | null;
  // The learner's display choices in the canvas (kept while the page lives).
  display: DisplayPrefs;
  format(label: string, values: Readonly<Record<string, unknown>>): string;
  announce(message: string): void;
  post(message: CanvasMessage): void;
  // What Next does on a slide with steps left (Continue): the screen view's steps.
  steps(): { more: boolean; reveal(): void };
  // The narration's transcript of the screen shown (its own panel).
  transcript(open: boolean): void;
}

// What is open, to open it again when the bars are mounted anew (the course's fields changed).
export interface LiveOpen {
  panel: PreviewPanel | null;
  resource: string | null;
}

export type LiveChrome = ReturnType<typeof createLiveChrome>;

export function createLiveChrome(options: LiveChromeOptions) {
  const { app, course, labels, tooltip, post } = options;
  let screen: string | null = null;
  let menuPopover: Popover | null = null;
  let languagePopover: Popover | null = null;
  let outline = options.outline;
  let order: string[] = [];
  const setOrder = () => { order = outline?.sections.flatMap((section) => section.screens.map((entry) => entry.id)) ?? []; };
  setOrder();
  const indexOf = () => (screen === null ? -1 : order.indexOf(screen));
  const go = (target: string | undefined, by: 'previous' | 'next' | 'outline') => { if (target) post({ type: 'elabora/navigate', screen: target, by }); };
  const refuse = (button: HTMLElement | null, reason: string) => { options.announce(reason); if (button) tooltip.flash(button, reason); };

  const chrome: Chrome = createChrome(course, labels, {
    tooltip,
    actions: {
      previous: () => {
        const index = indexOf();
        if (index <= 0) refuse(chrome.previousButton, labels.firstScreen); else go(order[index - 1], 'previous');
      },
      next: () => {
        const index = indexOf();
        if (options.steps().more) { options.steps().reveal(); update(); return; }
        if (index < 0 || index >= order.length - 1) refuse(chrome.nextButton, labels.lastScreen); else go(order[index + 1], 'next');
      },
      // Quit leaves nothing in the editor.
      quit: () => {},
      outline: () => toggleOutline(),
      sheet: (name, button) => sheets[name]?.sheet.toggle(button),
      language: () => languagePopover?.toggle(),
      display: () => menuPopover?.toggle()
    }
  });
  const sheetToggled = (name: SheetName) => (open: boolean) => chrome.sheetButtons.get(name)?.setAttribute('aria-expanded', String(open));
  const resources = course.resources?.length ? createResources({ resources: course.resources, labels, language: course.language, format: options.format, host: app, tooltip, onToggle: sheetToggled('resources') }) : null;
  const glossary = course.glossary?.length ? createGlossary({ entries: course.glossary, labels, language: course.language, format: options.format, host: app, tooltip, onToggle: sheetToggled('glossary') }) : null;
  const about = course.about ? createAbout({ about: course.about, labels, language: course.language, host: app, tooltip, onToggle: sheetToggled('about') }) : null;
  const sheets: Partial<Record<SheetName, { sheet: Sheet; dispose(): void }>> = { ...(resources ? { resources } : {}), ...(glossary ? { glossary } : {}), ...(about ? { about } : {}) };
  const unbindTerms = glossary ? glossary.bindTerms(document.body) : () => {};

  // The outline: where the screen is, then the sections and their screens; every screen is open in
  // the editor.
  const menu = chrome.menu;
  function renderOutline() {
    if (!menu || menu.hidden) return;
    const index = indexOf();
    const lists = (outline?.sections ?? []).map((section) => element('section', { class: 't-menu-section' },
      element('h2', { text: section.title }),
      element('ul', {}, section.screens.map((entry) => {
        const current = entry.id === screen;
        return element('li', {}, element('button', {
          type: 'button', class: 't-menu-item', 'aria-current': current ? 'page' : undefined, 'data-state': 'open',
          onclick: () => { toggleOutline(false); if (!current) go(entry.id, 'outline'); }
        }, element('span', { class: 't-menu-mark' }, current ? icon('dot') : element('span', { class: 't-menu-ring', 'aria-hidden': 'true' })), element('span', { class: 't-menu-text', text: entry.title })));
      }))));
    const where = element('p', { class: 't-menu-where', text: options.format(labels.screenOf, { n: index + 1, total: order.length }) });
    menu.replaceChildren(where, ...lists);
  }
  function toggleOutline(force?: boolean) {
    if (!menu || !chrome.outlineButton) return;
    const open = force ?? menu.hidden;
    menu.hidden = !open;
    chrome.outlineButton.setAttribute('aria-expanded', String(open));
    if (open) { alignToButton(menu, chrome.outlineButton); tooltip.hide(); renderOutline(); }
  }
  const outsideOutline = (target: EventTarget | null) => !(target instanceof Node && (menu?.contains(target) || chrome.outlineButton?.contains(target)));
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu && !menu.hidden) { toggleOutline(false); chrome.outlineButton?.focus(); } };
  const onPointer = (event: PointerEvent) => { if (menu && !menu.hidden && outsideOutline(event.target)) toggleOutline(false); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer);

  // « Affichage » and « Langue ».
  const narrated = [...(course.player.top?.items ?? []), ...(course.player.bottom?.items ?? [])].some((item) => item.id === 'controls');
  // « Texte : tout de suite » with a dialogue on the screen shown (D61).
  const dialogues = course.screens.some((screen) => screen.blocks.some((block) => block.behavior === 'dialogue'));
  menuPopover = chrome.displayButton ? createDisplayMenu(chrome.displayButton, { labels, prefs: options.display, narrated, dialogues, onChange: (prefs) => applyDisplay(app, prefs) }) : null;
  languagePopover = chrome.languageButton && course.languages ? createLanguageMenu(chrome.languageButton, {
    labels, languages: course.languages, current: course.language, name: languageName,
    choose: (code) => post({ type: 'elabora/language', protocol: PLAYER_PREVIEW_PROTOCOL, language: code })
  }) : null;
  applyDisplay(app, options.display);

  // The panels and the outline go between the bars, as in the player: their heights, measured.
  const measure = () => {
    const height = (bar: HTMLElement | null) => (bar && !bar.hidden && bar.dataset.position !== 'page' ? bar.offsetHeight : 0);
    app.style.setProperty('--t-bar-top', `${height(chrome.top)}px`);
    app.style.setProperty('--t-bar-bottom', `${height(chrome.bottom)}px`);
  };
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  for (const bar of [chrome.top, chrome.bottom]) if (bar) resized?.observe(bar);

  // The item the author clicks, for the host (the action runs as for a learner).
  const onClick = (event: MouseEvent) => {
    const node = event.target instanceof Element ? event.target.closest<HTMLElement>('.t-item[data-item]') : null;
    const bar = node?.closest<HTMLElement>('.t-bar[data-bar]')?.dataset.bar;
    if (node && (bar === 'top' || bar === 'bottom')) post({ type: 'elabora/item', protocol: PLAYER_PREVIEW_PROTOCOL, id: node.dataset.item as PlayerItemId, bar });
  };
  for (const bar of [chrome.top, chrome.bottom]) bar?.addEventListener('click', onClick, { capture: true });

  // Previous and Next as they would be on this screen; nothing is locked in the editor.
  function update() {
    const index = indexOf();
    const more = options.steps().more;
    chrome.setNav({ previous: index > 0, previousWhy: labels.firstScreen, next: more || (index >= 0 && index < order.length - 1), nextWhy: labels.lastScreen, nextLabel: more ? 'continue' : 'next' });
    const title = outline?.sections.flatMap((section) => section.screens).find((entry) => entry.id === screen)?.title;
    if (title) chrome.setScreen(title);
    renderOutline();
  }

  let highlighted: { item: PlayerItemId; bar?: 'top' | 'bottom' } | null = null;
  function highlight(item: PlayerItemId | null, bar?: 'top' | 'bottom') {
    highlighted = item ? { item, ...(bar ? { bar } : {}) } : null;
    for (const node of app.querySelectorAll('[data-t-highlight]')) node.removeAttribute('data-t-highlight');
    if (!item) return;
    for (const name of bar ? [bar] : ['top', 'bottom']) {
      const node = app.querySelector(`.t-bar[data-bar="${name}"] > .t-item[data-item="${CSS.escape(item)}"]`);
      if (node) { node.setAttribute('data-t-highlight', ''); if (item !== 'spacer') break; }
    }
  }

  function closeAll() {
    tooltip.hide();
    resources?.viewer?.close();
    for (const entry of Object.values(sheets)) entry?.sheet.close({ refocus: false });
    options.transcript(false);
    toggleOutline(false);
    menuPopover?.close();
    languagePopover?.close();
  }

  // Opens a panel as the host asks (the editor's row hovered or chosen). Returns false when the
  // course has nothing to open there.
  function open(panel: PreviewPanel, { resource, term }: { resource?: string; term?: string } = {}): boolean {
    closeAll();
    switch (panel) {
      case 'resources': {
        if (!resources) return false;
        resources.sheet.open(chrome.sheetButtons.get('resources') ?? null);
        const found = resource ? course.resources?.find((candidate) => candidate.id === resource) : undefined;
        if (found && found.kind === 'file' && (isPdf(found) || isImage(found))) resources.preview(found);
        return true;
      }
      case 'glossary':
        if (!glossary) return false;
        if (term) glossary.openAt(term, chrome.sheetButtons.get('glossary') ?? null); else glossary.sheet.open(chrome.sheetButtons.get('glossary') ?? null);
        return true;
      case 'about':
        if (!about) return false;
        about.sheet.open(chrome.sheetButtons.get('about') ?? null);
        return true;
      case 'outline':
        if (!menu) return false;
        toggleOutline(true);
        return true;
      case 'display':
        if (!menuPopover) return false;
        menuPopover.open();
        return true;
      case 'language':
        if (!languagePopover) return false;
        languagePopover.open();
        return true;
      case 'transcript':
        options.transcript(true);
        return true;
    }
  }

  function opened(): LiveOpen {
    const viewer = resources?.viewer;
    const panel: PreviewPanel | null = viewer?.open ? 'resources'
      : (Object.entries(sheets) as [SheetName, { sheet: Sheet }][]).find(([, entry]) => entry.sheet.isOpen)?.[0]
      ?? (menu && !menu.hidden ? 'outline' : menuPopover?.isOpen ? 'display' : languagePopover?.isOpen ? 'language' : app.querySelector('.t-sheet[data-sheet="transcript"]:not([hidden])') ? 'transcript' : null);
    return { panel, resource: viewer?.open ? viewer.dataset.resource ?? null : null };
  }

  return {
    top: chrome.top, bottom: chrome.bottom, controls: chrome.controls,
    get highlighted() { return highlighted; },
    // The screen shown (render data), and what Previous, Next and the outline say of it.
    show(id: string) { screen = id; update(); measure(); },
    setOutline(next: RenderOutline | null) { outline = next; setOrder(); update(); },
    update, highlight, open, close: closeAll, opened,
    dispose() {
      closeAll();
      resized?.disconnect();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      unbindTerms();
      menuPopover?.dispose();
      languagePopover?.dispose();
      for (const entry of Object.values(sheets)) entry?.dispose();
    }
  };
}
