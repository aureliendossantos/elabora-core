import { isBuiltinBlockType } from '@elabora/format';
import { kindOf, parseExpr, truthy, itemSchema } from './template.ts';
import type { SchemaNode } from './template.ts';
import { readingOrder } from '../project/load.ts';
import { objectsIn } from '../util/values.ts';
import type { Registry, ComponentDescriptor } from './registry.ts';
import type { Block, FallbackEntry } from '../project/model.ts';

// Fallback: every component can be expressed with native blocks. Exports (LESSON.md), the client
// review, text views, translation tools, editors that do not know the component, and "detach" use it.
//
// component.json "fallback": a list of native block templates:
//   { "type": "text", "props": { "markdown": "**{{value}}**\n\n{{body}}" } }
//   { "$if": "caption", "type": "text", … }   { "$each": "steps", "type": "text", … }   { "$slot": "body" }
// Strings take {{path}}, {{#list}}…{{/list}} (repeat, or "if" for a value) and {{^path}}…{{/path}}.
// A string made of a single {{path}} keeps the raw value, so a { "textRef": … } stays a plan link.
// Inside props, { "$each": "path", "as": <template> } builds a list (accordion items…).
// Without "fallback", Elabora generates one from the props: text and Markdown in a text block, lists
// as bullet lists, assets as images, TeX as equations, then the blocks of the slots.
// Forks of a built-in fall back to their built-in root, with the props the root knows.

