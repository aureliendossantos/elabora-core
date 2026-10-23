// The review bridge's protocol, elabora-review/1 (docs/review-bridge.md, docs/decisions.md D42): what
// a module built for the Revue (elabora build --target web --review-origin …) and the review page that
// shows it in an iframe say to each other with postMessage. Types and pure functions only, no DOM: the
// module's side is review.ts (elabora/review.js, in review builds only), and a review page may import
// this file for the same types, the origin rule, the text sizes and the anchor it builds.
//
//   module → page   window.parent.postMessage(message, <the page's origin>)
//     ready      the build, the course, its languages and its screens
//     layout     the text size the module takes, its column, the size thresholds, the margin kept
//     location   the screen, the step, the open layer; on a narrated screen the time, the line (its
//                text and speaker) and the word
//     key        the reviewer pressed C inside the module: the page's « Commenter » shortcut
//     blocks     the blocks of what is shown, with their names, boxes and reading order
//     went       the answer to go: what of the anchor was found
//     measured   the answer to measure: text size and widest column for a frame of another size
//     error      a message the module could not take
//   page → module   iframe.contentWindow.postMessage(message, <the module's origin>)
//     hello      the page listens: ready, layout, location and blocks again
//     go         to an anchor: screen, step, layer, moment, block scrolled to and highlighted
//     pause      the narration pauses (comment mode); resume plays it again if it played
//     layout     the margin the page keeps on the right (a floating panel)
//     measure    text size and widest column for a frame of another size (the docking rule)
//     scroll     a wheel turned over the page's overlay, passed on
//
// Every message carries protocol: 'elabora-review/1'. A page message may carry an id; the answers to
// it (went, measured, layout, error) carry it back as re.

import { isRecord } from './json.ts';
import type { LayoutRect } from './canvas-protocol.ts';

export const REVIEW_PROTOCOL = 'elabora-review/1';

export type MessageId = string | number;

// ── The anchor ────────────────────────────────────────────────────────
// What a comment points at, the contract shared with the comments API of Elabora's hosting: the page
// builds it from ready, location and blocks (anchorFor), and gives it back to go.
export interface ReviewAnchor {
  // The course version commented (course.json version) and the module's language.
  version: string;
  language: string;
  // The screen's permanent key (D4, elabora.lock.json): it survives a renamed screen.
  screen: string;
  // The block pointed at (its id; renames are in the course's journal).
  block?: string;
  // The step shown, and the layer open, when the comment was written.
  step?: number;
  layer?: string;
  // On a timed screen: seconds on its timeline, and on a narrated one the line and the word said
  // then (D28), so that the comment survives a new take: go prefers the word, then the line, then
  // the time. occurrence: which time the word appears in the line (1: the first), left out for 1.
  // The line may be a layer's (D62: go opens the layer at it, time is then the layer's) or a
  // dialogue's (D61: go shows the dialogue; <node>.<option> for what its learner says aloud).
  // said and speaker: the line's text (at most SAID_MAX characters, around the word) and who says
  // it, as the module showed them, so that the page and the author's tools can say « when Marc says
  // "…" » without the module.
  time?: number;
  line?: string;
  word?: string;
  occurrence?: number;
  said?: string;
  speaker?: string;
  // Where in the block's box (0..1 from its top left), or in the frame without a block.
  point?: { x: number; y: number };
  // The size of the module's frame (CSS px): a remark at 375 px is not a remark at 1600 × 900.
  frame: { width: number; height: number };
}

// ── Module → page ─────────────────────────────────────────────────────

export interface ReviewScreen {
  // Permanent key (D4): what anchors name.
  key: string;
  id: string;
  title: string;
  section: string;
}

export interface ReadyMessage {
  protocol: typeof REVIEW_PROTOCOL;
  type: 'ready';
  build: { id: string };
  course: { id: string; version: string; title: string };
  // The module's language, and the languages the course has (its own and its translations).
  language: string;
  languages: string[];
  presentation: 'slides' | 'scroll';
  screens: ReviewScreen[];
}

