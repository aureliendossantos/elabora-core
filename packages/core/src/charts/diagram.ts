// diagram: Mermaid text drawn by Pele (MIT, pinned; checked monthly) when the course is built (D60).
// Two variants are drawn, wide as written and narrow (Pele turns left-to-right into top-to-bottom), and
// the container picks one (charts.css). Nodes become the chart's items: the player reveals them by
// depth, draws the edges and lights the path to the node pointed at.

import { parse, render, detectType, PeleError } from 'pele';
import type { DiagramType } from 'pele';
import { attrs, esc } from './frame.ts';
import type { ChartType } from './types.ts';
import { isRecord, recordsOf, str } from './values.ts';

export const DIAGRAM_TYPES: readonly DiagramType[] = ['flowchart', 'sequence', 'state', 'mindmap', 'timeline', 'journey', 'ishikawa', 'venn'];
// Types whose words are swapped by id (labels); the others are translated as a whole source.
export const LABELLED_TYPES: readonly DiagramType[] = ['flowchart', 'state', 'mindmap'];
const NARROW = 560;

export type DiagramProblem = { code: 'E_DIAGRAM_TYPE' | 'E_DIAGRAM_SYNTAX'; message: string; line?: number; column?: number };

interface Parsed { type: DiagramType; model: ReturnType<typeof parse> }

// Colours written in the source (classDef, style, linkStyle) are left out (W_DIAGRAM_COLOR): the
// course's tokens colour every diagram. The lines stay, empty, so that errors keep their line numbers.
export const COLOR_LINES = /^[ \t]*(?:classDef|style|linkStyle)\b[^\n]*/gm;
export const hasColors = (source: string): boolean => new RegExp(COLOR_LINES.source, 'm').test(source);

export function parseDiagram(written: string): Parsed | DiagramProblem {
  const source = written.replace(COLOR_LINES, '');
  const type = detectType(source);
  if (!type) return { code: 'E_DIAGRAM_SYNTAX', message: 'the source does not start with a Mermaid diagram type (flowchart LR, mindmap, sequenceDiagram…)' };
  if (!DIAGRAM_TYPES.includes(type)) return { code: 'E_DIAGRAM_TYPE', message: `"${type}" diagrams are not drawn by the diagram block (allowed: ${DIAGRAM_TYPES.join(', ')}); use a chart block (bars, donut, trend…) for data` };
  try {
    return { type, model: parse(source, { limit: 20000 }) };
  } catch (error) {
    if (error instanceof PeleError) {
      const located = error as PeleError & { line?: number; column?: number };
      return { code: 'E_DIAGRAM_SYNTAX', message: error.message, ...(typeof located.line === 'number' ? { line: located.line } : {}), ...(typeof located.column === 'number' ? { column: located.column } : {}) };
    }
    return { code: 'E_DIAGRAM_SYNTAX', message: error instanceof Error ? error.message : String(error) };
  }
}
export const isProblem = (value: Parsed | DiagramProblem): value is DiagramProblem => 'code' in value;

type Model = Record<string, unknown> & { nodes?: unknown; edges?: unknown };

// The words of a diagram's nodes and edges by id (those that labels may replace).
export function diagramWords(parsed: Parsed): { id: string; text: string }[] {
  const model = parsed.model as unknown as Model;
  const out: { id: string; text: string }[] = [];
  if (parsed.type === 'mindmap') {
    const seen = new Set<string>();
    const walk = (nodes: unknown) => { for (const node of recordsOf(nodes)) { const id = str(node.nodeId); if (id && !seen.has(id)) { seen.add(id); out.push({ id, text: str(node.descr) }); } walk(node.children); } };
    walk(recordsOf(model.nodes).slice(0, 1));
    return out;
  }
  if (model.nodes instanceof Map) for (const [id, node] of model.nodes) if (isRecord(node) && typeof node.text === 'string' && node.text) out.push({ id: String(id), text: node.text });
  for (const edge of recordsOf(model.edges)) if (typeof edge.id === 'string' && typeof edge.text === 'string' && edge.text) out.push({ id: edge.id, text: edge.text });
  return out;
}

function relabel(parsed: Parsed, labels: Record<string, unknown>): void {
  const model = parsed.model as unknown as Model;
  const word = (id: unknown) => (typeof labels[String(id)] === 'string' && labels[String(id)] !== '' ? String(labels[String(id)]) : null);
  if (parsed.type === 'mindmap') {
    const walk = (nodes: unknown) => { for (const node of recordsOf(nodes)) { const text = word(node.nodeId); if (text) node.descr = text; walk(node.children); } };
    walk(model.nodes);
    return;
  }
  if (model.nodes instanceof Map) for (const [id, node] of model.nodes) { const text = word(id); if (text && isRecord(node)) node.text = text; }
  for (const edge of recordsOf(model.edges)) { const text = word(edge.id); if (text) edge.text = text; }
}

// Depth of each node from the roots, for the entrance (graph types), else the reading order.
function depths(parsed: Parsed): Map<string, number> {
  const model = parsed.model as unknown as Model;
  const edges = recordsOf(model.edges).map((edge) => ({ from: str(edge.start), to: str(edge.end) })).filter((edge) => edge.from && edge.to);
  const depth = new Map<string, number>();
  if (!edges.length) return depth;
  const ids = model.nodes instanceof Map ? [...model.nodes.keys()].map(String) : [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
  const targets = new Set(edges.map((edge) => edge.to));
  const queue: [string, number][] = ids.filter((id) => !targets.has(id)).map((id) => [id, 0]);
  if (!queue.length && ids.length) queue.push([ids[0], 0]);
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const edge of edges) if (edge.from === id) queue.push([edge.to, d + 1]);
  }
  return depth;
}

