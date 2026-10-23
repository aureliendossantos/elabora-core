import { analysisOf, instanceBehavior } from '../components/registry.ts';
import type { ComponentDescriptor } from '../components/registry.ts';
import { screenBlocks, resolveBlockProps } from '../project/load.ts';
import { valuesOfKind } from '../components/props.ts';
import type { Block, Screen } from '../project/model.ts';
import type { CourseCheckContext, ScreenFile } from './context.ts';
import { list, fieldsOf, text, byId, hasId } from './guards.ts';

// Course-level pedagogical heuristics (guardrails B1, E3) and screen completion coherence.
// Activities are recognised by behaviour (forks of quiz count), blocks in slots included.
const ACTIVITY_BEHAVIORS = new Set(['quiz', 'numeric', 'decision', 'dialogue', 'object', 'predict']);
const STREAK_LIMIT = 4; // exposition screens in a row before a warning (guardrail B1, to calibrate)
// Text density. Slides: a screen is one view. Scroll presentation: a screen is a page (a lesson),
// read in stretches between things to do; a very long page is two lessons.
const WORDS_PER_SCREEN = 250;
const WORDS_PER_STRETCH = 450;
const WORDS_PER_PAGE = 1500;
// Blocks that break a stretch of reading: activities, controls of templates (tabs, disclosures,
// buttons), disclosures and media.
const CONTROL_HOOK = /data-t-(tab|toggle|click)\b/;
const BREAKING_TYPES = new Set(['accordion', 'button', 'video', 'audio']);

const words = (value: unknown) => text(value).replace(/[#*_`>\[\]()!-]/g, ' ').split(/\s+/).filter(Boolean).length;

// Words the learner does not read on the page: props a template binds only in attributes that a screen
// reader says (alt, aria-label…), by their last key (alt, items.*.alt). An image's alt is not reading.
const UNREAD_ATTRS = new Set(['alt', 'aria-label', 'aria-description', 'aria-roledescription', 'title']);
const unreadCache = new WeakMap<ComponentDescriptor, Set<string>>();
function unreadKeys(component: ComponentDescriptor): Set<string> {
  let keys = unreadCache.get(component);
  if (keys) return keys;
  const refs = analysisOf(component)?.refs ?? [];
  const leaf = (path: string) => path.split('.').at(-1)!;
  const shown = new Set(refs.filter((ref) => !(ref.where === 'attr' && ref.attr && UNREAD_ATTRS.has(ref.attr))).map((ref) => leaf(ref.path)));
  keys = new Set(refs.filter((ref) => ref.where === 'attr' && ref.attr && UNREAD_ATTRS.has(ref.attr)).map((ref) => leaf(ref.path)).filter((key) => !shown.has(key)));
  unreadCache.set(component, keys);
  return keys;
}

// Blocks the learner sees on the screen itself (layers are opened by events).
function shownBlocks(data: Screen, file: string): Block[] {
  return [...screenBlocks(data, file)].filter((location) => !location.layer && location.block !== null && location.block !== undefined).map((location) => location.block);
}

const hasActivity = (ctx: CourseCheckContext, blocks: Block[]) => blocks.some((block) => hasId(ACTIVITY_BEHAVIORS, instanceBehavior(ctx.registry, block)));

// Text density and completion of a screen.
export function checkScreenPedagogy(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { reporter, planIndex, registry } = ctx;
  const { id, file, data } = screen;
  const blocks = shownBlocks(data, file);
  const wordsOf = (block: Block): number => {
    const component = registry.get(block.type);
    if (!component) return 0;
    if (!component.builtin && !component.root) {
      const unread = unreadKeys(component);
      return valuesOfKind(component.schema, resolveBlockProps(block, planIndex, registry), ['text', 'markdown']).filter((found) => !unread.has(found.path.split('/').at(-1)!)).reduce((sum, found) => sum + words(found.value), 0);
    }
    const props = fieldsOf(block.props);
    const locked = props.textRef ? byId(planIndex.texts, props.textRef)?.text : null;
    let count = words(props.markdown || locked || props.text || props.stem || props.prompt);
    if (component.root === 'quiz' || component.root === 'decision') count += list(props.options).reduce((sum: number, option) => { const fields = fieldsOf(option); return sum + words(fields.text || fields.label); }, 0);
    return count;
  };
  const count = blocks.reduce((sum, block) => sum + wordsOf(block), 0);
  if ((ctx.course.presentation?.mode || 'scroll') === 'slides') {
    if (count > WORDS_PER_SCREEN) reporter.emit('W_TEXT_DENSITY', { file, target: id, measured: count, limit: WORDS_PER_SCREEN, key: `${id}/slide@${count}`, message: `Screen "${id}" shows about ${count} words.` });
  } else {
    // The longest stretch of reading between two things to do, in reading order.
    const breaks = (block: Block) => hasId(ACTIVITY_BEHAVIORS, instanceBehavior(registry, block)) || BREAKING_TYPES.has(block.type) || CONTROL_HOOK.test(registry.get(block.type)?.template || '');
    let stretch = { words: 0, first: '', last: '' };
    let longest = stretch;
    for (const block of blocks) {
      if (breaks(block)) { stretch = { words: 0, first: '', last: '' }; continue; }
      const found = wordsOf(block);
      if (!found) continue;
      stretch = { words: stretch.words + found, first: stretch.first || block.id, last: block.id };
      if (stretch.words > longest.words) longest = stretch;
    }
    if (count > WORDS_PER_PAGE) reporter.emit('W_TEXT_DENSITY', { file, target: id, measured: count, limit: WORDS_PER_PAGE, key: `${id}/page@${count}`, message: `Page "${id}" is about ${count} words long: two lessons rather than one.` });
    else if (longest.words > WORDS_PER_STRETCH) reporter.emit('W_TEXT_DENSITY', { file, target: id, measured: longest.words, limit: WORDS_PER_STRETCH, key: `${id}/stretch/${longest.first}@${longest.words}`, message: `Page "${id}" has about ${longest.words} words to read in a row, from "${longest.first}" to "${longest.last}", with nothing to do.` });
  }

  if (hasActivity(ctx, blocks) && (data.completeWhen || 'viewed') === 'viewed') {
    reporter.emit('W_COMPLETION_MISMATCH', { file, path: '/completeWhen', target: id, message: `Screen "${id}" has an activity but completes as soon as it is viewed.` });
  }
}

// Screens in a row, in learner order, without learner activity (intro and summary screens are
// neutral).
export function checkExpositionStreak(ctx: CourseCheckContext): void {
  let streak = 0;
  let streakStart: string | null = null;
  for (const { id } of ctx.order) {
    const entry = ctx.screens.get(id);
    if (!entry) continue;
    const { data, file } = entry;
    const kinds = list(data.covers).map((itemId) => ctx.planIndex.items.get(itemId)?.kind);
    const neutral = kinds.length && kinds.every((kind) => kind === 'intro' || kind === 'summary');
    if (hasActivity(ctx, shownBlocks(data, file))) { streak = 0; streakStart = null; }
    else if (!neutral) {
      if (streak === 0) streakStart = id;
      streak++;
      if (streak === STREAK_LIMIT + 1) ctx.reporter.emit('W_EXPOSITION_STREAK', { file, target: id, measured: streak, limit: STREAK_LIMIT, message: `${streak} screens in a row without learner activity, from "${streakStart}" to "${id}".` });
    }
  }
}
