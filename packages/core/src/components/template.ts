import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { JsonSchema } from '@elabora/format';
import { renderMarkdown, renderMarkdownInline, markdownToText, renderTex } from '../compile/markdown.ts';

// Component templates: HTML with a small, declarative vocabulary, rendered at build time.
//
//   {{path}}            value of a prop (escaped text; Markdown and TeX props render as HTML in content)
//   {{path | inline}}   Markdown rendered without paragraph · {{path | text}} Markdown as plain text
//   {{.}} {{@index}} {{@number}} {{@count}} {{@first}} {{@last}}   inside data-each
//   {{@id}}             id of the block (or screen) using the component: unique ids for SVG gradients…
//   data-if="expr"      keep the element when expr holds: path, !path, path == value, path != value
//   data-each="path"    repeat the element for every item of a list prop (item fields in scope)
//   data-slot="id"      where the blocks of that slot go · data-title (screen components): the screen title
//   data-t-…            behaviour hooks handled by the player (docs/components.md)
//
// With the fields option (the app's canvas, never a package), an element whose whole content is one
// text prop gets data-t-field="<path below props>" (options.1.label): the app knows which text the
// author points at.
//
// No JavaScript ever: templates hold structure, decoration and bindings; words come from props.

type ParentNode = DefaultTreeAdapterMap['parentNode'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];
type DocumentFragment = DefaultTreeAdapterMap['documentFragment'];

export interface ParsedTemplate {
  source: string;
  root: DocumentFragment;
}

