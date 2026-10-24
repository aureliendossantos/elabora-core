import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  applyOps, invertOps, diffFiles, diffDocuments, undoChanges, makeFiles, formatJson, textFile, jsonFile, binaryFile, OpError,
  assignBatch, summarizeBatches, changesToUndo, undoneChanges, lastAiBatch, BATCH_IDLE_MS, touchedFiles,
  type Files, type FileContent, type Json, type JsonObject, type Op, type Author, type JournalEntry, type ChangeEntry, type UndoEntry
} from '@elabora/core/ops/index';
import { ROOT } from '../helpers.ts';

// ── tools ────────────────────────────────────────────────────────────

// Small seeded generator (mulberry32): a failing property names its seed, so it can be replayed.
type Rng = ReturnType<typeof random>;
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    next, int,
    chance: (p: number) => next() < p,
    pick: <T>(list: readonly T[]): T => list[int(list.length)],
    shuffle: <T>(list: readonly T[]): T[] => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
  };
}

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = <T>(value: T): T => structuredClone(value);
const text = (file: FileContent | undefined) => (file?.kind === 'text' ? file.text : undefined);
const doc = (files: Files, file: string) => JSON.parse(text(files.get(file)) as string) as JsonObject;
const sha = (data: string) => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;

function assertSameFiles(actual: Files, expected: Files, message: string): void {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), `${message}: same files`);
  for (const [file, content] of expected) {
    const got = actual.get(file) as FileContent;
    if (content.kind === 'text') assert.equal(text(got), content.text, `${message}: ${file}`);
    else assert.equal(got.kind === 'binary' ? got.hash : null, content.hash, `${message}: ${file}`);
  }
}

// Every operation is plain JSON and addresses arrays by id only.
function assertJournalSafe(ops: Op[], message: string): void {
  assert.deepEqual(JSON.parse(JSON.stringify(ops)), ops, `${message}: ops survive JSON`);
  for (const op of ops) {
    for (const p of 'path' in op ? [op.path, ...(op.op === 'move' ? [op.to.path] : [])] : []) {
      for (const segment of p) assert.ok(typeof segment === 'string' || (isObject(segment) && typeof segment.id === 'string'), `${message}: segment ${JSON.stringify(segment)}`);
    }
  }
}

// diff → apply gives after; inverse → before; both exactly, text included.
function roundTrip(before: Files, after: Files, message: string): Op[] {
  const ops = diffFiles(before, after);
  assertJournalSafe(ops, message);
  const applied = applyOps(before, ops);
  assertSameFiles(applied, after, `${message}: apply(diff)`);
  const inverse = invertOps(before, ops);
  assert.equal(inverse.length, ops.length, `${message}: one inverse per operation`);
  assertJournalSafe(inverse, message);
  assertSameFiles(applyOps(applied, inverse), before, `${message}: apply(inverse)`);
  return ops;
}

const filesOf = (docs: Map<string, Json>, others: Map<string, FileContent> = new Map()): Files => {
  const files = new Map<string, FileContent>(others);
  for (const [file, value] of docs) files.set(file, jsonFile(value));
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
};

// ── random documents and edits ───────────────────────────────────────

const WORDS = ['alpha', 'beta', 'gamma', 'intro', 'quiz', 'été', 'naïve', '"quoted"', 'line\nbreak', '', 'tab\there', '日本'];
const KEYS = ['title', 'props', 'markdown', 'type', 'hidden', 'width', 'note', 'style', 'text', 'a', 'b', 'c', 'x', 'y', 'über', 'with space', 'dot.key', 'blocks', 'layers', 'options', 'covers', 'tags', 'values'];
const KEYED_OBJECTS = new Set(['blocks', 'layers', 'options']);
const KEYED_STRINGS = new Set(['covers', 'tags']);
const STRINGS = ['ITEM-1', 'ITEM-2', 'ITEM-3', 'ITEM-4', 'ITEM-5', 'ITEM-6', 'ITEM-7'];

function generator(rng: Rng) {
  let counter = 0;
  const fresh = () => `e${++counter}`;
  const scalar = (): Json => {
    switch (rng.int(6)) {
      case 0: return null;
      case 1: return rng.chance(0.5);
      case 2: return rng.int(1000) - 500;
      case 3: return Math.round(rng.next() * 1e4) / 100;
      case 4: return rng.pick(WORDS);
      default: return `${rng.pick(WORDS)} ${rng.int(100)}`;
    }
  };
  const keyedStrings = (): Json[] => rng.shuffle(STRINGS).slice(0, rng.int(5));
  const object = (depth: number, id?: string): JsonObject => {
    const out: JsonObject = id ? { id } : {};
    for (let i = rng.int(5); i > 0; i--) {
      const key = rng.pick(KEYS);
      out[key] = KEYED_OBJECTS.has(key) ? keyedObjects(depth - 1) : KEYED_STRINGS.has(key) ? keyedStrings() : value(depth - 1);
    }
    return out;
  };
  const keyedObjects = (depth: number): Json[] => Array.from({ length: depth > 0 ? rng.int(5) : 0 }, () => object(depth - 1, fresh()));
  const plainArray = (depth: number): Json[] => {
    switch (rng.int(3)) {
      case 0: return Array.from({ length: rng.int(5) }, () => rng.int(4)); // duplicates: a value
      case 1: return Array.from({ length: rng.int(3) }, () => ({ kind: rng.pick(WORDS), n: rng.int(9) }));
      default: return Array.from({ length: rng.int(4) }, () => (depth > 0 ? value(depth - 1) : scalar()));
    }
  };
  const value = (depth: number): Json => {
    if (depth <= 0 || rng.chance(0.35)) return scalar();
    switch (rng.int(5)) {
      case 0: case 1: return object(depth - 1);
      case 2: return keyedObjects(depth - 1);
      case 3: return keyedStrings();
      default: return plainArray(depth - 1);
    }
  };
  return { fresh, scalar, value, object, keyedObjects, keyedStrings };
}

type Generator = ReturnType<typeof generator>;
interface Place { node: JsonObject | Json[]; parent: JsonObject | Json[] | null; key: string | number | null; arrayKey: string }

