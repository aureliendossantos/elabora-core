// A learner's progress in a dialogue (D61): the current path, the scored run when it differs, what
// was explored and the endings found. The first run to an end is the only one scored, whatever the
// mode: tries, returns and exploration after it change neither the score, nor the status, nor the
// interactions. Pure: the player keeps a DialogueRun per block and saves its progress (state.ts).

import { replay, walkScore, firstChoice, compare, optionOf, nodeOf, DialogueError } from './walk.ts';
import type { DialogueEnv, DialogueWalk, Entry, Decision } from './walk.ts';
import type { DialogueData, DialogueEndingData, DialogueEventCondition, DialogueQuality } from './types.ts';

export interface DialogueProgress {
  // The entries of the current path (walk.ts).
  path: Entry[];
  // The entries of the scored run once the learner left it (null: the current path is the scored run).
  scored: Entry[] | null;
  // Options ever chosen ("node.option"), and endings reached (their ids).
  explored: string[];
  endings: string[];
}

export interface DialogueRun {
  data: DialogueData;
  env: DialogueEnv;
  progress: DialogueProgress;
  // The current path, replayed.
  walk: DialogueWalk;
  // The scored run, replayed (the same object as walk while they are the same path).
  scoredWalk: DialogueWalk;
}

export const emptyProgress = (): DialogueProgress => ({ path: [], scored: null, explored: [], endings: [] });

// A run from saved progress (or from the start). A path saved with an older version of the module
// stops at its first choice that no longer exists: the learner resumes there (walk.invalid says it).
export function openDialogue(data: DialogueData, progress: DialogueProgress = emptyProgress(), env: DialogueEnv = {}): DialogueRun {
  const walk = replay(data, progress.path, env);
  const scoredWalk = progress.scored ? replay(data, progress.scored, env) : walk;
  // Keep only what replays: a truncated path is saved truncated.
  const kept: DialogueProgress = {
    path: walk.entries.slice(),
    scored: progress.scored ? scoredWalk.entries.slice() : null,
    explored: progress.explored.filter((ref) => { const [node, option] = ref.split('.'); return !!optionOf(data, node, option ?? null); }),
    endings: progress.endings.filter((id) => data.endings.some((ending) => ending.id === id))
  };
  return withEnded({ data, env, progress: kept, walk, scoredWalk });
}

// Endings reached and options chosen join what was found.
function withEnded(run: DialogueRun): DialogueRun {
  const explored = new Set(run.progress.explored);
  for (const entry of run.walk.entries) if (!entry.startsWith('>')) explored.add(entry.replace(/~$/, ''));
  const endings = new Set(run.progress.endings);
  if (run.walk.status === 'ended' && run.walk.ending) endings.add(run.walk.ending.id);
  const ordered = (set: Set<string>, order: string[]) => order.filter((id) => set.has(id));
  const optionOrder = run.data.nodes.flatMap((node) => node.options.map((option) => `${node.id}.${option.id}`));
  return { ...run, progress: { ...run.progress, explored: ordered(explored, optionOrder), endings: ordered(endings, run.data.endings.map((ending) => ending.id)) } };
}

function withPath(run: DialogueRun, path: Entry[], scored: Entry[] | null): DialogueRun {
  const walk = replay(run.data, path, run.env);
  const scoredWalk = scored ? (scored === run.progress.scored ? run.scoredWalk : replay(run.data, scored, run.env)) : walk;
  return withEnded({ ...run, progress: { ...run.progress, path: walk.entries.slice(), scored }, walk, scoredWalk });
}

// Whether the scored run reached an end.
export const scoredDone = (run: Pick<DialogueRun, 'scoredWalk'>): boolean => run.scoredWalk.status === 'ended';

// The learner chose an option of the decision waiting.
export function choose(run: DialogueRun, option: string): DialogueRun {
  const { walk } = run;
  const decision = walk.status === 'choosing' ? walk.decisions[walk.decisions.length - 1] : undefined;
  if (!decision) throw new DialogueError('No decision waits: the dialogue has ended.');
  const offered = walk.offer.find((candidate) => candidate.option.id === option);
  if (!offered) throw new DialogueError(`"${decision.node}" does not offer "${option}" (offered: ${walk.offer.map((candidate) => candidate.option.id).join(', ') || 'none'}).`);
  if (!offered.enabled) throw new DialogueError(`"${option}" cannot be chosen here (${offered.reason === 'retried' ? 'already tried' : offered.reason === 'once' ? 'already taken' : 'its condition fails'}).`);
  return withPath(run, [...run.progress.path, `${decision.node}.${option}`], run.progress.scored);
}

