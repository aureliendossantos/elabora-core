// compileInline without code generation (D80): an interpreter for JSON Schema 2020-12 whose errors are
// Ajv's (same keywords, instancePath, message, params, order), for the schemas Elabora compiles at run
// time (a component's props, a free object's props, the built-in blocks' props). It is not a general
// validator: the keywords below are refused when the schema is compiled, with a message that names
// them. test/unit/validation-differential.test.ts compares it with Ajv.
import { metaValidate } from './meta-validator.generated.ts';
import { MULTIPLE_OF_PRECISION, equal, ucs2length } from './validator-runtime.ts';
import type { ErrorObject, ValidateFunction } from './validator-runtime.ts';

// Keywords Ajv handles and the interpreter does not (each needs more than a walk over the data).
const UNSUPPORTED = new Set(['contains', 'minContains', 'maxContains', 'dependencies', 'dependentRequired', 'dependentSchemas', 'unevaluatedItems', '$dynamicRef', '$dynamicAnchor', '$anchor', '$recursiveRef']);
const SUPPORTED = 'type, enum, const, properties, required, additionalProperties, patternProperties, propertyNames, unevaluatedProperties, minProperties, maxProperties, items, prefixItems, minItems, maxItems, uniqueItems, minLength, maxLength, pattern, format "color", minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, allOf, anyOf, oneOf, not, if/then/else, $ref to #/$defs';

type Schema = any;
const GROUP_KEYWORDS: Record<string, string[]> = {
  number: ['maximum', 'minimum', 'exclusiveMaximum', 'exclusiveMinimum', 'multipleOf', 'format'],
  string: ['maxLength', 'minLength', 'pattern', 'format'],
  array: ['maxItems', 'minItems', 'uniqueItems', 'prefixItems', 'items'],
  object: ['maxProperties', 'minProperties', 'required', 'propertyNames', 'additionalProperties', 'properties', 'patternProperties']
};
const ptrEsc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const isObj = (d: unknown): d is Record<string, unknown> => d !== null && typeof d === 'object' && !Array.isArray(d);

function typeOk(t: string, d: any): boolean {
  switch (t) {
    case 'string': return typeof d === 'string';
    case 'number': return typeof d === 'number' && isFinite(d);
    case 'integer': return typeof d === 'number' && !(d % 1) && isFinite(d);
    case 'boolean': return typeof d === 'boolean';
    case 'null': return d === null;
    case 'array': return Array.isArray(d);
    case 'object': return isObj(d);
    default: throw new Error(`unknown type "${t}"`);
  }
}

const FORMATS: Record<string, RegExp> = { color: /^#[0-9A-Fa-f]{6}$/ };

function resolvePointer(root: Schema, ref: string): Schema {
  let cur: any = root;
  const path = ref.slice(1);
  if (path === '') return cur;
  if (!path.startsWith('/')) throw new Error(`can't resolve reference ${ref} from id #`);
  for (const raw of path.slice(1).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !(key in cur)) throw new Error(`can't resolve reference ${ref} from id #`);
    cur = cur[key];
  }
  return cur;
}

// Compile-time walk: everything ajv would reject when compiling, and the regular expressions.
function prepare(root: Schema): WeakMap<object, RegExp> {
  const regexps = new WeakMap<object, RegExp>();
  const seen = new Set<object>();
  const visit = (s: any): void => {
    if (s === null || typeof s !== 'object' || seen.has(s)) return;
    seen.add(s);
    if (Array.isArray(s)) { s.forEach(visit); return; }
    for (const k of Object.keys(s)) if (UNSUPPORTED.has(k)) throw new Error(`keyword "${k}" is not supported in Elabora schemas (supported: ${SUPPORTED})`);
    if (typeof s.$ref === 'string') {
      if (!s.$ref.startsWith('#')) throw new Error(`can't resolve reference ${s.$ref} from id #`);
      resolvePointer(root, s.$ref);
    }
    // pattern is a keyword only in a schema position, but a property named "pattern" holds a schema there.
    if (typeof s.pattern === 'string') regexps.set(s, new RegExp(s.pattern, 'u'));
    if (isObj(s.patternProperties)) for (const p of Object.keys(s.patternProperties)) re(p);
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (k === 'properties' || k === 'patternProperties' || k === '$defs' || k === 'definitions') { if (isObj(v)) Object.values(v).forEach(visit); }
      else if (k === 'enum' || k === 'const' || k === 'default' || k === 'examples' || k === 'required' || k === 'type' || k.startsWith('x-')) continue;
      else visit(v);
    }
  };
  visit(root);
  return regexps;
}

