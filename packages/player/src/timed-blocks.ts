// Timed blocks (docs/decisions.md D28): what is seen of a timed screen at a time t. A block with a
// timing comes at timing.in and leaves at timing.out with an effect; between them it is there, before
// and after it keeps its place hidden (nothing moves around it) and out of reach (inert). Effects are
// Web Animations created paused, whose currentTime the timeline sets at every frame: playing,
// seeking back and forth, changing the speed and capturing a time are one computation.
//
// Effects move the block relative to its place (opacity, translate, scale, clip-path, strokes),
// never the layout. Under reduced motion each becomes a short fade, at the same times. A theme's
// effect is its stylesheet's @keyframes t-fx-<name> (and t-fx-<name>-out for leaving: otherwise
// played backwards), read from the page's stylesheets.

import type { BlockData, MomentData, TimingData } from './course-data.ts';

export type TimedState = 'before' | 'entering' | 'shown' | 'leaving' | 'after';

export interface TimedBlocks {
  // Places every timed block at t (seconds on the timeline).
  apply(time: number): void;
  // The state of a block at the time applied last (shown: no timing).
  state(blockId: string): TimedState;
  // Whether a block is timed; its effect's progress (0 to 1) while it comes or goes, else null.
  has(blockId: string): boolean;
  progress(blockId: string): number | null;
  // Blocks hidden by their timing at the time applied last.
  hidden(): string[];
  dispose(): void;
}

// A short fade replaces every effect under reduced motion.
const REDUCED_SECONDS = 0.2;
const EASE_IN = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
const EASE_OUT = 'cubic-bezier(0.5, 0, 0.75, 0)';
const DRAWN = 'path, line, polyline, polygon, circle, ellipse, rect';

// The dash a shape is drawn with: as long as its longest subpath. A dash pattern starts again at
// every subpath, so a path of many (the hatching of an engraving: one path, hundreds of short
// lines) drawn with its total length showed every line at once; with its longest subpath's length,
// each line grows from its start at the same pace.
const lengths = new WeakMap<SVGGeometryElement, number>();
function strokeLength(shape: SVGGeometryElement): number {
  const known = lengths.get(shape);
  if (known !== undefined) return known;
  let length = 0;
  try {
    length = shape.getTotalLength();
    const d = shape instanceof SVGPathElement ? shape.getAttribute('d') ?? '' : '';
    const parts = (d.match(/[Mm]/g)?.length ?? 0) > 1 ? subpaths(d) : [];
    if (parts.length > 1) {
      const probe = shape.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
      probe.setAttribute('visibility', 'hidden');
      shape.parentNode?.appendChild(probe);
      length = 0;
      for (const part of parts) { probe.setAttribute('d', part); length = Math.max(length, probe.getTotalLength()); }
      probe.remove();
    }
  } catch { /* not rendered */ }
  length = Math.ceil(length);
  lengths.set(shape, length);
  return length;
}

// The subpaths of path data, each starting with an absolute moveto (a relative one after the first
// is relative to where the previous subpath ended, which is followed through every command). An
// arc's two flags are one digit each, written together or not (« a5 5 0 105 5 »). Path data it
// cannot read to its end gives no subpaths: the shape is then drawn with its total length.
const ARGUMENTS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;
export function subpaths(d: string): string[] {
  const parts: string[][] = [];
  let x = 0, y = 0, startX = 0, startY = 0;
  let command = '';
  let i = 0;
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  for (skip(); i < d.length; skip()) {
    if (/[a-zA-Z]/.test(d[i])) command = d[i++];
    const lower = command.toLowerCase();
    const count = ARGUMENTS[lower];
    if (count === undefined) return [];
    const relative = command === lower;
    if (lower === 'z') { x = startX; y = startY; parts.at(-1)?.push('Z'); skip(); if (i < d.length && !/[a-zA-Z]/.test(d[i])) return []; continue; }
    const args: number[] = [];
    for (let k = 0; k < count; k++) {
      skip();
      const flag = lower === 'a' && (k === 3 || k === 4);
      const found = flag ? /^[01]/.exec(d.slice(i)) : NUMBER.exec(d.slice(i));
      if (!found) return [];
      args.push(Number(found[0]));
      i += found[0].length;
    }
    if (lower === 'm') {
      x = relative ? x + args[0] : args[0];
      y = relative ? y + args[1] : args[1];
      startX = x; startY = y;
      parts.push([`M${x} ${y}`]);
      command = relative ? 'l' : 'L'; // pairs after a moveto are linetos of its kind
      continue;
    }
    if (!parts.length) return [];
    parts.at(-1)!.push(`${command}${args.join(' ')}`);
    if (lower === 'h') x = relative ? x + args[0] : args[0];
    else if (lower === 'v') y = relative ? y + args[0] : args[0];
    else { x = relative ? x + args[count - 2] : args[count - 2]; y = relative ? y + args[count - 1] : args[count - 1]; }
  }
  return parts.map((part) => part.join(''));
}

