// « Affichage » and « Langue » (docs/decisions.md D58, D59): the small menus of their buttons in the
// bars, and the learner's display choices. A menu opens under or above its button, as the outline
// does, and closes on Escape, a click outside or the focus leaving it.

import { element, uniqueId } from './dom.ts';
import { icon } from './icons.ts';
import type { Labels } from './labels.ts';

export type TextSize = 'normal' | 'large' | 'larger';

export interface DisplayPrefs {
  text: TextSize;
  captions: boolean;
  // « Texte : tout de suite »: a dialogue's lines show whole at once, not word by word (D61).
  instant?: boolean;
  // « Sons de l'interface » and « Musique et ambiances » (D67): on unless the learner switched them off.
  interfaceSounds: boolean;
  music: boolean;
}

// The learner's display choices, for this course, where the page may keep them (a module on the web
// that keeps nothing, D41: not kept).
const KEY = 'elabora.display';
export function loadDisplayPrefs(course: string, keep: boolean): DisplayPrefs {
  const prefs: DisplayPrefs = { text: 'normal', captions: false, interfaceSounds: true, music: true };
  if (!keep) return prefs;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`${KEY}:${course}`) || 'null');
    if (saved && typeof saved === 'object') {
      const record = saved as Record<string, unknown>;
      if (record.text === 'large' || record.text === 'larger') prefs.text = record.text;
      if (record.captions === true) prefs.captions = true;
      if (record.instant === true) prefs.instant = true;
      if (record.interfaceSounds === false) prefs.interfaceSounds = false;
      if (record.music === false) prefs.music = false;
    }
  } catch { /* storage refused (an LMS frame): the session keeps them */ }
  return prefs;
}
export function saveDisplayPrefs(course: string, keep: boolean, prefs: DisplayPrefs): void {
  if (!keep) return;
  try { localStorage.setItem(`${KEY}:${course}`, JSON.stringify(prefs)); } catch { /* see above */ }
}

// The choices on the page: the screen's text larger (#t-main, never the bars: nothing in them
// moves), the captions larger.
export function applyDisplay(app: HTMLElement, prefs: DisplayPrefs): void {
  if (prefs.text === 'normal') delete app.dataset.textSize; else app.dataset.textSize = prefs.text;
  if (prefs.captions) app.dataset.captions = 'large'; else delete app.dataset.captions;
  app.toggleAttribute('data-text-instant', !!prefs.instant);
}

// A menu of a bar's button: its element goes after the button, in the button's item.
// A popup of a bar (« Affichage », « Langue », the outline) opens toward the side of the window
// with more room: from its button's start when the button is in the first half of the line, from
// its end otherwise (items move: a popup at the start of a bar would leave the window).
export function alignToButton(popup: HTMLElement, button: HTMLElement) {
  const box = button.getBoundingClientRect();
  const centre = box.left + box.width / 2;
  const rtl = getComputedStyle(button).direction === 'rtl';
  popup.dataset.align = (rtl ? centre > window.innerWidth / 2 : centre < window.innerWidth / 2) ? 'start' : 'end';
}

export function createPopover(button: HTMLElement, { className, role, label }: { className: string; role: 'menu' | 'dialog'; label: string }) {
  const root = element('div', { class: `t-pop ${className}`, role, id: uniqueId('t-pop'), 'aria-label': label, hidden: true });
  button.setAttribute('aria-controls', root.id);
  button.after(root);
  const outside = (target: EventTarget | null) => !(target instanceof Node && (root.contains(target) || button.contains(target)));
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || root.hidden) return;
    const refocus = !outside(document.activeElement);
    close();
    if (refocus) button.focus();
  };
  const onPointer = (event: PointerEvent) => { if (!root.hidden && outside(event.target)) close(); };
  const onFocus = (event: FocusEvent) => { if (!root.hidden && outside(event.target)) close(); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer);
  document.addEventListener('focusin', onFocus);
  function open() {
    alignToButton(root, button);
    root.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    root.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"], button')?.focus({ preventScroll: true });
  }
  function close() {
    root.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }
  return {
    root, open, close,
    toggle() { if (root.hidden) open(); else close(); },
    get isOpen() { return !root.hidden; },
    dispose() { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); document.removeEventListener('focusin', onFocus); root.remove(); }
  };
}
export type Popover = ReturnType<typeof createPopover>;

