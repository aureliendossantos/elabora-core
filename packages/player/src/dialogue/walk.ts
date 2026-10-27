// The walk of a dialogue (D61), written once and pure: the player plays it, the core replays it for
// `elabora dialogue play` and `paths`, the validation and the debrief. Nothing here touches the DOM
// or Node, and nothing is random: the same path always gives the same beats.
//
// A path is a list of entries:
//   "node.option"   the learner chose that option (a retry option stays in the path as a try of its
//                   decision: the same options come back);
//   "node.option~"  the learner chose it, then went back to that decision before the first run
//                   ended: its first choice, kept for the score, without its consequences;
//   ">node"         an event of the screen moved the dialogue to that node (goto-dialogue).
// Everything else (the beats to show, the variables, the decisions and their tries, the options
// greyed, the ending) is recomputed by replaying the entries from the start.
//
// The six steps:
//   1. enter a node: count the visit, play its lines in order (a line whose if fails is skipped);
//   2. offer its options: an option is greyed when it was retried here, hidden or greyed (its
//      unavailable) when its if fails or a once option was taken; when no option can be chosen, its
//      fallback is taken by itself, else the node's way out; one option left is not taken by itself;
//   3. choose: the learner's bubble, the effects (set, add; points count in the score) applied before
//      any later condition, the actions, the reply, the feedback when it is shown now;
//   4. leave: retry (the options again), else the option's next or end, else the node's way out (its
//      next, a node or the first case whose if holds; its end; the next node of the list; the end);
//   5. end: the first ending whose if holds (or the one named), else an ending without title;
//   6. a condition that cannot be evaluated (a node deleted since) holds.

import type { CompareOp, DialogueAction, DialogueCondition, DialogueData, DialogueEndingData, DialogueLineData, DialogueNodeData, DialogueOptionData, DialogueValue } from './types.ts';

// A path holds at most this many decisions (a loop of next without end would make it endless; the
// suspend data needs a worst case). The validator says when a dialogue can reach it.
export const MAX_DECISIONS = 60;
// Nodes entered between two decisions at most: a loop of next without options stops there.
const MAX_STEPS = 400;

export type Entry = string;

export interface DialogueEnv {
  // The course's variables, read only ({ variable } conditions).
  variable?(id: string): DialogueValue | undefined;
}

export type LineRole = 'character' | 'learner' | 'narration';

export type Beat =
  | { type: 'node'; node: string }
  | { type: 'line'; node: string; line: DialogueLineData; role: LineRole; option?: string }
  | { type: 'decision'; node: string; decision: number }
  | { type: 'choice'; node: string; option: string; decision: number; auto?: true }
  | { type: 'actions'; node: string; option: string; actions: DialogueAction[] }
  | { type: 'feedback'; node: string; option: string }
  | { type: 'retry'; node: string; option: string; decision: number }
  | { type: 'jump'; node: string }
  | { type: 'end'; ending: string | null; capped?: true };

export interface DialogueTry {
  option: string;
  // retry: an option with retry (its consequence was played); return: the learner went back to this
  // decision before the first run ended (its consequences are gone, its first choice stays).
  by: 'retry' | 'return';
}

export interface Decision {
  // Its place among the decisions of the path.
  index: number;
  node: string;
  // The option kept (null while the decision waits, or when only retries closed it).
  choice: string | null;
  tries: DialogueTry[];
  // Closed: chosen, or left by its way out once nothing could be chosen any more.
  closed: boolean;
  // A fallback taken by itself: not the learner's decision, never scored.
  auto?: true;
  final?: true;
  // The entries of the path it holds: [start, end).
  entries: [number, number];
  // Its "decision" beat.
  beat: number;
}

export interface OfferedOption {
  option: DialogueOptionData;
  enabled: boolean;
  // Why a greyed option cannot be chosen: retried here, its if fails, a once option already taken.
  reason?: 'retried' | 'if' | 'once';
}

export interface DialogueWalk {
  entries: Entry[];
  beats: Beat[];
  status: 'choosing' | 'ended';
  // The node of the decision waiting (choosing), or the last node entered (ended).
  node: string;
  // While choosing: the options shown, in order (greyed ones included, hidden and fallback ones not).
  offer: OfferedOption[];
  decisions: Decision[];
  vars: Record<string, DialogueValue>;
  // The nodes entered, in order (a node entered twice is there twice).
  seen: string[];
  // When ended: the ending reached (null: the ending without title).
  ending: DialogueEndingData | null;
  // The decisions cap, or a loop of nodes without options, stopped the walk.
  capped: boolean;
  // Replay stopped at an entry it could not apply (an option no longer offered, or gone from a new
  // version of the module): the walk is where that entry should have been applied.
  invalid: { index: number; entry: Entry; reason: string } | null;
}

