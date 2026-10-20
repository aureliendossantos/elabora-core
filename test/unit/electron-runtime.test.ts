import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findElectronRuntime } from '@elabora/node/emulator/electron';

test('an app runtime is discovered, obsolete registration is ignored, and external overrides it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runtime.json');
  assert.equal(findElectronRuntime({ file, env: {} }), null);
  fs.writeFileSync(file, JSON.stringify({ protocol: 1, executable: process.execPath }));
  assert.deepEqual(findElectronRuntime({ file, env: {} }), { executable: process.execPath });
  assert.equal(findElectronRuntime({ file, env: { ELABORA_BROWSER: 'external' } }), null);
  assert.deepEqual(findElectronRuntime({ file, env: { ELABORA_ELECTRON_EXECUTABLE: '/app/electron', ELABORA_ELECTRON_ENTRY: '/app/worker.js' } }), { executable: '/app/electron', entry: '/app/worker.js' });
  for (const value of [{ protocol: 2, executable: process.execPath }, { protocol: 1, executable: './relative' }, { protocol: 1, executable: path.join(dir, 'removed') }]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.equal(findElectronRuntime({ file, env: {} }), null);
  }
});