// « Affichage »: the text size in three steps, larger captions, « Texte : tout de suite » (when the
// course has dialogues), « Sons de l'interface » and « Musique et ambiances » (when the course has
// them, D67) and the keyboard
// shortcuts of the narrated screens (when the course has one).
export function createDisplayMenu(button: HTMLElement, { labels, prefs, onChange, narrated, dialogues = false, interfaceSounds = false, music = false }: { labels: Labels; prefs: DisplayPrefs; onChange(prefs: DisplayPrefs): void; narrated: boolean; dialogues?: boolean; interfaceSounds?: boolean; music?: boolean }) {
  const popover = createPopover(button, { className: 't-display-menu', role: 'dialog', label: labels.display });
  const sizes: [TextSize, string][] = [['normal', labels.textNormal], ['large', labels.textLarge], ['larger', labels.textLarger]];
  const sizeButtons = sizes.map(([size, name]) => element('button', {
    type: 'button', class: `t-display-size t-display-size--${size}`, role: 'radio', 'aria-label': name, 'aria-checked': String(prefs.text === size),
    onclick: () => { prefs.text = size; render(); onChange(prefs); }
  }, element('span', { 'aria-hidden': 'true', text: 'A' })));
  const sizeLabel = element('span', { id: uniqueId('t-display-size'), class: 't-pop-label', text: labels.textSize });
  const captions = element('button', {
    type: 'button', class: 't-switch', role: 'switch', 'aria-checked': String(prefs.captions), 'aria-label': labels.largerCaptions,
    onclick: () => { prefs.captions = !prefs.captions; render(); onChange(prefs); }
  }, element('span', { class: 't-switch-knob', 'aria-hidden': 'true' }));
  const instant = element('button', {
    type: 'button', class: 't-switch', role: 'switch', 'aria-checked': String(!!prefs.instant), 'aria-label': labels.textInstant,
    onclick: () => { prefs.instant = !prefs.instant; render(); onChange(prefs); }
  }, element('span', { class: 't-switch-knob', 'aria-hidden': 'true' }));
  const sounds = element('button', {
    type: 'button', class: 't-switch', role: 'switch', 'aria-checked': String(prefs.interfaceSounds), 'aria-label': labels.interfaceSounds,
    onclick: () => { prefs.interfaceSounds = !prefs.interfaceSounds; render(); onChange(prefs); }
  }, element('span', { class: 't-switch-knob', 'aria-hidden': 'true' }));
  const musicSwitch = element('button', {
    type: 'button', class: 't-switch', role: 'switch', 'aria-checked': String(prefs.music), 'aria-label': labels.music,
    onclick: () => { prefs.music = !prefs.music; render(); onChange(prefs); }
  }, element('span', { class: 't-switch-knob', 'aria-hidden': 'true' }));
  const keys: [string, string][] = [['Ctrl+Alt+P', labels.shortcutPlay], ['Ctrl+Alt+R', labels.shortcutReplay], ['Ctrl+Alt+C', labels.shortcutCaptions], ['← →', labels.shortcutSeek], ['Page ↑ Page ↓', labels.shortcutStep], ['Home End', labels.shortcutEnds], ['Shift+?', labels.shortcutList]];
  const list = element('dl', { class: 't-display-keys', hidden: true }, keys.flatMap(([combo, what]) => [element('dt', {}, combo.split(' ').map((key) => element('kbd', { text: key }))), element('dd', { text: what })]));
  const keysButton = element('button', { type: 'button', class: 't-pop-item', 'aria-expanded': 'false', onclick: () => { list.hidden = !list.hidden; keysButton.setAttribute('aria-expanded', String(!list.hidden)); } }, icon('keyboard'), element('span', { text: labels.shortcuts }));
  popover.root.append(
    element('p', { class: 't-pop-head', text: labels.display }),
    element('div', { class: 't-pop-row' }, icon('textSize'), sizeLabel, element('span', { class: 't-display-sizes', role: 'radiogroup', 'aria-labelledby': sizeLabel.id }, sizeButtons)),
    element('label', { class: 't-pop-row' }, icon('captions'), element('span', { class: 't-pop-label', text: labels.largerCaptions }), captions),
    ...(dialogues ? [element('label', { class: 't-pop-row' }, icon('transcript'), element('span', { class: 't-pop-label', text: labels.textInstant }), instant)] : []),
    ...(interfaceSounds ? [element('label', { class: 't-pop-row' }, icon('volume'), element('span', { class: 't-pop-label', text: labels.interfaceSounds }), sounds)] : []),
    ...(music ? [element('label', { class: 't-pop-row' }, icon('volume'), element('span', { class: 't-pop-label', text: labels.music }), musicSwitch)] : []),
    ...(narrated ? [element('hr', { class: 't-pop-sep' }), keysButton, list] : []));
  function render() {
    sizeButtons.forEach((node, index) => node.setAttribute('aria-checked', String(sizes[index][0] === prefs.text)));
    captions.setAttribute('aria-checked', String(prefs.captions));
    instant.setAttribute('aria-checked', String(!!prefs.instant));
    sounds.setAttribute('aria-checked', String(prefs.interfaceSounds));
    musicSwitch.setAttribute('aria-checked', String(prefs.music));
  }
  return popover;
}

// « Langue »: the languages of the package, each in its own name; the one shown is checked.
export function createLanguageMenu(button: HTMLElement, { labels, languages, current, name, choose }: { labels: Labels; languages: readonly string[]; current: string; name(code: string): string; choose(code: string): void }) {
  const popover = createPopover(button, { className: 't-language-menu', role: 'menu', label: labels.language });
  popover.root.append(...languages.map((code) => element('button', {
    type: 'button', class: 't-pop-item', role: 'menuitemradio', lang: code, 'aria-checked': String(code === current),
    onclick: () => { popover.close(); if (code !== current) choose(code); }
  }, element('span', { text: name(code) }), code === current ? icon('check') : null)));
  return popover;
}
