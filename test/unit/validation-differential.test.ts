import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LAYOUT_TYPES, BLOCK_TYPES, derefSchema, getSchema, schemaId } from '@elabora/format';
import type { JsonSchema, SchemaName } from '@elabora/format';
import { SCHEMAS } from '@elabora/format/schemas.generated';
import { VALIDATORS } from '@elabora/format/validators.generated';
import { compileInterpreted } from '@elabora/format/inline-schema';
import { isDateTime } from '@elabora/format/validator-runtime';
import { inlineAjv, registryAjv } from '../../scripts/reference-ajv.ts';
import { seededRandom, mutate } from '../mutations.ts';
import { breakData, describeErrors, generate } from '../schema-fuzz.ts';
import { EXAMPLES_DIR, exampleNames, snapshotOfExample } from '../validation-corpus.ts';

// The validators of the format are Ajv's, compiled when `pnpm run gen` ran, and compileInline is an
// interpreter that reproduces Ajv's errors (D80). Ajv stays here as the reference. The default size runs
// in a few seconds; ELABORA_DIFFERENTIAL=long (or a number of samples per schema) and ELABORA_SEED run
// the long version by hand: ELABORA_DIFFERENTIAL=1500 ELABORA_SEED=777 pnpm run test:file -- test/unit/validation-differential.test.ts
const SAMPLES = process.env.ELABORA_DIFFERENTIAL === 'long' ? 1500 : Number(process.env.ELABORA_DIFFERENTIAL) || 12;
const MUTANTS = Math.max(4, Math.round(SAMPLES / 3));
const SEED = Number(process.env.ELABORA_SEED) || 12345;

const stripX = (value: unknown): unknown => Array.isArray(value) ? value.map(stripX) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('x-')).map(([key, v]) => [key, stripX(v)])) : value;
const readJSON = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));

// What the examples hold that a schema describes, by the name of the schema.
function schemaNameOf(file: string): SchemaName | null {
  if (file === 'course.json') return 'course';
  if (file === 'plan.json') return 'plan';
  if (/^screens\/[^/]+\.json$/.test(file)) return 'screen';
  if (/^plan-versions\/[^/]+\.json$/.test(file)) return 'plan-version';
  if (/^components\/[^/]+\/component\.json$/.test(file)) return 'component';
  if (/^objects\/[^/]+\/object\.manifest\.json$/.test(file)) return 'object-manifest';
  if (/^objects\/[^/]+\/object\.tests\.json$/.test(file)) return 'object-tests';
  return null;
}

test('the precompiled validators report what Ajv reports, on the sample courses and on broken copies of them', () => {
  const ajv = registryAjv(Object.values(SCHEMAS));
  let invalid = 0;
  let compared = 0;
  const compare = (name: SchemaName, data: unknown, label: string) => {
    const reference = ajv.getSchema(schemaId(name))!;
    const validate = VALIDATORS[name];
    const same = reference(data) === validate(data);
    assert.ok(same, `${label}: ${name} validity differs`);
    assert.equal(describeErrors(validate.errors ?? [], true), describeErrors(reference.errors ?? [], true), `${label}: ${name}`);
    compared++;
    if (!same || validate.errors?.length) invalid++;
  };
  const random = seededRandom(SEED);
  for (const example of exampleNames()) {
    const files = snapshotOfExample(example);
    for (const [file, content] of files) {
      const name = schemaNameOf(file);
      if (name && content.kind === 'text') compare(name, JSON.parse(content.text), `${example}/${file}`);
    }
    for (let n = 0; n < MUTANTS; n++) {
      const copy = new Map(files);
      const log = mutate(copy, random);
      for (const [file, content] of copy) {
        const name = schemaNameOf(file);
        if (!name || content.kind !== 'text' || content === files.get(file)) continue;
        let data: unknown;
        try { data = JSON.parse(content.text); } catch { continue; }
        compare(name, data, `${example}/${file} (${log.join('; ')})`);
      }
    }
  }
  assert.ok(compared > 50 && invalid > 5, `${compared} documents compared, ${invalid} invalid: the mutants should break some`);
});

test('the precompiled validators report what Ajv reports, on data made from every schema', () => {
  const ajv = registryAjv(Object.values(SCHEMAS));
  const random = seededRandom(SEED + 1);
  let invalid = 0;
  for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
    const reference = ajv.getSchema(schemaId(name))!;
    const validate = VALIDATORS[name];
    for (let n = 0; n < SAMPLES; n++) {
      let data = generate(getSchema(name), getSchema(name), random);
      for (let k = Math.floor(random() * 4); k > 0; k--) data = breakData(data, random);
      assert.equal(validate(data), reference(data), name);
      assert.equal(describeErrors(validate.errors ?? [], true), describeErrors(reference.errors ?? [], true), name);
      if (validate.errors?.length) invalid++;
    }
  }
  assert.ok(invalid > 0);
});