export class DialogueError extends Error {}

type Exit = { go: string } | { end: true | string };

// The value of each quality in the quality score.
export const QUALITY_VALUE: Readonly<Record<string, number>> = { good: 1, ok: 0.5, bad: 0 };

// What scoring the score conditions read: quality when the dialogue is not scored.
const scoreKind = (data: DialogueData) => (data.scoring === 'none' ? 'quality' : data.scoring);

export function compare(left: unknown, op: CompareOp, right: unknown): boolean {
  switch (op) {
    case 'eq': return left === right;
    case 'neq': return left !== right;
    case 'gt': return typeof left === 'number' && typeof right === 'number' && left > right;
    case 'gte': return typeof left === 'number' && typeof right === 'number' && left >= right;
    case 'lt': return typeof left === 'number' && typeof right === 'number' && left < right;
    case 'lte': return typeof left === 'number' && typeof right === 'number' && left <= right;
    default: return false;
  }
}

// The option a decision's score counts: its first choice, a try or the one kept.
export const firstChoice = (decision: Pick<Decision, 'tries' | 'choice'>): string | null => decision.tries[0]?.option ?? decision.choice;

export interface WalkScore {
  // 0..1 by the dialogue's scoring (quality when it is not scored); null without anything to count.
  score: number | null;
  quality: number | null;
  points: number;
}

// The score of a walk's decisions (closed, chosen by the learner), first choices counting.
export function walkScore(data: DialogueData, walk: Pick<DialogueWalk, 'decisions' | 'ending' | 'status'>, kind: 'quality' | 'points' | 'ending' = scoreKind(data)): WalkScore {
  let points = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  for (const decision of walk.decisions) {
    if (!decision.closed || decision.auto) continue;
    const option = optionOf(data, decision.node, firstChoice(decision));
    if (!option) continue;
    points += option.points || 0;
    if (option.quality) { qualitySum += QUALITY_VALUE[option.quality] ?? 0; qualityCount++; }
  }
  const quality = qualityCount ? qualitySum / qualityCount : null;
  let score: number | null;
  if (kind === 'quality') score = quality;
  else if (kind === 'points') score = data.maxPoints && data.maxPoints > 0 ? Math.max(0, Math.min(1, points / data.maxPoints)) : null;
  else score = walk.status === 'ended' && typeof walk.ending?.score === 'number' ? walk.ending.score / 100 : null;
  return { score, quality, points };
}

const nodesOf = new WeakMap<DialogueData, Map<string, { node: DialogueNodeData; index: number }>>();
export function nodeIndex(data: DialogueData): Map<string, { node: DialogueNodeData; index: number }> {
  let map = nodesOf.get(data);
  if (!map) {
    map = new Map();
    data.nodes.forEach((node, index) => { if (!map!.has(node.id)) map!.set(node.id, { node, index }); });
    nodesOf.set(data, map);
  }
  return map;
}
export const nodeOf = (data: DialogueData, id: string): DialogueNodeData | undefined => nodeIndex(data).get(id)?.node;
export const optionOf = (data: DialogueData, node: string, option: string | null): DialogueOptionData | undefined => (option === null ? undefined : nodeOf(data, node)?.options.find((candidate) => candidate.id === option));

class Walker {
  readonly data: DialogueData;
  readonly env: DialogueEnv;
  entries: Entry[] = [];
  beats: Beat[] = [];
  status: 'choosing' | 'ended' = 'ended';
  node = '';
  offer: OfferedOption[] = [];
  decisions: Decision[] = [];
  vars: Record<string, DialogueValue> = {};
  seen: string[] = [];
  ending: DialogueEndingData | null = null;
  capped = false;
  invalid: DialogueWalk['invalid'] = null;
  // The variables as they were when the waiting decision opened: a retry puts them back.
  private varsAtDecision: Record<string, DialogueValue> = {};

  constructor(data: DialogueData, env: DialogueEnv) {
    this.data = data;
    this.env = env;
    for (const variable of data.vars) this.vars[variable.id] = variable.default;
  }

  begin(): void { this.advance({ go: this.data.start }); }

  private pending(): Decision | null {
    const last = this.decisions[this.decisions.length - 1];
    return this.status === 'choosing' && last && !last.closed ? last : null;
  }

