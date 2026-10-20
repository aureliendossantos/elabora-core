import { compileInline } from '@elabora/format/schemas';
import type { ValidateFunction } from '@elabora/format';
import type { ObjectManifest, PropSchema, JsonSchema } from '../project/model.ts';
import { contrastRatio } from './theme.ts';
import { isRecord, fieldsOf, entriesOf } from './guards.ts';

// The props of a free object: the schema their values are checked against (lists included), the
// editor controls they declare, and the colours the object draws text in (x-text-on).

// ── Values ───────────────────────────────────────────────────────────
// A prop schema without its annotations (x-*, default, description), for ajv. Only keywords are
// annotations: the names of fields (an item field called description) and data (enum, const) stay.
const SUBSCHEMA = new Set(['items', 'not', 'if', 'then', 'else', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames']);
const SUBSCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SUBSCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas']);
function withoutAnnotations(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('x-') || key === 'default' || key === 'description') continue;
    if (SUBSCHEMA.has(key)) out[key] = withoutAnnotations(value);
    else if (SUBSCHEMA_LISTS.has(key) && Array.isArray(value)) out[key] = value.map(withoutAnnotations);
    else if (SUBSCHEMA_MAPS.has(key) && isRecord(value)) out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, withoutAnnotations(sub)]));
    else out[key] = value;
  }
  return out;
}
export const stripX = (schema: JsonSchema | boolean): JsonSchema | boolean => withoutAnnotations(schema) as JsonSchema | boolean;

// The schema the values of a prop are checked against: items that are objects take no field the
// manifest does not declare (a misspelt field would be lost on the object's side).
export function propValueSchema(prop: PropSchema | JsonSchema): JsonSchema | boolean {
  const schema = stripX(prop);
  if (!isRecord(schema) || !isRecord(schema.items) || schema.items.type !== 'object' || 'additionalProperties' in schema.items) return schema;
  return { ...schema, items: { ...schema.items, additionalProperties: false } };
}

// Validates prop values (of a block, the backdrop, an event, a test) against the manifest's prop
// schemas. A prop schema that does not compile is reported by the objects check; its values are not
// checked.
const propValidators = new WeakMap<ObjectManifest, Map<string, ValidateFunction | null>>();
export function objectPropErrors(manifest: ObjectManifest, values: unknown): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const declared: Record<string, PropSchema> = manifest.props?.properties || {};
  for (const [key, value] of entriesOf(values)) {
    if (!declared[key]) { errors.push({ path: `/${key}`, message: `prop "${key}" is not declared in the manifest (declared: ${Object.keys(declared).join(', ')})` }); continue; }
    let cache = propValidators.get(manifest);
    if (!cache) { cache = new Map(); propValidators.set(manifest, cache); }
    if (!cache.has(key)) {
      let compiled: ValidateFunction | null = null;
      try { compiled = compileInline(propValueSchema(declared[key])); } catch { /* reported by checkObjects */ }
      cache.set(key, compiled);
    }
    const validate = cache.get(key);
    if (validate && !validate(value)) {
      const found = validate.errors ?? [];
      errors.push({ path: `/${key}${found[0]?.instancePath ?? ''}`, message: `prop "${key}" ${found.map((e) => `${e.instancePath} ${e.message}${e.keyword === 'additionalProperties' ? ` ("${String(e.params.additionalProperty)}")` : ''}`.trim()).join(', ')}` });
    }
  }
  return errors;
}

// ── Editor controls ──────────────────────────────────────────────────
// The types each control edits. A list (type array, items) is rows of fields; vec3-gizmo moves a
// point of three numbers.
const CONTROL_TYPES: Readonly<Record<string, readonly string[]>> = {
  text: ['string'], textarea: ['string'], asset: ['string'], color: ['string'], select: ['string', 'number', 'integer'],
  slider: ['number', 'integer'], number: ['number', 'integer'], toggle: ['boolean'], list: ['array'], 'vec3-gizmo': ['array']
};

