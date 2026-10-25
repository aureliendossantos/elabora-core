// A character speaking to the learner (the speech block, « Personnage », D63): its bubbles beside its
// portrait. The template gives the hooks; the player fills them from the speaker course.json declares
// (its name, colour and look, as a dialogue's characters):
//
//   data-t-line="<id>"   each line (a bubble): read as « Marc : … », the name said before its words
//   data-t-speaker       where the name is written (seen; screen readers hear it with each line)
//   data-t-portrait      where the portrait is mounted: the character's SVG framed on its face (at
//                        rest: its default expression, the mouth closed, nothing moving), its
//                        portrait picture, or its initial. Decorative: the name is written.
//
// The speaker's colour gives --t-speech-color on the block (a colour token of the theme).

import type { SpeechBlock } from './course-data.ts';
import type { Labels } from './labels.ts';
import { element } from './dom.ts';
import { mountCharacter } from './character/index.ts';
import { tokenVar } from './dialogue/thread.ts';

export function bindSpeech(wrap: HTMLElement, block: SpeechBlock, labels: Labels): void {
  const speaker = block.props.speaker;
  const name = speaker?.name.trim() ?? '';
  const color = tokenVar(speaker?.color);
  if (color) wrap.style.setProperty('--t-speech-color', color);
  for (const node of wrap.querySelectorAll<HTMLElement>('[data-t-speaker]')) {
    if (!node.textContent?.trim()) node.textContent = name;
    node.setAttribute('aria-hidden', 'true');
  }
  // Each line says who speaks, before its first words (in its first paragraph, so that it reads as one).
  if (name) {
    for (const line of wrap.querySelectorAll<HTMLElement>('[data-t-line]')) {
      if (line.querySelector(':scope .t-speech-who')) continue;
      const first = line.querySelector<HTMLElement>('p, li, h2, h3, h4') ?? line;
      first.prepend(element('span', { class: 't-sr-only t-speech-who', text: `${name}${labels.colon}` }));
    }
  }
  for (const host of wrap.querySelectorAll<HTMLElement>('[data-t-portrait]')) {
    host.setAttribute('aria-hidden', 'true');
    if (!speaker || host.firstElementChild) continue;
    // At rest: the default expression, the mouth closed, no breathing nor blinking (nothing moves by itself).
    mountCharacter(host, speaker, { portrait: true }).set({ reducedMotion: true });
  }
}
