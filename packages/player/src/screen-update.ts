// Updating the screen shown in place (the editor canvas, screen-view.ts update): the blocks of the new
// data are placed into the page as it is. Blocks whose data did not change keep their node (a free
// object keeps running, a video keeps its frame), a component instance whose own data did not change
// keeps its node and gets its slots refilled, other blocks are rendered again. Nodes move with
// moveBefore where the browser has it, so frames are not reloaded. Blocks in dirty are rendered again
// whatever their data (a file they use changed).

import { flatBlocks } from './course-state.ts';
import { element } from './dom.ts';
import type { BlockData, LayerData, ScreenData } from './course-data.ts';

export interface PlacingContext {
  main: HTMLElement;
  // A block without the blocks of its slots, rendered.
  blockShell(block: BlockData): HTMLElement;
  // The slots of a template, by name, and the one a block goes into.
  slotsOf(host: HTMLElement): Map<string, HTMLElement>;
  slotFor(slots: ReadonlyMap<string, HTMLElement>, host: HTMLElement, block: BlockData, defaultSlot: string | null | undefined): HTMLElement;
  // The article of a screen and its title, without its blocks.
  screenArticle(screen: ScreenData): HTMLElement;
  // A block leaves the page: its object stops, its observers and timers end.
  disposeBlock(blockId: string): void;
  // The blocks that go have stopped; the new ones are about to be placed (the view shows next now).
  planned(): void;
  // An open layer whose blocks were placed again, or that is gone (closed without its events).
  layerRefilled(dialog: HTMLDialogElement, layer: LayerData): void;
  layerGone(id: string, dialog: HTMLDialogElement): void;
}

// A block of the screen being updated in place: kept as it is, kept with its slots refilled, or new.
type Plan = 'reuse' | 'keep' | 'new';

