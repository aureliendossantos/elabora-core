// The parts of a screen's transcript that are not its narration (D62, D61): each layer that speaks,
// under its title, and the path a dialogue has gone so far, under its title. A narrated screen's
// timeline puts them after its own lines; a screen without narration whose layers or dialogues speak
// has a transcript all the same: its own button in the player's controls item, the same side panel.

import { element } from './dom.ts';
import { icon } from './icons.ts';
import { createSheet } from './sheet.ts';
import type { Labels } from './labels.ts';
import type { Tooltip } from './tooltip.ts';

export interface TranscriptSection {
  title: string;
  lines: readonly { speaker?: string; text: string }[];
  // A dialogue's path (styled apart from a layer's lines).
  dialogue?: boolean;
}

// One section: its title, then each line with its speaker above it; screen readers and a copy read
// « Marc : … ».
export function transcriptSection(section: TranscriptSection, labels: Labels): HTMLElement {
  return element('section', { class: `t-timeline-transcript-step${section.dialogue ? ' t-timeline-transcript-dialogue' : ' t-timeline-transcript-layer'}` },
    element('h3', { text: section.title }),
    section.lines.map((line) => element('p', { class: 't-timeline-line' },
      line.speaker ? element('strong', { class: 't-timeline-speaker', text: line.speaker }) : null,
      line.speaker ? element('span', { class: 't-sr-only', text: labels.colon }) : null,
      element('span', { class: 't-timeline-line-text', text: line.text }))));
}

export interface TranscriptBarOptions {
  host: HTMLElement;
  sheetHost: HTMLElement;
  labels: Labels;
  tooltip?: Tooltip | null;
  // Read each time the panel opens: a dialogue's path grows.
  sections(): TranscriptSection[];
}

export type TranscriptBar = ReturnType<typeof createTranscriptBar>;

// The transcript of a screen without narration: a button where the narration's bar would be, and
// the panel.
export function createTranscriptBar(options: TranscriptBarOptions) {
  const { labels } = options;
  const button = element('button', { type: 'button', class: 't-timeline-btn t-timeline-transcript-btn', 'aria-label': labels.transcript, 'aria-expanded': 'false', onclick: () => toggle() }, icon('transcript'));
  options.tooltip?.attach(button, labels.transcript);
  const bar = element('div', { class: 't-timeline t-timeline--transcript', role: 'group', 'aria-label': labels.transcript }, element('span', { class: 't-timeline-tools' }, button));
  options.host.append(bar);
  const sheet = createSheet({ name: 'transcript', title: labels.transcript, closeLabel: labels.close, tooltip: options.tooltip, host: options.sheetHost, onToggle: (open) => button.setAttribute('aria-expanded', String(open)) });
  sheet.element.classList.add('t-timeline-transcript');
  const fill = () => sheet.body.replaceChildren(...options.sections().map((section) => transcriptSection(section, labels)));
  function toggle(open = !sheet.isOpen) {
    if (open) { fill(); sheet.open(button); } else sheet.close();
  }
  return {
    button, toggle,
    refresh() { if (sheet.isOpen) fill(); },
    dispose() { sheet.dispose(); bar.remove(); if (options.tooltip && bar.contains(options.tooltip.owner)) options.tooltip.hide(); }
  };
}
