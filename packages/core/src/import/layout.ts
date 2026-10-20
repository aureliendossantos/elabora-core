import type { Box, SourceItem } from './model.ts';

// Reading order of a positioned slide (docs/decisions.md D47). Storyline places objects at
// absolute positions on a slide of fixed size; Elabora reads blocks in order and lets the page
// reflow. The order is the author's focus order when the source has one, else a recursive XY cut:
// the slide is cut into bands where no object spans the gap (top to bottom), each band into
// columns (left to right), and so on; what overlaps is read by its top, then its left edge.
// The tree keeps the columns, so that two columns of one block each sit side by side.

export type LayoutNode =
  | { kind: 'item'; item: SourceItem }
  | { kind: 'rows'; children: LayoutNode[] }
  | { kind: 'columns'; children: LayoutNode[] };

// Text boxes overlap a little by their padding: an overlap smaller than this (slide pixels) still cuts.
const GAP = 4;

const boxOf = (item: SourceItem): Box => item.box ?? { x: 0, y: 0, width: 0, height: 0 };

// Groups of items whose projections on one axis do not overlap, in order along that axis.
function groupsAlong(items: SourceItem[], axis: 'x' | 'y'): SourceItem[][] {
  const start = (item: SourceItem) => (axis === 'y' ? boxOf(item).y : boxOf(item).x);
  const end = (item: SourceItem) => (axis === 'y' ? boxOf(item).y + boxOf(item).height : boxOf(item).x + boxOf(item).width);
  const sorted = [...items].sort((a, b) => start(a) - start(b) || end(a) - end(b));
  const groups: SourceItem[][] = [];
  let reach = -Infinity;
  for (const item of sorted) {
    if (!groups.length || start(item) >= reach - GAP) {
      groups.push([item]);
      reach = end(item);
    } else {
      groups[groups.length - 1].push(item);
      reach = Math.max(reach, end(item));
    }
  }
  return groups;
}

function cut(items: SourceItem[], depth: number): LayoutNode {
  if (items.length === 1) return { kind: 'item', item: items[0] };
  if (depth < 12) {
    const rows = groupsAlong(items, 'y');
    if (rows.length > 1) return { kind: 'rows', children: rows.map((row) => cut(row, depth + 1)) };
    const columns = groupsAlong(items, 'x');
    if (columns.length > 1) return { kind: 'columns', children: columns.map((column) => cut(column, depth + 1)) };
  }
  // Objects that overlap both ways: by their top, then their left edge, a row being a few pixels high.
  const sorted = [...items].sort((a, b) => {
    const dy = boxOf(a).y - boxOf(b).y;
    return Math.abs(dy) > 8 ? dy : boxOf(a).x - boxOf(b).x;
  });
  return { kind: 'rows', children: sorted.map((item) => ({ kind: 'item', item })) };
}

export function layoutTree(items: SourceItem[]): LayoutNode {
  if (!items.length) return { kind: 'rows', children: [] };
  const ordered = items.filter((item) => item.order !== undefined);
  // The author's focus order wins when it names every object read; the others follow in XY order.
  if (ordered.length) {
    const rest = items.filter((item) => item.order === undefined);
    const sorted = [...ordered].sort((a, b) => a.order! - b.order!);
    const tail = rest.length ? flatten(cut(rest, 0)) : [];
    return { kind: 'rows', children: [...sorted, ...tail].map((item) => ({ kind: 'item', item })) };
  }
  // Items without a box (a slide's audio) come first, the slide's objects after them.
  const unboxed = items.filter((item) => !item.box);
  if (!unboxed.length) return cut(items, 0);
  const boxed = items.filter((item) => item.box);
  return { kind: 'rows', children: [...unboxed.map((item) => ({ kind: 'item' as const, item })), ...(boxed.length ? [cut(boxed, 0)] : [])] };
}

export function flatten(node: LayoutNode): SourceItem[] {
  return node.kind === 'item' ? [node.item] : node.children.flatMap(flatten);
}

// An image that covers most of the slide is its background (decoration, unless the author says).
export function isBackground(item: SourceItem, slide: { width: number; height: number } | undefined): boolean {
  if (!slide || !item.box || item.kind !== 'image') return false;
  const { width, height } = item.box;
  return width * height >= 0.8 * slide.width * slide.height;
}

// The slide's visual title: a short text in the top band, in the largest type of the slide.
export function visualTitle(items: SourceItem[], slide: { width: number; height: number } | undefined): SourceItem | null {
  if (!slide) return null;
  const texts = items.filter((item): item is SourceItem & { kind: 'text' } => item.kind === 'text' && !!item.box && !item.hidden);
  const candidates = texts.filter((item) => {
    const centre = item.box!.y + item.box!.height / 2;
    const plain = item.markdown.replace(/[*_\\`#]/g, '').trim();
    return centre < slide.height * 0.25 && plain.length > 0 && plain.length <= 120 && !plain.includes('\n');
  });
  if (!candidates.length) return null;
  const size = (item: SourceItem & { kind: 'text' }) => (item.heading ? 1000 : 0) + (item.fontSize ?? 0);
  const best = [...candidates].sort((a, b) => size(b) - size(a) || a.box!.y - b.box!.y)[0];
  const largestElsewhere = Math.max(0, ...texts.filter((item) => item !== best).map((item) => item.fontSize ?? 0));
  // Without sizes, the topmost short text is the title only when nothing says otherwise.
  if (best.fontSize === undefined && !best.heading) return candidates.length === 1 ? best : null;
  return best.heading || (best.fontSize ?? 0) >= largestElsewhere ? best : null;
}