// The schemas compileInline gets in a course: built-in block and layout props as the registry reads them,
// the props of the example components and the props of their objects.
function inlineSchemas(): { name: string; schema: JsonSchema }[] {
  const out: { name: string; schema: JsonSchema }[] = [];
  for (const type of [...BLOCK_TYPES.map((t) => `blocks/${t}`), ...LAYOUT_TYPES.map((t) => `layouts/${t}`), 'sound', 'object-tests', 'plan-notes']) out.push({ name: type, schema: stripX(derefSchema(getSchema(type)!)) as JsonSchema });
  for (const example of exampleNames()) {
    const root = path.join(EXAMPLES_DIR, example);
    for (const dir of fs.existsSync(path.join(root, 'components')) ? fs.readdirSync(path.join(root, 'components')) : []) {
      const file = path.join(root, 'components', dir, 'component.json');
      if (fs.existsSync(file) && readJSON(file).props) out.push({ name: `${example}/components/${dir}`, schema: stripX(readJSON(file).props) as JsonSchema });
    }
    for (const dir of fs.existsSync(path.join(root, 'objects')) ? fs.readdirSync(path.join(root, 'objects')) : []) {
      const file = path.join(root, 'objects', dir, 'object.manifest.json');
      if (!fs.existsSync(file)) continue;
      for (const [prop, schema] of Object.entries<any>(readJSON(file).props?.properties ?? {})) out.push({ name: `${example}/objects/${dir}/${prop}`, schema: stripX(schema) as JsonSchema });
    }
  }
  return out;
}

function compareInline(name: string, schema: JsonSchema | boolean, samples: unknown[]) {
  let reference: ReturnType<ReturnType<typeof inlineAjv>['compile']> | undefined;
  let interpreted: ReturnType<typeof compileInterpreted> | undefined;
  let referenceError: string | undefined;
  let interpretedError: string | undefined;
  try { reference = inlineAjv().compile(schema); } catch (error) { referenceError = (error as Error).message; }
  try { interpreted = compileInterpreted(schema); } catch (error) { interpretedError = (error as Error).message; }
  if (referenceError || interpretedError) {
    // Ajv accepts some keywords the interpreter refuses by name (its own message); anything else must read the same.
    if (interpretedError?.startsWith('keyword "')) return 0;
    assert.equal(interpretedError, referenceError, `${name}: compile`);
    return 0;
  }
  let invalid = 0;
  for (const data of samples) {
    assert.equal(interpreted!(data), reference!(data), `${name}: ${JSON.stringify(data)?.slice(0, 200)}`);
    assert.equal(describeErrors(interpreted!.errors), describeErrors(reference!.errors), `${name}: ${JSON.stringify(data)?.slice(0, 200)}`);
    if (reference!.errors?.length) invalid++;
  }
  return invalid;
}

test('the interpreter behind compileInline reports what Ajv reports, on data made from the schemas courses compile', () => {
  const random = seededRandom(SEED + 2);
  const schemas = inlineSchemas();
  assert.ok(schemas.length > 100);
  let invalid = 0;
  for (const { name, schema } of schemas) {
    const samples = Array.from({ length: SAMPLES }, () => {
      let data = generate(schema, schema, random);
      for (let k = Math.floor(random() * 4); k > 0; k--) data = breakData(data, random);
      return data;
    });
    invalid += compareInline(name, schema, samples);
  }
  assert.ok(invalid > schemas.length, `${invalid} invalid samples`);
});

