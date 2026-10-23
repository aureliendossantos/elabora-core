// diagram (D60): Pele's SVG, marked by the core (charts/diagram.ts): nodes are the items
// (data-t-item, data-t-depth), edges name their ends (data-t-from, data-t-to). The entrance brings the
// nodes by depth, each edge drawing itself toward the node it leads to. Pointing at a node (or the
// voice naming it) lights the path that leads there; the rest steps back.

import type { ChartDom, ChartView } from './view.ts';
import { clamp01, easeOut, easeInOut } from './kit.ts';

interface Edge { group: SVGGElement; line: SVGPathElement | null; marker: SVGElement | null; label: SVGGElement[]; dashed: boolean; from: string; to: string }
interface Diagram { edges: Edge[]; into: Map<string, Edge[]> }
const diagrams = new WeakMap<HTMLElement, Diagram>();

function diagramOf(dom: ChartDom): Diagram {
  const known = diagrams.get(dom.root);
  if (known) return known;
  const labels = [...dom.root.querySelectorAll<SVGGElement>('.pele-edge-label[data-t-to]')];
  const edges: Edge[] = [...dom.root.querySelectorAll<SVGGElement>('.pele-edge[data-t-to]')].map((group) => {
    const line = group.querySelector<SVGPathElement>('path:not(.pele-marker)');
    const id = group.dataset.id;
    return {
      group, line,
      marker: group.querySelector<SVGElement>('.pele-marker'),
      label: labels.filter((label) => label.dataset.id === id && label.closest('svg') === group.closest('svg')),
      dashed: !!line?.getAttribute('stroke-dasharray'),
      from: group.dataset.tFrom ?? '', to: group.dataset.tTo ?? ''
    };
  });
  // A solid edge draws itself: its length is 1 for the dash (an attribute: the layout does not move).
  for (const edge of edges) if (edge.line && !edge.dashed) edge.line.setAttribute('pathLength', '1');
  const into = new Map<string, Edge[]>();
  for (const edge of edges) into.set(edge.to, [...(into.get(edge.to) ?? []), edge]);
  const diagram = { edges, into };
  diagrams.set(dom.root, diagram);
  return diagram;
}

// The nodes and edges on the way to a node, from the roots.
function pathTo(diagram: Diagram, id: string): { nodes: Set<string>; edges: Set<Edge> } {
  const nodes = new Set<string>([id]);
  const edges = new Set<Edge>();
  const queue = [id];
  while (queue.length) {
    const at = queue.shift()!;
    for (const edge of diagram.into.get(at) ?? []) {
      edges.add(edge);
      if (!nodes.has(edge.from)) { nodes.add(edge.from); queue.push(edge.from); }
    }
  }
  return { nodes, edges };
}

function light(dom: ChartDom, id: string | null, className: string): void {
  const diagram = diagramOf(dom);
  const path = id === null ? null : pathTo(diagram, id);
  for (const element of dom.root.querySelectorAll<HTMLElement>('[data-t-item]')) element.classList.toggle(className, !!path?.nodes.has(element.dataset.tItem ?? ''));
  for (const edge of diagram.edges) {
    const on = !!path?.edges.has(edge);
    edge.group.classList.toggle(className, on);
    for (const label of edge.label) label.classList.toggle(className, on);
  }
}

export const diagramView: ChartView = {
  entrance: { item: 0.7, stagger: 0.32 },
  // By depth: the roots first, then what they lead to.
  slot(dom, id) { return Number(dom.items.first(id)?.dataset.tDepth ?? 0); },
  reveal(dom, id, p) {
    const diagram = diagramOf(dom);
    const rest = p >= 1;
    // The edges that lead here draw during the first half; the node arrives as they land.
    const draw = easeInOut(clamp01(p / 0.6));
    for (const edge of diagram.into.get(id) ?? []) {
      if (edge.line) {
        if (edge.dashed) edge.line.style.opacity = rest ? '' : String(draw);
        else {
          edge.line.style.strokeDasharray = rest ? '' : '1 1';
          edge.line.style.strokeDashoffset = rest ? '' : String(1 - draw);
        }
      }
      if (edge.marker) edge.marker.style.opacity = rest ? '' : String(clamp01((p - 0.5) / 0.15));
      for (const label of edge.label) label.style.opacity = rest ? '' : String(clamp01((p - 0.35) / 0.3));
    }
    const arrive = clamp01(diagram.into.get(id)?.length ? (p - 0.4) / 0.6 : p);
    const e = easeOut(arrive);
    for (const node of dom.items.elements(id)) {
      node.style.opacity = rest ? '' : String(clamp01(arrive * 1.6));
      node.style.translate = rest ? '' : `0 ${Math.round((1 - e) * 10)}px`;
    }
  },
  focus(dom, id) { light(dom, id, 'is-lit'); },
  spot(dom, id) { light(dom, id, 'is-said'); }
};