// What does not fit between the x-control of a prop (or of the items and fields of a list) and its
// type: path under the prop schema, and why.
export function controlProblems(prop: unknown): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const check = (schema: Record<string, unknown>, path: string): void => {
    const { type } = schema;
    const control = schema['x-control'];
    if (typeof control !== 'string' || typeof type !== 'string' || !CONTROL_TYPES[control]) return;
    if (!CONTROL_TYPES[control].includes(type)) problems.push({ path, message: `x-control "${control}" edits ${CONTROL_TYPES[control].join(' or ')} values, not ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}` });
    else if (control === 'select' && !Array.isArray(schema.enum) && !(type === 'integer' && typeof schema.minimum === 'number' && typeof schema.maximum === 'number')) problems.push({ path, message: 'x-control "select" needs its choices: an enum, or an integer between a minimum and a maximum' });
    else if (control === 'slider' && (typeof schema.minimum !== 'number' || typeof schema.maximum !== 'number')) problems.push({ path, message: 'x-control "slider" needs a minimum and a maximum' });
    else if (control === 'color' && schema.format !== 'color') problems.push({ path, message: 'x-control "color" needs format "color" (#RRGGBB values)' });
    else if (control === 'vec3-gizmo') {
      const items = fieldsOf(schema.items);
      if ((items.type !== 'number' && items.type !== 'integer') || schema.minItems !== 3 || schema.maxItems !== 3) problems.push({ path, message: 'x-control "vec3-gizmo" edits three numbers: items of type number, minItems and maxItems 3' });
    } else if (control === 'list' && !isRecord(schema.items)) problems.push({ path, message: 'x-control "list" needs items (a simple type, or an object with fields)' });
  };
  const schema = fieldsOf(prop);
  check(schema, '');
  if (schema.type === 'array' && isRecord(schema.items)) {
    check(schema.items, '/items');
    for (const [name, field] of Object.entries(fieldsOf(schema.items.properties))) check(fieldsOf(field), `/items/properties/${name}`);
  }
  return problems;
}

// ── Words of the choices ─────────────────────────────────────────────
// Where a prop offers choices (an enum): the prop itself, the items of a list of simple values, or a
// field of a list's items. key names it in a block's props.enumLabels (failingDevice, voyages.from);
// path is its place under the prop schema; labels are its x-enum-labels (how each value reads in the
// editor, in the manifest's language).
export interface EnumPlace {
  key: string;
  path: string;
  title: string; // of the setting or field, for translators
  values: readonly unknown[] | null; // null: no enum
  labels: Record<string, unknown>;
}

export function enumPlaces(name: string, prop: unknown): EnumPlace[] {
  const places: EnumPlace[] = [];
  const schema = fieldsOf(prop);
  const titleOf = (node: Record<string, unknown>, fallback: string): string => [node.title, node.description].find((text): text is string => typeof text === 'string' && text !== '') ?? fallback;
  const add = (key: string, path: string, node: Record<string, unknown>): void => {
    if (Array.isArray(node.enum) || node['x-enum-labels'] !== undefined) places.push({ key, path, title: titleOf(node, titleOf(schema, name)), values: Array.isArray(node.enum) ? node.enum : null, labels: fieldsOf(node['x-enum-labels']) });
  };
  add(name, '', schema);
  if (schema.type === 'array' && isRecord(schema.items)) {
    add(name, '/items', schema.items);
    for (const [field, sub] of Object.entries(fieldsOf(schema.items.properties))) add(`${name}.${field}`, `/items/properties/${field}`, fieldsOf(sub));
  }
  return places;
}

const valuesText = (values: readonly unknown[]): string => values.map((value) => JSON.stringify(value)).join(', ');
const takes = (values: readonly unknown[], key: string): boolean => values.some((value) => String(value) === key);

