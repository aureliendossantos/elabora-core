import { declarations, parseCss, type CssBlockNode, type CssNode } from '../project/css-tree.ts';
import { isRecord } from '../util/values.ts';

// The cascade of a course's design layer (docs/decisions.md D32). Cascade layers, first to last
// (a later layer wins whatever the specificity):
//   components-over-theme  elabora.base < elabora.theme < elabora.components < elabora.overrides
//     The player, then the theme's rules (the course's defaults), then the component stylesheets,
//     which give way to nothing the theme says in general, then the theme's `@layer overrides`
//     blocks: what the theme overrides in components on purpose. What `elabora init` writes.
//   theme-over-components  elabora.base < elabora.components < elabora.theme < elabora.overrides
//     The order from 6 to 13 October 2026, kept for courses whose course.json does not say: the
//     theme wins over the components. `elabora theme upgrade` moves a course to the other order
//     without changing how it looks.
// The theme's `@layer overrides { … }` blocks, at the top of its stylesheet, are its layer
// elabora.overrides in both orders.

export type Cascade = 'components-over-theme' | 'theme-over-components';
export const CASCADES: readonly Cascade[] = ['components-over-theme', 'theme-over-components'];
export const CURRENT_CASCADE: Cascade = 'components-over-theme';
export const OVERRIDES_LAYER = 'overrides';

// The course's cascade: theme.cascade, else the order before D32 (course.json written then).
export function cascadeOf(course: unknown): Cascade {
  const theme = isRecord(course) && isRecord(course.theme) ? course.theme : null;
  return theme?.cascade === 'components-over-theme' ? 'components-over-theme' : 'theme-over-components';
}

// The statement that orders the layers. The player's stylesheet (elabora/player.css, shared by every
// course) names only elabora.base; elabora/theme.css and the editor canvas start with this one, so the
// course's order follows: a browser orders layers where their names first appear.
export function layerOrder(cascade: Cascade): string {
  return cascade === 'components-over-theme'
    ? '@layer elabora.base, elabora.theme, elabora.components, elabora.overrides;'
    : '@layer elabora.base, elabora.components, elabora.theme, elabora.overrides;';
}

export interface SplitTheme {
  // The stylesheet without its top-level `@layer overrides` blocks (each replaced by as many line
  // breaks as it had, so that lines keep their numbers).
  defaults: string;
  // The bodies of those blocks, in order: the layer elabora.overrides.
  overrides: string;
  // `@layer overrides` blocks inside another rule or at-rule: they stay a sub-layer of where they
  // are, so they do not override the components (the validator says so).
  nested: number;
}

const isOverrides = (node: CssBlockNode): boolean => node.kind === 'at-rule' && node.name === 'layer' && node.block && node.prelude.replace(/^@layer\s+/i, '').trim() === OVERRIDES_LAYER;

export function splitOverrides(css: string): SplitTheme {
  const tree = parseCss(css);
  const top = tree.filter(isOverrides);
  let nested = 0;
  const walk = (nodes: readonly CssNode[], depth: number) => {
    for (const node of nodes) if (node.kind !== 'declaration') { if (depth > 0 && isOverrides(node)) nested++; walk(node.children, depth + 1); }
  };
  walk(tree, 0);
  if (!top.length) return { defaults: css, overrides: '', nested };
  let defaults = '';
  let at = 0;
  for (const node of top) {
    defaults += css.slice(at, node.start) + css.slice(node.start, node.end).replace(/[^\n]/g, '');
    at = node.end;
  }
  defaults += css.slice(at);
  const overrides = top.map((node) => css.slice(node.bodyStart, node.bodyEnd).replace(/^\n/, '')).join('\n');
  return { defaults, overrides, nested };
}