type Frames = Keyframe[];
interface Played { animations: Animation[] }

interface Entry {
  id: string;
  timing: TimingData;
  node: HTMLElement | null;
  in: Played | null;
  out: Played | null;
  state: TimedState;
  progress: number | null;
}

// Every block with a timing, at any depth (contents of stacks and of other components' slots).
export function timedBlocksOf(blocks: readonly BlockData[]): BlockData[] {
  const out: BlockData[] = [];
  const walk = (list: readonly BlockData[] | undefined) => { for (const block of list ?? []) { if (block.timing && (block.timing.in || block.timing.out)) out.push(block); walk(block.blocks); } };
  walk(blocks);
  return out;
}

export function createTimedBlocks(root: ParentNode, blocks: readonly BlockData[], { reducedMotion = false, onChange }: { reducedMotion?: boolean; onChange?: (node: HTMLElement, state: TimedState) => void } = {}): TimedBlocks {
  const entries: Entry[] = timedBlocksOf(blocks).map((block) => ({ id: block.id, timing: block.timing!, node: null, in: null, out: null, state: 'shown', progress: null }));
  const nodeOf = (entry: Entry) => {
    if (!entry.node?.isConnected) entry.node = root.querySelector<HTMLElement>(`[data-block="${CSS.escape(entry.id)}"]`);
    return entry.node;
  };
  const stop = (played: Played | null) => { for (const animation of played?.animations ?? []) animation.cancel(); };

  // Under reduced motion an effect is a short fade: it starts at the same time and ends sooner.
  const lasts = (moment: MomentData) => (reducedMotion && moment.effect !== 'none' ? Math.min(moment.duration, REDUCED_SECONDS) : moment.duration);

  function play(node: HTMLElement, moment: MomentData, kind: 'in' | 'out'): Played {
    const reduced = reducedMotion && moment.effect !== 'none';
    const effect = reduced ? 'fade' : moment.effect;
    const duration = Math.max(1, lasts(moment) * 1000);
    const options: KeyframeAnimationOptions = { duration, fill: 'both', easing: kind === 'in' ? EASE_IN : EASE_OUT };
    const animations: Animation[] = [];
    const add = (target: Element, frames: Frames, extra: KeyframeAnimationOptions = {}) => {
      const animation = target.animate(frames, { ...options, ...extra });
      animation.pause();
      animations.push(animation);
    };
    if (effect === 'draw') {
      // The strokes of the block's own drawing (inline SVG) are drawn; a block without one is wiped.
      const strokes = [...node.querySelectorAll<SVGGeometryElement>(DRAWN)].filter((shape) => typeof shape.getTotalLength === 'function');
      if (strokes.length) {
        for (const shape of strokes) {
          const length = strokeLength(shape);
          if (!length) continue;
          const drawn = [{ strokeDasharray: `${length}`, strokeDashoffset: `${length}` }, { strokeDasharray: `${length}`, strokeDashoffset: '0' }];
          add(shape, kind === 'in' ? drawn : [...drawn].reverse(), { easing: 'ease-in-out' });
        }
        return { animations };
      }
    }
    const frames = framesOf(effect === 'draw' ? 'wipe' : effect, moment.direction, kind);
    if (frames) add(node, frames.frames, frames.reverse ? { direction: 'reverse' } : {});
    return { animations };
  }

  function seek(played: Played, seconds: number) {
    for (const animation of played.animations) animation.currentTime = Math.max(0, seconds * 1000);
  }

  return {
    apply(time: number) {
      for (const entry of entries) {
        const node = nodeOf(entry);
        if (!node) continue;
        const { in: coming, out: going } = entry.timing;
        const inStart = coming ? coming.at : -Infinity;
        const inEnd = coming ? coming.at + lasts(coming) : -Infinity;
        const outStart = going ? going.at : Infinity;
        const outEnd = going ? going.at + lasts(going) : Infinity;
        const state: TimedState = time >= outEnd - 1e-6 ? 'after' : time >= outStart ? 'leaving' : time < inStart - 1e-6 ? 'before' : time < inEnd && coming && lasts(coming) > 0 ? 'entering' : 'shown';
        if (state === 'entering' && coming) {
          stop(entry.out); entry.out = null;
          entry.in ??= play(node, coming, 'in');
          seek(entry.in, time - inStart);
        } else if (state === 'leaving' && going) {
          stop(entry.in); entry.in = null;
          entry.out ??= play(node, going, 'out');
          seek(entry.out, time - outStart);
        } else {
          stop(entry.in); stop(entry.out);
          entry.in = entry.out = null;
        }
        const fraction = (start: number, moment: MomentData) => Math.round(Math.min(1, Math.max(0, (time - start) / Math.max(1e-6, lasts(moment)))) * 1000) / 1000;
        entry.progress = state === 'entering' && coming ? fraction(inStart, coming) : state === 'leaving' && going ? fraction(outStart, going) : null;
        const hidden = state === 'before' || state === 'after';
        if (hidden) node.dataset.tTimed = state; else delete node.dataset.tTimed;
        if (state !== entry.state) { entry.state = state; onChange?.(node, state); }
      }
    },
    state: (blockId) => entries.find((entry) => entry.id === blockId)?.state ?? 'shown',
    has: (blockId) => entries.some((entry) => entry.id === blockId),
    progress: (blockId) => entries.find((entry) => entry.id === blockId)?.progress ?? null,
    hidden: () => entries.filter((entry) => entry.state === 'before' || entry.state === 'after').map((entry) => entry.id),
    dispose() {
      for (const entry of entries) {
        stop(entry.in); stop(entry.out);
        if (entry.node) delete entry.node.dataset.tTimed;
      }
    }
  };
}

