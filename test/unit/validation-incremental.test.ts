import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectFiles, SourceFile } from '@elabora/core/project/files';
import { loadProject } from '@elabora/core/project/load';
import { validateProject } from '@elabora/core/validate/index';
import { newErrors, revalidate, validationState, type ValidationState } from '@elabora/core/validate/incremental';
import { readProjectFiles } from '@elabora/node/project-reader';
import { runBench, sameFindings } from '../sync/bench.ts';
import { GEARSET, ROOT } from '../helpers.ts';

// A project's validation kept change by change (D86) finds what a whole validation of the same files
// finds: on every change the convergence bench places, and on edits of the examples that reach the
// rules across screens (an id of another screen, a block other screens name, a plan item, an asset,
// a validated text two screens show).
const DRAWS = Number(process.env.ELABORA_VALIDATION_DRAWS ?? 24);

test('the bench: after every change placed, the validation kept equals a whole validation', () => {
  const problems: string[] = [];
  let partial = 0;
  for (const [seed, solo] of [...Array.from({ length: DRAWS }, (_, i) => [2000 + i, false] as const), [7, true] as const, [8, true] as const]) {
    const report = runBench({ seed, solo, differential: true });
    problems.push(...report.problems.filter((problem) => problem.startsWith('after ')).map((problem) => `seed ${seed}: ${problem}`));
    partial += report.stats['validated in part'] ?? 0;
  }
  assert.deepEqual(problems, []);
  assert.ok(partial > DRAWS * 10, `${partial} changes validated in part`);
});

type Json = Record<string, any>;
const text = (value: unknown): SourceFile => ({ kind: 'text', text: `${JSON.stringify(value, null, 2)}\n` });

// Edits of a course, one after the other, each compared.
function walk(dir: string, label: string, edits: (files: Map<string, SourceFile>, json: (rel: string) => Json, screens: string[]) => Iterable<string>): ValidationState {
  const files = new Map(readProjectFiles(dir).files as ProjectFiles);
  let state: ValidationState = validationState(new Map(files));
  const json = (rel: string): Json => JSON.parse((files.get(rel) as { text: string }).text);
  const screens = [...files.keys()].filter((rel) => /^screens\/[^/]+\.json$/.test(rel)).sort();
  for (const step of edits(files, json, screens)) {
    const next = new Map(files);
    state = revalidate(state, next);
    const difference = sameFindings(state, validateProject(loadProject(next)).diagnostics);
    assert.equal(difference, null, `${label}, ${step}`);
  }
  return state;
}

function* acrossScreens(files: Map<string, SourceFile>, json: (rel: string) => Json, screens: string[]): Iterable<string> {
  const blocksOf = (rel: string): Json[] => json(rel).blocks ?? [];
  for (const [n, rel] of screens.slice(0, 4).entries()) {
    const other = screens[(n + 1) % screens.length]!;
    const screen = json(rel);
    screen.title = `${screen.title} (edited)`;
    files.set(rel, text(screen));
    yield `${rel}: its title`;
    const borrowed = blocksOf(other)[0];
    if (borrowed) {
      files.set(rel, text({ ...json(rel), blocks: [...blocksOf(rel), { id: borrowed.id, type: 'text', props: { markdown: 'Same id as a block of another screen.' } }] }));
      yield `${rel}: a block with the id of one of ${other}`;
      files.set(rel, text({ ...json(rel), blocks: blocksOf(rel).slice(0, -1) }));
      yield `${rel}: that block removed`;
    }
    const first = blocksOf(rel)[0];
    if (first) {
      files.set(rel, text({ ...json(rel), blocks: blocksOf(rel).slice(1) }));
      yield `${rel}: its first block removed (${first.id}, perhaps named by other screens)`;
    }
    files.set(rel, text({ ...json(rel), covers: ['ITEM-404'] }));
    yield `${rel}: covers a plan item that does not exist`;
  }
  // A screen file no section lists, then one that does not parse, then gone.
  files.set('screens/zz-extra.json', text({ id: 'zz-extra', title: 'Extra', covers: [], blocks: [{ id: 'zz-extra-text', type: 'text', props: { markdown: 'Unlisted.' } }] }));
  yield 'a screen file no section lists';
  files.set('screens/zz-extra.json', { kind: 'text', text: '{ "id": "zz-extra", ' });
  yield 'a screen file that does not parse';
  files.delete('screens/zz-extra.json');
  yield 'the screen file deleted';
  // An asset a screen shows, removed then put back.
  const asset = [...files.keys()].find((rel) => rel.startsWith('assets/images/') && screens.some((s) => (files.get(s) as { text?: string }).text?.includes(rel.slice('assets/'.length))));
  if (asset) {
    const kept = files.get(asset)!;
    files.delete(asset);
    yield `${asset} removed`;
    files.set(asset, kept);
    yield `${asset} back`;
  }
  // A file no check reads, and course.json.
  files.set('translations/xx.xlf', { kind: 'text', text: '<xliff' });
  yield 'a translation file that does not read';
  const course = json('course.json');
  course.title = `${course.title} (edited)`;
  files.set('course.json', text(course));
  yield 'course.json';
  // A screen deleted from its file only (still listed).
  files.delete(screens[screens.length - 1]!);
  yield `${screens[screens.length - 1]} deleted`;
}