// How the module's text size follows its frame (player.css): 16 px (the browser's default size,
// scale 1) above every rule; each rule that matches sets its scale, the last one winning. A rule
// matches when the frame is at most maxWidth wide, at most maxHeight high, or in portrait at most
// portraitMaxWidth wide.
export interface SizeRule {
  scale: number;
  maxWidth: number;
  maxHeight?: number;
  portraitMaxWidth?: number;
}

export const SIZE_RULES: readonly SizeRule[] = [
  { scale: 0.9375, maxWidth: 1499, maxHeight: 839 },
  { scale: 0.875, maxWidth: 1359, maxHeight: 759 },
  // Phones and portrait tablets: one step up again (player.css).
  { scale: 0.9375, maxWidth: 760, portraitMaxWidth: 1100 }
];

export interface LayoutMessage {
  protocol: typeof REVIEW_PROTOCOL;
  type: 'layout';
  re?: MessageId;
  frame: { width: number; height: number };
  // The root text size the module takes (CSS px), the browser's base size and the rules.
  fontSize: number;
  baseFontSize: number;
  sizes: readonly SizeRule[];
  // The column of the screen shown: its width (CSS px), the cap of the course's columns at this text
  // size, and whether the screen is full bleed (edge to edge, no column).
  column: { width: number; max: number; fullBleed: boolean };
  // The widest column the module can have in this frame: its cap, or the room the frame leaves.
  widest: number;
  // The margin the page keeps on the right, and whether the column moved into the room left (it
  // moves only when it keeps its width there).
  inset: { right: number; shifted: boolean };
  // The heights of the module's header and footer (its navigation): a floating panel sits between.
  chrome: { top: number; bottom: number };
}

export interface LocationMessage {
  protocol: typeof REVIEW_PROTOCOL;
  type: 'location';
  screen: string;
  index: number;
  step: number;
  steps: number[];
  layer: string | null;
  // A timed screen: its timeline. A narrated one: the line and the word said at that time, the
  // line's text (said) and its speaker's name when it has one (as captions show it).
  time?: number;
  duration?: number;
  playing?: boolean;
  line?: string;
  word?: string;
  occurrence?: number;
  said?: string;
  speaker?: string;
  // The page paused the narration (pause) and has not resumed it.
  held: boolean;
}

export interface ReviewBlock {
  id: string;
  // Its type (a built-in type or a course component), the built-in kind it is (from its lineage;
  // component when none), a short accessible name (« Image · Schéma du train ») in the module's
  // language and the words it is named by (null when it has none).
  type: string;
  kind: string;
  name: string;
  label: string | null;
  // Reading order on the screen, from 1.
  order: number;
  // In the frame's viewport, CSS px.
  rect: LayoutRect;
  layer: string | null;
  // The block whose slot holds it (a component instance).
  parent: string | null;
  // Not visible: a step to come, concealed by an event, or timed and not there at this time.
  hidden: boolean;
  // A free object: one block, its frame sandboxed.
  object?: true;
}

export interface BlocksMessage {
  protocol: typeof REVIEW_PROTOCOL;
  type: 'blocks';
  screen: string;
  step: number;
  layer: string | null;
  frame: { width: number; height: number };
  scroll: { x: number; y: number };
  blocks: ReviewBlock[];
}

// What of an anchor go found (missing: screen, step, layer, line, word, block).
export interface WentMessage {
  protocol: typeof REVIEW_PROTOCOL;
  type: 'went';
  re?: MessageId;
  ok: boolean;
  missing: AnchorPart[];
}

export type AnchorPart = 'screen' | 'step' | 'layer' | 'line' | 'word' | 'time' | 'block';

export interface MeasuredMessage {
  protocol: typeof REVIEW_PROTOCOL;
  type: 'measured';
  re?: MessageId;
  frame: { width: number; height: number };
  fontSize: number;
  widest: number;
}

// The reviewer pressed C (no modifier, outside a text field) while the focus was inside the module:
// keys pressed there never reach the page, which uses C for « Commenter ».
export interface KeyMessage {
  protocol: typeof REVIEW_PROTOCOL;
  type: 'key';
  key: 'c';
}

export interface ErrorMessage {
  protocol: typeof REVIEW_PROTOCOL;
  type: 'error';
  re?: MessageId;
  message: string;
}

export type ModuleMessage = ReadyMessage | LayoutMessage | LocationMessage | BlocksMessage | WentMessage | MeasuredMessage | KeyMessage | ErrorMessage;

