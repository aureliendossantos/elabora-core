import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '@elabora/node/build';
import { validateDir } from '@elabora/node/project-reader';
import { testPackage } from '@elabora/node/emulator/run';
import { fitDiagnostics, measureFit } from '@elabora/node/fit';

// The starter blocks sample (slow; npm run test:matrix): a Rise-style scroll course that uses every
// starter block of D63 and each of its presentations, the opening layout in its four, steps that open
// once explored or answered, an optional block, a character, a pre-question and a scored check.
const SOURCE = path.resolve(import.meta.dirname, '../../examples/coffee-in-brief');
const copy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-cb-'));
  fs.cpSync(SOURCE, dir, { recursive: true, filter: (file) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(file.slice(SOURCE.length)) });
  return dir;
};

type Block = { type: string; props?: Record<string, unknown>; blocks?: Block[] };
const PRESENTATIONS: Record<string, string[]> = {
  statement: ['statement', 'ruled', 'quote', 'image'], divider: ['line', 'ornament', 'number', 'space'], image: ['centered', 'wide', 'band', 'beside', 'over'],
  gallery: ['grid', 'mosaic', 'carousel', 'compare'], accordion: ['accordion', 'tabs', 'cards', 'stack'], steps: ['carousel', 'timeline', 'scroll'],
  hotspots: ['popover', 'side', 'below', 'tour'], quiz: ['text', 'images', 'image'], 'fill-in': ['typed', 'menus', 'bank'], sort: ['pairs', 'categories', 'order'], reflection: ['text', 'scale']
};

test('the coffee-in-brief sample uses every starter block and presentation, validates and passes the emulator with axe-core, without overflow at phone width', { timeout: 400000 }, async () => {
  const dir = copy();
  // Not a release yet: its plan has no validated version (a person makes it, elabora plan version and
  // plan approve); the release checks come with it.
  const validation = validateDir(dir);
  assert.equal(validation.summary.errors, 0, JSON.stringify(validation.diagnostics.filter((d) => d.severity === 'error')));
  const used = new Set<string>();
  const openings = new Set<string>();
  const walk = (blocks: Block[]) => { for (const block of blocks) {
    const props = block.props || {};
    used.add(block.type);
    used.add(`${block.type}:${String(props.presentation ?? PRESENTATIONS[block.type]?.[0] ?? '')}`);
    if (block.type === 'steps' && props.presentation === 'scroll') used.add(`figure:${String(props.figure ?? 'replace')}`);
    if (block.type === 'columns') used.add(`columns:${String(props.count ?? 2)}`);
    if (block.type === 'text' && props.aside) used.add('text:aside');
    walk(block.blocks || []);
  } };
  for (const file of fs.readdirSync(path.join(dir, 'screens'))) {
    const screen = JSON.parse(fs.readFileSync(path.join(dir, 'screens', file), 'utf8'));
    walk(screen.blocks);
    if (screen.layout === 'opening') openings.add(String(screen.layoutProps?.presentation ?? 'title'));
  }
  for (const [type, presentations] of Object.entries(PRESENTATIONS)) for (const presentation of presentations) assert.ok(used.has(`${type}:${presentation}`), `no ${type} ${presentation} in the sample`);
  for (const other of ['figure:replace', 'figure:build', 'figure:focus', 'columns:2', 'columns:3', 'text:aside', 'speech', 'numeric', 'results']) assert.ok(used.has(other), `no ${other} in the sample`);
  assert.deepEqual([...openings].sort(), ['band', 'cover', 'split', 'title']);
  const b = await build(dir, { profiles: ['moodle'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')) });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error')));
  const r = await testPackage({ dir: b.dirPath, profiles: ['moodle'], modes: ['iframe'], accessibility: true, unloadVariants: false });
  assert.deepEqual(r.runs.filter((run) => !run.ok).map((run) => run.failures.map((failure) => `${failure.code}: ${failure.message}`)), []);
  assert.ok(r.accessibility);
  assert.equal(r.accessibility.violations, 0, JSON.stringify(r.accessibility.details));
  assert.deepEqual(r.accessibility.overflow, []);
});

test('the coffee-in-brief pages read well down their whole length, the contrast of text over pictures included', { timeout: 400000 }, async () => {
  const fit = await measureFit(copy());
  assert.ok(fit.ok, JSON.stringify(fit.diagnostics));
  assert.equal(fit.mode, 'scroll');
  assert.deepEqual(fitDiagnostics(fit).map((d) => `${d.code} ${d.message}`), []);
});