  holds(conditions: readonly DialogueCondition[] | undefined): boolean {
    return (conditions ?? []).every((condition) => this.holdsOne(condition));
  }

  private holdsOne(condition: DialogueCondition): boolean {
    if ('chosen' in condition) {
      const [node, option] = condition.chosen.split('.');
      if (!optionOf(this.data, node, option ?? null)) return true;
      return this.decisions.some((decision) => decision.node === node && (decision.choice === option || decision.tries.some((attempt) => attempt.by === 'retry' && attempt.option === option)));
    }
    if ('seen' in condition) return nodeOf(this.data, condition.seen) ? this.seen.includes(condition.seen) : true;
    if ('var' in condition) return Object.hasOwn(this.vars, condition.var) ? compare(this.vars[condition.var], condition.op, condition.value) : true;
    if ('variable' in condition) {
      const value = this.env.variable?.(condition.variable);
      return value === undefined ? true : compare(value, condition.op, condition.value);
    }
    if ('score' in condition) {
      const { score } = walkScore(this.data, this);
      return score !== null && compare(score * 100, condition.score.op, condition.score.value);
    }
    return true;
  }

  private roleOf(line: DialogueLineData): LineRole {
    if (!line.speaker || this.data.speakers[line.speaker]?.narrator) return 'narration';
    return line.speaker === this.data.learner ? 'learner' : 'character';
  }

  private playLines(node: string, lines: readonly DialogueLineData[], option?: string): void {
    for (const line of lines) if (this.holds(line.if)) this.beats.push({ type: 'line', node, line, role: this.roleOf(line), ...(option ? { option } : {}) });
  }

  // The node's way out once its options are done with (or when it has none).
  private wayOut(node: DialogueNodeData): Exit {
    if (typeof node.next === 'string') return { go: node.next };
    if (Array.isArray(node.next)) {
      const found = node.next.find((entry) => this.holds(entry.if));
      if (found) return { go: found.go };
    }
    if (node.end !== undefined) return { end: node.end };
    const following = this.data.nodes[(nodeIndex(this.data).get(node.id)?.index ?? this.data.nodes.length) + 1];
    return following ? { go: following.id } : { end: true };
  }

  private takenOnPath(node: string, option: string): boolean {
    return this.decisions.some((decision) => decision.node === node && (decision.choice === option || decision.tries.some((attempt) => attempt.by === 'retry' && attempt.option === option)));
  }

  private computeOffer(node: DialogueNodeData, decision: Pick<Decision, 'tries'> | null): OfferedOption[] {
    const offer: OfferedOption[] = [];
    for (const option of node.options) {
      if (option.fallback) continue;
      if (decision?.tries.some((attempt) => attempt.by === 'retry' && attempt.option === option.id)) { offer.push({ option, enabled: false, reason: 'retried' }); continue; }
      const reason = !this.holds(option.if) ? 'if' : option.once && this.takenOnPath(node.id, option.id) ? 'once' : null;
      if (!reason) offer.push({ option, enabled: true });
      else if (option.unavailable === 'disable') offer.push({ option, enabled: false, reason });
    }
    return offer;
  }

  private fallbackOf(node: DialogueNodeData): DialogueOptionData | undefined {
    return node.options.find((option) => option.fallback && this.holds(option.if) && !(option.once && this.takenOnPath(node.id, option.id)));
  }

  // Enters nodes until a decision waits or the dialogue ends.
  private advance(exit: Exit): void {
    let steps = 0;
    let next: Exit | null = exit;
    while (next) {
      if ('end' in next) { this.finish(next.end); return; }
      if (++steps > MAX_STEPS) { this.finish(true, true); return; }
      const node = nodeOf(this.data, next.go);
      // A target that does not exist (E_DIALOGUE_TARGET) ends the dialogue.
      if (!node) { this.finish(true); return; }
      this.node = node.id;
      this.seen.push(node.id);
      this.beats.push({ type: 'node', node: node.id });
      this.playLines(node.id, node.lines);
      next = node.options.length ? this.open(node) : this.wayOut(node);
    }
  }