function placesIn(root: Json, arrayKey = ''): Place[] {
  const out: Place[] = [];
  const walk = (node: Json, parent: Place['parent'], key: Place['key'], parentKey: string) => {
    if (Array.isArray(node)) {
      out.push({ node, parent, key, arrayKey: parentKey });
      node.forEach((element, i) => walk(element, node, i, ''));
    } else if (isObject(node)) {
      out.push({ node, parent, key, arrayKey: '' });
      for (const k of Object.keys(node)) walk(node[k], node, k, k);
    }
  };
  walk(root, null, null, arrayKey);
  return out;
}

const kindOf = (array: Json[]): 'objects' | 'strings' | 'empty' | null => {
  if (!array.length) return 'empty';
  if (array.every((x) => typeof x === 'string')) return new Set(array).size === array.length ? 'strings' : null;
  const ids = array.map((x) => (isObject(x) && typeof x.id === 'string' ? x.id : null));
  return ids.every((id) => id !== null) && new Set(ids).size === ids.length ? 'objects' : null;
};
const contains = (node: Json, target: Json): boolean => node === target || (node !== null && typeof node === 'object' && Object.values(node).some((child) => contains(child, target)));

// Random edits in place, across documents (so elements also move between files).
function mutate(rng: Rng, gen: Generator, docs: Map<string, Json>, steps: number): void {
  for (let s = 0; s < steps; s++) {
    const all = [...docs.values()].flatMap((root) => placesIn(root));
    const place = rng.pick(all);
    const { node } = place;
    const replaceInParent = (value: Json) => {
      if (place.parent === null) return;
      if (Array.isArray(place.parent)) place.parent[place.key as number] = value;
      else place.parent[place.key as string] = value;
    };
    if (!Array.isArray(node)) {
      const keys = Object.keys(node);
      switch (rng.int(8)) {
        case 0: if (keys.length) node[rng.pick(keys)] = gen.value(2); break;
        case 1: { const key = rng.pick(KEYS); if (key !== 'id') node[key] = gen.value(2); break; }
        case 2: { // a key added in the middle
          const key = rng.pick(KEYS);
          if (key === 'id' || Object.hasOwn(node, key)) break;
          const entries = Object.entries(node);
          entries.splice(rng.int(entries.length + 1), 0, [key, gen.value(1)]);
          for (const k of keys) delete node[k];
          for (const [k, v] of entries) node[k] = v;
          break;
        }
        case 3: { const key = keys.filter((k) => k !== 'id'); if (key.length) delete node[rng.pick(key)]; break; }
        case 4: { // keys reordered
          if (!rng.chance(0.4)) break;
          const entries = rng.shuffle(Object.entries(node));
          for (const k of keys) delete node[k];
          for (const [k, v] of entries) node[k] = v;
          break;
        }
        case 5: if (place.parent !== null && !Array.isArray(place.parent)) replaceInParent(gen.scalar()); break; // type change
        default: { const key = keys.filter((k) => k !== 'id' && !isObject(node[k]) && !Array.isArray(node[k])); if (key.length) node[rng.pick(key)] = gen.scalar(); }
      }
      continue;
    }
    const kind = kindOf(node);
    if (kind === 'objects' || (kind === 'empty' && KEYED_OBJECTS.has(place.arrayKey))) {
      switch (rng.int(6)) {
        case 0: node.splice(rng.int(node.length + 1), 0, gen.object(2, gen.fresh())); break;
        case 1: if (node.length) node.splice(rng.int(node.length), 1); break;
        case 2: if (node.length > 1) { const [element] = node.splice(rng.int(node.length), 1); node.splice(rng.int(node.length + 1), 0, element); } break;
        case 3: case 4: { // to another keyed array, preferably under the same key
          if (!node.length) break;
          const index = rng.int(node.length);
          const element = node[index];
          const targets = all.filter((p) => Array.isArray(p.node) && p.node !== node && (kindOf(p.node) === 'objects' || (kindOf(p.node) === 'empty' && KEYED_OBJECTS.has(p.arrayKey)))
            && !contains(element, p.node) && (rng.chance(0.2) || p.arrayKey === place.arrayKey));
          if (!targets.length) break;
          const target = rng.pick(targets).node as Json[];
          node.splice(index, 1);
          target.splice(rng.int(target.length + 1), 0, element);
          break;
        }
        default: if (node.length && rng.chance(0.3)) node.push(clone(node[0])); // duplicate id: no longer keyed
      }
    } else if (kind === 'strings' || kind === 'empty') {
      switch (rng.int(4)) {
        case 0: { const missing = STRINGS.filter((x) => !node.includes(x)); if (missing.length) node.splice(rng.int(node.length + 1), 0, rng.pick(missing)); break; }
        case 1: if (node.length) node.splice(rng.int(node.length), 1); break;
        case 2: if (node.length > 1) { const [element] = node.splice(rng.int(node.length), 1); node.splice(rng.int(node.length + 1), 0, element); } break;
        default: {
          if (!node.length) break;
          const index = rng.int(node.length);
          const targets = all.filter((p) => Array.isArray(p.node) && p.node !== node && (kindOf(p.node) === 'strings' || (kindOf(p.node) === 'empty' && KEYED_STRINGS.has(p.arrayKey))) && !p.node.includes(node[index]));
          if (!targets.length) break;
          const target = rng.pick(targets).node as Json[];
          target.splice(rng.int(target.length + 1), 0, node.splice(index, 1)[0]);
        }
      }
    } else {
      switch (rng.int(3)) {
        case 0: node.push(gen.scalar()); break;
        case 1: node.pop(); break;
        default: replaceInParent(gen.keyedStrings());
      }
    }
  }
}

// ── properties on random documents ───────────────────────────────────

// ELABORA_SEEDS=50 npm test runs the properties on 50 times more seeds.
const SEEDS = Math.max(1, Number(process.env.ELABORA_SEEDS) || 1);

test('diff, apply and invert: random documents and random edits round-trip exactly', () => {
  for (let seed = 1; seed <= 400 * SEEDS; seed++) {
    const rng = random(seed);
    const gen = generator(rng);
    const before = gen.object(5);
    const after = clone(before);
    const docs = new Map<string, Json>([['doc.json', after]]);
    mutate(rng, gen, docs, 1 + rng.int(6));
    const message = `seed ${seed}`;
    roundTrip(new Map([['doc.json', jsonFile(before)]]), new Map([['doc.json', jsonFile(after)]]), message);
  }
});