test('the interpreter follows Ajv on the keywords that depend on each other (unevaluatedProperties, oneOf, if, $ref, uniqueItems…)', () => {
  const base = { type: 'object', properties: { a: { type: 'string' } } };
  const cases: { name: string; schema: JsonSchema; data: unknown[] }[] = [
    { name: 'unevaluatedProperties beside properties', schema: { ...base, unevaluatedProperties: false }, data: [{ a: 'x' }, { a: 'x', b: 1 }, { a: 1, b: 1, c: 2 }, {}, []] },
    { name: 'unevaluatedProperties through allOf', schema: { allOf: [base, { properties: { b: { type: 'number' } } }], unevaluatedProperties: false }, data: [{ a: 'x', b: 1 }, { a: 'x', b: 'y', c: 1 }, { c: 1 }] },
    { name: 'unevaluatedProperties through anyOf', schema: { anyOf: [{ properties: { a: true }, required: ['a'] }, { properties: { b: true }, required: ['b'] }], unevaluatedProperties: false }, data: [{ a: 1 }, { b: 1 }, { a: 1, b: 2 }, { a: 1, c: 3 }, { c: 3 }] },
    { name: 'unevaluatedProperties through oneOf', schema: { oneOf: [{ properties: { kind: { const: 'x' }, x: true }, required: ['kind'] }, { properties: { kind: { const: 'y' }, y: true }, required: ['kind'] }], unevaluatedProperties: false }, data: [{ kind: 'x', x: 1 }, { kind: 'y', x: 1 }, { kind: 'z' }, { kind: 'x', y: 1, z: 2 }] },
    { name: 'unevaluatedProperties through if/then/else', schema: { if: { properties: { t: { const: 1 } }, required: ['t'] }, then: { properties: { one: true } }, else: { properties: { other: true } }, unevaluatedProperties: false }, data: [{ t: 1, one: 1 }, { t: 1, other: 1 }, { t: 2, other: 1 }, { t: 2, one: 1 }, { z: 1 }] },
    { name: 'unevaluatedProperties through $ref', schema: { $defs: { part: { properties: { p: { type: 'integer' } } } }, allOf: [{ $ref: '#/$defs/part' }], unevaluatedProperties: { type: 'string' } }, data: [{ p: 1 }, { p: 1.5 }, { p: 1, q: 'x' }, { p: 1, q: 5 }] },
    { name: 'unevaluatedProperties with a schema', schema: { properties: { a: true }, unevaluatedProperties: { type: 'number', maximum: 3 } }, data: [{ a: 1, b: 2 }, { b: 'x' }, { b: 4, c: 5 }] },
    { name: 'oneOf with two matches and none', schema: { oneOf: [{ type: 'integer' }, { type: 'number', minimum: 0 }, { type: 'string' }] }, data: [1, 1.5, -1.5, 'x', null, -1] },
    { name: 'anyOf with errors in every branch', schema: { anyOf: [{ type: 'string', minLength: 2 }, { type: 'number', multipleOf: 0.05 }, { type: 'object', required: ['k'] }] }, data: ['a', 0.61, 0.6, {}, [], null] },
    { name: 'not, const, enum', schema: { properties: { a: { not: { enum: [1, 2] } }, b: { const: { x: [1, { y: 2 }] } }, c: { enum: ['u', null, [1], { z: 1 }] } } }, data: [{ a: 1 }, { a: 3, b: { x: [1, { y: 2 }] } }, { b: { x: [1, { y: 3 }] }, c: [1] }, { c: { z: 1 } }, { c: 'v' }] },
    { name: 'if/then/else reports the branch', schema: { if: { properties: { t: { const: 'a' } }, required: ['t'] }, then: { required: ['x'] }, else: { required: ['y'], properties: { y: { type: 'string' } } } }, data: [{ t: 'a' }, { t: 'a', x: 1 }, { t: 'b' }, { t: 'b', y: 1 }] },
    { name: 'uniqueItems on scalars and on objects', schema: { type: 'object', properties: { s: { type: 'array', items: { type: 'string' }, uniqueItems: true }, o: { type: 'array', items: { type: 'object' }, uniqueItems: true }, m: { type: 'array', uniqueItems: true } } }, data: [{ s: ['a', 'b', 'a'] }, { o: [{ a: 1 }, { a: 2 }, { a: 1 }] }, { m: [1, '1', 1] }, { m: [[1], [1]] }, { s: [], o: [], m: [] }] },
    { name: 'prefixItems and items', schema: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: { type: 'boolean' } }, data: [['a', 1, true], ['a', 'b', 1], [1], [], ['a', 1, 2, false]] },
    { name: 'items false', schema: { type: 'array', prefixItems: [{ type: 'string' }], items: false }, data: [['a'], ['a', 'b'], [], 'x'] },
    { name: 'patternProperties, additionalProperties and propertyNames', schema: { type: 'object', propertyNames: { pattern: '^[a-z]+$', maxLength: 4 }, patternProperties: { '^n': { type: 'number' } }, additionalProperties: { type: 'string' }, minProperties: 1, maxProperties: 4 }, data: [{ n1: 1, aa: 'x' }, { n1: 'x', aa: 2 }, { Bad: 'x' }, { toolong: 'x' }, {}, { a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' }] },
    { name: 'string lengths count code points', schema: { type: 'string', minLength: 2, maxLength: 3, pattern: '^.+$' }, data: ['😀', '😀😀', '😀😀😀😀', 'é', 'ab\ncd', ''] },
    { name: 'numbers: bounds, integer, multipleOf', schema: { type: 'integer', minimum: 1, exclusiveMaximum: 10, multipleOf: 3 }, data: [3, 9, 10, 0, 4, 3.0, 1.5, '3', 1e21] },
    { name: 'a type list and a nullable object', schema: { type: ['object', 'null'], properties: { a: { type: ['integer', 'string'] } }, required: ['a'] }, data: [null, { a: 1 }, { a: 1.5 }, { a: null }, 'x', []] },
    { name: 'type and constraints of another type', schema: { type: 'string', properties: { a: { type: 'number' } }, minimum: 3, items: { type: 'string' } }, data: [5, 'x', { a: 'x' }, [1]] },
    { name: 'boolean schemas', schema: { properties: { yes: true, no: false } }, data: [{ yes: 1 }, { no: 1 }, {}] },
    { name: 'a recursive $ref', schema: { $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' }, v: { type: 'integer' } }, additionalProperties: false } }, $ref: '#/$defs/node' }, data: [{ v: 1, next: { v: 2, next: { v: 'x' } } }, { next: { w: 1 } }, 3] },
    { name: 'the color format', schema: { type: 'object', properties: { c: { type: 'string', format: 'color' } } }, data: [{ c: '#12ab9F' }, { c: '#12ab9' }, { c: 'red' }, { c: 4 }] },
    { name: 'required with an undefined-looking value', schema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'null' } } }, data: [{ a: null }, { a: null, b: 0 }, { b: false }] }
  ];
  for (const { name, schema, data } of cases) {
    const invalid = compareInline(name, schema, data);
    assert.ok(invalid > 0 || name.startsWith('boolean') || name.startsWith('a recursive'), `${name}: no sample was invalid`);
  }
});

test('a schema that does not compile gives the message Ajv gives; a keyword the interpreter lacks is named', () => {
  for (const schema of [{ type: 'strng' }, { type: 'object', properties: { a: { pattern: '^([' } } }, { $ref: 'other.json#/x' }, { properties: { a: { $ref: '#/$defs/missing' } } }, { minLength: -1 }, { required: 'a' }, { $schema: 'http://json-schema.org/draft-07/schema#' }, 'x']) {
    compareInline(JSON.stringify(schema), schema as JsonSchema, [1]);
    let ajvMessage = '';
    try { inlineAjv().compile(schema as JsonSchema); } catch (error) { ajvMessage = (error as Error).message; }
    assert.throws(() => compileInterpreted(schema as JsonSchema), (error: Error) => error.message === ajvMessage, JSON.stringify(schema));
  }
  for (const keyword of ['contains', 'dependentRequired', 'dependentSchemas', 'unevaluatedItems', '$dynamicRef', '$anchor']) {
    const schema = { type: 'object', properties: { a: { [keyword]: keyword.startsWith('$') ? 'x' : keyword === 'dependentRequired' ? { a: ['b'] } : keyword === 'unevaluatedItems' ? false : {} } } } as JsonSchema;
    assert.throws(() => compileInterpreted(schema), (error: Error) => error.message.includes(`keyword "${keyword}" is not supported`) && error.message.includes('supported:'), keyword);
  }
});

test('format date-time is the one Ajv checks', () => {
  const reference = registryAjv(Object.values(SCHEMAS)).compile({ type: 'string', format: 'date-time' });
  const random = seededRandom(SEED + 3);
  const digits = (n: number) => String(Math.floor(random() * 10 ** n)).padStart(n, '0');
  const strings = ['2026-11-12T10:00:00Z', '2026-11-12t10:00:00z', '2026-11-12 10:00:00+01:00', '2026-02-29T00:00:00Z', '2028-02-29T23:59:60Z', '2026-11-12T23:59:60+00:00', '2026-11-12T10:00:00', '2026-13-01T00:00:00Z', '2026-11-12T24:00:00Z', '2026-11-12T10:00:00.123456Z', '2026-11-12T10:00:00+25:00', '2026-11-12', '', 'T', '2026-11-12T10:00:00Z T', '2026-11-12 10:00:00 Z', 'T2026-11-12T10:00:00Z'];
  for (let n = 0; n < SAMPLES * 20; n++) strings.push(`${digits(4)}-${digits(2)}-${digits(2)}${random() < 0.5 ? 'T' : ' '}${digits(2)}:${digits(2)}:${digits(2)}${random() < 0.3 ? `.${digits(3)}` : ''}${random() < 0.5 ? 'Z' : `${random() < 0.5 ? '+' : '-'}${digits(2)}:${digits(2)}`}`);
  let valid = 0;
  for (const text of strings) {
    assert.equal(isDateTime(text), reference(text), text);
    if (reference(text)) valid++;
  }
  assert.ok(valid > 3 && valid < strings.length);
});