// ── Page → module ─────────────────────────────────────────────────────

// The parts of an anchor go uses (version, language, point and frame are the comment's).
export type GoTarget = Partial<Pick<ReviewAnchor, 'block' | 'step' | 'layer' | 'time' | 'line' | 'word' | 'occurrence'>> & { screen: string };

export type PageMessage =
  | { type: 'hello'; id?: MessageId }
  | { type: 'go'; id?: MessageId; anchor: GoTarget; highlight: boolean }
  | { type: 'pause'; id?: MessageId }
  | { type: 'resume'; id?: MessageId }
  | { type: 'layout'; id?: MessageId; inset: { right: number } }
  | { type: 'measure'; id?: MessageId; frame: { width: number; height: number } }
  | { type: 'scroll'; id?: MessageId; by: { x: number; y: number }; at?: { x: number; y: number } };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPoint = (value: unknown): value is { x: number; y: number } => isRecord(value) && finite(value.x) && finite(value.y);
const isSize = (value: unknown): value is { width: number; height: number } => isRecord(value) && finite(value.width) && finite(value.height) && value.width > 0 && value.height > 0;
const isSlug = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

// A page message read from postMessage data: null when it is not one this version takes (another
// protocol, an unknown type, a field of the wrong kind). Unknown fields are ignored.
export function readPageMessage(data: unknown): PageMessage | null {
  if (!isRecord(data) || data.protocol !== REVIEW_PROTOCOL) return null;
  const id = typeof data.id === 'string' || finite(data.id) ? { id: data.id } : {};
  switch (data.type) {
    case 'hello': case 'pause': case 'resume': return { type: data.type, ...id };
    case 'go': {
      const anchor = goTarget(data.anchor);
      return anchor ? { type: 'go', ...id, anchor, highlight: data.highlight !== false } : null;
    }
    case 'layout': return isRecord(data.inset) && finite(data.inset.right) ? { type: 'layout', ...id, inset: { right: Math.max(0, data.inset.right) } } : null;
    case 'measure': return isSize(data.frame) ? { type: 'measure', ...id, frame: { width: data.frame.width, height: data.frame.height } } : null;
    case 'scroll': return isPoint(data.by) ? { type: 'scroll', ...id, by: { x: data.by.x, y: data.by.y }, ...(isPoint(data.at) ? { at: { x: data.at.x, y: data.at.y } } : {}) } : null;
    default: return null;
  }
}

// The parts of an anchor go takes; a whole comment anchor is one.
export function goTarget(value: unknown): GoTarget | null {
  if (!isRecord(value) || !isSlug(value.screen)) return null;
  const target: GoTarget = { screen: value.screen };
  if (isSlug(value.block)) target.block = value.block;
  if (finite(value.step) && value.step >= 1) target.step = Math.floor(value.step);
  if (isSlug(value.layer)) target.layer = value.layer;
  if (finite(value.time) && value.time >= 0) target.time = value.time;
  if (isSlug(value.line)) target.line = value.line;
  if (typeof value.word === 'string' && value.word.trim()) target.word = value.word;
  if (finite(value.occurrence) && value.occurrence > 1) target.occurrence = Math.floor(value.occurrence);
  return target;
}

// A protocol of the same family but another version: the module says which one it speaks.
export const otherVersion = (data: unknown): boolean => isRecord(data) && typeof data.protocol === 'string' && data.protocol.startsWith('elabora-review/') && data.protocol !== REVIEW_PROTOCOL;

// ── Origins ───────────────────────────────────────────────────────────
// A review build names the origins of the pages that may show it: an https origin
// (https://revue.elabora.studio), or http on this computer for development (http://localhost:5173,
// http://127.0.0.1:8787, http://revue.localhost:3000). The origin as the browser writes it
// (event.origin), or null when the value is not one: a path, a query, credentials, a wildcard.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost)$/i;
export function reviewOrigin(value: string): string | null {
  if (typeof value !== 'string' || /[*\s]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  if (!/^https?:\/\/[^/]+\/?$/i.test(value)) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOCAL_HOST.test(url.hostname)) return url.origin;
  return null;
}