// The node of each edge (graph types): the player lights the edges that lead to a node.
function edgeEnds(parsed: Parsed): Map<string, { from: string; to: string }> {
  const model = parsed.model as unknown as Model;
  return new Map(recordsOf(model.edges).filter((edge) => typeof edge.id === 'string').map((edge) => [String(edge.id), { from: str(edge.start), to: str(edge.end) }]));
}

export function drawDiagram(source: string, labels: Record<string, unknown>, options: { id: string; fontFamily?: string; highlight?: string }): { wide: string; narrow: string; type: DiagramType } | DiagramProblem {
  const first = parseDiagram(source);
  if (isProblem(first)) return first;
  const draw = (variant: 'w' | 'n') => {
    const parsed = parseDiagram(source) as Parsed;
    relabel(parsed, labels);
    // Measured 6 % larger than shown (charts.css draws labels at 16 px): the course's font may be wider
    // than the metrics Pele measures with outside a browser.
    const result = render(parsed.model, {
      idPrefix: `${options.id}-${variant}`, fontSize: 17, padding: 4, links: false, images: false,
      ...(options.fontFamily ? { fontFamily: options.fontFamily } : {}),
      ...(variant === 'n' ? { maxWidth: NARROW - 40, autoDirection: true, directionBreakpoint: NARROW } : {})
    });
    return mark(result.svg, parsed, options.highlight);
  };
  return { wide: draw('w'), narrow: draw('n'), type: first.type };
}

// The groups of Pele's SVG that are the diagram's items (nodes, sets, categories), and its edges.
const ITEM_GROUP = /<g class="(pele-node[^"]*|pele-venn-region[^"]*|pele-venn-set[^"]*|pele-ishikawa-category[^"]*|pele-ishikawa-head[^"]*)" data-id="([^"]*)"/g;
const EDGE_GROUP = /<g class="pele-edge(?:\s[^"]*)?" data-id="([^"]*)"/g;

// The ids a highlight or a beat (items) and a label (items and edges) may name, as Pele draws them.
export function diagramIds(source: string): { items: string[]; edges: string[] } | DiagramProblem {
  const drawn = drawDiagram(source, {}, { id: 'ids' });
  if ('code' in drawn) return drawn;
  return {
    items: [...new Set([...drawn.wide.matchAll(ITEM_GROUP)].map((match) => unescapeId(match[2])))],
    edges: [...new Set([...drawn.wide.matchAll(EDGE_GROUP)].map((match) => unescapeId(match[1])))]
  };
}
const unescapeId = (id: string) => id.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Pele's nodes and edges as the chart's items: data-t-item (and the words said), depth, highlight.
function mark(svg: string, parsed: Parsed, highlight: string | undefined): string {
  const words = new Map(diagramWords(parsed).map((word) => [word.id, word.text]));
  const depth = depths(parsed);
  const ends = edgeEnds(parsed);
  let order = 0;
  return svg
    .replace(ITEM_GROUP, (_whole, classes: string, id: string) => {
      const said = words.get(id) ?? id;
      const lit = highlight && id === highlight ? ' is-hl' : '';
      return `<g class="${classes}${lit}" data-id="${id}"${attrs({ 'data-t-item': id, 'data-t-say': said, 'data-t-depth': depth.get(id) ?? order++ })}`;
    })
    .replace(/<g class="(pele-edge[^"]*)" data-id="([^"]*)"/g, (_whole, classes: string, id: string) => {
      const end = ends.get(id);
      return `<g class="${classes}" data-id="${id}"${end ? attrs({ 'data-t-from': end.from, 'data-t-to': end.to, 'data-t-depth': depth.get(end.from) ?? 0 }) : ''}`;
    });
}

export const diagram: ChartType = {
  axis: 'xy',
  items: (props) => recordsOf(props.beats).flatMap((beat, index) => (typeof beat.node === 'string' && isRecord(beat.at) ? [{ id: beat.node, at: beat.at as never, path: `/beats/${index}/at` }] : [])),
  body(props, context) {
    const drawn = drawDiagram(str(props.mermaid), isRecord(props.labels) ? props.labels : {}, { id: context.id, highlight: str(props.highlight) || undefined });
    if ('code' in drawn) return `<p class="t-diagram-problem">${esc(drawn.message)}</p>`;
    return `<div class="t-diagram t-diagram--${drawn.type}"><div class="t-diagram-wide">${drawn.wide}</div><div class="t-diagram-narrow">${drawn.narrow}</div></div>`;
  },
  table(props) {
    const parsed = parseDiagram(str(props.mermaid));
    if (isProblem(parsed)) return { head: [], rows: [] };
    const labels = isRecord(props.labels) ? props.labels : {};
    relabel(parsed, labels);
    const words = new Map(diagramWords(parsed).map((word) => [word.id, word.text]));
    const model = parsed.model as unknown as Model;
    const edges = recordsOf(model.edges).filter((edge) => edge.start && edge.end);
    if (edges.length) return { head: [], rows: edges.map((edge) => [words.get(str(edge.start)) ?? str(edge.start), `${edge.text ? `${str(edge.text)} → ` : '→ '}${words.get(str(edge.end)) ?? str(edge.end)}`]) };
    return { head: [], rows: [...words.values()].map((text) => [text]) };
  }
};
