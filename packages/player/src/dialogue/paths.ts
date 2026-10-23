// Every path through a dialogue (D61), by the walk itself: each choice the learner may make, retries
// included, until an end. The core reads it for `elabora dialogue paths`, the highest sum of points
// (the points score's maximum) and the validation (nodes and endings no path reaches, the decisions
// cap). Bounded: past `limit` paths it stops and says so.

import { replay, walkScore } from './walk.ts';
import type { DialogueEnv, DialogueWalk, Entry } from './walk.ts';
import type { DialogueData } from './types.ts';

export interface ExploredPath {
  entries: Entry[];
  walk: DialogueWalk;
  ending: string | null;
  points: number;
  quality: number | null;
  // Decisions the learner made on it.
  decisions: number;
}

export interface Exploration {
  paths: ExploredPath[];
  // Every path was explored (false: stopped at the limit).
  complete: boolean;
  nodes: Set<string>;
  endings: Set<string>;
  // A path ended on the implicit ending (no declared ending held).
  implicitEnding: boolean;
  // A path reached the decisions cap, or a loop of nodes without options.
  capped: boolean;
  maxPoints: number | null;
  minPoints: number | null;
}

export const PATH_LIMIT = 2000;

export function explorePaths(data: DialogueData, { env = {}, limit = PATH_LIMIT }: { env?: DialogueEnv; limit?: number } = {}): Exploration {
  const out: Exploration = { paths: [], complete: true, nodes: new Set(), endings: new Set(), implicitEnding: false, capped: false, maxPoints: null, minPoints: null };
  // Depth first, the options in their order: the first path is the first options all along.
  const stack: Entry[][] = [[]];
  const visits = { count: 0 };
  while (stack.length) {
    const entries = stack.pop()!;
    if (++visits.count > limit * 20) { out.complete = false; break; }
    const walk = replay(data, entries, env);
    for (const node of walk.seen) out.nodes.add(node);
    if (walk.status === 'ended') {
      if (out.paths.length >= limit) { out.complete = false; break; }
      const { points, quality } = walkScore(data, walk, 'quality');
      out.paths.push({ entries, walk, ending: walk.ending?.id ?? null, points, quality, decisions: walk.decisions.filter((decision) => decision.closed && !decision.auto).length });
      if (walk.ending) out.endings.add(walk.ending.id);
      else out.implicitEnding = true;
      if (walk.capped) out.capped = true;
      out.maxPoints = out.maxPoints === null ? points : Math.max(out.maxPoints, points);
      out.minPoints = out.minPoints === null ? points : Math.min(out.minPoints, points);
      continue;
    }
    const decision = walk.decisions[walk.decisions.length - 1];
    const choices = walk.offer.filter((offered) => offered.enabled).map((offered) => [...walk.entries, `${decision.node}.${offered.option.id}`]);
    for (let index = choices.length - 1; index >= 0; index--) stack.push(choices[index]);
  }
  return out;
}

// The highest sum of points a path can reach. When the paths are too many to list, an upper bound
// from the graph (each decision's best option, along the longest way), so a score never exceeds 1.
export function maxPointsOf(data: DialogueData, exploration: Exploration = explorePaths(data)): number | null {
  if (exploration.complete) return exploration.maxPoints !== null && exploration.maxPoints > 0 ? exploration.maxPoints : null;
  const index = new Map(data.nodes.map((node, i) => [node.id, i]));
  const memo = new Map<number, number>();
  const visiting = new Set<number>();
  const best = (i: number): number => {
    if (memo.has(i)) return memo.get(i)!;
    if (visiting.has(i)) return 0;
    visiting.add(i);
    const node = data.nodes[i];
    const after = (id: string | undefined) => { const found = id === undefined ? undefined : index.get(id); return found === undefined ? 0 : best(found); };
    const common = typeof node.next === 'string' ? after(node.next) : Array.isArray(node.next) ? Math.max(0, ...node.next.map((entry) => after(entry.go))) : node.end !== undefined ? 0 : i + 1 < data.nodes.length ? best(i + 1) : 0;
    const value = node.options.length ? Math.max(0, ...node.options.map((option) => Math.max(0, option.points || 0) + (option.next !== undefined ? after(option.next) : option.end !== undefined ? 0 : common))) : common;
    visiting.delete(i);
    memo.set(i, value);
    return value;
  };
  const start = index.get(data.start) ?? 0;
  const bound = data.nodes.length ? best(start) : 0;
  return bound > 0 ? bound : null;
}
