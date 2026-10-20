import { kindOf, itemSchema } from './template.ts';
import type { SchemaNode } from './template.ts';

// Props of a component instance, read through the component's schema.

const defaultOf = (schema: SchemaNode): unknown => (schema && typeof schema === 'object' ? schema.default : undefined);
const propertiesOf = (schema: SchemaNode) => (schema && typeof schema === 'object' ? schema.properties : undefined);

// Defaults of the schema (top level, objects and list items) applied to a value.
export function applyDefaults(schema: SchemaNode, value: unknown): unknown {
  if (!schema) return value;
  if (value === undefined) return defaultOf(schema) !== undefined ? structuredClone(defaultOf(schema)) : undefined;
  if (Array.isArray(value)) return itemSchema(schema) ? value.map((x) => applyDefaults(itemSchema(schema), x)) : value;
  const properties = propertiesOf(schema);
  if (value && typeof value === 'object' && properties) {
    const out: Record<string, unknown> = { ...value };
    for (const [k, s] of Object.entries(properties)) {
      const v = applyDefaults(s, out[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

export interface KindValue {
  kind: string;
  value: unknown;
  path: string; // JSON pointer below props
  schema: SchemaNode;
}

// Every value of a given kind (asset, token, markdown, tex…) with its JSON pointer below props.
export function valuesOfKind(schema: SchemaNode, value: unknown, kinds: string | readonly string[], base = ''): KindValue[] {
  const want = new Set(Array.isArray(kinds) ? kinds : [kinds]);
  const out: KindValue[] = [];
  const walk = (s: SchemaNode, v: unknown, p: string): void => {
    if (v === undefined || v === null) return;
    const k = kindOf(s);
    if (want.has(k) && typeof v !== 'object') { out.push({ kind: k, value: v, path: p, schema: s }); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(itemSchema(s), x, `${p}/${i}`));
    if (typeof v === 'object' && propertiesOf(s)) for (const [key, x] of Object.entries(v)) walk(propertiesOf(s)?.[key], x, `${p}/${key}`);
  };
  walk(schema, value, base);
  return out;
}
