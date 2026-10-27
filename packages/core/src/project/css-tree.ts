// A stylesheet read as a tree of ranges (no values parsed): rules, at-rules, declarations, each
// with where it is in the text, so that a tool can cut a stylesheet apart and put it together again
// without touching what it does not move. Comments, strings, escapes and url() are skipped as CSS
// tokenizes them, so a brace or a semicolon inside them does not count. Used to place the theme's
// `@layer overrides` blocks (docs/decisions.md D32) and to upgrade a theme to that cascade.

export interface CssDeclaration {
  kind: 'declaration';
  start: number; // the property's first character
  end: number; // after its value (the semicolon not included)
  property: string; // lowercase, as written (custom properties keep their case)
  text: string; // `property: value` as written, trimmed
}

export interface CssBlockNode {
  kind: 'rule' | 'at-rule';
  start: number;
  end: number; // after the closing brace (or the semicolon of a statement)
  prelude: string; // the selector, or `@media (…)`, trimmed, comments removed
  name: string; // at-rules: the name, lowercase, without @ (media, layer, keyframes…); rules: ''
  // At-rules: true when the at-rule has a block. Statements (@import, @layer a, b;) have none.
  block: boolean;
  // Inside the braces: declarations and nested rules in order. Blocks of declarations only
  // (@font-face, @page, @property, @counter-style) and @keyframes keep their body opaque.
  children: CssNode[];
  bodyStart: number; // after the opening brace
  bodyEnd: number; // at the closing brace
}

export type CssNode = CssDeclaration | CssBlockNode;

// At-rules whose block holds rules (grouping rules): their children are read as a stylesheet.
const GROUPING = new Set(['media', 'supports', 'layer', 'container', 'scope', 'document', '-moz-document', 'starting-style']);
// At-rules whose block is not rules nor declarations of elements: kept whole.
const OPAQUE = new Set(['keyframes', '-webkit-keyframes', 'font-face', 'page', 'property', 'counter-style', 'font-feature-values', 'font-palette-values', 'view-transition', 'position-try', 'color-profile']);

export function parseCss(css: string): CssBlockNode[] {
  return readList(css, 0, css.length, 'sheet').filter((node): node is CssBlockNode => node.kind !== 'declaration');
}

// Skips what may hold braces or semicolons that do not count: a comment, a string, an escape, an
// unquoted url(). Returns the index after it, or i when there is nothing to skip.
function skip(css: string, i: number): number {
  const c = css[i];
  if (c === '/' && css[i + 1] === '*') {
    const end = css.indexOf('*/', i + 2);
    return end < 0 ? css.length : end + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
    return Math.min(css.length, j + 1);
  }
  if (c === '\\') return Math.min(css.length, i + 2);
  if ((c === 'u' || c === 'U') && /^url\(\s*[^'"\s)]/i.test(css.slice(i, i + 6)) && !/[\w-]/.test(css[i - 1] ?? '')) {
    const end = css.indexOf(')', i);
    return end < 0 ? css.length : end + 1;
  }
  return i;
}

// The end of a balanced block that starts at the brace at i (the index of its closing brace).
function closing(css: string, i: number, limit: number): number {
  let depth = 0;
  for (let j = i; j < limit; ) {
    const next = skip(css, j);
    if (next !== j) { j = next; continue; }
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) return j;
    j++;
  }
  return limit;
}

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');

// Rules of a stylesheet or of a grouping at-rule ('sheet'), or what a rule's braces hold ('body':
// declarations and nested rules).
function readList(css: string, from: number, to: number, context: 'sheet' | 'body'): CssNode[] {
  const nodes: CssNode[] = [];
  let i = from;
  while (i < to) {
    if (/\s|;/.test(css[i])) { i++; continue; }
    if (css[i] === '/' && css[i + 1] === '*') { i = skip(css, i); continue; }
    const start = i;
    // Up to a semicolon, an opening brace or the end, at depth 0 of parentheses and brackets.
    let depth = 0;
    let j = i;
    const custom = context === 'body' && css.startsWith('--', i);
    while (j < to) {
      const next = skip(css, j);
      if (next !== j) { j = next; continue; }
      const c = css[j];
      if (c === '(' || c === '[') depth++;
      else if ((c === ')' || c === ']') && depth > 0) depth--;
      else if (depth === 0 && (c === ';' || c === '}')) break;
      else if (depth === 0 && c === '{') {
        if (!custom) break;
        j = closing(css, j, to) + 1; // a custom property's value may hold braces
        continue;
      }
      j++;
    }
    const head = css.slice(start, j);
    if (j < to && css[j] === '{') {
      const close = closing(css, j, to);
      const prelude = withoutComments(head).trim();
      const at = /^@([\w-]+)/.exec(prelude);
      const name = at ? at[1].toLowerCase() : '';
      const node: CssBlockNode = { kind: at ? 'at-rule' : 'rule', start, end: Math.min(to, close + 1), prelude, name, block: true, children: [], bodyStart: j + 1, bodyEnd: close };
      if (!at) node.children = readList(css, j + 1, close, 'body');
      else if (GROUPING.has(name)) node.children = readList(css, j + 1, close, context === 'body' ? 'body' : 'sheet');
      else if (!OPAQUE.has(name)) node.children = readList(css, j + 1, close, 'body');
      nodes.push(node);
      i = node.end;
      continue;
    }
    const text = withoutComments(head).trim();
    if (text.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(text)?.[1].toLowerCase() ?? '';
      nodes.push({ kind: 'at-rule', start, end: Math.min(to, j + (css[j] === ';' ? 1 : 0)), prelude: text, name, block: false, children: [], bodyStart: j, bodyEnd: j });
    } else if (context === 'body') {
      const colon = text.indexOf(':');
      if (colon > 0) {
        const property = text.slice(0, colon).trim();
        // The declaration's own range: from its first character to its last, comments around left.
        let end = j;
        while (end > start && /\s/.test(css[end - 1])) end--;
        nodes.push({ kind: 'declaration', start, end, property: property.startsWith('--') ? property : property.toLowerCase(), text });
      }
    }
    // A stray closing brace (a broken stylesheet) or an item without a block at the top: skipped.
    i = j < to && css[j] === '}' ? j + 1 : Math.max(j + (j < to ? 1 : 0), start + 1);
  }
  return nodes;
}

// Every declaration under a node (rules nested at any depth), with the nodes it sits in.
export function* declarations(nodes: readonly CssNode[], parents: CssBlockNode[] = []): Generator<{ declaration: CssDeclaration; parents: CssBlockNode[] }> {
  for (const node of nodes) {
    if (node.kind === 'declaration') yield { declaration: node, parents };
    else yield* declarations(node.children, [...parents, node]);
  }
}
