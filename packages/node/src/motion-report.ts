import type { Page } from 'playwright-core';
import type { LayoutRect } from '@elabora/player/canvas-protocol';

// What moves on a page of a course and where its blocks are in the window (elabora look --scroll and
// --block, its --json and the note of elabora_look). Measured in any page that shows a screen (the
// canvas of looks, a package in the player): blocks are the .t-block[data-block] elements, the window
// scrolls.
//
// A block's animations are the CSS animations and transitions of the block's own elements and of
// its descendants, in the innermost block that holds their element (except for the block measured
// alone, which gets all of them); the others (a backdrop) are the page's. A scroll-driven animation (a
// scroll() or view() timeline of the window) whose progress stays under its end at the page's
// maximum scroll cannot finish: the page is too short for its range, and learners never see its last
// state (opacity under 1, a rotation left).

export type TimelineKind = 'time' | 'scroll' | 'view' | 'none';

export interface AnimationFact {
  kind: 'animation' | 'transition';
  // The animation's name (@keyframes), the property of a transition.
  name: string;
  // The element it moves: tag.class, ::pseudo-element.
  target: string;
  timeline: TimelineKind;
  // A scroll-driven animation's range, as animation-range gives it ("entry 40% → cover 52%").
  range?: string;
  state: string; // running, paused, finished
  endless?: boolean; // infinite iterations, document time
  // Overall progress now, 0 to 1 (null: not started, no time).
  progress: number | null;
  // Scroll-driven, on the window's scroll: progress at the page's maximum scroll.
  atEnd?: number | null;
  cannotFinish?: boolean;
  // Cannot finish: the animated properties at the maximum scroll, and what the last keyframe asks.
  stuck?: { property: string; value: string; to: string | null }[];
}

export interface BlockMotion {
  id: string;
  // Inside the window, partly (clipped), or not at all; ratio: the share of its height in the window.
  visibility: 'visible' | 'clipped' | 'outside';
  ratio: number;
  hidden: boolean; // a pending step, a concealed or timed block
  rect: LayoutRect; // px of the page
  animations: AnimationFact[];
}

export interface MotionReport {
  scroll: { top: number; max: number };
  scope: 'window' | 'page' | 'block';
  // Animations on (false: the page prefers reduced motion, its animations are mostly off).
  motion: boolean;
  // scope 'window': the blocks in the window; 'page': the blocks that move; or the block asked for.
  blocks: BlockMotion[];
  // Animations of no block (a backdrop, the bars).
  page: AnimationFact[];
  // Every scroll-driven animation of the page that cannot finish, wherever it is.
  unfinished: { block: string | null; name: string; target: string; atEnd: number | null }[];
}

export interface MotionOptions {
  // One block (all the animations below it), whether in the window or not.
  block?: string;
  scope?: 'window' | 'page';
}

// Measures in the page as it is (scrolled where it stands). When scroll-driven animations of the
// window run, it scrolls to the end for their progress there, then back.
export async function measureMotion(page: Page, { block, scope = 'window' }: MotionOptions = {}): Promise<MotionReport> {
  const found = await page.evaluate(readMotion, { block: block ?? null, scope });
  if ('error' in found) throw new Error(found.error);
  return found;
}