// Pattern-properties regexps, by pattern.
const reCache = new Map<string, RegExp>();
const re = (p: string) => { let r = reCache.get(p); if (!r) { r = new RegExp(p, 'u'); reCache.set(p, r); } return r; };

interface Ctx { root: Schema; regexps: WeakMap<object, RegExp> }

// Validate data against schema; push errors; evaluated is the set of object properties the schema (and its
// applicators) evaluated, for unevaluatedProperties.
function check(ctx: Ctx, schema: Schema, data: any, ip: string, sp: string, errors: ErrorObject[], ev: Set<string> | null, parent?: Schema): void {
  if (schema === true) return;
  if (schema === false) { errors.push({ instancePath: ip, schemaPath: sp, keyword: 'false schema', params: {}, message: 'boolean schema is false' }); return; }
  ev = ev ?? (schema.unevaluatedProperties !== undefined ? new Set<string>() : null);
  const err = (keyword: string, params: Record<string, unknown>, message: string, path = ip) => errors.push({ instancePath: path, schemaPath: `${sp}/${keyword}`, keyword, params, message });

  // type. ajv reports a single type that one of its keyword groups (number, string, array, object) also
  // handles from inside that group (after the untyped keywords); any other type error comes first.
  const types: string[] | null = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeFails = types !== null && !types.some((t) => typeOk(t, data));
  const deferred = types !== null && types.length === 1 && GROUP_KEYWORDS[types[0]!] !== undefined && GROUP_KEYWORDS[types[0]!]!.some((k) => schema[k] !== undefined) ? types[0]! : null;
  const typeError = () => err('type', { type: schema.type }, `must be ${types!.join(',')}`);
  if (typeFails && deferred === null) typeError();

  // any: $ref, const, enum, not, anyOf, oneOf, allOf, if
  if (typeof schema.$ref === 'string') {
    const target = resolvePointer(ctx.root, schema.$ref);
    const sub = ev ? new Set<string>() : null;
    check(ctx, target, data, ip, schema.$ref, errors, sub, undefined);
    if (ev && sub) for (const k of sub) ev.add(k);
  }
  if ('const' in schema && !equal(data, schema.const)) err('const', { allowedValue: schema.const }, 'must be equal to constant');
  if (Array.isArray(schema.enum) && !schema.enum.some((v: unknown) => equal(data, v))) err('enum', { allowedValues: schema.enum }, 'must be equal to one of the allowed values');
  if (schema.not !== undefined) {
    const tmp: ErrorObject[] = [];
    check(ctx, schema.not, data, ip, `${sp}/not`, tmp, null);
    if (tmp.length === 0) err('not', {}, 'must NOT be valid');
  }
  if (Array.isArray(schema.anyOf)) {
    let valid = false;
    const tmp: ErrorObject[] = [];
    const evs: Set<string>[] = [];
    schema.anyOf.forEach((s: Schema, i: number) => {
      const before = tmp.length;
      const sub = ev ? new Set<string>() : null;
      check(ctx, s, data, ip, `${sp}/anyOf/${i}`, tmp, sub);
      if (tmp.length === before) { valid = true; if (sub) evs.push(sub); }
    });
    if (valid) { if (ev) for (const s of evs) for (const k of s) ev.add(k); }
    else { errors.push(...tmp); err('anyOf', {}, 'must match a schema in anyOf'); }
  }
  if (Array.isArray(schema.oneOf)) {
    const tmp: ErrorObject[] = [];
    const passing: number[] = [];
    const evs: Set<string>[] = [];
    // ajv stops at the second branch that holds (the branches after it are never evaluated).
    for (let i = 0; i < schema.oneOf.length && passing.length < 2; i++) {
      const before = tmp.length;
      const sub = ev ? new Set<string>() : null;
      check(ctx, schema.oneOf[i], data, ip, `${sp}/oneOf/${i}`, tmp, sub);
      if (tmp.length === before) { passing.push(i); if (sub) evs.push(sub); }
    }
    if (passing.length === 1) { if (ev) for (const s of evs) for (const k of s) ev.add(k); }
    else {
      errors.push(...tmp);
      err('oneOf', { passingSchemas: passing.length ? passing : null }, 'must match exactly one schema in oneOf');
    }
  }
  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((s: Schema, i: number) => check(ctx, s, data, ip, `${sp}/allOf/${i}`, errors, ev));
  }
  if (schema.if !== undefined) {
    const tmp: ErrorObject[] = [];
    const sub = ev ? new Set<string>() : null;
    check(ctx, schema.if, data, ip, `${sp}/if`, tmp, sub);
    const ok = tmp.length === 0;
    const branch = ok ? schema.then : schema.else;
    if (ok && ev && sub) for (const k of sub) ev.add(k);
    if (branch !== undefined) {
      const name = ok ? 'then' : 'else';
      const before = errors.length;
      check(ctx, branch, data, ip, `${sp}/${name}`, errors, ev);
      if (errors.length > before) err('if', { failingKeyword: name }, `must match "${name}" schema`);
    }
  }

  // number
  if (typeof data === 'number' && isFinite(data)) {
    if (typeof schema.maximum === 'number' && !(data <= schema.maximum)) err('maximum', { comparison: '<=', limit: schema.maximum }, `must be <= ${schema.maximum}`);
    if (typeof schema.minimum === 'number' && !(data >= schema.minimum)) err('minimum', { comparison: '>=', limit: schema.minimum }, `must be >= ${schema.minimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && !(data < schema.exclusiveMaximum)) err('exclusiveMaximum', { comparison: '<', limit: schema.exclusiveMaximum }, `must be < ${schema.exclusiveMaximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && !(data > schema.exclusiveMinimum)) err('exclusiveMinimum', { comparison: '>', limit: schema.exclusiveMinimum }, `must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.multipleOf === 'number') {
      const m = schema.multipleOf;
      const div = data / m;
      if (m === 0 || Math.abs(Math.round(div) - div) > Number(`1e-${MULTIPLE_OF_PRECISION}`)) err('multipleOf', { multipleOf: m }, `must be multiple of ${m}`);
    }
  } else if (typeFails && deferred === 'number') typeError();
  // string
  if (typeof data === 'string') {
    if (typeof schema.maxLength === 'number' && ucs2length(data) > schema.maxLength) err('maxLength', { limit: schema.maxLength }, `must NOT have more than ${schema.maxLength} characters`);
    if (typeof schema.minLength === 'number' && ucs2length(data) < schema.minLength) err('minLength', { limit: schema.minLength }, `must NOT have fewer than ${schema.minLength} characters`);
    if (typeof schema.pattern === 'string' && !(ctx.regexps.get(schema) ?? re(schema.pattern)).test(data)) err('pattern', { pattern: schema.pattern }, `must match pattern "${schema.pattern}"`);
    if (typeof schema.format === 'string' && Object.hasOwn(FORMATS, schema.format) && !FORMATS[schema.format]!.test(data)) err('format', { format: schema.format }, `must match format "${schema.format}"`);
  } else if (typeFails && deferred === 'string') typeError();
  // array
  if (Array.isArray(data)) {
    if (typeof schema.maxItems === 'number' && data.length > schema.maxItems) err('maxItems', { limit: schema.maxItems }, `must NOT have more than ${schema.maxItems} items`);
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) err('minItems', { limit: schema.minItems }, `must NOT have fewer than ${schema.minItems} items`);
    let start = 0;
    if (Array.isArray(schema.prefixItems)) {
      const n = Math.min(schema.prefixItems.length, data.length);
      for (let i = 0; i < n; i++) check(ctx, schema.prefixItems[i], data[i], `${ip}/${i}`, `${sp}/prefixItems/${i}`, errors, null);
      start = schema.prefixItems.length;
    }
    if (schema.items !== undefined) {
      if (schema.items === false) { if (data.length > start) err('items', { limit: start }, `must NOT have more than ${start} items`); }
      else if (schema.items !== true) for (let i = start; i < data.length; i++) check(ctx, schema.items, data[i], `${ip}/${i}`, `${sp}/items`, errors, null);
    }
    if (schema.uniqueItems === true) {
      const it = schema.items;
      const itemTypes: string[] = isObj(it) && it.type !== undefined ? (Array.isArray(it.type) ? it.type : [it.type]) : [];
      const scalar = itemTypes.length > 0 && !itemTypes.some((t) => t === 'object' || t === 'array');
      let found: [number, number] | null = null;
      if (scalar) {
        const indices: Record<string, number> = {};
        for (let i = data.length; i--;) {
          let item = data[i];
          if (typeof item === 'string') item = '"' + item;
          if (typeof indices[item] === 'number') { found = [indices[item]!, i]; break; }
          indices[item] = i;
        }
      } else {
        outer: for (let i = data.length; i--;) for (let j = i; j--;) if (equal(data[i], data[j])) { found = [j, i]; break outer; }
      }
      if (found) err('uniqueItems', { i: found[1], j: found[0] }, `must NOT have duplicate items (items ## ${found[0]} and ${found[1]} are identical)`);
    }
  } else if (typeFails && deferred === 'array') typeError();
  // object
  if (isObj(data)) {
    const keys = Object.keys(data);
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) err('maxProperties', { limit: schema.maxProperties }, `must NOT have more than ${schema.maxProperties} properties`);
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) err('minProperties', { limit: schema.minProperties }, `must NOT have fewer than ${schema.minProperties} properties`);
    if (Array.isArray(schema.required)) for (const p of schema.required) if ((data as any)[p] === undefined) err('required', { missingProperty: p }, `must have required property '${p}'`);
    if (schema.propertyNames !== undefined) {
      for (const k of keys) {
        const tmp: ErrorObject[] = [];
        check(ctx, schema.propertyNames, k, ip, `${sp}/propertyNames`, tmp, null);
        if (tmp.length) {
          for (const e of tmp) { e.propertyName = k; errors.push(e); }
          err('propertyNames', { propertyName: k }, 'property name must be valid');
        }
      }
    }
    const props = isObj(schema.properties) ? schema.properties : null;
    const patterns = isObj(schema.patternProperties) ? Object.keys(schema.patternProperties) : [];
    if (schema.additionalProperties !== undefined) {
      for (const k in data) {
        if (props && Object.hasOwn(props, k)) continue;
        if (patterns.some((p) => re(p).test(k))) continue;
        if (schema.additionalProperties === false) err('additionalProperties', { additionalProperty: k }, 'must NOT have additional properties');
        else if (schema.additionalProperties !== true) check(ctx, schema.additionalProperties, (data as any)[k], `${ip}/${ptrEsc(k)}`, `${sp}/additionalProperties`, errors, null);
        ev?.add(k);
      }
    }
    if (props) for (const k of Object.keys(props)) {
      ev?.add(k);
      if ((data as any)[k] !== undefined) check(ctx, props[k], (data as any)[k], `${ip}/${ptrEsc(k)}`, `${sp}/properties/${ptrEsc(k)}`, errors, null);
    }
    for (const p of patterns) for (const k in data) if (re(p).test(k)) {
      ev?.add(k);
      check(ctx, (schema.patternProperties as any)[p], (data as any)[k], `${ip}/${ptrEsc(k)}`, `${sp}/patternProperties/${ptrEsc(p)}`, errors, null);
    }
    if (schema.unevaluatedProperties !== undefined) {
      // Evaluated by this schema's own keywords (and the applicators above, through ev).
      const done = ev ?? new Set<string>();
      for (const k of keys) {
        if (done.has(k)) continue;
        if (schema.unevaluatedProperties === false) err('unevaluatedProperties', { unevaluatedProperty: k }, 'must NOT have unevaluated properties');
        else if (schema.unevaluatedProperties !== true) check(ctx, schema.unevaluatedProperties, (data as any)[k], `${ip}/${ptrEsc(k)}`, `${sp}/unevaluatedProperties`, errors, null);
        ev?.add(k);
      }
    }
  } else if (typeFails && deferred === 'object') typeError();
}

export function compileInterpreted(schema: Schema): ValidateFunction {
  if (typeof schema !== 'object' && typeof schema !== 'boolean') throw new Error('schema must be object or boolean');
  if (typeof schema === 'object' && schema !== null && typeof schema.$schema === 'string' && schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error(`no schema with key or ref "${schema.$schema}"`);
  // ajv validates every schema it compiles against the meta-schema (precompiled at build time here).
  if (!metaValidate(schema)) {
    const errors = (metaValidate as any).errors as ErrorObject[];
    throw new Error('schema is invalid: ' + errors.map((e) => `data${e.instancePath} ${e.message}`).join(', '));
  }
  const ctx: Ctx = { root: schema, regexps: typeof schema === 'object' ? prepare(schema) : new WeakMap() };
  const validate = ((data: unknown) => {
    const errors: ErrorObject[] = [];
    check(ctx, schema, data, '', '#', errors, new Set<string>());
    validate.errors = errors.length ? errors : null;
    return errors.length === 0;
  }) as ValidateFunction;
  validate.errors = null;
  return validate;
}
