// « IA et crédits » (docs/decisions.md D58): what the course says of itself in its language. What
// was made with AI comes first (the EU AI Act's transparency duty for synthetic audio, images and
// video, art. 50), then the author's credits and those its voices ask for (CC-BY voices).

import { element, linkedText } from './dom.ts';
import { icon } from './icons.ts';
import { createSheet } from './sheet.ts';
import type { Labels } from './labels.ts';
import type { AboutData } from './course-data.ts';
import type { Tooltip } from './tooltip.ts';

export interface AboutOptions {
  about: AboutData;
  labels: Labels;
  language: string;
  host: HTMLElement;
  tooltip: Tooltip | null;
  onToggle?(open: boolean): void;
}

export function createAbout(options: AboutOptions) {
  const { labels, about } = options;
  const sheet = createSheet({ name: 'about', title: labels.about, closeLabel: labels.close, tooltip: options.tooltip, host: options.host, onToggle: options.onToggle });
  const list = (items: string[]) => {
    try { return new Intl.ListFormat(options.language, { type: 'conjunction' }).format(items); } catch { return items.join(', '); }
  };
  const mention = (text: string, detail?: string) => element('li', { class: 't-about-ai' }, icon('spark'), element('span', {}, element('span', { class: 't-about-ai-text', text }), detail ? element('span', { class: 't-about-ai-detail', text: detail }) : null));
  const ai = about.ai;
  if (ai) {
    const media: Record<string, string> = { image: labels.generatedImages, video: labels.generatedVideos, audio: labels.generatedAudio };
    sheet.body.append(element('section', { class: 't-about-section', 'data-about': 'ai' },
      element('h3', { class: 't-about-heading', text: labels.aiHeading }),
      element('ul', { class: 't-about-list' },
        ai.voices ? mention(labels.generatedVoice, ai.voices.length ? list(ai.voices) : undefined) : null,
        (ai.media ?? []).map((kind) => mention(media[kind])))));
  }
  if (about.credits?.length) {
    sheet.body.append(element('section', { class: 't-about-section t-about-credits', 'data-about': 'credits' },
      element('h3', { class: 't-about-heading', text: labels.credits }),
      about.credits.map((credit) => linkedText('p', credit))));
  }
  return { sheet, dispose() { sheet.dispose(); } };
}
