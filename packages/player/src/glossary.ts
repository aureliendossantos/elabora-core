// The glossary (docs/decisions.md D58): course.json glossary in a side panel, with a search field and
// the entries in the alphabetical order of the course's language. A text's link to glossary:<id>
// (compiled to a.t-term[data-term]) shows its definition in the player's tooltip when it is
// hovered or focused, and opens the panel at its entry.

import { element, uniqueId } from './dom.ts';
import { icon } from './icons.ts';
import { createSheet } from './sheet.ts';
import type { Labels } from './labels.ts';
import type { GlossaryData } from './course-data.ts';
import type { Tooltip } from './tooltip.ts';

export interface GlossaryOptions {
  entries: readonly GlossaryData[];
  labels: Labels;
  language: string;
  format(label: string, values: Readonly<Record<string, unknown>>): string;
  host: HTMLElement;
  tooltip: Tooltip | null;
  onToggle?(open: boolean): void;
}

// Lower case, without accents: « Réseau » is found with « reseau ».
const folded = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

export function sortedEntries(entries: readonly GlossaryData[], language: string): GlossaryData[] {
  const collator = new Intl.Collator(language, { sensitivity: 'base', numeric: true });
  return [...entries].sort((a, b) => collator.compare(a.term, b.term));
}

export function createGlossary(options: GlossaryOptions) {
  const { labels } = options;
  const sheet = createSheet({ name: 'glossary', title: labels.glossary, closeLabel: labels.close, tooltip: options.tooltip, host: options.host, onToggle: options.onToggle, focus: () => input });
  const entries = sortedEntries(options.entries, options.language);
  const searchId = uniqueId('t-glossary-search');
  const input = element('input', { id: searchId, class: 't-glossary-input', type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: labels.searchGlossary });
  const count = element('p', { class: 't-glossary-count', role: 'status', 'aria-live': 'polite' });
  const rows = entries.map((entry) => ({
    entry,
    haystack: folded([entry.term, ...(entry.variants ?? [])].join('\n')),
    definition: folded(entry.definition),
    node: element('div', { class: 't-glossary-entry', id: `t-glossary-${entry.id}`, 'data-term': entry.id },
      element('dt', {}, element('span', { class: 't-glossary-term', text: entry.term }), entry.variants?.length ? element('span', { class: 't-glossary-variants', text: entry.variants.join(', ') }) : null),
      element('dd', { text: entry.definition }))
  }));
  const list = element('dl', { class: 't-glossary-list' }, rows.map((row) => row.node));
  sheet.body.append(element('div', { class: 't-glossary-search' }, element('label', { class: 't-sr-only', for: searchId, text: labels.searchGlossary }), icon('search'), input), count, list);

  // Terms and their variants first, then definitions that say the words searched.
  function filter() {
    const query = folded(input.value.trim());
    let shown = 0;
    const byTerm: HTMLElement[] = [];
    const byDefinition: HTMLElement[] = [];
    for (const row of rows) {
      const inTerm = !query || row.haystack.includes(query);
      const inDefinition = !inTerm && row.definition.includes(query);
      row.node.hidden = !inTerm && !inDefinition;
      if (inTerm) byTerm.push(row.node); else if (inDefinition) byDefinition.push(row.node);
      if (inTerm || inDefinition) shown++;
    }
    if (query) list.append(...byTerm, ...byDefinition); else list.append(...rows.map((row) => row.node));
    count.textContent = query ? options.format(labels.glossaryCount, { n: shown }) : '';
  }
  input.addEventListener('input', filter);

  // Opens the panel at an entry, which is marked for a moment.
  function openAt(id: string, from?: HTMLElement | null) {
    input.value = '';
    filter();
    if (!sheet.isOpen) sheet.open(from);
    const node = rows.find((row) => row.entry.id === id)?.node;
    if (!node) return;
    node.scrollIntoView?.({ block: 'center' });
    node.setAttribute('data-t-found', '');
    setTimeout(() => node.removeAttribute('data-t-found'), 1800);
  }

  // Terms in the screens: the definition in the tooltip, the panel on a click.
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const definitionOf = (node: Element | null) => {
    const entry = node instanceof HTMLElement ? byId.get(node.dataset.term ?? '') : undefined;
    return entry ? `${entry.term}${labels.colon}${entry.definition}` : null;
  };
  // Terms linked in the page (screens and their layers): their definition, and the panel on a click.
  // Returns what unbinds them (the player is mounted again in another language, D59).
  function bindTerms(root: HTMLElement): () => void {
    const termOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('a.t-term[data-term]') : null);
    const onOver = (event: Event) => {
      const term = termOf(event.target);
      if (!term || term.dataset.tTip) return;
      term.dataset.tTip = '';
      options.tooltip?.attach(term, () => definitionOf(term), { wrap: true });
      term.dispatchEvent(new PointerEvent('pointerenter', { pointerType: (event as PointerEvent).pointerType }));
    };
    const onFocus = (event: Event) => {
      const term = termOf(event.target);
      if (!term || term.dataset.tTip) return;
      term.dataset.tTip = '';
      options.tooltip?.attach(term, () => definitionOf(term), { wrap: true });
      term.dispatchEvent(new FocusEvent('focus'));
    };
    const onClick = (event: Event) => {
      const term = termOf(event.target);
      if (!term) return;
      event.preventDefault();
      // In a modal layer the panel would open under it: the definition stays in the tooltip.
      const definition = definitionOf(term);
      if (term.closest('dialog[open]')?.matches(':modal')) { if (definition) options.tooltip?.flash(term, definition, { duration: 8000 }); return; }
      options.tooltip?.hide();
      openAt(term.dataset.term ?? '', term);
    };
    root.addEventListener('pointerover', onOver);
    root.addEventListener('focusin', onFocus);
    root.addEventListener('click', onClick);
    return () => { root.removeEventListener('pointerover', onOver); root.removeEventListener('focusin', onFocus); root.removeEventListener('click', onClick); };
  }

  return { sheet, openAt, bindTerms, definitionOf, dispose() { sheet.dispose(); } };
}