// A decision the learner may go back to (« Reprendre d'ici »): after-end once the scored run is done,
// anytime from the first choice; never to a final decision closed on the path, nor before it.
export function canRevisit(run: DialogueRun, index: number): boolean {
  const { revisit } = run.data;
  if (revisit !== 'anytime' && !(revisit === 'after-end' && scoredDone(run))) return false;
  return revisitable(run.walk, index);
}

function revisitable(walk: DialogueWalk, index: number): boolean {
  const decision = walk.decisions[index];
  if (!decision || !decision.closed || decision.auto) return false;
  return !walk.decisions.some((other) => other.index >= index && other.closed && other.final);
}

// « Choisir autrement »: back to the last decision the learner closed, right after its consequence
// (revisit retry, after-end and anytime).
export function canRetryLast(run: DialogueRun): boolean {
  if (run.data.revisit === 'none') return false;
  const last = lastClosed(run.walk);
  return last !== undefined && revisitable(run.walk, last.index);
}

const lastClosed = (walk: DialogueWalk): Decision | undefined => [...walk.decisions].reverse().find((decision) => decision.closed && !decision.auto);

// « Recommencer »: after-end once the scored run is done, anytime. A final decision closes what comes
// before it until the dialogue ends; once it has ended, starting over is a new run, not a revisit.
export function canRestart(run: DialogueRun): boolean {
  const { revisit } = run.data;
  if (revisit !== 'anytime' && !(revisit === 'after-end' && scoredDone(run))) return false;
  return run.walk.status === 'ended' || !run.walk.decisions.some((decision) => decision.closed && decision.final);
}

// The path cut back to a decision, which waits again. Before the scored run is done, the choice
// replaced stays as its first choice ("~"); after, the scored run is kept apart.
function backTo(run: DialogueRun, index: number): DialogueRun {
  const decision = run.walk.decisions[index];
  if (!decision) throw new DialogueError(`No decision ${index + 1} on the path.`);
  const done = scoredDone(run);
  const [start, end] = decision.entries;
  const own = run.progress.path.slice(start, end);
  // Its tries stay (retries, and a first choice already replaced); the choice kept goes.
  const tries = own.filter((entry) => entry.endsWith('~') || isRetryEntry(run.data, entry));
  const kept = decision.choice === null ? own : own.slice(0, -1).filter((entry) => tries.includes(entry));
  const replacedFirst = !done && decision.choice !== null && !kept.length ? [`${decision.node}.${decision.choice}~`] : [];
  const path = [...run.progress.path.slice(0, start), ...kept, ...replacedFirst];
  const scored = done && run.progress.scored === null ? run.progress.path.slice() : run.progress.scored;
  return withPath(run, path, scored);
}

const isRetryEntry = (data: DialogueData, entry: Entry): boolean => {
  const [node, option] = entry.split('.');
  return !!optionOf(data, node, option ?? null)?.retry && data.revisit !== 'none';
};

export function revisit(run: DialogueRun, index: number): DialogueRun {
  if (!canRevisit(run, index)) throw new DialogueError(`Decision ${index + 1} cannot be revisited (revisit ${run.data.revisit}${scoredDone(run) ? '' : ', first run not ended'}).`);
  return backTo(run, index);
}

export function retryLast(run: DialogueRun): DialogueRun {
  if (!canRetryLast(run)) throw new DialogueError('No decision to choose again.');
  return backTo(run, lastClosed(run.walk)!.index);
}

export function restart(run: DialogueRun): DialogueRun {
  if (!canRestart(run)) throw new DialogueError(`The dialogue cannot start over (revisit ${run.data.revisit}${scoredDone(run) ? '' : ', first run not ended'}).`);
  const first = run.walk.decisions.find((decision) => decision.closed && !decision.auto);
  // Before the scored run is done, starting over is going back to the first decision.
  if (!scoredDone(run) && first) return backTo(run, first.index);
  const scored = scoredDone(run) && run.progress.scored === null ? run.progress.path.slice() : run.progress.scored;
  return withPath(run, [], scored);
}