// The keyframes of an effect as the block comes (in) or goes (out); reverse: play them backwards.
function framesOf(effect: string, direction: MomentData['direction'], kind: 'in' | 'out'): { frames: Frames; reverse?: boolean } | null {
  const away = (distance: string): string => {
    switch (direction ?? 'left') {
      case 'right': return `${distance} 0`;
      case 'up': return `0 -${distance}`;
      case 'down': return `0 ${distance}`;
      default: return `-${distance} 0`;
    }
  };
  const built = (from: Keyframe, to: Keyframe): Frames => (kind === 'in' ? [from, to] : [to, from]);
  switch (effect) {
    case 'none': return null;
    case 'fade': return { frames: built({ opacity: 0 }, { opacity: 1 }) };
    case 'rise': return { frames: built({ opacity: 0, translate: '0 0.75rem' }, { opacity: 1, translate: '0 0' }) };
    case 'slide': return { frames: built({ opacity: 0, translate: away('2.5rem') }, { opacity: 1, translate: '0 0' }) };
    case 'zoom': return { frames: built({ opacity: 0, scale: '0.85' }, { opacity: 1, scale: '1' }) };
    case 'wipe': {
      // From the left: uncovered from left to right (and covered back towards it).
      const hidden = { left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)', up: 'inset(0 0 100% 0)', down: 'inset(100% 0 0 0)' }[direction ?? 'left'];
      return { frames: built({ clipPath: hidden }, { clipPath: 'inset(0 0 0 0)' }) };
    }
    default: {
      const own = themeKeyframes(`t-fx-${effect}${kind === 'out' ? '-out' : ''}`);
      if (own) return { frames: own };
      const coming = kind === 'out' ? themeKeyframes(`t-fx-${effect}`) : null;
      if (coming) return { frames: coming, reverse: true };
      return { frames: built({ opacity: 0 }, { opacity: 1 }) };
    }
  }
}

// A @keyframes rule of the page's stylesheets (cascade layers included) as Web Animations keyframes.
const keyframesCache = new Map<string, Frames | null>();
function themeKeyframes(name: string): Frames | null {
  if (keyframesCache.has(name)) return keyframesCache.get(name)!;
  let found: Frames | null = null;
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (found) return;
      if (rule instanceof CSSKeyframesRule && rule.name === name) found = keyframesOf(rule);
      // The theme comes in by @import into its cascade layer (elabora/theme.css).
      else if (rule instanceof CSSImportRule) { try { if (rule.styleSheet) visit(rule.styleSheet.cssRules); } catch { /* another origin */ } }
      else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try { visit(sheet.cssRules); } catch { /* another origin */ }
    if (found) break;
  }
  keyframesCache.set(name, found);
  return found;
}

function keyframesOf(rule: CSSKeyframesRule): Frames {
  const frames: (Keyframe & { offset: number })[] = [];
  for (const frame of rule.cssRules) {
    if (!(frame instanceof CSSKeyframeRule)) continue;
    for (const key of frame.keyText.split(',')) {
      const text = key.trim();
      const offset = text === 'from' ? 0 : text === 'to' ? 1 : parseFloat(text) / 100;
      if (!Number.isFinite(offset)) continue;
      const keyframe: Keyframe & { offset: number } = { offset };
      for (let index = 0; index < frame.style.length; index++) {
        const property = frame.style[index];
        const camel = property.startsWith('--') ? property : property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        keyframe[camel] = frame.style.getPropertyValue(property);
      }
      frames.push(keyframe);
    }
  }
  return frames.sort((a, b) => a.offset - b.offset);
}

// Forgets what was read of the stylesheets (the canvas replaces them).
export function forgetThemeKeyframes(): void {
  keyframesCache.clear();
}
