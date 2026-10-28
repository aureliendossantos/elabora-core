import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '@elabora/node/build';
import { testPackage } from '@elabora/node/emulator/run';
import { fitDiagnostics, measureFit } from '@elabora/node/fit';
import { testObject } from '@elabora/node/objects/test';
import { listModuleTemplates } from '@elabora/node/module-templates';
import { withCourseLanguage } from '@elabora/node/translate';

// The module templates in a browser (slow; pnpm run test:matrix), as their authors checked them
// (docs/decisions/D68.md): every screen fits at 1600×900 and 1280×720, its text readable on the
// backdrop's pixels; the package passes the LMS emulator with axe-core, without overflow at phone
// width; the backdrop object passes its gates.

const copy = (source: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-template-'));
  fs.cpSync(source, dir, { recursive: true, filter: (file) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(file.slice(source.length)) });
  return dir;
};

for (const template of listModuleTemplates()) {
  test(`the ${template.id} template fits its screens and reads on its backdrop, in English and in French`, { timeout: 600000 }, async () => {
    const dir = copy(template.dir);
    for (const language of [undefined, 'fr']) {
      const fit = await withCourseLanguage(dir, { language }, (root) => measureFit(root));
      assert.ok(fit.ok, JSON.stringify(fit.diagnostics));
      assert.equal(fit.mode, 'slides');
      assert.deepEqual(fitDiagnostics(fit).map((d) => `${language ?? 'en'} ${d.code} ${d.message}`), []);
    }
  });

  test(`the ${template.id} template passes the LMS emulator with axe-core, without overflow at phone width`, { timeout: 600000 }, async () => {
    const dir = copy(template.dir);
    const b = await build(dir, { profiles: ['moodle'], emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-')) });
    assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error')));
    const r = await testPackage({ dir: b.dirPath, profiles: ['moodle'], modes: ['iframe'], accessibility: true, unloadVariants: false });
    assert.deepEqual(r.runs.filter((run) => !run.ok).map((run) => run.failures.map((failure) => `${failure.code}: ${failure.message}`)), []);
    assert.ok(r.accessibility);
    assert.equal(r.accessibility.violations, 0, JSON.stringify(r.accessibility.details));
    assert.deepEqual(r.accessibility.overflow, []);
  });

  test(`the ${template.id} template's backdrop object passes its gates`, { timeout: 600000 }, async () => {
    const dir = copy(template.dir);
    const object = fs.readdirSync(path.join(dir, 'objects'))[0];
    const r = await testObject(dir, object);
    assert.ok(r.ok, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'), null, 1));
  });
}
