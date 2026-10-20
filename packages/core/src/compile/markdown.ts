import MarkdownIt from 'markdown-it';
import type { StateBlock, StateCore, StateInline, Token } from 'markdown-it';
import temml from 'temml';

// Elabora Markdown subset: CommonMark without raw HTML, plus tables and maths.
// Maths: $…$ inline, $$…$$ display (inline or on its own lines), LaTeX rendered to MathML at
// build time by temml: native in browsers, read by screen readers, no script at runtime.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
md.disable(['image']);
md.inline.ruler.after('escape', 'math_inline', mathInline);
md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.core.ruler.push('math_glue', mathGlue);
md.renderer.rules.math_inline = (tokens, index) => {
  const token = tokens[index];
  const { display, lead, trail } = mathMeta(token);
  const html = renderTex(token.content, display);
  return lead || trail ? `<span class="t-nobr">${md.utils.escapeHtml(lead)}${html}${md.utils.escapeHtml(trail)}</span>` : html;
};
md.renderer.rules.math_block = (tokens, index) => `<div class="t-math-display">${renderTex(tokens[index].content, true)}</div>\n`;

const defaultLink = md.renderer.rules.link_open || ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const href = String(tokens[index].attrGet('href') || '');
  // A link to a glossary entry (glossary:<id>, D58): the player shows its definition and opens the
  // Glossary there; without the player's script it still leads to the entry's place.
  const term = /^glossary:([a-z][a-z0-9-]{0,47})$/.exec(href);
  if (term) {
    tokens[index].attrSet('href', `#t-glossary-${term[1]}`);
    tokens[index].attrSet('class', 't-term');
    tokens[index].attrSet('data-term', term[1]);
    return defaultLink(tokens, index, options, env, self);
  }
  if (/^https?:\/\//i.test(href)) {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLink(tokens, index, options, env, self);
};

// What a math token keeps in meta: display maths, and the punctuation glued to it (mathGlue).
function mathMeta(token: Token): { display: boolean; lead: string; trail: string } {
  const meta = token.meta || {};
  return { display: meta.display === true, lead: typeof meta.lead === 'string' ? meta.lead : '', trail: typeof meta.trail === 'string' ? meta.trail : '' };
}

// Browsers may break a line between inline MathML and the punctuation around it, leaving "(" at
// the end of a line or "," at the start of the next: the punctuation is moved next to the maths,
// in a span that does not wrap.
function mathGlue(state: StateCore): void {
  for (const block of state.tokens) {
    const children = block.type === 'inline' ? block.children || [] : [];
    for (let i = 0; i < children.length; i++) {
      const token = children[i];
      if (token.type !== 'math_inline' || mathMeta(token).display) continue;
      const previous = children[i - 1]?.type === 'text' ? children[i - 1] : null;
      const next = children[i + 1]?.type === 'text' ? children[i + 1] : null;
      const lead = previous ? (/[([{«“‘"']+$/u.exec(previous.content)?.[0] || '') : '';
      const trail = next ? (/^[)\]}»”’"'.,;:!?%…]+/u.exec(next.content)?.[0] || '') : '';
      if (!lead && !trail) continue;
      if (previous && lead) previous.content = previous.content.slice(0, -lead.length);
      if (next && trail) next.content = next.content.slice(trail.length);
      token.meta = { ...token.meta, lead, trail };
    }
  }
}

// The text functions take any prop value: templates and the compiler pass props as they are.
export function renderMarkdown(text: unknown): string {
  return text ? md.render(String(text)).trim() : '';
}

// Inline rendering (no paragraph): for short fields placed inside a sentence or a label.
export function renderMarkdownInline(text: unknown): string {
  return text ? md.renderInline(String(text)).trim() : '';
}

// The tokens of a text in the subset (markdown-it's, with math_inline and math_block), for the
// renderers that do not write HTML (the plan's document, D48).
export function parseMarkdown(text: unknown): Token[] {
  return text ? md.parse(String(text), {}) : [];
}

export type { Token as MarkdownToken };

export function markdownToText(text: unknown): string {
  return String(text || '').replace(/[*_`#>]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
}

// LaTeX → MathML. Errors render as the source in red (temml), and validation reports them.
export function renderTex(tex: unknown, display = false): string {
  return temml.renderToString(String(tex), { displayMode: !!display, throwOnError: false });
}

export interface MathError {
  tex: string;
  message: string;
}

// Maths errors of a Markdown text (or of a raw TeX string with { tex: true }), for the validator.
export function mathErrors(text: unknown, { tex = false }: { tex?: boolean } = {}): MathError[] {
  if (!text) return [];
  const sources = tex ? [String(text)] : mathSources(String(text));
  const errors: MathError[] = [];
  for (const source of sources) {
    try { temml.renderToString(source, { throwOnError: true }); } catch (error) { errors.push({ tex: source, message: errorMessage(error).replace(/^Temml parse error:\s*/i, '') }); }
  }
  return errors;
}

function errorMessage(error: unknown): string {
  const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
  return String(message || error);
}

function mathSources(text: string): string[] {
  const sources: string[] = [];
  const walk = (tokens: Token[] | null): void => {
    for (const token of tokens || []) {
      if (token.type === 'math_inline' || token.type === 'math_block') sources.push(token.content);
      if (token.children) walk(token.children);
    }
  };
  walk(md.parse(text, {}));
  return sources;
}

// $…$ (inline) and $$…$$ (display inside a sentence). Pandoc rules avoid prices: no space just
// inside the dollars, no digit right after the closing dollar. \$ is a literal dollar.
function mathInline(state: StateInline, silent: boolean): boolean {
  const source = state.src;
  const start = state.pos;
  if (source.charCodeAt(start) !== 0x24 /* $ */) return false;
  const display = source.charCodeAt(start + 1) === 0x24;
  const delimiter = display ? '$$' : '$';
  const from = start + delimiter.length;
  let end = from;
  for (;;) {
    end = source.indexOf(delimiter, end);
    if (end < 0) return false;
    if (source.charCodeAt(end - 1) === 0x5c /* \ */) { end += 1; continue; }
    break;
  }
  const content = source.slice(from, end);
  if (!content.trim()) return false;
  if (!display) {
    if (/^\s|\s$/.test(content)) return false;
    const after = source.charCodeAt(end + 1);
    if (after >= 0x30 && after <= 0x39) return false;
  }
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = content;
    token.markup = delimiter;
    token.meta = { display };
  }
  state.pos = end + delimiter.length;
  return true;
}

// $$ on its own line(s): $$ … $$, possibly over several lines.
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const source = state.src;
  let position = state.bMarks[startLine] + state.tShift[startLine];
  let lineEnd = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (source.slice(position, position + 2) !== '$$') return false;
  const first = source.slice(position + 2, lineEnd).trim();
  let next = startLine;
  const body: string[] = [];
  let found = false;
  if (first.endsWith('$$') && first.length >= 2) {
    body.push(first.slice(0, -2));
    found = true;
  } else {
    if (first) body.push(first);
    while (!found) {
      next++;
      if (next >= endLine) break;
      position = state.bMarks[next] + state.tShift[next];
      lineEnd = state.eMarks[next];
      const line = source.slice(position, lineEnd).trim();
      if (line.endsWith('$$')) { body.push(line.slice(0, -2)); found = true; } else body.push(line);
    }
  }
  if (!found) return false;
  if (silent) return true;
  state.line = next + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = body.join('\n').trim();
  token.markup = '$$';
  token.map = [startLine, state.line];
  return true;
}
