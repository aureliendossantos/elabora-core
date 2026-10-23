// The map of a dialogue (D61): its nodes and endings placed in layers, pure and deterministic, so the
// client's export and the app's Carte draw the same thing and the module stores no position. A
// node's layer is its distance from the start; within a layer nodes are ordered by the barycentre of
// those that lead to them (a few sweeps down and up); edges are curves, those that go back (a loop,
// a retry) dashed, as in the Lin 09 mock-up.

import type { DialogueData } from '@elabora/player/dialogue/types';
import { dialogueEdges } from './graph.ts';
import type { EdgeKind } from './graph.ts';
import { describeConditions, letterOf, SCRIPT_WORDS } from './script.ts';
import type { ScriptWords } from './script.ts';

export const MAP_NODE_WIDTH = 220;
const HEADER = 40;
const OPTION_ROW = 28;
const LINES_HEIGHT = 44;
const GAP_X = 96;
const GAP_Y = 28;
const MARGIN = 24;

export interface MapOption {
  id: string;
  letter: string;
  label: string;
  quality: string | null;
  // Its row's centre, from the top of the node.
  y: number;
}

export interface MapNode {
  // A node's id, or « end:<ending> » (« end » for the ending without title).
  id: string;
  kind: 'node' | 'ending';
  number: number | null;
  title: string;
  final: boolean;
  rank: number;
  x: number;
  y: number;
  width: number;
  height: number;
  options: MapOption[];
}

export interface MapEdge {
  from: string;
  to: string;
  kind: EdgeKind | 'end';
  option: string | null;
  // It goes back (to a layer before, or to itself): drawn dashed.
  back: boolean;
  // SVG path data.
  d: string;
  label: string | null;
  labelX: number;
  labelY: number;
}

export interface DialogueMap {
  width: number;
  height: number;
  nodes: MapNode[];
  edges: MapEdge[];
}

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const round = (value: number): number => Math.round(value);

