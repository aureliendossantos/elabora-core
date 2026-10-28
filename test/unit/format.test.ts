import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateFormatFiles } from '../../scripts/gen-format.ts';
import { BLOCK_TYPES, FORMAT, compileInline, derefSchema, getAjv, getSchema, isBuiltinBlockType, schemaId, validateSchema } from '@elabora/format';
import type { JsonSchema, SchemaName } from '@elabora/format';
import { SCHEMAS } from '@elabora/format/schemas.generated';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXAMPLE = path.join(ROOT, 'examples/planetary-gearset');
const readJSON = (rel: string): any => JSON.parse(fs.readFileSync(path.join(EXAMPLE, rel), 'utf8'));
// Entries of a sample folder, without OS files (.DS_Store) that a checkout may hold.
const list = (rel: string) => (fs.existsSync(path.join(EXAMPLE, rel)) ? fs.readdirSync(path.join(EXAMPLE, rel)).filter((n) => !n.startsWith('.')).sort() : []);

test('generated format modules are up to date (pnpm run gen)', () => {
  for (const { path: file, content } of generateFormatFiles()) {
    const current = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(current === content, `${file} is stale: run pnpm run gen`);
  }
});

test('every schema compiles in strict mode under its id', () => {
  const ajv = getAjv();
  const names = Object.keys(SCHEMAS) as SchemaName[];
  assert.ok(names.includes('course') && names.includes('blocks/quiz') && names.includes('object-manifest'));
  for (const name of names) {
    assert.equal(getSchema(name).$id, schemaId(name), name);
    assert.equal(typeof ajv.getSchema(schemaId(name)), 'function', name);
  }
  assert.equal(getSchema('nothing'), undefined);
  assert.equal(getSchema('constructor'), undefined);
});

test('format version and block catalogue follow the schemas', () => {
  assert.equal((getSchema('course').properties?.format as JsonSchema).const, FORMAT);
  const blockFiles = Object.keys(SCHEMAS).filter((n) => n.startsWith('blocks/')).map((n) => n.slice('blocks/'.length));
  assert.deepEqual([...BLOCK_TYPES].sort(), blockFiles.sort());
  assert.ok(isBuiltinBlockType('free-object'));
  assert.ok(!isBuiltinBlockType('ratio-card') && !isBuiltinBlockType(undefined));
});

test('the registry accepts the planetary-gearset course', () => {
  const files: [SchemaName, string][] = [['course', 'course.json'], ['plan', 'plan.json']];
  for (const f of list('screens')) files.push(['screen', `screens/${f}`]);
  for (const c of list('components')) files.push(['component', `components/${c}/component.json`]);
  for (const o of list('objects')) files.push(['object-manifest', `objects/${o}/object.manifest.json`], ['object-tests', `objects/${o}/object.tests.json`]);
  for (const v of list('plan-versions')) files.push(['plan-version', `plan-versions/${v}`]);
  assert.ok(files.length > 15);
  for (const [name, rel] of files) assert.deepEqual(validateSchema(name, readJSON(rel)), [], rel);
});

test('the registry reports what is wrong in a broken copy of the course', () => {
  const course = readJSON('course.json');
  course.format = 'elabora/0.0';
  delete course.title;
  const courseErrors = validateSchema('course', course);
  assert.ok(courseErrors.some((e) => e.path === '/format' && e.message === `must be "${FORMAT}"`));
  assert.ok(courseErrors.some((e) => e.path === '' && e.message === 'missing required property "title"'));

  // Block props are checked against the schema of their built-in type.
  const screen = readJSON('screens/assessment.json');
  const quiz = screen.blocks.find((b: { type: string }) => b.type === 'quiz');
  quiz.props.attempts = 9;
  quiz.props.hint = 'not a quiz prop';
  const screenErrors = validateSchema('screen', screen);
  const at = `/blocks/${screen.blocks.indexOf(quiz)}/props`;
  assert.ok(screenErrors.some((e) => e.path === `${at}/attempts` && e.keyword === 'maximum'));
  assert.ok(screenErrors.some((e) => e.path === at && e.message === 'unknown property "hint" (not allowed by the schema)'));
});

test('derefSchema inlines the shared definitions', () => {
  const quiz = derefSchema(getSchema('blocks/quiz'));
  assert.equal(quiz.$id, undefined);
  assert.ok(!JSON.stringify(quiz).includes('defs.schema.json'));
  assert.equal((quiz.properties?.questionRef as JsonSchema).pattern, (getSchema('defs').$defs?.planId as JsonSchema).pattern);
});

test('multipleOf with decimals takes the values a slider gives (0.6 is a multiple of 0.05)', () => {
  const step = compileInline({ type: 'number', multipleOf: 0.05 });
  for (const value of [0.6, 0.7, 0.3, 2.4, 11.95]) assert.equal(step(value), true, String(value));
  assert.equal(step(0.61), false);
  assert.equal(compileInline({ type: 'number', multipleOf: 0.1 })(2.4), true);
});
