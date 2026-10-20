// Minimal validator for the JSON Schema subset allowed in free-object payloads and states:
// type (or list of types), enum, minimum, maximum, maxLength, items, maxItems, properties, required.
// Small enough to ship in every package, and it needs no eval (the package CSP may forbid it).

import { isRecord } from './json.ts';

export type DataType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

// The subset of JSON Schema of object manifests (dataSchema, dataField and stateSchema). enum takes
// what the format allows (any values): they are compared with ===.
export interface DataSchema {
  type?: DataType | DataType[];
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  items?: DataSchema;
  maxItems?: number;
  properties?: Record<string, DataSchema>;
  required?: string[];
  description?: string;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(expected: DataType | DataType[], value: unknown): boolean {
  const actual = typeOf(value);
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((type) => type === actual || (type === 'number' && actual === 'integer'));
}

export function validateData(schema: DataSchema | null | undefined, value: unknown, path = ''): string[] {
  const errors: string[] = [];
  if (!schema) return errors;
  if (schema.type && !matchesType(schema.type, value)) {
    errors.push(`${path || 'value'} must be ${([] as DataType[]).concat(schema.type).join(' or ')}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some((allowed) => allowed === value)) errors.push(`${path || 'value'} must be one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be ≤ ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    const items = schema.items;
    if (items) value.forEach((item: unknown, index) => errors.push(...validateData(items, item, `${path}/${index}`)));
  }
  if (isRecord(value)) {
    for (const name of schema.required || []) if (!(name in value)) errors.push(`${path}/${name} is required`);
    for (const [name, property] of Object.entries(schema.properties || {})) if (name in value) errors.push(...validateData(property, value[name], `${path}/${name}`));
  }
  return errors;
}
