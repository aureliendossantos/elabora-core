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
// kind: what a schema node holds (a component's x-kind; a free object's x-control, objectAssets).
export function valuesOfKind(schema: SchemaNode, value: unknown, kinds: string | readonly string[], base = '', kind: (schema: SchemaNode) => string = kindOf): KindValue[] {
  const want = new Set(Array.isArray(kinds) ? kinds : [kinds]);
  const out: KindValue[] = [];
  const walk = (s: SchemaNode, v: unknown, p: string): void => {
    if (v === undefined || v === null) return;
    const k = kind(s);
    if (want.has(k) && typeof v !== 'object') { out.push({ kind: k, value: v, path: p, schema: s }); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(itemSchema(s), x, `${p}/${i}`));
    if (typeof v === 'object' && propertiesOf(s)) for (const [key, x] of Object.entries(v)) walk(propertiesOf(s)?.[key], x, `${p}/${key}`);
  };
  walk(schema, value, base);
  return out;
}

// The course files a free object's settings name: a prop, or a field of a list's items, whose manifest
// control is x-control "asset" (a file of assets/, as a block's media is). The paths are below the
// object's props.
export function objectAssets(manifest: { props?: unknown } | null | undefined, values: unknown): KindValue[] {
  if (!manifest?.props || typeof manifest.props !== 'object') return [];
  const control = (schema: SchemaNode) => (schema && typeof schema === 'object' && (schema as Record<string, unknown>)['x-control'] === 'asset' ? 'asset' : kindOf(schema));
  return valuesOfKind(manifest.props as SchemaNode, values, 'asset', '', control).filter((found) => typeof found.value === 'string' && found.value !== '');
}