  // Offers a node's options: a decision waits (null), or the walk goes on.
  private open(node: DialogueNodeData): Exit | null {
    const offer = this.computeOffer(node, null);
    if (offer.some((offered) => offered.enabled)) {
      if (this.decisions.filter((decision) => !decision.auto).length >= MAX_DECISIONS) return this.cap();
      const decision: Decision = { index: this.decisions.length, node: node.id, choice: null, tries: [], closed: false, ...(node.final ? { final: true as const } : {}), entries: [this.entries.length, this.entries.length], beat: this.beats.length };
      this.decisions.push(decision);
      this.beats.push({ type: 'decision', node: node.id, decision: decision.index });
      this.status = 'choosing';
      this.offer = offer;
      this.varsAtDecision = { ...this.vars };
      return null;
    }
    const fallback = this.fallbackOf(node);
    if (!fallback) return this.wayOut(node);
    const decision: Decision = { index: this.decisions.length, node: node.id, choice: null, tries: [], closed: false, auto: true, entries: [this.entries.length, this.entries.length], beat: this.beats.length };
    this.decisions.push(decision);
    this.varsAtDecision = { ...this.vars };
    return this.apply(node, fallback, decision);
  }

  private cap(): Exit {
    this.capped = true;
    return { end: true };
  }

  // The learner's choice (or a fallback): step 3, then where it leaves (step 4); null when the same
  // options come back.
  private apply(node: DialogueNodeData, option: DialogueOptionData, decision: Decision): Exit | null {
    this.beats.push({ type: 'choice', node: node.id, option: option.id, decision: decision.index, ...(decision.auto ? { auto: true as const } : {}) });
    for (const [name, value] of Object.entries(option.set ?? {})) if (Object.hasOwn(this.vars, name)) this.vars[name] = value;
    for (const [name, by] of Object.entries(option.add ?? {})) if (typeof this.vars[name] === 'number' && typeof by === 'number') this.vars[name] = (this.vars[name] as number) + by;
    if (option.do?.length) this.beats.push({ type: 'actions', node: node.id, option: option.id, actions: option.do });
    this.playLines(node.id, option.reply, option.id);
    if (option.feedback && this.data.feedback !== 'debrief') this.beats.push({ type: 'feedback', node: node.id, option: option.id });
    if (option.retry && this.data.revisit !== 'none' && !decision.auto) {
      decision.tries.push({ option: option.id, by: 'retry' });
      // A retry replaces the choice: its effects go, its first choice stays in the score.
      this.vars = { ...this.varsAtDecision };
      this.beats.push({ type: 'retry', node: node.id, option: option.id, decision: decision.index });
      const offer = this.computeOffer(node, decision);
      if (offer.some((offered) => offered.enabled)) { this.status = 'choosing'; this.offer = offer; return null; }
      decision.closed = true;
      const fallback = this.fallbackOf(node);
      if (fallback) {
        const auto: Decision = { index: this.decisions.length, node: node.id, choice: null, tries: [], closed: false, auto: true, entries: [this.entries.length, this.entries.length], beat: this.beats.length };
        this.decisions.push(auto);
        return this.apply(node, fallback, auto);
      }
      return this.wayOut(node);
    }
    decision.choice = option.id;
    decision.closed = true;
    this.status = 'ended';
    this.offer = [];
    if (option.next !== undefined) return { go: option.next };
    if (option.end !== undefined) return { end: option.end };
    return this.wayOut(node);
  }

  private finish(end: true | string, capped = false): void {
    if (capped) this.capped = true;
    // An ending named (one that does not exist is E_DIALOGUE_TARGET: the conditions choose), else the
    // first whose conditions hold, else the ending without title.
    const named = typeof end === 'string' ? this.data.endings.find((candidate) => candidate.id === end) : undefined;
    const ending = named ?? this.data.endings.find((candidate) => this.holds(candidate.if)) ?? null;
    this.ending = ending;
    this.status = 'ended';
    this.offer = [];
    this.beats.push({ type: 'end', ending: ending?.id ?? null, ...(this.capped ? { capped: true as const } : {}) });
  }

  applyEntry(entry: Entry): string | null {
    if (entry.startsWith('>')) {
      const target = entry.slice(1);
      if (!nodeOf(this.data, target)) return `no node "${target}"`;
      const pending = this.pending();
      if (pending) { this.decisions.pop(); this.offer = []; }
      this.entries.push(entry);
      this.beats.push({ type: 'jump', node: target });
      this.status = 'ended';
      this.advance({ go: target });
      return null;
    }
    const replaced = entry.endsWith('~');
    const [node, option] = (replaced ? entry.slice(0, -1) : entry).split('.');
    const decision = this.pending();
    if (!decision) return 'no decision waits';
    if (decision.node !== node) return `the decision waiting is "${decision.node}"`;
    const offered = this.offer.find((candidate) => candidate.option.id === option);
    if (!offered) return `"${node}" does not offer "${option}"`;
    if (!offered.enabled) return `"${option}" cannot be chosen (${offered.reason === 'retried' ? 'already tried' : offered.reason === 'once' ? 'already taken' : 'its condition fails'})`;
    this.entries.push(entry);
    decision.entries[1] = this.entries.length;
    if (replaced) {
      decision.tries.push({ option, by: 'return' });
      return null;
    }
    const exit = this.apply(nodeOf(this.data, node)!, offered.option, decision);
    decision.entries[1] = this.entries.length;
    if (exit) { this.status = 'ended'; this.advance(exit); }
    return null;
  }