test('diff, apply and invert: several files, moves between files, created and deleted files', () => {
  for (let seed = 1; seed <= 300 * SEEDS; seed++) {
    const rng = random(1000 + seed);
    const gen = generator(rng);
    const docs = new Map<string, Json>();
    for (const name of ['a', 'b', 'c']) docs.set(`screens/${name}.json`, { id: name, blocks: gen.keyedObjects(3), layers: gen.keyedObjects(2), covers: gen.keyedStrings() });
    const others = new Map<string, FileContent>([['notes.md', textFile('notes.md', 'Notes\n')], ['assets/logo.png', binaryFile(sha('logo'), 4)], ['broken.json', textFile('broken.json', '{ "no": ')]]);
    const before = filesOf(docs, others);
    const afterDocs = new Map([...docs].map(([file, value]) => [file, clone(value)]));
    mutate(rng, gen, afterDocs, 1 + rng.int(8));
    const afterOthers = new Map(others);
    if (rng.chance(0.3)) afterDocs.delete(rng.pick([...afterDocs.keys()]));
    if (rng.chance(0.3)) afterDocs.set('screens/new.json', { id: 'new', blocks: gen.keyedObjects(2) });
    if (rng.chance(0.3)) afterOthers.set('notes.md', textFile('notes.md', 'Notes, edited\n'));
    if (rng.chance(0.3)) afterOthers.set('assets/logo.png', binaryFile(sha('logo 2'), 6));
    if (rng.chance(0.2)) afterOthers.delete('assets/logo.png');
    if (rng.chance(0.2)) afterOthers.set('broken.json', textFile('broken.json', '{ "fixed": true }\n'));
    roundTrip(before, filesOf(afterDocs, afterOthers), `seed ${seed}`);
  }
});

test('invert: random operation sequences, including key placement, come back exactly', () => {
  for (let seed = 1; seed <= 300 * SEEDS; seed++) {
    const rng = random(5000 + seed);
    const gen = generator(rng);
    let files: Files = new Map([['a.json', jsonFile(gen.object(4))], ['b.json', jsonFile(gen.object(4))], ['notes.md', textFile('notes.md', 'x\n')]]);
    const original = files;
    const ops: Op[] = [];
    for (let n = 1 + rng.int(8); n > 0; n--) {
      const op = randomOp(rng, gen, files);
      if (!op) continue;
      files = applyOps(files, [op]);
      ops.push(op);
    }
    const inverse = invertOps(original, ops);
    assertSameFiles(applyOps(files, inverse), original, `seed ${seed}`);
    assertSameFiles(applyOps(original, ops), files, `seed ${seed}: one call or several`);
  }
});

// A valid operation on the current files, chosen at random.
function randomOp(rng: Rng, gen: Generator, files: Files): Op | null {
  const docs = [...files].filter(([, content]) => content.kind === 'text' && content.json !== undefined).map(([file, content]) => [file, (content as { json: Json }).json] as const);
  const targets: { file: string; path: (string | { id: string })[]; node: Json }[] = [];
  for (const [file, root] of docs) {
    const walk = (node: Json, p: (string | { id: string })[]) => {
      targets.push({ file, path: p, node });
      if (isObject(node)) for (const k of Object.keys(node)) walk(node[k], [...p, k]);
      else if (Array.isArray(node) && (kindOf(node) === 'objects')) for (const element of node) walk(element, [...p, { id: (element as JsonObject).id as string }]);
    };
    walk(root, []);
  }
  const target = rng.pick(targets);
  const { file, path: p, node } = target;
  const choice = rng.int(9);
  if (choice === 0) return rng.chance(0.5) ? { op: 'write', file: 'notes.md', text: `${rng.pick(WORDS)}\n` } : { op: 'write', file: 'c.json', text: formatJson({ made: rng.int(9) }) };
  if (isObject(node)) {
    // The id of an element is permanent (see "ids are permanent").
    const keys = Object.keys(node).filter((k) => k !== 'id' || !p.length || typeof p[p.length - 1] === 'string');
    const fresh = KEYS.filter((k) => !Object.hasOwn(node, k));
    if (choice <= 3 && fresh.length) return { op: 'set', file, path: [...p, rng.pick(fresh)], value: gen.value(2), ...(rng.chance(0.6) ? { after: keys.length && rng.chance(0.8) ? rng.pick(keys) : null } : {}) };
    if (choice <= 5 && keys.length) return { op: 'unset', file, path: [...p, rng.pick(keys)] };
    if (keys.length) return { op: 'set', file, path: [...p, rng.pick(keys)], value: gen.value(2) };
    return null;
  }
  if (Array.isArray(node)) {
    const kind = kindOf(node);
    if (kind === null) return { op: 'set', file, path: p, value: gen.value(1) };
    const ids = node.map((x) => (typeof x === 'string' ? x : (x as JsonObject).id as string));
    if (choice <= 4) {
      const element = kind === 'strings' ? STRINGS.find((x) => !ids.includes(x)) : gen.object(2, gen.fresh());
      if (element === undefined) return null;
      return { op: 'insert', file, path: p, value: element, after: ids.length && rng.chance(0.7) ? rng.pick(ids) : null };
    }
    if (!ids.length) return null;
    const id = rng.pick(ids);
    if (choice <= 6) return { op: 'remove', file, path: [...p, { id }] };
    const others = ids.filter((x) => x !== id);
    return { op: 'move', file, path: [...p, { id }], to: { file, path: p }, after: others.length && rng.chance(0.7) ? rng.pick(others) : null };
  }
  const element = p.length > 1 && p[p.length - 1] === 'id' && typeof p[p.length - 2] !== 'string';
  return p.length && !element ? { op: 'set', file, path: p, value: gen.scalar() } : null;
}

// ── semantics ────────────────────────────────────────────────────────

const sample = () => makeFiles({
  'course.json': formatJson({ id: 'c', title: 'Course', sections: [{ id: 's1', screens: ['a', 'b'] }, { id: 's2', screens: ['c'] }] }),
  'screens/a.json': formatJson({ id: 'a', title: 'A', blocks: [{ id: 'a1', type: 'text', props: { markdown: 'One' } }, { id: 'a2', type: 'text', props: {} }], layers: [{ id: 'a-layer', blocks: [] }] }),
  'screens/b.json': formatJson({ id: 'b', blocks: [{ id: 'b1', type: 'text', props: {} }], values: [1, 1, 2] }),
  'notes.md': 'Notes\n',
  'assets/logo.png': binaryFile(sha('logo'))
});