// In the page.
async function readMotion({ block, scope }: { block: string | null; scope: 'window' | 'page' }): Promise<MotionReport | { error: string }> {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const BLOCKS = '.t-block[data-block]';
  const root = document.scrollingElement ?? document.documentElement;
  const top = Math.round(scrollY);
  const max = Math.max(0, Math.round(root.scrollHeight - innerHeight));
  const only = block === null ? null : document.querySelector<HTMLElement>(`${BLOCKS.replace(']', `="${CSS.escape(block)}"]`)}`);
  if (block !== null && !only) {
    const ids = [...document.querySelectorAll<HTMLElement>(`#t-main ${BLOCKS}`)].map((node) => node.dataset.block);
    return { error: `No block "${block}" in the page. Blocks: ${ids.join(', ')}` };
  }
  const constructorOf = (name: string): (abstract new (...args: never[]) => unknown) | null => {
    const value: unknown = Reflect.get(globalThis, name);
    return typeof value === 'function' ? value as abstract new (...args: never[]) => unknown : null;
  };
  const ViewTimelineClass = constructorOf('ViewTimeline');
  const ScrollTimelineClass = constructorOf('ScrollTimeline');
  const CSSAnimationClass = constructorOf('CSSAnimation');
  const CSSTransitionClass = constructorOf('CSSTransition');
  const timelineOf = (animation: Animation): TimelineKind => {
    const timeline = animation.timeline;
    if (!timeline) return 'none';
    if (ViewTimelineClass && timeline instanceof ViewTimelineClass) return 'view';
    if (ScrollTimelineClass && timeline instanceof ScrollTimelineClass) return 'scroll';
    return 'time';
  };
  // On the window's scroll (its max is the page's), not a box that scrolls inside it.
  const onWindow = (animation: Animation) => {
    const source: unknown = animation.timeline ? Reflect.get(animation.timeline, 'source') : null;
    return source === root || source === document.documentElement || source === document.body;
  };
  // Of an endless animation, the current iteration's.
  const progressOf = (animation: Animation): number | null => {
    const overall: unknown = animation.effect?.getComputedTiming().iterations === Infinity ? null : Reflect.get(animation, 'overallProgress');
    if (typeof overall === 'number') return round(overall);
    const progress = animation.effect?.getComputedTiming().progress;
    return typeof progress === 'number' ? round(progress) : null;
  };
  const rangeOf = (animation: Animation): string | undefined => {
    const side = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') {
        const name = Reflect.get(value, 'rangeName');
        const offset: unknown = Reflect.get(value, 'offset');
        return `${typeof name === 'string' && name !== 'none' ? name : ''} ${offset && typeof offset === 'object' ? String(offset) : ''}`.trim();
      }
      return 'normal';
    };
    const start = side(Reflect.get(animation, 'rangeStart'));
    const end = side(Reflect.get(animation, 'rangeEnd'));
    return start === 'normal' && end === 'normal' ? undefined : `${start} → ${end}`;
  };
  const targetOf = (animation: Animation): Element | null => {
    const effect = animation.effect;
    return effect instanceof KeyframeEffect ? effect.target : null;
  };
  const describe = (element: Element | null, pseudo: string | null) => {
    if (!element) return '(none)';
    const classes = [...element.classList].filter((name) => !/^t-block--/.test(name)).slice(0, 2);
    return `${element.localName}${classes.map((name) => `.${name}`).join('')}${pseudo ?? ''}`;
  };
  const properties = (animation: Animation): { property: string; to: string | null }[] => {
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect)) return [];
    const keyframes = effect.getKeyframes();
    const names = new Set<string>();
    for (const keyframe of keyframes) for (const name of Object.keys(keyframe)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(name)) names.add(name);
    return [...names].map((property) => {
      const last = [...keyframes].reverse().find((keyframe) => keyframe[property] !== undefined)?.[property];
      return { property, to: last === undefined || last === null ? null : String(last) };
    });
  };
  const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

  const animations = document.getAnimations().filter((animation) => animation.playState !== 'idle');
  const facts = animations.map((animation) => {
    const element = targetOf(animation);
    const effect = animation.effect;
    const pseudo = effect instanceof KeyframeEffect ? effect.pseudoElement : null;
    const transition = !!CSSTransitionClass && animation instanceof CSSTransitionClass;
    const name = transition ? String(Reflect.get(animation, 'transitionProperty')) : CSSAnimationClass && animation instanceof CSSAnimationClass ? String(Reflect.get(animation, 'animationName')) : animation.id || 'animation';
    const timeline = timelineOf(animation);
    const fact: AnimationFact = { kind: transition ? 'transition' : 'animation', name, target: describe(element, pseudo), timeline, state: animation.playState, progress: progressOf(animation) };
    const range = timeline === 'scroll' || timeline === 'view' ? rangeOf(animation) : undefined;
    if (range) fact.range = range;
    if (timeline === 'time' && effect?.getComputedTiming().iterations === Infinity) fact.endless = true;
    return { animation, element, fact };
  });

  // The window at its end for the progress there, then back where it was.
  const driven = facts.filter((entry) => (entry.fact.timeline === 'scroll' || entry.fact.timeline === 'view') && onWindow(entry.animation));
  if (driven.length) {
    const back = scrollY;
    scrollTo({ top: max, behavior: 'instant' });
    await frames();
    for (const { animation, element, fact } of driven) {
      fact.atEnd = progressOf(animation);
      fact.cannotFinish = fact.atEnd === null || fact.atEnd < 0.999;
      if (!fact.cannotFinish || !element) continue;
      const effect = animation.effect;
      const style = getComputedStyle(element, effect instanceof KeyframeEffect ? effect.pseudoElement : null);
      fact.stuck = properties(animation).map(({ property, to }) => ({ property: kebab(property), value: style.getPropertyValue(kebab(property)), to }));
    }
    scrollTo({ top: back, behavior: 'instant' });
    await frames();
  }

  const holder = (element: Element | null): HTMLElement | null => (element ? element.closest<HTMLElement>(BLOCKS) : null);
  const blockMotion = (node: HTMLElement, own: AnimationFact[]): BlockMotion => {
    const box = node.getBoundingClientRect();
    const height = Math.max(1, box.height);
    const ratio = box.height > 0 ? round(Math.min(1, Math.max(0, (Math.min(box.bottom, innerHeight) - Math.max(box.top, 0)) / height))) : 0;
    return {
      id: node.dataset.block ?? '', visibility: ratio >= 0.999 ? 'visible' : ratio > 0 ? 'clipped' : 'outside', ratio,
      hidden: !!node.closest('[data-t-pending], [data-t-concealed], [data-t-timed]'),
      rect: { x: Math.round(box.left + scrollX), y: Math.round(box.top + scrollY), width: Math.round(box.width), height: Math.round(box.height) },
      animations: own
    };
  };
  const blocks: BlockMotion[] = [];
  const page: AnimationFact[] = [];
  if (only) blocks.push(blockMotion(only, facts.filter((entry) => entry.element && only.contains(entry.element)).map((entry) => entry.fact)));
  else {
    const byBlock = new Map<HTMLElement, AnimationFact[]>();
    for (const entry of facts) {
      const node = holder(entry.element);
      if (!node) { page.push(entry.fact); continue; }
      byBlock.set(node, [...(byBlock.get(node) ?? []), entry.fact]);
    }
    for (const node of document.querySelectorAll<HTMLElement>(`#t-main ${BLOCKS}, dialog.t-layer[open] ${BLOCKS}`)) {
      const measured = blockMotion(node, byBlock.get(node) ?? []);
      if (scope === 'window' ? measured.ratio > 0 : measured.animations.length > 0) blocks.push(measured);
    }
  }
  const unfinished = facts.filter((entry) => entry.fact.cannotFinish).map((entry) => ({ block: holder(entry.element)?.dataset.block ?? null, name: entry.fact.name, target: entry.fact.target, atEnd: entry.fact.atEnd ?? null }));
  return { scroll: { top, max }, scope: only ? 'block' : scope, motion: !matchMedia('(prefers-reduced-motion: reduce)').matches, blocks, page, unfinished };
}