const ONE = /^\s*\{\{\s*([^{}#^/|]+?)\s*\}\}\s*$/;

interface Scope {
  data: unknown;
  vars?: Record<string, unknown>;
  parent: Scope | null;
}
type Record_ = Record<string, unknown>;
const isRecord = (v: unknown): v is Record_ => !!v && typeof v === 'object' && !Array.isArray(v);
const loopVars = (i: number, count: number) => ({ index: i, number: i + 1, count, first: i === 0, last: i === count - 1 });

function lookup(scope: Scope, path: string): unknown {
  if (path === '.') return scope.data;
  if (path.startsWith('@')) { for (let s: Scope | null = scope; s; s = s.parent) if (s.vars && path.slice(1) in s.vars) return s.vars[path.slice(1)]; return undefined; }
  const [first, ...rest] = path.split('.');
  for (let s: Scope | null = scope; s; s = s.parent) {
    if (s.data && typeof s.data === 'object' && !Array.isArray(s.data) && first in s.data) return rest.reduce<unknown>((v, k) => (v == null ? undefined : (v as Record_)[k]), (s.data as Record_)[first]);
  }
  return undefined;
}
function cond(expr: string, scope: Scope): boolean {
  const e = parseExpr(expr);
  if (e.error !== undefined) return false;
  const v = lookup(scope, e.path);
  const ok = e.op === '==' ? v === e.literal : e.op === '!=' ? v !== e.literal : truthy(v);
  return e.not ? !ok : ok;
}
const asText = (v: unknown): string => (isRecord(v) && typeof v.textRef === 'string' ? `[${v.textRef}]` : v == null ? '' : typeof v === 'object' ? '' : String(v));

// Mustache-like strings: sections and interpolations, over the resolved props.
export function interpolate(str: unknown, scope: Scope): string {
  let s = String(str);
  const section = /\{\{([#^])\s*([^{}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
  let m;
  while ((m = section.exec(s))) {
    const v = lookup(scope, m[2]);
    const body = m[3];
    let rep = '';
    if (m[1] === '^') rep = truthy(v) ? '' : interpolate(body, scope);
    else if (Array.isArray(v)) rep = v.map((item, i) => interpolate(body, { data: item, vars: loopVars(i, v.length), parent: scope })).join('');
    else if (truthy(v)) rep = interpolate(body, { data: v, parent: scope });
    s = s.slice(0, m.index) + rep + s.slice(m.index + m[0].length);
  }
  return s.replace(/\{\{\s*([^{}#^/|]+?)\s*\}\}/g, (_, p: string) => asText(lookup(scope, p.trim())));
}

function fill(tpl: unknown, raw: Scope, res: Scope): unknown {
  if (typeof tpl === 'string') {
    const one = ONE.exec(tpl);
    if (one) { const v = lookup(raw, one[1].trim()); return v !== undefined ? structuredClone(v) : undefined; }
    return interpolate(tpl, res);
  }
  if (Array.isArray(tpl)) return tpl.map((t) => fill(t, raw, res)).filter((v) => v !== undefined);
  if (!isRecord(tpl)) return tpl;
  if (typeof tpl.$each === 'string') {
    const listRaw = lookup(raw, tpl.$each);
    const listRes = lookup(res, tpl.$each);
    if (!Array.isArray(listRes)) return [];
    return listRes.map((item, i) => {
      const vars = loopVars(i, listRes.length);
      return fill(tpl.as, { data: (listRaw as Record_ | null | undefined)?.[i], vars, parent: raw }, { data: item, vars, parent: res });
    });
  }
  const out: Record_ = {};
  for (const [k, v] of Object.entries(tpl)) {
    const x = fill(v, raw, res);
    if (x === undefined || x === '') continue;
    // A plan link stays a plan link: markdown/text receiving { textRef } become textRef.
    if (isRecord(x) && typeof x.textRef === 'string' && Object.keys(x).length === 1 && (k === 'markdown' || k === 'text')) { out.textRef = x.textRef; continue; }
    out[k] = x;
  }
  return out;
}

// Keep only what a schema declares (forks of a built-in → their built-in root).
export function filterToSchema(value: unknown, schema: SchemaNode): unknown {
  if (!schema || typeof schema !== 'object' || value === undefined) return value;
  if (Array.isArray(value)) return schema.items ? value.map((v) => filterToSchema(v, itemSchema(schema))) : value;
  if (!value || typeof value !== 'object') return value;
  if (!schema.properties) return value;
  const out: Record_ = {};
  for (const [k, v] of Object.entries(value)) {
    if (schema.properties[k]) out[k] = filterToSchema(v, schema.properties[k]);
    else if (schema.additionalProperties !== false && schema.additionalProperties !== undefined) out[k] = v;
  }
  return out;
}

type NativeBlock = Omit<Block, 'id'> & { id?: string };

function autoFallback(d: ComponentDescriptor, raw: Record_, res: Record_, id: string): Block[] {
  const blocks: NativeBlock[] = [];
  let paras: string[] = [];
  const flush = () => { if (paras.length) blocks.push({ type: 'text', props: { markdown: paras.join('\n\n') } }); paras = []; };
  const line = (item: unknown, schema: SchemaNode) => Object.entries((schema && typeof schema === 'object' && schema.properties) || {}).map(([k, s]) => ['text', 'markdown', 'number'].includes(kindOf(s)) && k !== 'id' ? asText((item as Record_ | null | undefined)?.[k]) : '').filter(Boolean).join(' — ');
  for (const [k, s] of Object.entries(d.schema?.properties || {})) {
    const kind = kindOf(s);
    const v = res[k];
    if (v === undefined || v === null || v === '') continue;
    if (kind === 'markdown' || kind === 'text') {
      const r = raw[k];
      if (isRecord(r) && typeof r.textRef === 'string') { flush(); blocks.push({ type: 'text', props: { textRef: r.textRef } }); } else if (k !== 'id') paras.push(String(v));
    } else if (kind === 'number') paras.push(String(v));
    else if (kind === 'tex') { flush(); blocks.push({ type: 'math', props: { tex: String(v) } }); }
    else if (kind === 'asset') { flush(); blocks.push({ type: 'image', props: { asset: v, decorative: true } }); }
    else if (kind === 'list' && Array.isArray(v)) {
      const items = v.map((it) => (itemSchema(s) && kindOf(itemSchema(s)) === 'object' ? line(it, itemSchema(s)) : asText(it))).filter(Boolean);
      if (items.length) paras.push(items.map((x) => `- ${x}`).join('\n'));
    } else if (kind === 'object') { const l = line(v, s); if (l) paras.push(l); }
  }
  flush();
  return blocks.map((b, i) => ({ id: i ? `${id}-${i + 1}` : id, ...b }) as Block);
}

type Placed = Block | { $slot: string };

// fallbackBlocks(reg, block, { resolve }) → native blocks (children included, recursively).
// resolve: the props with plan references resolved (resolveBlockProps).
export function fallbackBlocks(reg: Registry, block: Block, { resolve }: { resolve?: (b: Block) => Record_ } = {}): Block[] {
  const d = reg.get(block.type);
  const children = block.blocks || [];
  const native = (b: Block) => fallbackBlocks(reg, b, { resolve });
  if (!d || d.builtin) {
    const { blocks, ...rest } = block;
    return [rest, ...objectsIn(blocks).flatMap(native)];
  }
  const res = resolve ? resolve(block) : block.props || {};
  const raw = block.props || {};
  let out: Placed[];
  if (d.level === 'screen') out = [];
  else if (d.fallback === 'root' || (d.fallback == null && d.root)) {
    const rootSchema = reg.get(d.root ?? '')?.schema;
    const props = filterToSchema(structuredClone(raw), rootSchema) as Record_;
    if (d.root === 'quiz' && props.questionRef) delete props.options;
    out = [{ id: block.id, type: d.root as string, props }];
  } else if (Array.isArray(d.fallback)) {
    const placed: Placed[] = [];
    let n = 0;
    const rawScope: Scope = { data: raw, vars: { id: block.id }, parent: null };
    const resScope: Scope = { data: res, vars: { id: block.id }, parent: null };
    const place = (entry: FallbackEntry, rs: Scope, ss: Scope) => {
      if (entry.$slot !== undefined) { placed.push({ $slot: entry.$slot }); return; }
      if (entry.$if !== undefined && !cond(entry.$if, ss)) return;
      const { $if, $each, ...tpl } = entry;
      const b = fill(tpl, rs, ss) as Record_;
      placed.push({ id: n++ ? `${block.id}-${n}` : block.id, ...b } as Block);
    };
    for (const entry of d.fallback) {
      if (entry && typeof entry.$each === 'string') {
        const listRes = lookup(resScope, entry.$each);
        const listRaw = lookup(rawScope, entry.$each);
        (Array.isArray(listRes) ? listRes : []).forEach((item, i, list) => {
          const vars = loopVars(i, list.length);
          place(entry, { data: (listRaw as Record_ | null | undefined)?.[i], vars, parent: rawScope }, { data: item, vars, parent: resScope });
        });
      } else if (entry) place(entry, rawScope, resScope);
    }
    out = placed;
  } else out = autoFallback(d, raw, res, block.id);

  // Slot contents: where the fallback says, otherwise after it, in template order.
  const ordered = readingOrder(children, d);
  const done = new Set<Block>();
  const result: Block[] = [];
  for (const b of out) {
    if ('$slot' in b) {
      for (const c of ordered.filter((c) => (c.slot || d.defaultSlot) === b.$slot)) { done.add(c); result.push(...native(stripSlot(c))); }
    } else result.push(b);
  }
  for (const c of ordered) if (!done.has(c)) result.push(...native(stripSlot(c)));
  if (block.hidden && result[0]) result[0] = { ...result[0], hidden: true };
  return result;
}
const stripSlot = ({ slot, ...b }: Block): Block => b;

// Translatable strings of a component instance that its fallback does not carry.
// fallbackProps: the props of the fallback blocks, with plan references resolved.
export function fallbackLosses(reg: Registry, block: Block, resolvedProps: unknown, fallbackProps: unknown): string[] {
  const d = reg.get(block.type);
  if (!d || d.builtin || d.level === 'screen') return [];
  const strings: string[] = [];
  const walk = (v: unknown, s: SchemaNode, key: string | null): void => {
    const kind = kindOf(s);
    if ((kind === 'text' || kind === 'markdown') && typeof v === 'string' && key !== 'id' && /\p{L}{2,}/u.test(v)) strings.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, itemSchema(s), key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, s && typeof s === 'object' ? s.properties?.[k] : undefined, k);
  };
  walk(resolvedProps, d.schema, null);
  const norm = (t: unknown) => String(t).replace(/[*_`$\\]/g, '').replace(/\s+/g, ' ').trim();
  const texts: string[] = [];
  const collect = (v: unknown): void => { if (typeof v === 'string') texts.push(v); else if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
  collect(fallbackProps);
  const carried = norm(texts.join(' '));
  return strings.filter((t) => !carried.includes(norm(t)));
}

export const isNativeType = (t: unknown): boolean => isBuiltinBlockType(t);