test('apply: JSON is written with 2-space indentation and a final newline, key order kept, new keys appended or placed', () => {
  const files = sample();
  const out = applyOps(files, [
    { op: 'set', file: 'screens/a.json', path: ['title'], value: 'A again' },
    { op: 'set', file: 'screens/a.json', path: ['zz'], value: 1 },
    { op: 'set', file: 'screens/a.json', path: ['hidden'], value: true, after: 'id' },
    { op: 'set', file: 'screens/a.json', path: ['$schema'], value: 's', after: null }
  ]);
  const value = doc(out, 'screens/a.json');
  assert.deepEqual(Object.keys(value), ['$schema', 'id', 'hidden', 'title', 'blocks', 'layers', 'zz']);
  assert.equal(text(out.get('screens/a.json')), `${JSON.stringify(value, null, 2)}\n`);
  assert.deepEqual(out.get('course.json'), files.get('course.json'), 'untouched content is preserved');
});

test('apply: keyed arrays are addressed by id, strings by value; other arrays are values', () => {
  const out = applyOps(sample(), [
    { op: 'insert', file: 'screens/a.json', path: ['blocks'], value: { id: 'a0', type: 'text', props: {} }, after: null },
    { op: 'move', file: 'screens/a.json', path: ['blocks', { id: 'a2' }], to: { file: 'screens/a.json', path: ['layers', { id: 'a-layer' }, 'blocks'] }, after: null },
    { op: 'move', file: 'course.json', path: ['sections', { id: 's1' }, 'screens', { id: 'b' }], to: { file: 'course.json', path: ['sections', { id: 's2' }, 'screens'] }, after: 'c' },
    { op: 'remove', file: 'course.json', path: ['sections', { id: 's1' }, 'screens', { id: 'a' }] },
    { op: 'set', file: 'screens/a.json', path: ['blocks', { id: 'a1' }, 'props', 'markdown'], value: 'Uno' },
    { op: 'set', file: 'screens/b.json', path: ['values'], value: [3] },
    { op: 'set', file: 'screens/a.json', path: ['blocks', { id: 'a1' }], value: { id: 'a1', type: 'heading', props: { text: 'Title' } } }
  ]);
  assert.deepEqual(doc(out, 'screens/a.json').blocks, [{ id: 'a0', type: 'text', props: {} }, { id: 'a1', type: 'heading', props: { text: 'Title' } }]);
  assert.deepEqual((doc(out, 'screens/a.json').layers as JsonObject[])[0].blocks, [{ id: 'a2', type: 'text', props: {} }]);
  assert.deepEqual((doc(out, 'course.json').sections as JsonObject[]).map((s) => s.screens), [[], ['c', 'b']]);
  assert.deepEqual(doc(out, 'screens/b.json').values, [3]);
});

test('apply: files are written, created and deleted; inputs are never mutated', () => {
  const files = sample();
  const snapshot = JSON.stringify([...files]);
  const out = applyOps(files, [
    { op: 'write', file: 'notes.md', text: 'New notes\n' },
    { op: 'write', file: 'screens/new.json', text: '{"id":"new"}' },
    { op: 'set', file: 'screens/new.json', path: ['title'], value: 'New' },
    { op: 'write', file: 'assets/logo.png', blob: sha('logo 2') },
    { op: 'delete', file: 'screens/b.json' },
    { op: 'set', file: 'screens/a.json', path: ['blocks', { id: 'a1' }, 'props', 'markdown'], value: 'changed' }
  ]);
  assert.equal(text(out.get('notes.md')), 'New notes\n');
  assert.equal(text(out.get('screens/new.json')), formatJson({ id: 'new', title: 'New' }));
  assert.deepEqual(out.get('assets/logo.png'), binaryFile(sha('logo 2')));
  assert.ok(!out.has('screens/b.json'));
  assert.equal(JSON.stringify([...files]), snapshot, 'the input files and their parsed values are unchanged');
});

test('apply: errors carry codes and leave the input untouched', () => {
  const files = sample();
  const snapshot = JSON.stringify([...files]);
  const code = (ops: Op[], expected: string) => assert.throws(() => applyOps(files, ops), (error: unknown) => error instanceof OpError && error.code === expected, `${expected}: ${JSON.stringify(ops)}`);
  code([{ op: 'set', file: 'screens/zz.json', path: ['title'], value: 1 }], 'E_OP_TARGET_MISSING');
  code([{ op: 'set', file: 'screens/a.json', path: ['nope', 'title'], value: 1 }], 'E_OP_TARGET_MISSING');
  code([{ op: 'unset', file: 'screens/a.json', path: ['nope'] }], 'E_OP_TARGET_MISSING');
  code([{ op: 'remove', file: 'screens/a.json', path: ['blocks', { id: 'zz' }] }], 'E_OP_TARGET_MISSING');
  code([{ op: 'insert', file: 'screens/a.json', path: ['blocks'], value: { id: 'n' }, after: 'zz' }], 'E_OP_TARGET_MISSING');
  code([{ op: 'set', file: 'screens/a.json', path: ['new'], value: 1, after: 'zz' }], 'E_OP_TARGET_MISSING');
  code([{ op: 'delete', file: 'nope.md' }], 'E_OP_TARGET_MISSING');
  code([{ op: 'insert', file: 'screens/a.json', path: ['blocks'], value: { id: 'a1' }, after: null }], 'E_OP_DUPLICATE');
  code([{ op: 'move', file: 'screens/a.json', path: ['blocks', { id: 'a1' }], to: { file: 'screens/b.json', path: ['blocks'] }, after: null }, { op: 'insert', file: 'screens/b.json', path: ['blocks'], value: { id: 'a1' }, after: null }], 'E_OP_DUPLICATE');
  code([{ op: 'remove', file: 'screens/b.json', path: ['values', { id: '1' }] }], 'E_OP_NOT_KEYED');
  code([{ op: 'insert', file: 'course.json', path: ['sections', { id: 's1' }, 'screens'], value: { id: 'x' }, after: null }], 'E_OP_NOT_KEYED');
  code([{ op: 'insert', file: 'screens/a.json', path: ['blocks'], value: 'a3', after: null }], 'E_OP_NOT_KEYED');
  code([{ op: 'set', file: 'notes.md', path: ['title'], value: 1 }], 'E_OP_NOT_JSON');
  code([{ op: 'set', file: 'assets/logo.png', path: [], value: 1 }], 'E_OP_NOT_JSON');
  code([{ op: 'unset', file: 'screens/a.json', path: ['blocks', { id: 'a1' }] }], 'E_OP_INVALID');
  code([{ op: 'remove', file: 'screens/a.json', path: ['title'] }], 'E_OP_INVALID');
  code([{ op: 'move', file: 'screens/a.json', path: ['blocks', { id: 'a1' }], to: { file: 'screens/a.json', path: ['blocks', { id: 'a1' }, 'blocks'] }, after: null }], 'E_OP_INVALID');
  code([{ op: 'set', file: 'screens/a.json', path: ['blocks', { id: 'a1' }], value: { id: 'other' } }], 'E_OP_INVALID');
  code([{ op: 'rename', file: 'notes.md' } as unknown as Op], 'E_OP_INVALID');
  code([{ op: 'set', file: '', path: [], value: 1 } as Op], 'E_OP_INVALID');
  const broken = makeFiles({ 'x.json': '{ nope' });
  assert.throws(() => applyOps(broken, [{ op: 'set', file: 'x.json', path: ['a'], value: 1 }]), (error: unknown) => error instanceof OpError && error.code === 'E_OP_NOT_JSON');
  assert.equal(JSON.stringify([...files]), snapshot);
});

