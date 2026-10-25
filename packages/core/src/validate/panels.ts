import type { ComponentDescriptor } from '../components/registry.ts';
import type { Block } from '../project/model.ts';
import { checkKinds } from './components.ts';
import { checkMarkdown } from './blocks.ts';
import type { CheckContext } from './context.ts';
import { fieldsOf, list, text } from './guards.ts';

// Panels (« Panneaux »: accordion, tabs, cards, stack), the character block (speech) and the gallery's
// carousel (D63): what their schemas cannot say. Forks are checked like their root; the assets and
// Markdown of a fork are checked with its props (checkInstance), those of a built-in here.

interface Place {
  block: Block;
  component: ComponentDescriptor;
  file: string;
  at: (sub?: string) => string;
}

// How many items each presentation shows well (D63, W_ITEMS_MANY): a row of tabs, a grid of cards, a
// gallery's carousel; the accordion lists them all.
export const ITEMS_MANY: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  accordion: { tabs: 7, cards: 12, stack: 12 },
  gallery: { carousel: 5 }
};
// A tab names its panel in one or two words (W_TABS_LABEL_LONG).
export const TAB_LABEL_MAX = 24;

const PRESENTATION_WORDS: Readonly<Record<string, string>> = { tabs: 'tabs', cards: 'cards', stack: 'a stack of cards', carousel: 'a carousel' };

function checkItemsMany(ctx: CheckContext, { block, component, file, at }: Place, props: Record<string, unknown>, listName: string): void {
  const presentation = text(props.presentation);
  const most = ITEMS_MANY[component.root ?? '']?.[presentation];
  const count = list(props[listName]).length;
  if (most === undefined || count <= most) return;
  ctx.reporter.emit('W_ITEMS_MANY', { file, path: at(listName), target: block.id, measured: count, message: `"${block.id}" shows ${count} ${listName} as ${PRESENTATION_WORDS[presentation] ?? presentation}: ${most} at most read well.` });
}

export function checkPanels(ctx: CheckContext, place: Place, props: Record<string, unknown>): void {
  const { block, component, file, at } = place;
  if (component.builtin) checkKinds(ctx, component.schema, props, file, at(), block.id);
  else list(props.items).forEach((item, i) => checkMarkdown(ctx, fieldsOf(item).markdown, file, at(`items/${i}/markdown`), block.id));
  list(props.items).forEach((entry, i) => {
    const item = fieldsOf(entry);
    // An item's image needs alt; alt "" says it is decorative.
    if (item.image && typeof item.alt !== 'string') ctx.reporter.emit('E_IMAGE_ALT_MISSING', { file, path: at(`items/${i}/alt`), target: block.id, message: `The image of "${text(item.title) || text(item.id)}" in "${block.id}" has no alt (alt "" marks it decorative).` });
    if (props.presentation === 'tabs' && text(item.title).length > TAB_LABEL_MAX) ctx.reporter.emit('W_TABS_LABEL_LONG', { file, path: at(`items/${i}/title`), target: block.id, measured: text(item.title).length, message: `Tab "${text(item.title)}" of "${block.id}" has ${text(item.title).length} characters: ${TAB_LABEL_MAX} at most.` });
  });
  checkItemsMany(ctx, place, props, 'items');
}

export function checkGalleryCarousel(ctx: CheckContext, place: Place, props: Record<string, unknown>): void {
  checkItemsMany(ctx, place, props, 'images');
}

// A character speaks (speech): its speaker is one of the course's (its name, colour and look are
// read there; its look is checked with course.json, W_CHARACTER_*).
export function checkSpeech(ctx: CheckContext, { block, component, file, at }: Place, props: Record<string, unknown>): void {
  if (component.builtin) checkKinds(ctx, component.schema, props, file, at(), block.id);
  const speakers = list(ctx.course?.speakers).map((speaker) => fieldsOf(speaker).id).filter((id): id is string => typeof id === 'string');
  const speaker = text(props.speaker);
  if (speaker && !speakers.includes(speaker)) ctx.reporter.emit('E_SPEECH_SPEAKER', { file, path: at('speaker'), target: block.id, message: `Speech "${block.id}" names speaker "${speaker}", which course.json speakers does not have (speakers: ${speakers.join(', ') || 'none'}).` });
}
