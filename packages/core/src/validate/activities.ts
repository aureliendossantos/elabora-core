import { parseBlanks, MAX_BLANKS } from '@elabora/player/fill-in';
import type { ComponentDescriptor } from '../components/registry.ts';
import type { Block } from '../project/model.ts';
import { checkAsset, checkMarkdown } from './blocks.ts';
import type { CheckContext } from './context.ts';
import { fieldsOf, list, text } from './guards.ts';

// The activities of D63 (fill-in, sort, reflection) and the quiz's picture presentations: what their
// props must hold for the player to run them. Forks are checked like their root; the assets of a fork
// are checked with its props (checkKinds), those of a built-in here.

interface Place {
  block: Block;
  component: ComponentDescriptor;
  file: string;
  at: (sub?: string) => string;
}

// Feedback for wrong answers (guardrail D1).
function checkFeedback(ctx: CheckContext, { block, file, at }: Place, props: Record<string, unknown>, what: string): void {
  const feedback = fieldsOf(props.feedback);
  if (!text(feedback.incorrect).trim()) ctx.reporter.emit('W_ACTIVITY_NO_FEEDBACK', { file, path: at(props.feedback ? 'feedback' : ''), target: block.id, message: `${what} "${block.id}" has no feedback.incorrect: say what to look at again when an answer is wrong.` });
  checkMarkdown(ctx, feedback.correct, file, at('feedback/correct'), block.id);
  checkMarkdown(ctx, feedback.incorrect, file, at('feedback/incorrect'), block.id);
}

// An image of an item, an option or the block: its asset, and an alt that says what it shows.
function checkPicture(ctx: CheckContext, place: Place, image: unknown, alt: unknown, path: string, what: string): void {
  if (!image) return;
  if (place.component.builtin) checkAsset(ctx, image, place.file, place.at(`${path}image`), place.block.id);
  if (!text(alt).trim()) ctx.reporter.emit('E_IMAGE_ALT_MISSING', { file: place.file, path: place.at(`${path}alt`), target: place.block.id, message: `${what} of "${place.block.id}" has an image without alt.` });
}

export function checkFillIn(ctx: CheckContext, place: Place, props: Record<string, unknown>): void {
  const { block, file, at } = place;
  const report = (message: string) => ctx.reporter.emit('E_FILLIN_NO_BLANK', { file, path: at('markdown'), target: block.id, message: `Fill-in "${block.id}" ${message}` });
  const blanks = parseBlanks(props.markdown);
  if (!blanks.length) report('has no blank: write each one in its Markdown as [[answer]] or [[answer|other accepted]].');
  blanks.forEach((blank, index) => { if (!blank.answers.length) report(`has an empty blank (blank ${index + 1}): give it its answer, [[answer]].`); });
  if (blanks.length > MAX_BLANKS) report(`has ${blanks.length} blanks: ${MAX_BLANKS} at most, one to three per sentence.`);
  checkFeedback(ctx, place, props, 'Fill-in');
  checkMarkdown(ctx, props.stem, file, at('stem'), block.id);
  checkMarkdown(ctx, props.markdown, file, at('markdown'), block.id);
}

export function checkSort(ctx: CheckContext, place: Place, props: Record<string, unknown>): void {
  const { block, file, at } = place;
  const report = (path: string, message: string) => ctx.reporter.emit('E_SORT_TARGET', { file, path: at(path), target: block.id, message: `Sort "${block.id}" ${message}` });
  const presentation = props.presentation === 'categories' || props.presentation === 'order' ? props.presentation : 'pairs';
  const items = list(props.items).map(fieldsOf);
  const targets = list(props.targets).map(fieldsOf);
  const repeated = (entries: Record<string, unknown>[]) => entries.map((entry) => entry.id).filter((id, index, ids) => typeof id === 'string' && ids.indexOf(id) !== index);
  if (items.length < 2) report('items', items.length ? 'has one item: a sort needs at least two (four to eight is best).' : 'has no items.');
  for (const id of new Set(repeated(items))) report('items', `has two items "${String(id)}".`);
  if (presentation !== 'order') {
    for (const id of new Set(repeated(targets))) report('targets', `has two targets "${String(id)}".`);
    const ids = targets.map((target) => target.id);
    items.forEach((item, index) => {
      if (item.target === undefined) report(`items/${index}`, `(${presentation}) has an item, "${String(item.id)}", that names no target.`);
      else if (!ids.includes(item.target)) report(`items/${index}/target`, `has an item, "${String(item.id)}", that goes to "${String(item.target)}", which is not one of its targets (${ids.join(', ') || 'none'}).`);
    });
    if (presentation === 'categories' && (targets.length < 2 || targets.length > 4)) report('targets', `(categories) has ${targets.length} targets: two to four categories.`);
    if (presentation === 'pairs') {
      const taken = items.map((item) => item.target);
      const unmatched = targets.filter((target) => taken.filter((id) => id === target.id).length !== 1);
      if (items.length !== targets.length || unmatched.length) report('targets', `(pairs) does not match one to one: ${items.length} items for ${targets.length} targets${unmatched.length ? `, ${unmatched.map((target) => `"${String(target.id)}"`).join(', ')} not taken by exactly one item` : ''}.`);
    }
  }
  items.forEach((item, index) => checkPicture(ctx, place, item.image, item.alt, `items/${index}/`, `Item "${String(item.id)}"`));
  if (presentation !== 'order') targets.forEach((target, index) => checkPicture(ctx, place, target.image, target.alt, `targets/${index}/`, `Target "${String(target.id)}"`));
  checkFeedback(ctx, place, props, 'Sort');
  checkMarkdown(ctx, props.stem, file, at('stem'), block.id);
}

export function checkReflection(ctx: CheckContext, { block, file, at }: Place, props: Record<string, unknown>): void {
  checkMarkdown(ctx, props.prompt, file, at('prompt'), block.id);
  checkMarkdown(ctx, props.model, file, at('model'), block.id);
}

// presentation images: a picture per option; image: one picture, and a zone per option.
export function checkQuizPictures(ctx: CheckContext, place: Place, props: Record<string, unknown>, question: Record<string, unknown>): void {
  const { block, file, at } = place;
  const report = (path: string, message: string) => ctx.reporter.emit('E_QUIZ_PICTURE', { file, path: at(path), target: block.id, message: `Quiz "${block.id}" ${message}` });
  const options = list(question.options).map(fieldsOf);
  const planned = props.questionRef ? ` (the plan's question ${String(props.questionRef)} has none: write it inline, or fork the quiz)` : '';
  if (props.presentation === 'images') {
    options.forEach((option, index) => {
      if (!option.image) report(`options/${index}`, `(images): option "${String(option.id)}" has no image${planned}.`);
      else checkPicture(ctx, place, option.image, option.alt, `options/${index}/`, `Option "${String(option.id)}"`);
    });
  } else if (props.presentation === 'image') {
    if (!props.image) report('image', '(image) has no picture to place its zones on.');
    else checkPicture(ctx, place, props.image, props.alt, '', 'The picture');
    options.forEach((option, index) => {
      if (typeof option.x !== 'number' || typeof option.y !== 'number') report(`options/${index}`, `(image): option "${String(option.id)}" has no place on the picture (x and y, 0 to 1)${planned}.`);
    });
  }
}