// ── Property families ────────────────────────────────────────────────
// Properties that act on one another (a shorthand and its longhands, logical and physical sides,
// aliases) share a family: a theme upgrade moves a family whole, so the theme's declarations of
// one family keep their order among themselves. Families are coarse on purpose: two that act on
// one another must never be apart; one family too many only moves more.
const FAMILIES: readonly [RegExp, string][] = [
  [/^margin/, 'margin'], [/^padding/, 'padding'], [/^(inset|top|right|bottom|left)(-|$)/, 'inset'],
  [/^border/, 'border'], [/^outline/, 'outline'], [/^background/, 'background'],
  [/^(font|line-height)(-|$)/, 'font'], [/^text-decoration/, 'text-decoration'], [/^text-emphasis/, 'text-emphasis'],
  [/^(text-wrap|white-space)(-|$)/, 'text-wrap'], [/^text-align/, 'text-align'], [/^text-box/, 'text-box'],
  [/^list-style/, 'list-style'], [/^(grid|gap|row-gap|column|columns)(-|$)/, 'grid'], [/^(flex|order)(-|$)/, 'flex'],
  [/^(place|align|justify)-/, 'align'], [/^(overflow|word-wrap)(-|$)/, 'overflow'],
  [/^(width|height|min-|max-|inline-size|block-size|aspect-ratio|contain-intrinsic)/, 'size'],
  [/^animation/, 'animation'], [/^transition/, 'transition'], [/^(transform|translate|rotate|scale)(-|$)/, 'transform'],
  [/^mask/, 'mask'], [/^container/, 'container'], [/^scroll-/, 'scroll'], [/^offset/, 'offset'], [/^caret/, 'caret'],
  [/^marker/, 'marker'], [/^(break-|page-break-)/, 'break'], [/^(vertical-align|baseline-|alignment-baseline|dominant-baseline)/, 'vertical-align'],
  [/^overscroll/, 'overscroll'], [/^line-clamp/, 'line-clamp'], [/^box-/, 'box'], [/^(contain|content-visibility)(-|$)/, 'contain'],
  [/^(position-|inset-area|anchor)/, 'position-anchor']
];

export function propertyFamily(property: string): string {
  if (property.startsWith('--')) return property;
  const name = property.toLowerCase().replace(/^-(webkit|moz|ms|o)-/, '');
  if (name === 'all') return '*';
  for (const [pattern, family] of FAMILIES) if (pattern.test(name)) return family;
  return name;
}

// ── Upgrading a theme to components-over-theme ───────────────────────
export interface ThemeUpgrade {
  css: string; // the theme stylesheet to write
  // The families of properties the components set, which the theme set too: its declarations of
  // those stay over the components, in a `@layer overrides` block.
  families: string[];
  moved: number; // declarations moved into the block
  rules: string[]; // selectors (with their at-rules) of the rules some declarations left
}

// The theme as the new order needs it to look the same: every declaration of the theme of a family
// that some component stylesheet sets too goes into a `@layer overrides` block, in order, inside the
// same rules and at-rules (it wins over the components as before); the others stay where they are,
// under the components that never set them. Each family is moved whole, so the theme's own
// declarations keep their order and specificity among themselves; @keyframes and @property the
// components define too go along. A component or a theme that sets `all` acts on every property:
// the whole theme is moved. The block goes before the theme's own `@layer overrides` blocks, which
// keep coming last. Comments outside moved rules stay; a rule left empty goes.
const UPGRADED_LAYER = 'upgraded';