// Words of a manifest for values its props do not take (x-enum-labels keys are values of the enum).
export function enumLabelProblems(name: string, prop: unknown): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  for (const place of enumPlaces(name, prop)) {
    const where = place.key === name ? `prop "${name}"${place.path ? ', its items' : ''}` : `field "${place.key.split('.')[1]}" of prop "${name}"`;
    if (!place.values) { problems.push({ path: `${place.path}/x-enum-labels`, message: `x-enum-labels words the values of an enum, and ${where} has none` }); continue; }
    for (const key of Object.keys(place.labels)) if (!takes(place.values, key)) problems.push({ path: `${place.path}/x-enum-labels/${key}`, message: `"${key}" is not a value of ${where} (values: ${valuesText(place.values)})` });
  }
  return problems;
}

// A block's props.enumLabels: keys are props (or fields of a list's items) with an enum, and each
// words values of it.
export function blockEnumLabelErrors(manifest: ObjectManifest, enumLabels: unknown): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const places = Object.entries(manifest.props?.properties || {}).flatMap(([name, prop]) => enumPlaces(name, prop)).filter((place) => place.values);
  for (const [key, labels] of entriesOf(enumLabels)) {
    const place = places.find((candidate) => candidate.key === key);
    if (!place?.values) { errors.push({ path: `/${key}`, message: `"${key}" is not a setting with choices of ${manifest.id} (${places.length ? `with choices: ${[...new Set(places.map((candidate) => candidate.key))].join(', ')}` : 'it has none'})` }); continue; }
    for (const value of Object.keys(fieldsOf(labels))) if (!takes(place.values, value)) errors.push({ path: `/${key}/${value}`, message: `"${value}" is not a value of "${key}" (values: ${valuesText(place.values)})` });
  }
  return errors;
}

// ── Text colours ─────────────────────────────────────────────────────
// A colour prop the object draws text in names, with x-text-on, the colour that text is read on: a
// colour prop of the manifest or a theme token. Material colours (brass, wood) need no theme token,
// but text keeps the contrast WCAG asks for, with the defaults and with whatever a block sets.
export const TEXT_CONTRAST = 4.5;
export interface TextContrast {
  prop: string;
  on: string;
  ratio: number | null; // null: x-text-on names neither a colour prop nor a token
  message: string;
}

const hexColour = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  return /^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((c) => c + c).join('')}` : null;
};

// The text colours under 4.5:1 with these values (a block's, over the defaults and tokens).
export function textContrasts(manifest: ObjectManifest, values: Record<string, unknown>, tokens: Readonly<Record<string, string | number>>): TextContrast[] {
  const declared: Record<string, PropSchema> = manifest.props?.properties || {};
  const valueOf = (name: string): unknown => {
    if (Object.hasOwn(values, name)) return values[name];
    const token = declared[name]['x-token'];
    return typeof token === 'string' && tokens[token] !== undefined ? tokens[token] : declared[name].default;
  };
  const found: TextContrast[] = [];
  for (const [name, prop] of Object.entries(declared)) {
    const on = prop['x-text-on'];
    if (typeof on !== 'string') continue;
    const isProp = Object.hasOwn(declared, on);
    if (!isProp && tokens[on] === undefined) {
      found.push({ prop: name, on, ratio: null, message: `x-text-on "${on}" of prop "${name}" is neither a colour prop of ${manifest.id} nor a theme token` });
      continue;
    }
    const text = hexColour(valueOf(name));
    const background = hexColour(isProp ? valueOf(on) : tokens[on]);
    if (!text || !background) continue; // not colours: their schema says so
    const ratio = contrastRatio(text, background);
    if (ratio < TEXT_CONTRAST) found.push({ prop: name, on, ratio: Math.round(ratio * 100) / 100, message: `text in ${name} ${text} on ${on} ${background}: ${ratio.toFixed(2)}:1, under ${TEXT_CONTRAST}:1` });
  }
  return found;
}
