import type { ErrorObject } from '@elabora/format';
import type { Random } from './mutations.ts';

// Data made from a JSON Schema, then broken, for the differential tests of the validators (Ajv against
// the interpreter and the precompiled validators, D80). A schema can be anything the format or a
// component writes: the generator follows the keywords the interpreter supports and ignores the rest.

type Schema = any;
type Json = any;

const WORDS = ['a', 'hello', '', '#A1B2C3', 'x'.repeat(40), 'é😀', 'foo-bar', 'bogus', '1', 'none', '#zzz', '2026-11-12T10:00:00Z', 'not a date'];
const BREAKS: Json[] = [1, -1, 1.5, 1e9, 0.3, 'z', '', null, true, [], {}, [1, 1], 'x'.repeat(500)];

export function generate(schema: Schema, root: Schema, random: Random, depth = 0): Json {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const below = (n: number) => Math.floor(random() * n);
  if (schema === true || schema === undefined || depth > 6) return pick([1, 'a', null, true, [], {}]);
  if (schema === false) return null;
  if (schema.$ref) {
    try {
      let target = root;
      for (const key of schema.$ref.slice(2).split('/')) target = target[key.replace(/~1/g, '/').replace(/~0/g, '~')];
      return generate(target, root, random, depth + 1);
    } catch { return null; }
  }
  if ('const' in schema) return schema.const;
  if (schema.enum) return pick(schema.enum);
  if (random() < 0.2 && 'default' in schema) return schema.default;
  if (schema.oneOf || schema.anyOf) return generate(pick(schema.oneOf || schema.anyOf), root, random, depth + 1);
  let type = Array.isArray(schema.type) ? pick(schema.type) : schema.type;
  if (!type) type = schema.properties || schema.required ? 'object' : schema.items ? 'array' : pick(['string', 'number', 'object']);
  let value: Json;
  switch (type) {
    case 'string': {
      value = pick(WORDS);
      if (schema.minLength && value.length < schema.minLength) value = value.padEnd(schema.minLength, 'k');
      if (schema.maxLength && value.length > schema.maxLength) value = value.slice(0, schema.maxLength);
      if (schema.format === 'color' && random() < 0.7) value = '#12AB9f';
      break;
    }
    case 'integer': case 'number': {
      const low = schema.minimum ?? schema.exclusiveMinimum ?? 0;
      const high = schema.maximum ?? schema.exclusiveMaximum ?? low + 100;
      value = low + random() * (high - low);
      if (type === 'integer' || random() < 0.5) value = Math.round(value);
      if (schema.multipleOf && random() < 0.7) value = Math.round(value / schema.multipleOf) * schema.multipleOf;
      break;
    }
    case 'boolean': value = random() < 0.5; break;
    case 'null': value = null; break;
    case 'array': {
      const n = below(4) + (schema.minItems || 0);
      value = [];
      for (let i = 0; i < n && (!schema.maxItems || i < schema.maxItems); i++) value.push(generate(Array.isArray(schema.prefixItems) && schema.prefixItems[i] ? schema.prefixItems[i] : schema.items, root, random, depth + 1));
      break;
    }
    default: {
      value = {};
      for (const key of schema.required || []) value[key] = generate((schema.properties || {})[key], root, random, depth + 1);
      for (const [key, sub] of Object.entries(schema.properties || {})) if (!(key in value) && random() < 0.6) value[key] = generate(sub, root, random, depth + 1);
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && random() < 0.5) value[pick(['k1', 'k2', 'aA'])] = generate(schema.additionalProperties, root, random, depth + 1);
    }
  }
  if (Array.isArray(schema.allOf) && value && typeof value === 'object') {
    for (const sub of schema.allOf) {
      const part = generate(sub, root, random, depth + 1);
      if (part && typeof part === 'object' && !Array.isArray(part) && !Array.isArray(value)) value = { ...part, ...value };
    }
  }
  if (schema.if && schema.then && value && typeof value === 'object' && !Array.isArray(value) && random() < 0.5) {
    const part = generate(schema.then, root, random, depth + 1);
    if (part && typeof part === 'object' && !Array.isArray(part)) value = { ...value, ...part };
  }
  return value;
}

// One change somewhere in the data: a value of another kind, a missing or extra key, a doubled item…
export function breakData(data: Json, random: Random): Json {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const copy = structuredClone(data);
  const nodes: [Json, Json, Json][] = [];
  (function walk(value: Json, parent: Json, key: Json) {
    nodes.push([parent, key, value]);
    if (value && typeof value === 'object') for (const k of Object.keys(value)) walk(value[k], value, k);
  })(copy, null, null);
  const [parent, key, value] = pick(nodes);
  const replace = (next: Json) => {
    if (parent === null) return next;
    parent[key] = next;
    return copy;
  };
  const isObject = value && typeof value === 'object' && !Array.isArray(value);
  switch (Math.floor(random() * 9)) {
    case 0: return replace(pick(BREAKS));
    case 1: if (parent && !Array.isArray(parent)) delete parent[key]; return copy;
    case 2: if (isObject) value[pick(['zz', 'Bad Key', 'a/b', 'k~1'])] = pick([1, 'q', {}]); return copy;
    case 3: if (Array.isArray(value)) value.push(...(value.length ? [value[0], value[0]] : [1, 1])); return copy;
    case 4: return typeof value === 'number' ? replace(value * 1000 + 0.05) : copy;
    case 5: return typeof value === 'string' ? replace(value + '😀'.repeat(Math.floor(random() * 30))) : copy;
    case 6: if (Array.isArray(value)) value.length = 0; return copy;
    case 7: if (isObject) { const keys = Object.keys(value); if (keys.length) delete value[pick(keys)]; } return copy;
    default: return replace(pick(WORDS));
  }
}

// The fields of an error the core reads: two validators agree when these agree, in this order.
export function describeErrors(errors: readonly ErrorObject[] | null | undefined, withSchemaPath = false): string {
  return JSON.stringify((errors ?? []).map((e) => ({ instancePath: e.instancePath, keyword: e.keyword, message: e.message, params: e.params, propertyName: e.propertyName, ...(withSchemaPath ? { schemaPath: e.schemaPath } : {}) })));
}