export function upgradeTheme(theme: string, components: readonly string[]): ThemeUpgrade {
  const componentFamilies = new Set<string>();
  const componentNames = new Set<string>();
  for (const css of components) {
    const tree = parseCss(css);
    for (const { declaration } of declarations(tree)) componentFamilies.add(propertyFamily(declaration.property));
    for (const name of namedRules(tree)) componentNames.add(name);
  }
  const tree = parseCss(theme);
  const outside = tree.filter((node) => !isOverrides(node));
  let everything = componentFamilies.has('*');
  for (const { declaration } of declarations(outside)) if (propertyFamily(declaration.property) === '*') everything = true;
  const moves = (node: CssNode): boolean => node.kind === 'declaration'
    ? everything || componentFamilies.has(propertyFamily(node.property))
    : node.kind === 'at-rule' && !node.block ? false
    : node.kind === 'at-rule' && namedRuleOf(node) !== null ? everything || componentNames.has(namedRuleOf(node)!)
    : false;

  // What stays and what goes: a node is kept whole, moved whole, or split (some of its children go).
  const families = new Set<string>();
  let moved = 0;
  const rules = new Set<string>();
  const cuts: [number, number][] = [];
  // Returns the text of the node in the overrides block ('' when nothing of it moves), and records
  // the cuts in the original.
  const visit = (node: CssNode, parents: CssBlockNode[], indent: string): string => {
    if (moves(node)) {
      cuts.push(cutRange(theme, node.start, node.end, node.kind === 'declaration'));
      // The declaration as written (its text without comments would empty a string holding « /* »).
      if (node.kind === 'declaration') { moved++; families.add(propertyFamily(node.property)); rules.add(parents.map((parent) => parent.prelude).join(' › ')); return `${indent}${theme.slice(node.start, node.end).trim()};\n`; }
      return `${indent}${reindent(theme.slice(node.start, node.end), indent)}\n`;
    }
    if (node.kind === 'declaration' || !node.block || !node.children.length) return '';
    const inner = node.children.map((child) => visit(child, [...parents, node], `${indent}  `)).join('');
    if (!inner) return '';
    // Left with nothing but whitespace and comments: the whole rule goes.
    const remaining = node.children.filter((child) => !cuts.some(([from, to]) => from <= child.start && child.end <= to));
    if (!remaining.length) cuts.push(cutRange(theme, node.start, node.end, false));
    return `${indent}${node.prelude} {\n${inner}${indent}}\n`;
  };
  const block = outside.map((node) => visit(node, [], '  ')).join('');
  if (!block) return { css: theme, families: [], moved: 0, rules: [] };
  // Cuts nested in a larger cut are covered by it; cuts with only spaces between them on a line are one, and
  // a line they leave empty goes with them.
  const sorted: [number, number][] = [];
  for (const cut of cuts.sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
    const last = sorted.at(-1);
    if (last && cut[0] <= last[1]) last[1] = Math.max(last[1], cut[1]);
    else if (last && !/[^ \t]/.test(theme.slice(last[1], cut[0]))) last[1] = cut[1];
    else sorted.push([...cut]);
  }
  for (const cut of sorted) {
    if (theme[cut[1] - 1] === '\n') continue; // whole lines already
    let from = cut[0];
    while (from > 0 && /[ \t]/.test(theme[from - 1])) from--;
    let to = cut[1];
    while (to < theme.length && /[ \t]/.test(theme[to])) to++;
    if ((from === 0 || theme[from - 1] === '\n') && theme[to] === '\n') { cut[0] = from; cut[1] = to + 1; }
  }
  let kept = '';
  let at = 0;
  for (const [from, to] of sorted) { kept += theme.slice(at, from); at = to; }
  kept += theme.slice(at);
  const firstOverrides = tree.find(isOverrides);
  const insertAt = firstOverrides ? firstOverrides.start - sorted.filter(([, to]) => to <= firstOverrides.start).reduce((sum, [from, to]) => sum + (to - from), 0) : kept.length;
  const note = `/* Rules that override the components (cascade layer elabora.overrides, docs D32). elabora theme upgrade put here what the\n   theme set on properties the components also set (${[...families].sort().join(', ')}), so that the course looks as it did when\n   the theme won over the components. Move out of this block the rules that are course-wide defaults: components then\n   give them their own values. */\n`;
  // Beside overrides the author already wrote, what moved goes into a sublayer under them: the
  // author's overrides won over the theme before, and win over what moved now, whatever the
  // specificity (and an !important that moved still wins over theirs, as the theme's did).
  const insertion = firstOverrides
    ? `${note}@layer ${OVERRIDES_LAYER} {\n  @layer ${UPGRADED_LAYER} {\n${block.replace(/^(?=.)/gm, '  ')}  }\n}\n`
    : `${note}@layer ${OVERRIDES_LAYER} {\n${block}}\n`;
  const before = kept.slice(0, insertAt);
  const css = `${before}${before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}${insertion}${firstOverrides ? '\n' : ''}${kept.slice(insertAt)}`;
  return { css, families: [...families].sort(), moved, rules: [...rules].filter(Boolean) };
}

// A range to cut: a declaration with its semicolon, the spaces after it, and its line when nothing
// else is on it; a rule with its line too.
function cutRange(css: string, start: number, end: number, declaration: boolean): [number, number] {
  let to = end;
  if (declaration) {
    let j = to;
    while (j < css.length && /[ \t]/.test(css[j])) j++;
    if (css[j] === ';') to = j + 1;
  }
  while (to < css.length && /[ \t]/.test(css[to])) to++;
  let from = start;
  while (from > 0 && /[ \t]/.test(css[from - 1])) from--;
  const lineStart = from === 0 || css[from - 1] === '\n';
  if (lineStart && css[to] === '\n') to++;
  else from = start;
  return [from, to];
}

const reindent = (text: string, indent: string): string => text.replace(/\n[ \t]*/g, `\n${indent}  `).replace(/\n[ \t]*}$/, `\n${indent}}`);

// @keyframes and @property name what a later layer may redefine.
function namedRuleOf(node: CssBlockNode): string | null {
  if (!/^(-webkit-)?keyframes$|^property$/.test(node.name)) return null;
  return `${node.name.replace(/^-webkit-/, '')} ${node.prelude.replace(/^@[\w-]+\s+/, '').trim()}`;
}

function* namedRules(nodes: readonly CssNode[]): Generator<string> {
  for (const node of nodes) {
    if (node.kind === 'declaration') continue;
    const name = namedRuleOf(node);
    if (name) yield name;
    else yield* namedRules(node.children);
  }
}