export function dialogueMap(data: DialogueData, { words = SCRIPT_WORDS.en }: { words?: ScriptWords } = {}): DialogueMap {
  const graph = dialogueEdges(data);
  const endingId = (end: true | string | undefined): string[] => {
    if (typeof end === 'string' && data.endings.some((ending) => ending.id === end)) return [`end:${end}`];
    return data.endings.length ? data.endings.map((ending) => `end:${ending.id}`) : ['end'];
  };
  // Edges between map nodes: an end goes to its ending (or to each ending its conditions choose).
  const edges: { from: string; to: string; kind: EdgeKind | 'end'; option: string | null; label: string | null }[] = [];
  for (const edge of graph) {
    if (edge.to !== null) { edges.push({ from: edge.from, to: data.nodes.some((node) => node.id === edge.to) ? edge.to : 'end', kind: edge.kind, option: edge.option ?? null, label: null }); continue; }
    const targets = endingId(edge.end);
    for (const target of targets) {
      const ending = data.endings.find((candidate) => `end:${candidate.id}` === target);
      edges.push({ from: edge.from, to: target, kind: 'end', option: edge.option ?? null, label: targets.length > 1 && ending?.if?.length ? describeConditions(ending.if, words) : null });
    }
  }
  // Endings come last, in their order (every declared ending is drawn, reached or not).
  const targeted = new Set(edges.map((edge) => edge.to));
  const ids = [...data.nodes.map((node) => node.id), ...data.endings.map((ending) => `end:${ending.id}`), ...(targeted.has('end') ? ['end'] : [])];

  // Layers: the longest way from the start, once the edges that close a loop are set aside (those a
  // walk from the start meets going back to a node it is still in), so that a branch that comes back
  // to the trunk comes back forward, and only a loop or a retry is drawn going back; nodes no path
  // reaches after the others; endings after the last node that leads to them.
  const rank = new Map<string, number>();
  const start = data.nodes.some((node) => node.id === data.start) ? data.start : data.nodes[0]?.id;
  if (start) {
    const out = (id: string) => edges.filter((edge) => edge.from === id && edge.to !== id && !edge.to.startsWith('end'));
    const state = new Map<string, 'open' | 'done'>();
    const closing = new Set<(typeof edges)[number]>();
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    state.set(start, 'open');
    const order: string[] = [];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const leaving = out(top.id);
      if (top.next >= leaving.length) { state.set(top.id, 'done'); order.push(top.id); stack.pop(); continue; }
      const edge = leaving[top.next++]!;
      const seen = state.get(edge.to);
      if (seen === 'open') closing.add(edge);
      else if (!seen) { state.set(edge.to, 'open'); stack.push({ id: edge.to, next: 0 }); }
    }
    // Finished last first: a node comes after every node that leads to it.
    rank.set(start, 0);
    for (const id of order.reverse()) {
      const at = rank.get(id);
      if (at === undefined) continue;
      for (const edge of out(id)) if (!closing.has(edge)) rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, at + 1));
    }
  }
  let deepest = Math.max(-1, ...rank.values());
  for (const node of data.nodes) if (!rank.has(node.id)) rank.set(node.id, ++deepest);
  const nodeDepth = Math.max(0, ...data.nodes.map((node) => rank.get(node.id) ?? 0));
  for (const id of ids) if (id.startsWith('end')) rank.set(id, nodeDepth + 1);

  // Order within each layer: first met, then barycentres of the neighbours in the layer before
  // (down) and after (up); a stable sort keeps ties as they were.
  const layers: string[][] = [];
  for (const id of ids) {
    const r = rank.get(id)!;
    (layers[r] ??= []).push(id);
  }
  for (let r = 0; r < layers.length; r++) layers[r] ??= [];
  const position = new Map<string, number>();
  const place = () => layers.forEach((layer) => layer.forEach((id, index) => position.set(id, index)));
  place();
  const forward = edges.filter((edge) => rank.get(edge.to)! > rank.get(edge.from)!);
  const sweep = (r: number, neighbours: (id: string) => string[]) => {
    const scored = layers[r].map((id, index) => {
      const around = neighbours(id).map((other) => position.get(other)!).filter((value) => value !== undefined);
      return { id, index, value: around.length ? around.reduce((sum, value) => sum + value, 0) / around.length : index };
    });
    scored.sort((a, b) => a.value - b.value || a.index - b.index);
    layers[r] = scored.map((entry) => entry.id);
    layers[r].forEach((id, index) => position.set(id, index));
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let r = 1; r < layers.length; r++) sweep(r, (id) => forward.filter((edge) => edge.to === id).map((edge) => edge.from));
    for (let r = layers.length - 2; r >= 0; r--) sweep(r, (id) => forward.filter((edge) => edge.from === id).map((edge) => edge.to));
  }

  // Sizes and places: columns side by side, each centred on the tallest.
  const nodeOf = (id: string) => data.nodes.find((node) => node.id === id);
  const heightOf = (id: string) => {
    const node = nodeOf(id);
    const options = node ? node.options.filter((option) => !option.fallback).length : 0;
    return options ? HEADER + options * OPTION_ROW + 6 : LINES_HEIGHT;
  };
  const columnHeight = (layer: string[]) => layer.reduce((sum, id) => sum + heightOf(id), 0) + Math.max(0, layer.length - 1) * GAP_Y;
  const tallest = Math.max(0, ...layers.map(columnHeight));
  const nodes: MapNode[] = [];
  layers.forEach((layer, r) => {
    let y = MARGIN + (tallest - columnHeight(layer)) / 2;
    for (const id of layer) {
      const node = nodeOf(id);
      const ending = data.endings.find((candidate) => `end:${candidate.id}` === id);
      const height = heightOf(id);
      const options = (node?.options ?? []).filter((option) => !option.fallback).map((option, index): MapOption => ({
        id: option.id, letter: letterOf(node!.options.indexOf(option)), label: shorten(option.label ?? option.text ?? '', 34), quality: option.quality ?? null, y: HEADER + index * OPTION_ROW + OPTION_ROW / 2
      }));
      nodes.push({
        id, kind: node ? 'node' : 'ending', number: node ? data.nodes.indexOf(node) + 1 : null,
        title: shorten(node ? node.title ?? node.id : ending ? ending.title ?? ending.id : words.end.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase()), 30),
        final: node?.final === true, rank: r, x: MARGIN + r * (MAP_NODE_WIDTH + GAP_X), y: round(y), width: MAP_NODE_WIDTH, height, options
      });
      y += height + GAP_Y;
    }
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // Edges: from the option's row (or the node's middle) to the target's header.
  const mapEdges: MapEdge[] = edges.map((edge) => {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const row = edge.option ? from.options.find((option) => option.id === edge.option) : undefined;
    const sx = from.x + from.width;
    const sy = from.y + (row ? row.y : from.options.length ? HEADER / 2 : from.height / 2);
    const tx = to.x;
    const ty = to.y + (to.options.length ? HEADER / 2 : to.height / 2);
    const back = to.rank <= from.rank;
    let d: string;
    let labelX: number;
    let labelY: number;
    if (edge.from === edge.to) {
      // A retry: a loop from the option's row back into the node's right edge, high in its header,
      // above the way out that leaves from the header's middle.
      const into = from.y + 10;
      d = `M ${sx} ${round(sy)} C ${sx + 40} ${round(sy)}, ${sx + 40} ${round(into)}, ${sx} ${round(into)}`;
      labelX = sx + 36;
      labelY = round((sy + into) / 2);
    } else if (back) {
      const below = Math.max(from.y + from.height, to.y + to.height) + 22;
      d = `M ${sx} ${round(sy)} C ${sx + 70} ${round(sy)}, ${sx + 70} ${round(below)}, ${round((sx + tx) / 2)} ${round(below)} S ${tx - 70} ${round(ty)}, ${tx} ${round(ty)}`;
      labelX = round((sx + tx) / 2);
      labelY = round(below);
    } else {
      const dx = Math.max(30, (tx - sx) / 2);
      d = `M ${sx} ${round(sy)} C ${round(sx + dx)} ${round(sy)}, ${round(tx - dx)} ${round(ty)}, ${tx} ${round(ty)}`;
      labelX = round(tx - 40);
      labelY = round(ty - 8);
    }
    return { from: edge.from, to: edge.to, kind: edge.kind, option: edge.option, back, d, label: edge.label, labelX, labelY };
  });
  const width = MARGIN * 2 + layers.length * MAP_NODE_WIDTH + Math.max(0, layers.length - 1) * GAP_X;
  const bottom = Math.max(MARGIN + tallest, ...mapEdges.filter((edge) => edge.back).map((edge) => edge.labelY + 10));
  return { width, height: round(bottom + MARGIN), nodes, edges: mapEdges };
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The map as an SVG (no script, no font of its own: the page's), with classes the page styles.
export function dialogueMapSvg(map: DialogueMap, { title, qualities }: { title: string; qualities?: Partial<Record<string, string>> }): string {
  const out: string[] = [];
  out.push(`<svg class="dm" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${map.width} ${map.height}" width="${map.width}" height="${map.height}" role="img" aria-label="${escape(title)}">`);
  out.push('<defs><marker id="dm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" class="dm-arrowhead"/></marker></defs>');
  for (const edge of map.edges) out.push(`<path class="dm-edge${edge.back ? ' dm-back' : ''}${edge.kind === 'end' ? ' dm-to-end' : ''}" d="${edge.d}" marker-end="url(#dm-arrow)"/>`);
  for (const node of map.nodes) {
    out.push(`<g class="dm-node dm-${node.kind}${node.final ? ' dm-final' : ''}" transform="translate(${node.x} ${node.y})">`);
    out.push(`<rect width="${node.width}" height="${node.height}" rx="8"/>`);
    const headerY = node.options.length ? HEADER / 2 : node.height / 2;
    out.push(`<text class="dm-title" x="12" y="${headerY}" dominant-baseline="central">${node.number !== null ? `<tspan class="dm-number">${node.number}</tspan> ` : ''}${escape(node.title)}</text>`);
    for (const option of node.options) {
      out.push(`<text class="dm-option${option.quality ? ` dm-${option.quality}` : ''}" x="12" y="${option.y}" dominant-baseline="central"><tspan class="dm-letter">${option.letter}</tspan> ${escape(option.label)}${option.quality && qualities?.[option.quality] ? ` <tspan class="dm-quality">${escape(qualities[option.quality]!)}</tspan>` : ''}</text>`);
    }
    out.push('</g>');
  }
  for (const edge of map.edges) if (edge.label) out.push(`<text class="dm-label" x="${edge.labelX}" y="${edge.labelY}" text-anchor="end">${escape(edge.label)}</text>`);
  out.push('</svg>');
  return out.join('\n');
}