// The report in a few lines, for people and agents (elabora look, the note of elabora_look). Alike
// animations (the same on several elements) are counted once; of the blocks of a whole page, only the
// animations that cannot finish are listed.
export function motionText(report: MotionReport, { limit = 6 }: { limit?: number } = {}): string[] {
  const percent = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)} %`);
  const animation = (fact: AnimationFact) => {
    const timeline = fact.timeline === 'time' ? (fact.endless ? 'time, endless' : 'time') : `${fact.timeline}${fact.range ? ` ${fact.range}` : ''}`;
    const end = fact.cannotFinish
      ? `, CANNOT FINISH: ${percent(fact.atEnd)} at the end of the page${fact.stuck?.length ? ` (${fact.stuck.map((stuck) => `${stuck.property} ${stuck.value}${stuck.to !== null ? `, to ${stuck.to}` : ''}`).join('; ')})` : ''}`
      : fact.atEnd !== undefined ? `, ${percent(fact.atEnd)} at the end of the page` : '';
    return `${fact.name} on ${fact.target} (${timeline}): ${percent(fact.progress)}${end}`;
  };
  const list = (facts: AnimationFact[], onlyUnfinished: boolean) => {
    const counted = new Map<string, number>();
    for (const fact of [...facts.filter((each) => each.cannotFinish), ...facts.filter((each) => !each.cannotFinish && !onlyUnfinished)]) {
      const line = animation(fact);
      counted.set(line, (counted.get(line) ?? 0) + 1);
    }
    const lines = [...counted].map(([line, count]) => `    ${line}${count > 1 ? ` (×${count})` : ''}`);
    const shown = lines.slice(0, limit);
    return [...shown, ...(lines.length > shown.length ? [`    … ${lines.length - shown.length} more (--json)`] : [])];
  };
  const page = report.scope === 'page';
  const lines = [`Scrolled ${report.scroll.top} of ${report.scroll.max} px${report.motion ? '' : ' — reduced motion: animations off (--motion)'}`];
  for (const block of report.blocks) {
    const unfinished = block.animations.filter((fact) => fact.cannotFinish).length;
    const where = page ? '' : `${block.visibility}${block.visibility === 'clipped' ? ` (${percent(block.ratio)} in the window)` : ''}${block.hidden ? ', hidden' : ''}, `;
    const moves = block.animations.length ? `${block.animations.length} animation(s)${unfinished ? `, ${unfinished} cannot finish` : block.animations.some((fact) => fact.atEnd !== undefined) ? ', all can finish' : ''}` : 'no animation';
    lines.push(`  ${block.id}: ${where}${moves}`, ...list(block.animations, page));
  }
  if (report.page.length) lines.push('  page (no block):', ...list(report.page, false));
  const elsewhere = report.unfinished.filter((entry) => entry.block !== null && !report.blocks.some((block) => block.id === entry.block));
  if (elsewhere.length) lines.push(`  cannot finish elsewhere: ${elsewhere.map((entry) => `${entry.block} ${entry.name} (${percent(entry.atEnd)})`).join(', ')}`);
  return lines;
}