test('the examples: edits that reach other screens, the plan, an asset, course.json', () => {
  const examples = fs.readdirSync(path.join(ROOT, 'examples')).map((name) => path.join(ROOT, 'examples', name));
  for (const dir of [...examples, GEARSET]) walk(dir, path.basename(dir), acrossScreens);
});

test('a validated text whose maths fail, shown on two screens, is one error; a change elsewhere keeps it one', () => {
  const last = walk(path.join(ROOT, 'examples/canal-locks'), 'canal-locks', function* (files, json) {
    const plan = json('plan.json');
    const item = plan.items.find((candidate: Json) => candidate.lockedTexts?.some((locked: Json) => locked.id === 'TXT-1'));
    item.lockedTexts.find((locked: Json) => locked.id === 'TXT-1').text = 'The level is $\\frac{1}{$ of the chamber.';
    files.set('plan.json', text(plan));
    yield 'TXT-1 with maths that fail';
    const lab = json('screens/lock-lab.json');
    lab.blocks.push({ id: 'lock-lab-quote', type: 'text', props: { textRef: 'TXT-1' } });
    files.set('screens/lock-lab.json', text(lab));
    yield 'TXT-1 shown on a second screen';
    const inside = json('screens/inside-the-lock.json');
    inside.title = 'Inside the lock, again';
    files.set('screens/inside-the-lock.json', text(inside));
    yield 'a third screen changed';
    const intro = json('screens/intro.json');
    intro.title = 'The canal, again';
    files.set('screens/intro.json', text(intro));
    yield 'the first screen that shows it changed';
  });
  const maths = last.diagnostics.filter((d) => d.code === 'E_MATH_PARSE' && d.file === 'plan.json');
  assert.equal(maths.length, 1, JSON.stringify(maths));
  assert.equal(last.ran.full, false);
});

test('a room\'s rule: the errors a change adds, counted by code, file and path', () => {
  const files = new Map(readProjectFiles(path.join(ROOT, 'examples/canal-locks')).files as ProjectFiles);
  const before = validationState(files);
  const intro = JSON.parse((files.get('screens/intro.json') as { text: string }).text);
  const lab = JSON.parse((files.get('screens/lock-lab.json') as { text: string }).text);
  lab.blocks.push({ id: intro.blocks[0].id, type: 'text', props: { markdown: 'Same id.' } });
  const after = revalidate(before, new Map(files).set('screens/lock-lab.json', text(lab)));
  assert.equal(after.ran.full, false);
  assert.ok(after.ran.screens >= 2 && after.ran.screens < after.project.screens.size, `${after.ran.screens} screens checked again`);
  assert.ok(newErrors(before, after).some((key) => key.startsWith('E_DUPLICATE_ID|')), newErrors(before, after).join(', '));
  assert.deepEqual(newErrors(after, revalidate(after, files)), []);
  // The same files: the same value.
  assert.equal(revalidate(after, after.files), after);
});