// Places the blocks of next into the page that shows previous (the same screen); returns the nodes
// rendered anew.
export function placeInPlace(context: PlacingContext, previous: ScreenData, next: ScreenData, article: HTMLElement, dirty: ReadonlySet<string>): HTMLElement[] {
  const { blockShell, slotsOf, slotFor, disposeBlock } = context;
  // The blocks shown now (screen and open layers), with the data they were rendered from.
  const nodes = new Map<string, HTMLElement>();
  for (const node of document.querySelectorAll<HTMLElement>('#t-main .t-block[data-block], dialog.t-layer .t-block[data-block]')) nodes.set(node.dataset.block ?? '', node);
  const before = new Map<string, BlockData>();
  for (const block of [...flatBlocks(previous.blocks), ...previous.layers.flatMap((layer) => flatBlocks(layer.blocks))]) before.set(block.id, block);
  const plans = new Map<string, Plan>();
  const kept = new Set<string>();
  // Where a block goes (its slot) and when (its step) do not change its node: placing and
  // applySteps take care of them, so a block moved to another slot keeps running.
  const rendering = (block: BlockData, children = true) => ({ ...block, slot: undefined, step: undefined, timing: undefined, ...(children ? {} : { blocks: undefined }) });
  const planOf = (block: BlockData) => {
    const old = before.get(block.id);
    const reusable = !!old && nodes.has(block.id) && !dirty.has(block.id);
    const clean = !flatBlocks(block.blocks).some((child) => dirty.has(child.id));
    if (reusable && clean && same(rendering(old), rendering(block))) { plans.set(block.id, 'reuse'); for (const id of [block.id, ...flatBlocks(block.blocks).map((child) => child.id)]) kept.add(id); return; }
    const keep = reusable && block.html != null && same(rendering(old, false), rendering(block, false));
    plans.set(block.id, keep ? 'keep' : 'new');
    if (keep) kept.add(block.id);
    for (const child of block.blocks || []) planOf(child);
  };
  for (const block of [...next.blocks, ...next.layers.flatMap((layer) => layer.blocks)]) planOf(block);
  // Blocks rendered again or gone stop before anything is rendered (hosts are kept by block id).
  for (const id of before.keys()) if (!kept.has(id)) disposeBlock(id);
  context.planned();

  const fresh: HTMLElement[] = [];
  const placed = new Map<string, HTMLElement>();
  const wanted = new Map<HTMLElement, HTMLElement[]>();
  const slotted: HTMLElement[] = [];
  const nodeFor = (block: BlockData): HTMLElement => {
    const plan = plans.get(block.id);
    let node = plan === 'reuse' || plan === 'keep' ? nodes.get(block.id) : undefined;
    if (!node) { node = blockShell(block); fresh.push(node); }
    placed.set(block.id, node);
    return node;
  };
  // Places the blocks of a host (in its slots, or in a column), then the blocks of their slots.
  // Nodes are only moved here: what a container no longer holds leaves once everything is placed,
  // so a node going to another container moves there without leaving the page.
  const fill = (host: HTMLElement, blocks: readonly BlockData[], defaultSlot: string | null | undefined, column: HTMLElement | null) => {
    const slots = column ? new Map<string, HTMLElement>() : slotsOf(host);
    slotted.push(...slots.values());
    const lists = new Map<HTMLElement, HTMLElement[]>(column ? [[column, []]] : [...[...slots.values(), host].map((container) => [container, []] as [HTMLElement, HTMLElement[]])]);
    for (const block of blocks) lists.get(column || slotFor(slots, host, block, defaultSlot))?.push(nodeFor(block));
    for (const [container, list] of lists) { arrange(container, list); wanted.set(container, list); }
    for (const block of blocks) {
      const node = placed.get(block.id);
      if (node && plans.get(block.id) !== 'reuse' && block.html != null && (block.blocks?.length || block.defaultSlot)) fill(node, block.blocks || [], block.defaultSlot, null);
    }
  };
  // The article: kept when the screen's own data is the same, otherwise a new one next to it.
  const own = (shown: ScreenData) => ({ ...shown, blocks: undefined, layers: undefined, events: undefined, key: undefined, covers: undefined, completeWhen: undefined, required: undefined, continueRevealsSteps: undefined, backdrop: undefined });
  let target = article;
  if (!same(own(previous), own(next))) {
    target = context.screenArticle(next);
    article.after(target);
  }
  if (next.layout) fill(target, next.blocks, next.layout.defaultSlot, null);
  else {
    let column = target.querySelector<HTMLElement>(':scope > .t-blocks');
    if (!column) { column = element('div', { class: 't-blocks' }); target.append(column); }
    fill(target, next.blocks, null, column);
  }
  // Open layers: refilled, or closed when the layer is gone or changed (the canvas opens it again).
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.t-layer')) {
    const id = dialog.dataset.layer ?? '';
    const layer = next.layers.find((candidate) => candidate.id === id);
    const old = previous.layers.find((candidate) => candidate.id === id);
    const column = dialog.querySelector<HTMLElement>(':scope > .t-blocks');
    if (layer && old && column && layer.title === old.title && layer.presentation === old.presentation && same(layer.narration ?? null, old.narration ?? null)) {
      fill(dialog, layer.blocks, null, column);
      context.layerRefilled(dialog, layer);
    } else context.layerGone(id, dialog);
  }
  for (const [container, list] of wanted) for (const child of [...container.children]) if (child instanceof HTMLElement && isBlockNode(child) && !list.includes(child)) child.remove();
  if (target !== article) article.remove();
  for (const node of slotted) node.toggleAttribute('data-empty', !node.children.length);
  // Kept blocks that left the page with a closed layer stop too.
  for (const id of kept) if (!placed.get(id)?.isConnected && !nodes.get(id)?.isConnected) disposeBlock(id);
  return fresh;
}

// Same data (the compiler writes block and screen data in a fixed key order).
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const isBlockNode = (node: Element): boolean => node.matches('.t-block[data-block]');

// Puts nodes in a container in order, before the blocks it no longer holds and after its other
// content: moved only when out of place, with moveBefore when the browser has it (an iframe moved
// with it keeps running; insertBefore would load it again).
type MovableParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
function arrange(container: MovableParent, nodes: readonly HTMLElement[]) {
  nodes.forEach((node, index) => {
    const current = [...container.children].filter(isBlockNode);
    if (current[index] === node) return;
    const before = current[index] ?? null;
    if (container.moveBefore && node.isConnected && container.isConnected) container.moveBefore(node, before);
    else container.insertBefore(node, before);
  });
}