// An event of the screen moved the dialogue to a node (goto-dialogue). Two jumps in a row: the
// second replaces the first (the path stays bounded).
export function jump(run: DialogueRun, node: string): DialogueRun {
  if (!nodeOf(run.data, node)) throw new DialogueError(`No node "${node}" in the dialogue.`);
  const path = run.progress.path.slice();
  if (path.length && path[path.length - 1].startsWith('>')) path.pop();
  return withPath(run, [...path, `>${node}`], run.progress.scored);
}


export type InteractionResult = 'correct' | 'neutral' | 'wrong';
const RESULT: Readonly<Record<DialogueQuality, InteractionResult>> = { good: 'correct', ok: 'neutral', bad: 'wrong' };

export interface ScoredDecision {
  // Its place among the scored run's decisions.
  index: number;
  node: string;
  prompt?: string;
  // The first choice (what counts), and the option kept when it differs.
  option: string;
  kept: string | null;
  quality?: DialogueQuality;
  points: number;
  feedback?: string;
  objective?: string;
}

export interface DialogueInteraction {
  // Permanent within the block: the node, and its occurrence when the path passed it again
  // (« premiere-question », « hub.2 »). The player prefixes the block's id.
  id: string;
  node: string;
  // The option chosen first.
  response: string;
  result: InteractionResult;
  objective?: string;
}

export interface ScoredResult {
  // The scored run reached an end: the score and the interactions are final.
  done: boolean;
  ending: DialogueEndingData | null;
  // 0..1 by the dialogue's scoring; null when it is not scored or has nothing to count.
  score: number | null;
  // The quality score (0..1), whatever the scoring: the debrief and conditions read it.
  quality: number | null;
  points: number;
  maxPoints: number | null;
  decisions: ScoredDecision[];
  interactions: DialogueInteraction[];
  // Endings found on every run, and how many the dialogue has (1 without declared endings).
  endingsFound: number;
  endingsTotal: number;
}

export function scoredResult(run: Pick<DialogueRun, 'data' | 'scoredWalk' | 'progress'>): ScoredResult {
  const { data, scoredWalk } = run;
  const scored = walkScore(data, scoredWalk);
  const decisions: ScoredDecision[] = [];
  const interactions: DialogueInteraction[] = [];
  const occurrences = new Map<string, number>();
  for (const decision of scoredWalk.decisions) {
    if (!decision.closed || decision.auto) continue;
    const first = firstChoice(decision);
    const option = optionOf(data, decision.node, first);
    if (!option || first === null) continue;
    const node = nodeOf(data, decision.node);
    const count = (occurrences.get(decision.node) ?? 0) + 1;
    occurrences.set(decision.node, count);
    const objective = option.objective ?? node?.objective ?? data.objective;
    decisions.push({
      index: decisions.length, node: decision.node, ...(node?.prompt ? { prompt: node.prompt } : {}), option: first, kept: decision.choice !== first ? decision.choice : null,
      ...(option.quality ? { quality: option.quality } : {}), points: option.points || 0, ...(option.feedback ? { feedback: option.feedback } : {}), ...(objective ? { objective } : {})
    });
    interactions.push({ id: count > 1 ? `${decision.node}.${count}` : decision.node, node: decision.node, response: first, result: option.quality ? RESULT[option.quality] : 'neutral', ...(objective ? { objective } : {}) });
  }
  const done = scoredWalk.status === 'ended';
  return {
    done, ending: done ? scoredWalk.ending : null,
    score: data.scoring === 'none' ? null : walkScore(data, scoredWalk, data.scoring).score,
    quality: scored.quality, points: scored.points, maxPoints: data.maxPoints,
    decisions, interactions,
    endingsFound: data.endings.length ? run.progress.endings.length : done ? 1 : 0, endingsTotal: Math.max(1, data.endings.length)
  };
}

// A condition of the course's events on this dialogue (event.schema.json): what its scored run gave.
export function eventConditionHolds(run: Pick<DialogueRun, 'data' | 'scoredWalk' | 'progress'>, condition: DialogueEventCondition): boolean {
  const result = scoredResult(run);
  if ('ending' in condition) return result.done && result.ending?.id === condition.ending;
  if ('done' in condition) return result.done === condition.done;
  if ('score' in condition) {
    const score = run.data.scoring === 'none' ? result.quality : result.score;
    return score !== null && compare(score * 100, condition.score.op, condition.score.value);
  }
  if ('chosen' in condition) {
    const [node, option] = condition.chosen.split('.');
    return run.scoredWalk.decisions.some((decision) => decision.node === node && (decision.choice === option || decision.tries.some((attempt) => attempt.option === option)));
  }
  return false;
}