// Whom the module listens to and posts to. ancestor: the embedder's origin when the browser says it
// (location.ancestorOrigins, Chrome and Safari). An embedder the build did not name gets nothing:
// silent. Otherwise the module posts to the embedder's origin, or to every allowed origin until one
// of them speaks (postMessage drops a message whose target origin is not the page's).
export function reviewPeer(origins: readonly string[], ancestor: string | undefined): { peer: string | null; silent: boolean } {
  if (ancestor === undefined) return { peer: null, silent: false };
  return origins.includes(ancestor) ? { peer: ancestor, silent: false } : { peer: null, silent: true };
}

// A message the module takes: from the window that embeds it, from an allowed origin, and from the
// page's origin once it is known.
export function acceptsFrom(origins: readonly string[], peer: string | null, message: { origin: string; fromParent: boolean }): boolean {
  return message.fromParent && origins.includes(message.origin) && (peer === null || peer === message.origin);
}

// ── Text sizes ────────────────────────────────────────────────────────
// The scale of the root text size in a frame of that size (1: the browser's base size).
export function textScale(frame: { width: number; height: number }, rules: readonly SizeRule[] = SIZE_RULES): number {
  let scale = 1;
  for (const rule of rules) {
    const matches = frame.width <= rule.maxWidth || (rule.maxHeight !== undefined && frame.height <= rule.maxHeight)
      || (rule.portraitMaxWidth !== undefined && frame.height >= frame.width && frame.width <= rule.portraitMaxWidth);
    if (matches) scale = rule.scale;
  }
  return scale;
}

// The widest column in a frame: the cap (rem) at the text size it takes, or the room it leaves
// (its width less the scrollbar and the screen's side padding, rem). Px, to the hundredth.
export function widestColumn(frame: { width: number; height: number }, { baseFontSize, capRem, paddingRem, scrollbar = 0, rules = SIZE_RULES }: { baseFontSize: number; capRem: number; paddingRem: number; scrollbar?: number; rules?: readonly SizeRule[] }): { fontSize: number; widest: number } {
  const fontSize = baseFontSize * textScale(frame, rules);
  const room = frame.width - scrollbar - 2 * paddingRem * fontSize;
  return { fontSize: hundredth(fontSize), widest: hundredth(Math.max(0, Math.min(capRem * fontSize, room))) };
}

const hundredth = (value: number) => Math.round(value * 100) / 100;

// ── Pointing ──────────────────────────────────────────────────────────
// The block under a point of the frame (viewport CSS px): the innermost visible block whose box holds
// it (a block in a component's slot before the component), the smallest box first; null outside every
// block. The page does this test from the blocks message, without a message per pointer move.
export function blockAt(blocks: readonly ReviewBlock[], point: { x: number; y: number }): ReviewBlock | null {
  const inside = blocks.filter((block) => !block.hidden && point.x >= block.rect.x && point.x <= block.rect.x + block.rect.width && point.y >= block.rect.y && point.y <= block.rect.y + block.rect.height);
  // A layer open over the screen takes the point before the screen under it.
  const layered = inside.some((block) => block.layer !== null) ? inside.filter((block) => block.layer !== null) : inside;
  const area = (block: ReviewBlock) => block.rect.width * block.rect.height;
  return layered.sort((a, b) => area(a) - area(b) || b.order - a.order)[0] ?? null;
}