for (const [name, change, moves] of [
  ['reordering siblings', (a: JsonObject) => (a.blocks as Json[]).reverse(), 1],
  ['moving into a layer and editing', (a: JsonObject) => {
    const moved = (a.blocks as JsonObject[]).pop()!;
    moved.props = { markdown: 'In the layer' };
    ((a.layers as JsonObject[])[0].blocks as Json[]).push(moved);
  }, 1]
] as const) test(`diff replays ${name} with the minimum moves`, () => {
  const before = sample();
  const a = clone(doc(before, 'screens/a.json'));
  change(a);
  const ops = roundTrip(before, new Map(before).set('screens/a.json', jsonFile(a)), name);
  assert.equal(ops.filter(op => op.op === 'move').length, moves);
});

for (const [name, before, after] of [
  ['new keys and duplicate values', { id: 'x', a: 1, b: [1, 1] }, { id: 'x', n: 0, a: 2, b: [1] }],
  ['an object replaced by an array', { a: { b: 1 }, c: 1 }, { a: [1], c: 1 }],
  ['the first keyed element', { list: [] }, { list: [{ id: 'q' }] }],
  ['key order around a large value', { id: 's', blocks: [{ id: 'b', text: 'x'.repeat(1000) }], layout: 'stage' }, { id: 's', layout: 'stage', blocks: [{ id: 'b', text: 'x'.repeat(1000) }] }]
] satisfies [string, Json, Json][]) test(`document diff preserves ${name}`, () => {
  const files = makeFiles({ 'f.json': formatJson(before) });
  const ops = diffDocuments(before, after, 'f.json');
  assertSameFiles(applyOps(files, ops), makeFiles({ 'f.json': formatJson(after) }), name);
  assertSameFiles(applyOps(applyOps(files, ops), invertOps(files, ops)), files, name);
});

test('formatting alone produces no change', () => {
  const compact = makeFiles({ 'f.json': '{"a":[1,2],"b":{"c":true}}' });
  assert.deepEqual(diffFiles(compact, makeFiles({ 'f.json': formatJson({ a: [1, 2], b: { c: true } }) })), []);
});

test('a malformed JSON edit is reproduced and can be undone', () => {
  roundTrip(makeFiles({ 'f.json': '{"a":1}' }), makeFiles({ 'f.json': '{"a": ' }), 'malformed JSON');
});

test('ids are permanent: an element keeps its id, and its id key stays in place when keys are reordered', () => {
  const files = sample();
  assert.throws(() => applyOps(files, [{ op: 'set', file: 'screens/a.json', path: ['blocks', { id: 'a1' }, 'id'], value: 'a9' }]), (error: unknown) => error instanceof OpError && error.code === 'E_OP_INVALID');
  assert.throws(() => applyOps(files, [{ op: 'unset', file: 'screens/a.json', path: ['blocks', { id: 'a1' }, 'id'] }]), (error: unknown) => error instanceof OpError && error.code === 'E_OP_INVALID');
  applyOps(files, [{ op: 'set', file: 'screens/a.json', path: ['blocks', { id: 'a1' }, 'id'], value: 'a1' }]);
  const big = 'x'.repeat(500);
  const before = { blocks: [{ id: 'b1', type: 'text', props: { markdown: big } }] };
  const after = { blocks: [{ type: 'text', props: { markdown: big }, id: 'b1' }] };
  roundTrip(new Map([['f.json', jsonFile(before)]]), new Map([['f.json', jsonFile(after)]]), 'id pinned');
});

test('diff: index-like keys and "__proto__" keys are handled like any other key', () => {
  const before = JSON.parse('{"id":"x","10":"ten","b":1,"__proto__":{"polluted":true},"2":"two"}') as JsonObject;
  const after = JSON.parse('{"id":"x","b":2,"1":"one","__proto__":{"polluted":false},"z":0}') as JsonObject;
  roundTrip(new Map([['f.json', jsonFile(before)]]), new Map([['f.json', jsonFile(after)]]), '__proto__');
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, 'no prototype was touched');
});

test('apply: a JSON file in another formatting is formatted when touched, kept as is otherwise', () => {
  const files = makeFiles({ 'a.json': '{ "a": [1, 2], "b": 1 }', 'b.json': '{ "x": [ 1 ] }' });
  const out = applyOps(files, [{ op: 'set', file: 'a.json', path: ['b'], value: 2 }]);
  assert.equal(text(out.get('a.json')), formatJson({ a: [1, 2], b: 2 }));
  assert.equal(text(out.get('b.json')), '{ "x": [ 1 ] }');
  // Its value comes back after the inverse; its text is now the formatted one.
  const back = applyOps(out, invertOps(files, [{ op: 'set', file: 'a.json', path: ['b'], value: 2 }]));
  assert.equal(text(back.get('a.json')), formatJson({ a: [1, 2], b: 1 }));
});

