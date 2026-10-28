import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectTestStep } from '@elabora/format';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drawnBeforeSnapshots, pruneSnapshots } from '@elabora/node/objects/test';

test('a dry run of an object test draws the last step that runs frames before each snapshot', () => {
  const steps = (...actions: ObjectTestStep['action'][]) => actions.map((action) => ({ action }));
  // Keys and expectations run no frame: the step before them is drawn.
  assert.deepEqual([...drawnBeforeSnapshots(steps('step', 'key', 'step', 'key', 'expect-state', 'snapshot', 'step', 'expect-event'))], [2]);
  // A click, set-props… run one frame; consecutive snapshots need nothing more.
  assert.deepEqual([...drawnBeforeSnapshots(steps('step', 'click', 'snapshot', 'snapshot', 'set-view', 'snapshot'))], [1, 4]);
  // A snapshot right after the mount, or after only keys: the mount's frame is drawn already.
  assert.deepEqual([...drawnBeforeSnapshots(steps('snapshot', 'key', 'snapshot', 'step'))], []);
  assert.deepEqual([...drawnBeforeSnapshots(steps('step', 'expect-state'))], []);
});

test('--update-snapshots removes the baselines of states no test names, for every engine, and lists those kept for other engines and systems', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-snapshots-'));
  const files = [
    'scroll--drawn-darwin.png', 'scroll--drawn-electron-darwin.png', 'scroll--drawn-win32.png', 'scroll--drawn-electron-win32.png',
    'scroll--drawn-again-darwin.png', // a test state whose name starts like another's: its own
    'old-test--gone-darwin.png', 'old-test--gone-electron-darwin.png', 'scroll--renamed-firefox-linux.png',
    'legacy--start.png', 'notes.txt',
    'flash--electron-darwin.png' // Chromium's baseline of a state named "electron"
  ];
  for (const name of files) fs.writeFileSync(path.join(dir, name), '');
  const result = pruneSnapshots(dir, ['scroll--drawn', 'legacy--start', 'flash--electron'], 'electron');
  assert.deepEqual(result.removed, ['old-test--gone-darwin.png', 'old-test--gone-electron-darwin.png', 'scroll--drawn-again-darwin.png', 'scroll--renamed-firefox-linux.png']);
  const own = process.platform === 'darwin' ? 'scroll--drawn-electron-darwin.png' : process.platform === 'win32' ? 'scroll--drawn-electron-win32.png' : null;
  assert.deepEqual(result.kept, ['flash--electron-darwin.png', 'legacy--start.png', 'scroll--drawn-darwin.png', 'scroll--drawn-electron-darwin.png', 'scroll--drawn-electron-win32.png', 'scroll--drawn-win32.png'].filter((name) => name !== own));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['flash--electron-darwin.png', 'legacy--start.png', 'notes.txt', 'scroll--drawn-darwin.png', 'scroll--drawn-electron-darwin.png', 'scroll--drawn-electron-win32.png', 'scroll--drawn-win32.png']);
});

test('object map: the sections of the code with their lines and functions, the manifest and the tests in a few lines', async () => {
  const { objectMap, objectMapText, mapCode } = await import('@elabora/node/objects/map');
  const code = mapCode('object.js', '// A demo object.\n// Two lines.\nexport function mount(container, ctx) {\n  // ── State ──\n  const ease = (x) => x;\n  function step() {}\n  // ── Start ──\n  return {};\n}\n');
  assert.equal(code.about, 'A demo object. Two lines.');
  assert.deepEqual(code.sections.map((section) => [section.title, section.from, section.to, section.functions.map((fn) => `${fn.name} ${fn.line}`)]), [
    ['(top)', 1, 3, ['mount 3']], ['State', 4, 6, ['ease 5', 'step 6']], ['Start', 7, 10, []]
  ]);
  const map = objectMap(path.join(import.meta.dirname, '../../examples/planetary-gearset'), 'planetary-lab');
  assert.ok(!('error' in map), JSON.stringify(map));
  assert.equal(map.files[0].file, 'object.js');
  assert.ok(map.props.length > 2 && map.tests.length > 0 && map.events.length > 0, JSON.stringify(map));
  const text = objectMapText(map);
  assert.ok(text.length < 6000 && /^props: /m.test(text) && /^tests \(\d+\): /m.test(text), text);
  const missing = objectMap(path.join(import.meta.dirname, '../../examples/planetary-gearset'), 'nowhere');
  assert.ok('error' in missing && /Objects: planetary-lab/.test(missing.error));
});