  result(): DialogueWalk {
    return {
      entries: this.entries, beats: this.beats, status: this.status, node: this.node, offer: this.offer, decisions: this.decisions,
      vars: this.vars, seen: this.seen, ending: this.ending, capped: this.capped, invalid: this.invalid
    };
  }
}

// The walk of a path: from the start, each entry applied in turn. Replay stops at the first entry it
// cannot apply (invalid says which): a path saved with an older version of the module resumes at the
// first choice that no longer exists.
export function replay(data: DialogueData, entries: readonly Entry[] = [], env: DialogueEnv = {}): DialogueWalk {
  const walker = new Walker(data, env);
  walker.begin();
  for (let index = 0; index < entries.length; index++) {
    const reason = walker.applyEntry(entries[index]);
    if (reason) { walker.invalid = { index, entry: entries[index], reason }; break; }
  }
  return walker.result();
}

// The walk once the learner chose an option of the decision waiting. Throws when it is not offered
// or cannot be chosen.
export function chooseOption(data: DialogueData, walk: DialogueWalk, option: string, env: DialogueEnv = {}): DialogueWalk {
  const decision = walk.status === 'choosing' ? walk.decisions[walk.decisions.length - 1] : null;
  if (!decision) throw new DialogueError('No decision waits: the dialogue has ended.');
  const offered = walk.offer.find((candidate) => candidate.option.id === option);
  if (!offered) throw new DialogueError(`"${decision.node}" does not offer "${option}" (offered: ${walk.offer.map((candidate) => candidate.option.id).join(', ') || 'none'}).`);
  if (!offered.enabled) throw new DialogueError(`"${option}" cannot be chosen here (${offered.reason === 'retried' ? 'already tried' : offered.reason === 'once' ? 'already taken' : 'its condition fails'}).`);
  return replay(data, [...walk.entries, `${decision.node}.${option}`], env);
}

// The beats a walk added to another (a path that extends another's): what the player shows next.
export const newBeats = (before: Pick<DialogueWalk, 'beats'>, after: Pick<DialogueWalk, 'beats'>): Beat[] => after.beats.slice(before.beats.length);

// What the screen shows once the path is replayed (D61, §4.5): the last visibility and props each
// block got from the actions of the options chosen and of the cues of the lines played, and the
// highest step revealed. Layers stay closed and media still: replaying opens and plays nothing.
export interface DialoguePresentation {
  blocks: Record<string, boolean>;
  props: Record<string, Record<string, unknown>>;
  step: number;
}

export function presentationOf(walk: Pick<DialogueWalk, 'beats'>): DialoguePresentation {
  const out: DialoguePresentation = { blocks: {}, props: {}, step: 0 };
  const run = (actions: readonly DialogueAction[] | undefined) => {
    for (const action of actions ?? []) {
      if ((action.type === 'show-block' || action.type === 'hide-block') && action.block) out.blocks[action.block] = action.type === 'show-block';
      else if (action.type === 'set-object-props' && action.block && action.props) out.props[action.block] = { ...(out.props[action.block] ?? {}), ...action.props };
      else if (action.type === 'reveal-step' && typeof action.step === 'number') out.step = Math.max(out.step, action.step);
    }
  };
  for (const beat of walk.beats) {
    if (beat.type === 'actions') run(beat.actions);
    else if (beat.type === 'line') for (const cue of beat.line.cues ?? []) run(cue.do);
  }
  return out;
}

// Each speaker's expression once the path is replayed: the last a line or a cue gave.
export function expressionsOf(walk: Pick<DialogueWalk, 'beats'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const beat of walk.beats) {
    if (beat.type !== 'line' || !beat.line.speaker) continue;
    if (beat.line.expression) out[beat.line.speaker] = beat.line.expression;
    for (const cue of beat.line.cues ?? []) if (cue.expression) out[beat.line.speaker] = cue.expression;
  }
  return out;
}
