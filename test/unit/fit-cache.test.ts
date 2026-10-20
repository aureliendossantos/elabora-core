import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { fitKey, screenRenders } from '@elabora/node/fit-cache';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';

// The keys of fit's measures, screen by screen: what changed is measured again, nothing else.
const BROWSER = { engine: 'chromium', version: '154.0.1' };
function keys(dir: string, { code = '0.1.0+abc', browser = BROWSER, size = '1600x900', role = 'reference', mode = 'scroll', platform = 'darwin-arm64' } = {}): Map<string, string> {
  const rendered = screenRenders(loadProjectFromDir(dir));
  assert.ok(rendered);
  return new Map([...rendered.renders].map(([id, render]) => [id, fitKey({ render, code, browser, size, role, mode, platform })]));
}
const changed = (before: Map<string, string>, after: Map<string, string>) => [...before.keys()].filter((id) => before.get(id) !== after.get(id)).sort();

test('fit keys: a screen file, a component, the object code and an image change the screens they touch; the theme, every screen', () => {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const all = [...keys(dir).keys()].sort();
  let before = keys(dir);
  assert.deepEqual(changed(before, keys(dir)), [], 'the same course, the same keys');

  // One screen's file.
  const accueil = readJSON(dir, 'screens/accueil.json');
  accueil.title = `${accueil.title} (revu)`;
  writeJSON(dir, 'screens/accueil.json', accueil);
  // The outline of the bars shows every screen's title: a title is the one change every screen sees.
  assert.deepEqual(changed(before, keys(dir)), all);
  before = keys(dir);
  const block = accueil.blocks.find((candidate: { type: string }) => candidate.type === 'callout');
  block.props.markdown = `${block.props.markdown} Encore.`;
  writeJSON(dir, 'screens/accueil.json', accueil);
  assert.deepEqual(changed(before, keys(dir)), ['accueil']);

  // A component's stylesheet: every screen loads the course's component stylesheets.
  before = keys(dir);
  fs.appendFileSync(path.join(dir, 'components/network-path/component.css'), '\n.np-extra { color: red; }\n');
  assert.deepEqual(changed(before, keys(dir)), all);
  // A component's template: the screens that use it.
  before = keys(dir);
  const template = path.join(dir, 'components/network-path/template.html');
  fs.writeFileSync(template, fs.readFileSync(template, 'utf8').replace('class="network-path__caption"', 'class="network-path__caption network-path__caption--revu"'));
  assert.deepEqual(changed(before, keys(dir)), ['chemin']);

  // The code of a free object: the screen that places it.
  before = keys(dir);
  fs.appendFileSync(path.join(dir, 'objects/diagnostic-reseau/object.js'), '\n// revu\n');
  assert.deepEqual(changed(before, keys(dir)), ['simulation']);

  // The theme: every screen.
  before = keys(dir);
  const course = readJSON(dir, 'course.json');
  course.theme.tokens = { ...course.theme.tokens, 'color.primary': '#7a1f3d' };
  writeJSON(dir, 'course.json', course);
  assert.deepEqual(changed(before, keys(dir)), all);

  // An image a block shows: its screen.
  const fixture = copyExample();
  before = keys(fixture);
  fs.appendFileSync(path.join(fixture, 'assets/images/ticket-marc.svg'), '\n<!-- revu -->\n');
  assert.deepEqual(changed(before, keys(fixture)), ['accueil']);
});

test('fit keys: the code that measures (the player included), the browser, the system, the size, its role and the presentation are part of the key', () => {
  const dir = copyExample();
  const base = keys(dir);
  for (const other of [{ code: '0.1.0+def' }, { browser: { engine: 'chromium', version: '155.0.0' } }, { browser: { engine: 'electron', version: '154.0.1' } }, { platform: 'win32-x64' }, { size: '1280x720' }, { role: 'minimum' }, { mode: 'slides' }]) {
    const after = keys(dir, other);
    assert.ok([...base].every(([id, key]) => after.get(id) !== key), JSON.stringify(other));
  }
});
