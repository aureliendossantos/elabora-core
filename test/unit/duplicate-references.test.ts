import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, copyExample, readJSON } from '../helpers.ts';
import * as edit from '@elabora/node/edit';
import { validateDir } from '@elabora/node/project-reader';

// Every screen of the examples that names something of its own duplicated: the copies add no error,
// and nothing in a copy still names a block, a layer or an event of its original (what the walk of
// references would miss).
const examples = fs.readdirSync(path.join(ROOT, 'examples')).filter((name) => fs.existsSync(path.join(ROOT, 'examples', name, 'course.json')));

for (const example of examples) {
  test(`${example}: each screen duplicated names its own blocks and layers`, () => {
    const dir = copyExample(path.join(ROOT, 'examples', example));
    const errors = (diagnostics: { severity: string; code: string; file?: string }[]) => diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.file ?? ''}`);
    const before = errors(validateDir(dir).diagnostics);
    // The screens that name something of their own: events, layers, actions in their blocks.
    const screens: string[] = readJSON(dir, 'course.json').sections.flatMap((section: { screens: string[] }) => section.screens)
      .filter((screen: string) => /"(events|layers|do)":/.test(fs.readFileSync(path.join(dir, 'screens', `${screen}.json`), 'utf8')));
    const left: string[] = [];
    for (const screen of screens) {
      const { screen: copy, renamed } = edit.duplicateScreen(dir, { id: screen });
      const strings = (value: unknown, at: string): void => {
        if (typeof value === 'string' && Object.hasOwn(renamed, value)) left.push(`${copy} ${at}: "${value}"`);
        else if (Array.isArray(value)) value.forEach((each, index) => strings(each, `${at}/${index}`));
        else if (value && typeof value === 'object') for (const [key, each] of Object.entries(value)) if (key !== 'id') strings(each, `${at}/${key}`);
      };
      strings(readJSON(dir, `screens/${copy}.json`), '');
    }
    assert.deepEqual(left, []);
    const after = errors(validateDir(dir).diagnostics).filter((each) => !before.includes(each));
    assert.deepEqual(after, []);
  });
}