// A schema as templates navigate it: subschemas may be booleans, or missing.
export type SchemaNode = JsonSchema | boolean | null | undefined;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INTERP = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g;
const DIRECTIVES = new Set(['data-if', 'data-each', 'data-t-heading']);
const KEEP_EMPTY = new Set(['alt', 'value']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';

const isText = (n: ChildNode): n is TextNode => n.nodeName === '#text';
const isElement = (n: ChildNode): n is Element => 'tagName' in n;
// A <template> element holds its children in content.
const childrenOf = (n: Element): ParentNode => ('content' in n ? (n as DefaultTreeAdapterMap['template']).content : n);
const attributes = (n: Element): Record<string, string> => Object.fromEntries((n.attrs || []).map((a) => [a.name, a.value]));

const cache = new Map<string, ParsedTemplate>();
export function parseTemplate(html: string | null | undefined): ParsedTemplate {
  const key = String(html ?? '');
  const cached = cache.get(key);
  if (cached) return cached;
  const frag = parseFragment(key.replace(/<!--[\s\S]*?-->/g, ''), { sourceCodeLocationInfo: true });
  const tpl = { source: key, root: frag };
  cache.set(key, tpl);
  return tpl;
}

// ── schema navigation ────────────────────────────────────────────────
const KIND_OF_TYPE: Record<string, string> = { string: 'text', number: 'number', integer: 'number', boolean: 'boolean', array: 'list', object: 'object' };

export function kindOf(schema: SchemaNode): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema['x-kind']) return schema['x-kind'] as string;
  if (schema.enum) return typeof schema.enum[0] === 'number' ? 'number' : 'enum';
  if (schema.const !== undefined) return typeof schema.const;
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  return KIND_OF_TYPE[t ?? ''] || 'unknown';
}
export const childSchema = (schema: SchemaNode, key: string): SchemaNode => {
  if (!schema || typeof schema !== 'object') return undefined;
  return schema.properties?.[key] ?? (schema.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
};
export const itemSchema = (schema: SchemaNode): SchemaNode => (schema && typeof schema === 'object' ? schema.items : undefined);

// ── expressions ──────────────────────────────────────────────────────
export type Expression = { error: string } | { error?: undefined; not: boolean; path: string; op: '==' | '!=' | null; literal: unknown };

// path: name, name.sub, ., @index… · condition: path, !path, path == literal, path != literal
export function parseExpr(expr: unknown): Expression {
  const s = String(expr || '').trim();
  const m = /^(!)?\s*([@.\w][\w.@-]*)\s*(?:(==|!=)\s*(.+))?$/.exec(s);
  if (!m) return { error: `cannot read "${s}"` };
  let literal: unknown;
  if (m[3]) {
    const raw = m[4].trim();
    if (/^-?\d+(\.\d+)?$/.test(raw)) literal = Number(raw);
    else if (raw === 'true' || raw === 'false') literal = raw === 'true';
    else if (raw === 'null') literal = null;
    else literal = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
  return { not: !!m[1], path: m[2], op: (m[3] as '==' | '!=' | undefined) || null, literal };
}
export const truthy = (v: unknown): boolean => !(v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0));

// Scopes: { data, schema, vars, parent }. Lookup walks up until a scope has the first segment.
interface Scope {
  data: unknown;
  schema: SchemaNode;
  vars: Record<string, unknown> | null;
  parent: Scope | null;
  path?: (string | number)[] | null; // where data sits below props (null: not a prop)
}
interface Found {
  found: boolean;
  value?: unknown;
  schema?: SchemaNode;
}

function lookup(scope: Scope, path: string): Found {
  if (path === '.') return { value: scope.data, schema: scope.schema, found: true };
  if (path.startsWith('@')) {
    for (let s: Scope | null = scope; s; s = s.parent) if (s.vars && path.slice(1) in s.vars) return { value: s.vars[path.slice(1)], schema: { type: typeof s.vars[path.slice(1)] }, found: true };
    return { found: false };
  }
  const [first, ...rest] = path.split('.');
  for (let s: Scope | null = scope; s; s = s.parent) {
    const has = !!s.data && typeof s.data === 'object' && !Array.isArray(s.data) && Object.prototype.hasOwnProperty.call(s.data, first);
    const declared = childSchema(s.schema, first);
    if (!has && !declared) continue;
    let value: unknown = has ? (s.data as Record<string, unknown>)[first] : undefined;
    let schema = declared;
    for (const seg of rest) { value = value == null ? undefined : (value as Record<string, unknown>)[seg]; schema = childSchema(schema, seg); }
    return { value, schema, found: true };
  }
  return { found: false };
}
// The path below props of a prop a template names (null: a variable, or not found).
function fieldPath(scope: Scope, path: string): (string | number)[] | null {
  if (path.startsWith('@')) return null;
  if (path === '.') return scope.path ?? null;
  const [first, ...rest] = path.split('.');
  for (let s: Scope | null = scope; s; s = s.parent) {
    const has = !!s.data && typeof s.data === 'object' && !Array.isArray(s.data) && Object.prototype.hasOwnProperty.call(s.data, first);
    if (!has && !childSchema(s.schema, first)) continue;
    return s.path ? [...s.path, first, ...rest] : null;
  }
  return null;
}

function evalCond(expr: string, scope: Scope): boolean {
  const e = parseExpr(expr);
  if (e.error !== undefined) return false;
  const { value } = lookup(scope, e.path);
  const ok = e.op === '==' ? value === e.literal || (value == null && e.literal == null) : e.op === '!=' ? value !== e.literal : truthy(value);
  return e.not ? !ok : ok;
}

// ── rendering ────────────────────────────────────────────────────────
const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: unknown): string => esc(s).replace(/"/g, '&quot;');
export const tokenVar = (name: unknown): string => `var(--t-${String(name).replace(/\./g, '-').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)})`;

// Where an asset prop points in the package: assets/<value>, unless the build ships a rendition
// under another name (RenderOptions.assetPath).
export const defaultAssetPath = (name: string): string => `assets/${name}`;

function attrValue(v: unknown, schema: SchemaNode, assetPath: (name: string) => string): string {
  if (v === undefined || v === null) return '';
  const kind = kindOf(schema);
  if (kind === 'asset') return assetPath(String(v));
  if (kind === 'token') return tokenVar(v);
  if (kind === 'markdown') return markdownToText(v);
  if (typeof v === 'object') return '';
  return String(v);
}

function contentValue(v: unknown, schema: SchemaNode, filter: string | undefined, alone: boolean, assetPath: (name: string) => string): string {
  if (v === undefined || v === null) return '';
  const kind = kindOf(schema);
  if (kind === 'markdown') {
    if (filter === 'text') return esc(markdownToText(v));
    return filter === 'inline' || !alone ? renderMarkdownInline(v) : renderMarkdown(v);
  }
  if (kind === 'tex') return renderTex(v, filter !== 'inline');
  if (kind === 'asset') return esc(assetPath(String(v)));
  if (kind === 'token') return esc(tokenVar(v));
  if (typeof v === 'object') return '';
  return esc(v);
}

export interface RenderOptions {
  props?: unknown;
  schema?: SchemaNode;
  id?: string;
  language?: string;
  assetPath?: (name: string) => string; // package path of an asset prop's value
  // Level of the heading before the instance (1: the screen title). Headings marked data-t-heading
  // follow it: the first is one level deeper, the others keep their distance to the first.
  headingLevel?: number;
  // Mark the elements whose content is one text prop (data-t-field): the app's canvas only.
  fields?: boolean;
}

// Declared level of the shallowest heading marked data-t-heading in a template (null: none).
function relativeHeadingTop(tpl: ParsedTemplate): number | null {
  let top: number | null = null;
  const visit = (node: ParentNode) => {
    for (const child of node.childNodes || []) {
      if (!isElement(child)) continue;
      const m = /^h([1-6])$/.exec(child.tagName);
      if (m && (child.attrs || []).some((attribute) => attribute.name === 'data-t-heading')) top = Math.min(top ?? 6, Number(m[1]));
      visit(childrenOf(child));
    }
  };
  visit(tpl.root);
  return top;
}

// renderTemplate(tpl, { props, schema, id, language }) → { html, headings }
// headings: levels of the h1–h6 elements of the template itself (not of the Markdown inside props).
export function renderTemplate(tpl: ParsedTemplate, { props = {}, schema = null, id = '', language = 'en', assetPath = defaultAssetPath, headingLevel, fields = false }: RenderOptions = {}): { html: string; headings: number[] } {
  const out: string[] = [];
  const headings: number[] = [];
  // Headings that follow the page (data-t-heading): shifted so the shallowest one sits one level
  // under the heading before the instance (h2 to h6).
  const relative = relativeHeadingTop(tpl);
  const shift = headingLevel !== undefined && relative !== null ? headingLevel + 1 - relative : 0;
  const root: Scope = { data: props, schema, vars: { id, lang: language }, parent: null, path: [] };
  const renderChildren = (node: ParentNode, scope: Scope) => { for (const c of node.childNodes || []) renderNode(c, scope); };
  function renderNode(node: ChildNode, scope: Scope): void {
    if (isText(node)) {
      const text = node.value;
      // Indentation between tags is template formatting, not content.
      if (!text.trim()) { if (!text.includes('\n')) out.push(' '); return; }
      const alone = /^\s*\{\{[^{}]+\}\}\s*$/.test(text);
      let last = 0;
      let s = '';
      for (const m of text.matchAll(INTERP)) {
        s += esc(text.slice(last, m.index));
        const r = lookup(scope, m[1].trim());
        s += r.found ? contentValue(r.value, r.schema, m[2], alone, assetPath) : '';
        last = m.index + m[0].length;
      }
      out.push(alone ? s.trim() : s + esc(text.slice(last)));
      return;
    }
    if (!isElement(node)) return;
    const attrs = attributes(node);
    if (attrs['data-each'] !== undefined) {
      const r = lookup(scope, attrs['data-each'].trim());
      const list = Array.isArray(r.value) ? r.value : [];
      list.forEach((item, i) => {
        const at = fieldPath(scope, attrs['data-each'].trim());
        const s: Scope = { data: item, schema: itemSchema(r.schema), vars: { index: i, number: i + 1, count: list.length, first: i === 0, last: i === list.length - 1 }, parent: scope, path: at ? [...at, i] : null };
        if (attrs['data-if'] !== undefined && !evalCond(attrs['data-if'], s)) return;
        renderElement(node, s);
      });
      return;
    }
    if (attrs['data-if'] !== undefined && !evalCond(attrs['data-if'], scope)) return;
    renderElement(node, scope);
  }
  function renderElement(node: Element, scope: Scope): void {
    const html = (node.namespaceURI as string) === HTML_NS;
    const m = /^h([1-6])$/.exec(node.tagName);
    const follows = !!m && html && (node.attrs || []).some((attribute) => attribute.name === 'data-t-heading');
    const tag = follows ? `h${Math.min(6, Math.max(2, Number(m?.[1]) + shift))}` : node.tagName;
    if (m && html) headings.push(Number(tag.slice(1)));
    let s = `<${tag}`;
    for (const a of node.attrs || []) {
      if (DIRECTIVES.has(a.name)) continue;
      const only = /^\s*\{\{[^{}]+\}\}\s*$/.test(a.value);
      let v = a.value.replace(INTERP, (_, p: string) => { const r = lookup(scope, p.trim()); return r.found ? attrValue(r.value, r.schema, assetPath) : ''; });
      if (a.name === 'class') v = v.replace(/\s+/g, ' ').trim();
      if (only && v === '' && !KEEP_EMPTY.has(a.name)) continue;
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
      s += v === '' && !KEEP_EMPTY.has(a.name) && !a.value ? ` ${name}` : ` ${name}="${escAttr(v)}"`;
    }
    const field = fields && html ? textField(node, scope) : null;
    if (field) s += ` data-t-field="${escAttr(field)}"`;
    out.push(`${s}>`);
    if (VOID.has(tag) && html) return;
    renderChildren(childrenOf(node), scope);
    out.push(`</${tag}>`);
  }
  // The prop an element shows as its whole content, when it is text (a string, Markdown included).
  function textField(node: Element, scope: Scope): string | null {
    const content = (childrenOf(node).childNodes || []).filter((child) => !(isText(child) && !child.value.trim()));
    if (content.length !== 1 || !isText(content[0])) return null;
    const m = /^\s*\{\{\s*([^{}|]+?)\s*(?:\|\s*([a-z]+)\s*)?\}\}\s*$/.exec(content[0].value);
    if (!m) return null;
    const found = lookup(scope, m[1].trim());
    if (!found.found || typeof found.value !== 'string') return null;
    const at = fieldPath(scope, m[1].trim());
    return at && at.length ? at.join('.') : null;
  }
  renderChildren(tpl.root, root);
  return { html: out.join('').trim(), headings };
}

// ── static analysis (validator, editors) ─────────────────────────────
export interface TemplateRef {
  path: string;
  filter: string | null;
  where: 'text' | 'attr';
  attr: string | null;
  tag: string | null;
  line: number | undefined;
  kind: string | null;
  schema: SchemaNode;
}
export interface TemplateCondition {
  path: string;
  where: 'data-if';
  line: number | undefined;
  error?: string;
}
export interface TemplateElement {
  tag: string;
  ns: string;
  attrs: Record<string, string>;
  line: number | undefined;
  inEach: boolean;
  each: string | null;
  conditional: boolean;
  inSvg: boolean;
  parentHooks: string[];
}
export interface TemplateHook {
  hook: string;
  value: string;
  tag: string;
  line: number | undefined;
  inEach: boolean;
  each: string | null;
  within: string[]; // hooks of the enclosing elements
  // What the element holds: the tags and the hooks (with their values) of its descendants.
  inner: { tags: string[]; hooks: { hook: string; value: string }[] };
}
export interface TemplateAnalysis {
  refs: TemplateRef[];
  unknown: (TemplateRef | TemplateCondition)[];
  badEach: { path: string; line: number | undefined; found: boolean }[];
  elements: TemplateElement[];
  texts: { text: string; line: number | undefined; inSvg: boolean; svgText?: boolean }[];
  slots: { id: string; line: number | undefined; empty: boolean; conditional: boolean; inEach: boolean }[];
  titles: number;
  hooks: TemplateHook[];
  usedProps: Set<string>;
  conditions: { expr: string; line: number | undefined }[];
}

interface WalkContext {
  inSvg?: boolean;
  inSvgText?: boolean;
  each?: string | null;
  conditional?: boolean;
  hooks: string[];
}

// Walks the template with the props schema: every binding, hook, slot, literal text and tag, with
// its line. The validator turns this into diagnostics; editors use it to know what a prop drives.
export function analyzeTemplate(tpl: ParsedTemplate, schema: SchemaNode): TemplateAnalysis {
  const a: TemplateAnalysis = { refs: [], unknown: [], badEach: [], elements: [], texts: [], slots: [], titles: 0, hooks: [], usedProps: new Set(), conditions: [] };
  const line = (n: { sourceCodeLocation?: { startLine: number } | null }) => n.sourceCodeLocation?.startLine;
  const root: Scope = { data: null, schema, vars: { id: '', lang: '' }, parent: null };
  const staticLookup = (scope: Scope, p: string): { found: boolean; schema?: SchemaNode } => {
    if (p === '.') return { found: !!scope.schema, schema: scope.schema };
    if (p.startsWith('@')) {
      for (let s: Scope | null = scope; s; s = s.parent) if (s.vars && p.slice(1) in s.vars) return { found: true, schema: { type: 'string' } };
      return { found: false };
    }
    const [first, ...rest] = p.split('.');
    for (let s: Scope | null = scope; s; s = s.parent) {
      let sch = childSchema(s.schema, first);
      if (!sch) continue;
      if (s === root) a.usedProps.add(first);
      for (const seg of rest) sch = childSchema(sch, seg);
      return { found: !!sch, schema: sch };
    }
    return { found: false };
  };
  const refsIn = (str: string, scope: Scope, where: 'text' | 'attr', node: { tagName?: string; sourceCodeLocation?: { startLine: number } | null }, attr: string | null) => {
    for (const m of String(str).matchAll(INTERP)) {
      const p = m[1].trim();
      const r = staticLookup(scope, p);
      const ref: TemplateRef = { path: p, filter: m[2] || null, where, attr, tag: node.tagName || null, line: line(node), kind: r.found ? kindOf(r.schema) : null, schema: r.schema };
      a.refs.push(ref);
      if (!r.found) a.unknown.push(ref);
    }
  };
  const walk = (node: ParentNode, scope: Scope, ctx: WalkContext): TemplateHook['inner'] => {
    const held: TemplateHook['inner'] = { tags: [], hooks: [] };
    for (const c of node.childNodes || []) {
      if (isText(c)) {
        refsIn(c.value, scope, 'text', { tagName: 'tagName' in node ? node.tagName : undefined, sourceCodeLocation: c.sourceCodeLocation }, null);
        const literal = c.value.replace(INTERP, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
        if (/\p{L}{2,}/u.test(literal) && !ctx.inSvgText) a.texts.push({ text: literal.trim().replace(/\s+/g, ' '), line: line(c), inSvg: !!ctx.inSvg });
        else if (/\p{L}{2,}/u.test(literal)) a.texts.push({ text: literal.trim().replace(/\s+/g, ' '), line: line(c), inSvg: true, svgText: true });
        continue;
      }
      if (!isElement(c)) continue;
      const attrs = attributes(c);
      let scope2 = scope;
      if (attrs['data-each'] !== undefined) {
        const p = attrs['data-each'].trim();
        const r = staticLookup(scope, p);
        if (!r.found || kindOf(r.schema) !== 'list') a.badEach.push({ path: p, line: line(c), found: r.found });
        scope2 = { data: null, schema: itemSchema(r.schema), vars: { index: 0, number: 1, count: 1, first: true, last: true }, parent: scope };
      }
      if (attrs['data-if'] !== undefined) {
        const e = parseExpr(attrs['data-if']);
        if (e.error !== undefined) a.unknown.push({ path: attrs['data-if'], where: 'data-if', line: line(c), error: e.error });
        else {
          const r = staticLookup(scope2, e.path);
          if (!r.found) a.unknown.push({ path: e.path, where: 'data-if', line: line(c) });
          a.conditions.push({ expr: attrs['data-if'], line: line(c) });
        }
      }
      for (const x of c.attrs || []) if (!DIRECTIVES.has(x.name)) refsIn(x.value, scope2, 'attr', c, x.name);
      const el: TemplateElement = { tag: c.tagName, ns: c.namespaceURI, attrs, line: line(c), inEach: !!ctx.each || attrs['data-each'] !== undefined, each: attrs['data-each'] ?? ctx.each ?? null, conditional: attrs['data-if'] !== undefined || !!ctx.conditional, inSvg: !!ctx.inSvg, parentHooks: ctx.hooks };
      a.elements.push(el);
      if (attrs['data-slot'] !== undefined) a.slots.push({ id: attrs['data-slot'], line: el.line, empty: !(c.childNodes || []).some((n) => !isText(n) || n.value.trim()), conditional: el.conditional, inEach: el.inEach });
      if (attrs['data-title'] !== undefined) a.titles++;
      const hooks = Object.keys(attrs).filter((k) => k.startsWith('data-t-'));
      const own = hooks.map((h) => ({ hook: h.slice(7), value: attrs[h], tag: c.tagName, line: el.line, inEach: el.inEach, each: el.each, within: ctx.hooks, inner: { tags: [], hooks: [] } as TemplateHook['inner'] }));
      a.hooks.push(...own);
      const inner = walk(childrenOf(c), scope2, {
        inSvg: ctx.inSvg || c.tagName === 'svg', inSvgText: ctx.inSvgText || (ctx.inSvg && /^(title|desc)$/.test(c.tagName)),
        each: attrs['data-each'] ?? ctx.each, conditional: el.conditional, hooks: [...(ctx.hooks || []), ...hooks.map((h) => h.slice(7))]
      });
      for (const hook of own) hook.inner = inner;
      held.tags.push(c.tagName, ...inner.tags);
      held.hooks.push(...own.map(({ hook, value }) => ({ hook, value })), ...inner.hooks);
    }
    return held;
  };
  walk(tpl.root, root, { hooks: [] });
  return a;
}
