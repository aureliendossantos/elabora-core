// A side panel of the player (docs/decisions.md D58): Resources, Glossary, « IA et crédits » and the
// transcript of a narrated screen. It slides over the screen from the end of the line, between the
// bars, and leaves the screen usable (not modal: the voice goes on); on phones it rises from the
// bottom. One is open at a time. Its title takes the focus; Escape and its close button give the
// focus back to what opened it.

import { element, uniqueId } from './dom.ts';
import { icon } from './icons.ts';
import type { Tooltip } from './tooltip.ts';

export interface SheetOptions {
  name: string; // data-sheet: resources, glossary, about, transcript
  title: string;
  closeLabel: string;
  tooltip?: Tooltip | null;
  // Where it goes (the app root).
  host: HTMLElement;
  onToggle?(open: boolean): void;
  // What takes the focus when it opens (default: its title): the glossary's search field.
  focus?(): HTMLElement | null;
}

export type Sheet = ReturnType<typeof createSheet>;

const open = new Set<Sheet>();

export function createSheet(options: SheetOptions) {
  const titleId = uniqueId(`t-sheet-${options.name}`);
  const title = element('h2', { id: titleId, class: 't-sheet-title', tabindex: '-1', text: options.title });
  const close = element('button', { type: 'button', class: 't-icon-btn t-sheet-close', 'aria-label': options.closeLabel, onclick: () => sheet.close() }, icon('close'));
  options.tooltip?.attach(close, options.closeLabel);
  const head = element('div', { class: 't-sheet-head' }, title, close);
  const body = element('div', { class: 't-sheet-body' });
  const root = element('section', { class: 't-sheet', 'data-sheet': options.name, role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, hidden: true }, head, body);
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); sheet.close(); } });
  options.host.append(root);
  let opener: HTMLElement | null = null;

  const sheet = {
    element: root, head, body, title,
    get isOpen() { return !root.hidden; },
    open(from?: HTMLElement | null) {
      for (const other of [...open]) if (other !== sheet) other.close({ refocus: false });
      opener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      options.tooltip?.hide();
      root.hidden = false;
      open.add(sheet);
      (options.focus?.() ?? title).focus({ preventScroll: true });
      options.onToggle?.(true);
    },
    close({ refocus = true }: { refocus?: boolean } = {}) {
      if (root.hidden) return;
      root.hidden = true;
      open.delete(sheet);
      options.onToggle?.(false);
      if (refocus && opener?.isConnected) opener.focus({ preventScroll: true });
      opener = null;
    },
    toggle(from?: HTMLElement | null) { if (root.hidden) sheet.open(from); else sheet.close(); },
    setTitle(text: string) { title.textContent = text; },
    dispose() { sheet.close({ refocus: false }); root.remove(); }
  };
  return sheet;
}
