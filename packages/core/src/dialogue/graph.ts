// A dialogue as a graph, read from its structure only (D61): every way a node may go, whatever the
// conditions. The validation reads it (what no path reaches, loops without a way out, a tree that
// never joins) and so does the map (layout.ts).

import type { DialogueData, DialogueNodeData } from '@elabora/player/dialogue/types';

export type EdgeKind = 'option' | 'common' | 'retry' | 'next' | 'case' | 'follow';

export interface DialogueEdge {
  from: string;
  // A node id, or null for an end.
  to: string | null;
  kind: EdgeKind;
  // The option it leaves by (option, retry), or the options that take the node's way (common).
  option?: string;
  // The ending an end names (true: its conditions choose).
  end?: true | string;
  // A case's conditions hold (case), the fall when none does (follow after cases).
  conditional?: boolean;
}

// Where the node goes once its options are done with (or when it has none).
export function wayOutEdges(data: DialogueData, node: DialogueNodeData, index: number, kind: EdgeKind = 'next'): DialogueEdge[] {
  const edges: DialogueEdge[] = [];
  const fall = (): DialogueEdge => (node.end !== undefined ? { from: node.id, to: null, kind, end: node.end }
    : data.nodes[index + 1] ? { from: node.id, to: data.nodes[index + 1].id, kind: kind === 'common' ? 'common' : 'follow' }
    : { from: node.id, to: null, kind, end: true });
  if (typeof node.next === 'string') edges.push({ from: node.id, to: node.next, kind });
  else if (Array.isArray(node.next)) {
    for (const entry of node.next) edges.push({ from: node.id, to: entry.go, kind: kind === 'common' ? 'common' : 'case', ...(entry.if?.length ? { conditional: true } : {}) });
    if (node.next.every((entry) => entry.if?.length)) edges.push({ ...fall(), conditional: true });
  } else edges.push(fall());
  return edges;
}

export function dialogueEdges(data: DialogueData): DialogueEdge[] {
  const edges: DialogueEdge[] = [];
  data.nodes.forEach((node, index) => {
    if (!node.options.length) { edges.push(...wayOutEdges(data, node, index)); return; }
    let common = false;
    for (const option of node.options) {
      if (option.retry && data.revisit !== 'none') { edges.push({ from: node.id, to: node.id, kind: 'retry', option: option.id }); common = true; continue; }
      if (option.next !== undefined) edges.push({ from: node.id, to: option.next, kind: 'option', option: option.id });
      else if (option.end !== undefined) edges.push({ from: node.id, to: null, kind: 'option', option: option.id, end: option.end });
      else common = true;
    }
    // Options without a way of their own, retries once exhausted, and a node whose options may all be
    // unavailable: the node's way out.
    if (common || node.options.every((option) => option.if?.length || option.once)) edges.push(...wayOutEdges(data, node, index, 'common'));
  });
  return edges;
}

// Nodes the start reaches, whatever the conditions (and every node a jump of the screen names).
export function reachableNodes(data: DialogueData, edges: readonly DialogueEdge[] = dialogueEdges(data), jumps: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  const stack = [data.start, ...jumps].filter((id) => data.nodes.some((node) => node.id === id));
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const edge of edges) if (edge.from === id && edge.to !== null && !out.has(edge.to)) stack.push(edge.to);
  }
  return out;
}

// Nodes from which an end can be reached.
export function nodesReachingEnd(edges: readonly DialogueEdge[], nodes: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) if (edge.to === null || !nodes.includes(edge.to)) out.add(edge.from);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of edges) if (edge.to !== null && out.has(edge.to) && !out.has(edge.from)) { out.add(edge.from); grew = true; }
  }
  return out;
}