// The anchor of a comment: the module's version and language (ready), where the learner is
// (location), and, when the reviewer pointed, the block and the point in it (blocks, a point of the
// frame); block null: the whole screen, the point in the frame. Times are kept to the millisecond.
export function anchorFor(ready: Pick<ReadyMessage, 'course' | 'language'>, location: Omit<LocationMessage, 'protocol' | 'type'>, frame: { width: number; height: number }, pointed?: { block: ReviewBlock | null; point: { x: number; y: number } } | null): ReviewAnchor {
  const anchor: ReviewAnchor = { version: ready.course.version, language: ready.language, screen: location.screen, frame: { width: Math.round(frame.width), height: Math.round(frame.height) } };
  const block = pointed?.block ?? null;
  if (block) anchor.block = block.id;
  anchor.step = location.step;
  // The layer the block is in, else the one open (a panel stays open beside the screen).
  const layer = block?.layer ?? location.layer;
  if (layer) anchor.layer = layer;
  if (location.time !== undefined) anchor.time = Math.round(location.time * 1000) / 1000;
  if (location.line) anchor.line = location.line;
  if (location.word) anchor.word = location.word;
  if (location.word && location.occurrence && location.occurrence > 1) anchor.occurrence = location.occurrence;
  if (location.line && location.said) anchor.said = saidAround(location.said, location.word, location.occurrence);
  if (location.line && location.speaker) anchor.speaker = location.speaker.slice(0, SPEAKER_MAX);
  if (pointed) {
    const box = block?.rect ?? { x: 0, y: 0, width: frame.width, height: frame.height };
    const along = (value: number, start: number, size: number) => (size > 0 ? Math.round(Math.min(1, Math.max(0, (value - start) / size)) * 10000) / 10000 : 0);
    anchor.point = { x: along(pointed.point.x, box.x, box.width), y: along(pointed.point.y, box.y, box.height) };
  }
  return orderedAnchor(anchor);
}

// The anchor's fields in the contract's order (stable JSON for the API).
function orderedAnchor(anchor: ReviewAnchor): ReviewAnchor {
  const keys = ['version', 'language', 'screen', 'block', 'step', 'layer', 'time', 'line', 'word', 'occurrence', 'said', 'speaker', 'point', 'frame'] as const;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (anchor[key] !== undefined) out[key] = anchor[key];
  return out as unknown as ReviewAnchor;
}

// ── The line said ─────────────────────────────────────────────────────
// The anchor keeps a line's text up to SAID_MAX characters (the comments API takes 4 KiB of anchor):
// a longer line is cut around the word said, at spaces, with « … » where it was cut.
export const SAID_MAX = 280;
export const SPEAKER_MAX = 60;

export function saidAround(text: string, word?: string, occurrence = 1, max = SAID_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  let at = 0;
  if (word) {
    const lower = normalizeWord(line);
    const wanted = normalizeWord(word);
    let from = 0;
    for (let seen = 0; seen < Math.max(1, occurrence); seen++) {
      const found = lower.indexOf(wanted, from);
      if (found < 0) break;
      at = found;
      from = found + wanted.length;
    }
  }
  const room = max - 2; // the two « … »
  let start = Math.max(0, Math.min(at - Math.floor(room / 3), line.length - room));
  let end = Math.min(line.length, start + room);
  if (start > 0) { const space = line.indexOf(' ', start); if (space >= 0 && space < at) start = space + 1; }
  if (end < line.length) { const space = line.lastIndexOf(' ', end); if (space > start && space > at) end = space; }
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}

// ── Words ─────────────────────────────────────────────────────────────
// A word as anchors compare it (the same as @elabora/core narration/words normalizeWord): Unicode NFC,
// lower case, one kind of apostrophe and hyphen.
export const normalizeWord = (word: string): string => word.normalize('NFC').toLowerCase().replace(/[’‘]/g, "'").replace(/‐/g, '-');

// The word said at a time in a line's word times ([word, start, end], timeline seconds): its index
// (the last one started), its text and which occurrence of that word in the line it is.
export function wordAt(words: readonly (readonly [string, number, number])[], time: number): { index: number; word: string; occurrence: number } | null {
  let index = -1;
  for (const [i, word] of words.entries()) { if (word[1] <= time + 1e-3) index = i; else break; }
  if (index < 0) return null;
  const word = words[index][0];
  const same = normalizeWord(word);
  const occurrence = words.slice(0, index + 1).filter((candidate) => normalizeWord(candidate[0]) === same).length;
  return { index, word, occurrence };
}

// When a word (or the first word of a few) is said in a line: the start of its occurrence-th time,
// null when the line no longer says it.
export function wordTime(words: readonly (readonly [string, number, number])[], phrase: string, occurrence = 1): number | null {
  const wanted = phrase.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (!wanted.length) return null;
  let seen = 0;
  for (let index = 0; index + wanted.length <= words.length; index++) {
    if (!wanted.every((target, offset) => normalizeWord(words[index + offset][0]) === target)) continue;
    if (++seen === Math.max(1, occurrence)) return words[index][1];
  }
  return null;
}