test('touchedFiles lists sources and destinations of moves', () => {
  assert.deepEqual(touchedFiles([
    { op: 'set', file: 'a.json', path: ['x'], value: 1 },
    { op: 'move', file: 'b.json', path: ['l', { id: 'i' }], to: { file: 'c.json', path: ['l'] }, after: null },
    { op: 'delete', file: 'a.json' }
  ]), ['a.json', 'b.json', 'c.json']);
});

// ── the example projects, with realistic edits ───────────────────────

const TEXT = /\.(json|md|css|html|js|mjs|svg|xlf|vtt|txt|csv|gitignore)$/i;

// The example as a snapshot, its JSON formatted the way Elabora writes it.
function loadExample(name: string): Map<string, FileContent> {
  const root = path.join(ROOT, 'examples', name);
  const files = new Map<string, FileContent>();
  const walk = (abs: string, rel: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (['dist', '.elabora', 'node_modules'].includes(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), child);
      else {
        const bytes = fs.readFileSync(path.join(abs, entry.name));
        if (!TEXT.test(entry.name)) files.set(child, binaryFile(`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, bytes.length));
        else {
          const file = textFile(child, bytes.toString('utf8'));
          files.set(child, file.json !== undefined ? jsonFile(file.json) : file);
        }
      }
    }
  };
  walk(root, '');
  return files;
}

interface Project { docs: Map<string, Json>; others: Map<string, FileContent> }
const projectOf = (files: Files): Project => {
  const docs = new Map<string, Json>();
  const others = new Map<string, FileContent>();
  for (const [file, content] of files) {
    if (content.kind === 'text' && content.json !== undefined) docs.set(file, clone(content.json));
    else others.set(file, content);
  }
  return { docs, others };
};
// Course-shaped edits supplement the arbitrary JSON properties without duplicating a command engine.
const courseEdits: Record<string, (docs: Map<string, Json>) => void> = {
  'edit props': docs => { (docs.get('screens/a.json') as JsonObject).title = 'Revised'; },
  'reorder blocks': docs => { ((docs.get('screens/a.json') as JsonObject).blocks as Json[]).reverse(); },
  'move between screens': docs => {
    const a = docs.get('screens/a.json') as JsonObject, b = docs.get('screens/b.json') as JsonObject;
    (b.blocks as Json[]).push((a.blocks as Json[]).shift()!);
  },
  'move into layer': docs => {
    const a = docs.get('screens/a.json') as JsonObject;
    ((a.layers as JsonObject[])[0].blocks as Json[]).push((a.blocks as Json[]).pop()!);
  },
  'add screen': docs => {
    docs.set('screens/new.json', { id: 'new', blocks: [] });
    ((docs.get('course.json') as JsonObject).sections as JsonObject[])[0].screens = ['a', 'b', 'new'];
  },
  'delete screen': docs => { docs.delete('screens/b.json'); },
  'add event': docs => { (docs.get('screens/a.json') as JsonObject).events = [{ id: 'enter', on: { type: 'screen.enter' }, do: [] }]; },
  'delete event': docs => { delete (docs.get('screens/a.json') as JsonObject).events; },
  'reorder screens': docs => { (((docs.get('course.json') as JsonObject).sections as JsonObject[])[0].screens as Json[]).reverse(); },
  'move screen to section': docs => {
    const sections = (docs.get('course.json') as JsonObject).sections as JsonObject[];
    (sections[1].screens as Json[]).push((sections[0].screens as Json[]).pop()!);
  }
};
for (const [name, edit] of Object.entries(courseEdits)) test(`course edit round-trips: ${name}`, () => {
  const before = new Map(sample()).set('screens/a.json', jsonFile({ ...doc(sample(), 'screens/a.json'), events: [{ id: 'old', on: { type: 'screen.enter' }, do: [] }] }));
  const project = projectOf(before);
  edit(project.docs);
  roundTrip(before, filesOf(project.docs, project.others), name);
});

for (const example of ['diagnostic-reseau', 'orbital-rendezvous', 'planetary-gearset']) {
  test(`examples/${example}: arbitrary edits round-trip without changing original files`, () => {
    const before = loadExample(example);
    for (let seed = 1; seed <= 60 * SEEDS; seed++) {
      const rng = random(seed * 7919);
      const project = projectOf(before);
      mutate(rng, generator(rng), project.docs, 1 + rng.int(4));
      roundTrip(before, filesOf(project.docs, project.others), `${example} seed ${seed}`);
    }
  });
}

test('examples: a block moved to another screen is one move; a screen added is a write and an insert', () => {
  const before = loadExample('planetary-gearset');
  const project = projectOf(before);
  const intro = project.docs.get('screens/intro.json') as JsonObject;
  const lab = project.docs.get('screens/lab.json') as JsonObject;
  const block = (intro.blocks as JsonObject[]).pop() as JsonObject;
  (lab.blocks as JsonObject[]).splice(1, 0, block);
  project.docs.set('screens/extra.json', { id: 'extra', title: 'Extra', covers: [], blocks: [] });
  (((project.docs.get('course.json') as JsonObject).sections as JsonObject[])[0].screens as Json[]).push('extra');
  const ops = roundTrip(before, filesOf(project.docs, project.others), 'planetary-gearset');
  assert.equal(ops.filter(op => op.op === 'move').length, 1);
  assert.ok(ops.some(op => op.op === 'write' && op.file === 'screens/extra.json'));
});

// ── undo ─────────────────────────────────────────────────────────────

function change(before: Files, after: Files): { id: string; ops: Op[]; inverse: Op[] } {
  const ops = diffFiles(before, after);
  return { id: sha(JSON.stringify(ops)), ops, inverse: invertOps(before, ops) };
}
const edit = (files: Files, file: string, fn: (value: JsonObject) => void): Files => {
  const value = clone(doc(files, file));
  fn(value);
  return new Map(files).set(file, jsonFile(value));
};

test('undo: without later edits, undoing changes newest first gives back the files exactly', () => {
  for (let seed = 1; seed <= 150 * SEEDS; seed++) {
    const rng = random(9000 + seed);
    const gen = generator(rng);
    const docs = new Map<string, Json>([['a.json', gen.object(4)], ['b.json', { id: 'b', blocks: gen.keyedObjects(3) }]]);
    const original = filesOf(docs);
    let files = original;
    const changes = [];
    for (let n = 1 + rng.int(4); n > 0; n--) {
      const next = new Map([...projectOf(files).docs]);
      mutate(rng, gen, next, 1 + rng.int(3));
      const after = filesOf(next);
      changes.unshift(change(files, after));
      files = after;
    }
    const result = undoChanges(files, changes);
    assert.deepEqual(result.skipped, [], `seed ${seed}`);
    assertSameFiles(result.files, original, `seed ${seed}`);
    assertSameFiles(applyOps(files, result.ops), original, `seed ${seed}: the ops give the same files`);
  }
});

test('undo: human edits made after the AI are kept, and what they touched is reported', () => {
  const start = sample();
  // AI work, two changes.
  const ai1 = edit(edit(start, 'screens/a.json', (a) => {
    a.title = 'AI title';
    (a.blocks as JsonObject[]).push({ id: 'a3', type: 'callout', props: { markdown: 'AI callout' } });
    (a.blocks as JsonObject[]).splice(1, 1);
  }), 'course.json', (c) => { c.title = 'AI course'; });
  const change1 = change(start, ai1);
  const ai2 = edit(ai1, 'screens/b.json', (b) => { (b.blocks as JsonObject[])[0].props = { markdown: 'AI text' }; b.title = 'B'; });
  const change2 = change(ai1, ai2);
  // The human then edits the AI's title and callout, and another key.
  const human = edit(edit(ai2, 'screens/a.json', (a) => {
    a.title = 'Human title';
    ((a.blocks as JsonObject[]).find((b) => b.id === 'a3') as JsonObject).props = { markdown: 'Human callout' };
  }), 'screens/b.json', (b) => { b.note = 'human note'; });

  const result = undoChanges(human, [change2, change1]);
  const a = doc(result.files, 'screens/a.json');
  const b = doc(result.files, 'screens/b.json');
  assert.equal(a.title, 'Human title', 'the human title stays');
  assert.deepEqual((a.blocks as JsonObject[]).map((x) => x.id), ['a1', 'a2', 'a3'], 'the removed block is back in its place; the callout the human edited stays');
  assert.equal(doc(result.files, 'course.json').title, 'Course', 'untouched AI work is undone');
  assert.deepEqual(b, { id: 'b', blocks: [{ id: 'b1', type: 'text', props: {} }], values: [1, 1, 2], note: 'human note' });
  assert.deepEqual(result.skipped.map((s) => [s.change, s.reason, s.op.op]), [[change1.id, 'changed', 'remove'], [change1.id, 'changed', 'set']]);
  assert.match(result.skipped[0].message, /^screens\/a\.json blocks\[a3\]: changed since$/);
  assert.match(result.skipped[1].message, /^screens\/a\.json title: changed since$/);
});

test('undo: moves, anchors, files and elements removed or re-added since', () => {
  const start = sample();
  // The AI moves a block to another screen; the human edits it there: it goes back, edited.
  const moved = edit(edit(start, 'screens/a.json', (a) => { (a.blocks as Json[]).shift(); }), 'screens/b.json', (b) => { (b.blocks as Json[]).push({ id: 'a1', type: 'text', props: { markdown: 'One' } }); });
  const move = change(start, moved);
  assert.equal(move.ops.length, 1);
  const touched = edit(moved, 'screens/b.json', (b) => { ((b.blocks as JsonObject[])[1].props as JsonObject).markdown = 'Human'; });
  let result = undoChanges(touched, [move]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(doc(result.files, 'screens/a.json').blocks, [{ id: 'a1', type: 'text', props: { markdown: 'Human' } }, { id: 'a2', type: 'text', props: {} }]);

  // The human deleted the moved block: nothing to move back.
  result = undoChanges(edit(moved, 'screens/b.json', (b) => { (b.blocks as Json[]).pop(); }), [move]);
  assert.deepEqual(result.skipped.map((s) => s.reason), ['missing']);

  // The AI removed a2; the human removed a1, a2's anchor: a2 comes back last.
  const removed = edit(start, 'screens/a.json', (a) => { (a.blocks as Json[]).pop(); });
  const remove = change(start, removed);
  const anchorGone = edit(edit(removed, 'screens/a.json', (a) => { (a.blocks as Json[]).shift(); }), 'screens/a.json', (a) => { (a.blocks as Json[]).push({ id: 'h1', type: 'text', props: {} }); });
  result = undoChanges(anchorGone, [remove]);
  assert.deepEqual((doc(result.files, 'screens/a.json').blocks as JsonObject[]).map((x) => x.id), ['h1', 'a2']);
  // The human re-added a block with the same id: the AI's removal stays undone.
  result = undoChanges(edit(removed, 'screens/a.json', (a) => { (a.blocks as Json[]).push({ id: 'a2', type: 'heading', props: {} }); }), [remove]);
  assert.deepEqual(result.skipped.map((s) => s.reason), ['changed']);

  // Files: the AI deleted a file and wrote another; the human recreated the first and edited the second.
  const filesChanged = new Map(start);
  filesChanged.delete('notes.md');
  filesChanged.set('assets/logo.png', binaryFile(sha('logo 2')));
  const fileChange = change(start, filesChanged);
  const humanFiles = new Map(filesChanged).set('notes.md', textFile('notes.md', 'Human notes\n'));
  result = undoChanges(humanFiles, [fileChange]);
  assert.equal(text(result.files.get('notes.md')), 'Human notes\n');
  assert.deepEqual(result.files.get('assets/logo.png'), binaryFile(sha('logo')));
  assert.deepEqual(result.skipped.map((s) => [s.reason, s.op.op]), [['changed', 'write']]);

  // A binary content that was not kept cannot come back: that operation is skipped.
  result = undoChanges(filesChanged, [fileChange], { canRestore: (hash) => hash !== sha('logo') });
  assert.deepEqual(result.skipped.map((s) => [s.reason, s.op.op, s.message]), [['unavailable', 'write', 'assets/logo.png: its previous content was not kept']]);
  // The same when the change recorded the content as unavailable (an external overwrite).
  result = undoChanges(filesChanged, [{ ...fileChange, unavailable: [sha('logo')] }]);
  assert.deepEqual(result.skipped.map((s) => [s.reason, s.op.op]), [['unavailable', 'write']]);
  assert.equal(text(result.files.get('notes.md')), 'Notes\n', 'the rest is undone');
});

test('undo: an undo is a change that can be undone in turn', () => {
  const start = sample();
  const ai = edit(start, 'screens/a.json', (a) => { a.title = 'AI'; (a.blocks as Json[]).reverse(); });
  const aiChange = change(start, ai);
  const undo = undoChanges(ai, [aiChange]);
  assertSameFiles(undo.files, start, 'undone');
  const undoChange = { id: 'u1', ops: undo.ops, inverse: invertOps(ai, undo.ops) };
  const redo = undoChanges(undo.files, [undoChange]);
  assert.deepEqual(redo.skipped, []);
  assertSameFiles(redo.files, ai, 'redone');
});

test('undo: a change whose inverse does not match its operations is refused', () => {
  assert.throws(() => undoChanges(sample(), [{ id: 'bad', ops: [{ op: 'delete', file: 'notes.md' }], inverse: [] }]), (error: unknown) => error instanceof OpError && error.code === 'E_OP_INVALID');
});

// ── batches ──────────────────────────────────────────────────────────

const agent: Author = { kind: 'agent', name: 'claude-code' };
const human: Author = { kind: 'human' };
const minutes = (n: number) => new Date(Date.UTC(2026, 9, 6, 10, 0) + n * 60_000).toISOString();

// Builds a journal the way the node journal does: seq, then the batch from the previous entry.
function journal(specs: ({ author: Author; at: number; files?: string[] } | { mark: string; at: number } | { undoes: string[]; at: number; author?: Author })[]): JournalEntry[] {
  const entries: JournalEntry[] = [];
  specs.forEach((spec, i) => {
    const head = { seq: i + 1, id: `e${i + 1}`, at: minutes(spec.at) };
    const previous = entries[entries.length - 1];
    if ('mark' in spec) entries.push({ type: 'mark', ...head, author: human, request: spec.mark });
    else if ('undoes' in spec) {
      const author = spec.author ?? human;
      entries.push({ type: 'undo', ...head, author, batch: assignBatch(previous, { ...head, author }), undoes: { changes: spec.undoes }, skipped: [], ops: [], inverse: [], files: [] } satisfies UndoEntry);
    } else {
      entries.push({ type: 'change', ...head, author: spec.author, batch: assignBatch(previous, { ...head, author: spec.author }), ops: [], inverse: [], files: (spec.files ?? []).map((p) => ({ path: p, before: null, after: null })) } satisfies ChangeEntry);
    }
  });
  return entries;
}

test('batches: AI changes less than 5 minutes apart share a batch; humans, marks and pauses close it', () => {
  const entries = journal([
    { author: agent, at: 0, files: ['a.json'] },
    { author: { kind: 'external' }, at: 4, files: ['b.json'] },  // an agent's own edit joins
    { author: agent, at: 8 },                                     // 4 minutes after the previous
    { author: human, at: 9 },
    { author: agent, at: 10 },                                    // after a human: new batch
    { author: agent, at: 16 },                                    // 6 minutes later: new batch
    { mark: 'Add a quiz', at: 17 },
    { author: agent, at: 18 },                                    // after a mark: new batch, labelled
    { author: { kind: 'system' }, at: 19 },
    { author: agent, at: 20 }
  ]);
  const batch = (seq: number) => (entries[seq - 1] as ChangeEntry).batch;
  assert.deepEqual([1, 2, 3].map(batch), ['e1', 'e1', 'e1']);
  assert.equal(batch(4), 'e4', 'a human change is its own batch');
  assert.equal(batch(5), 'e5');
  assert.equal(batch(6), 'e6');
  assert.equal(batch(8), 'e8');
  assert.equal(batch(9), 'e9');
  assert.equal(batch(10), 'e10', 'a system change closes the batch');
  assert.equal(assignBatch(entries[0], { id: 'x', at: new Date(Date.parse(minutes(0)) + BATCH_IDLE_MS).toISOString(), author: agent }), 'x', 'exactly 5 minutes: a new batch');
  const summaries = summarizeBatches(entries);
  assert.deepEqual(summaries.map((s) => [s.id, s.ai, s.label ?? null, s.changes.length]), [
    ['e1', true, null, 3], ['e4', false, null, 1], ['e5', true, null, 1], ['e6', true, null, 1], ['e8', true, 'Add a quiz', 1], ['e9', false, null, 1], ['e10', true, null, 1]
  ]);
  assert.deepEqual(summaries[0].files, ['a.json', 'b.json']);
  assert.deepEqual(summaries[0].authors, [agent, { kind: 'external' }]);
});

test('batches: a mark labels the next AI batch even after a human edit', () => {
  const summaries = summarizeBatches(journal([{ mark: 'Shorter intro', at: 0 }, { author: human, at: 1 }, { author: agent, at: 2 }]));
  assert.deepEqual(summaries.map((s) => s.label ?? null), [null, 'Shorter intro']);
});

test('batches: undone changes, undo of an undo, and what to undo next', () => {
  const entries = journal([
    { author: agent, at: 0 },
    { author: agent, at: 1 },
    { undoes: ['e1', 'e2'], at: 2 },         // undo the batch e1
    { author: agent, at: 3 },
    { undoes: ['e3'], at: 4 }                // undo the undo: e1 and e2 are back
  ]);
  assert.deepEqual([...undoneChanges(entries)].sort(), ['e3']);
  assert.deepEqual(changesToUndo(entries, { batch: 'e1' }).map((e) => e.id), ['e2', 'e1'], 'newest first');
  assert.deepEqual(changesToUndo(entries.slice(0, 3), { batch: 'e1' }), [], 'nothing left to undo once undone');
  assert.deepEqual(changesToUndo(entries, { change: 'e4' }).map((e) => e.id), ['e4']);
  assert.equal(lastAiBatch(entries)?.id, 'e4');
  assert.equal(lastAiBatch(entries.slice(0, 3)), undefined, 'the only AI batch is undone');
  assert.equal(summarizeBatches(entries.slice(0, 3))[0].undone, true);
});
