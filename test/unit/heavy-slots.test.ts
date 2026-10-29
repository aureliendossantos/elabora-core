import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const module = path.resolve(import.meta.dirname, '../../scripts/heavy-slots.ts');

// A process that takes a slot, says so, holds it ms milliseconds, then ends (killed with SIGKILL
// when kill is set: it gives nothing back).
function holder(env: NodeJS.ProcessEnv, ms: number, kill = false) {
  const code = `const { acquire } = await import(${JSON.stringify(module)});
    const slot = await acquire('holder');
    console.log(JSON.stringify({ waited: slot.waited, env: slot.env }));
    await new Promise((resolve) => setTimeout(resolve, ${ms}));
    ${kill ? "process.kill(process.pid, 'SIGKILL');" : 'slot.release();'}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const said = new Promise<{ waited: number; env: Record<string, string> }>((resolve) => child.stdout.once('data', (data: Buffer) => resolve(JSON.parse(data.toString()))));
  const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
  return { said, ended };
}

const fresh = (slots: number): NodeJS.ProcessEnv => ({ ...process.env, ELABORA_HEAVY_SLOTS: String(slots), ELABORA_HEAVY_SLOTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-slots-test-')), ELABORA_HEAVY_SLOT: '', NODE_TEST_CONTEXT: undefined });

test('heavy slots: a process waits while every slot is taken, then takes the one given back', async () => {
  const env = fresh(1);
  const first = holder(env, 1500);
  assert.ok((await first.said).waited < 1000);
  const second = holder(env, 0);
  const { waited } = await second.said;
  assert.ok(waited >= 1000, `the second waited for the first (${waited} ms)`);
  await Promise.all([first.ended, second.ended]);
});

test('heavy slots: two slots run two at once', async () => {
  const env = fresh(2);
  const first = holder(env, 1500);
  await first.said;
  const second = holder(env, 0);
  assert.ok((await second.said).waited < 1000);
  await Promise.all([first.ended, second.ended]);
});

test('heavy slots: the slot of a process killed is taken back', async () => {
  const env = fresh(1);
  const killed = holder(env, 0, true);
  await killed.said;
  await killed.ended;
  assert.equal(fs.readdirSync(env.ELABORA_HEAVY_SLOTS_DIR!).filter((name) => name.startsWith('slot-')).length, 1, 'the dead process left its slot');
  const next = holder(env, 0);
  assert.ok((await next.said).waited < 2000);
  await next.ended;
});

test('heavy slots: a child of the holder takes its slot at once, a stranger waits', async () => {
  const env = fresh(1);
  const parent = holder(env, 2500);
  const handed = (await parent.said).env;
  const child = holder({ ...env, ...handed }, 0);
  assert.ok((await child.said).waited < 500, 'the child waits for nothing');
  await child.ended;
  assert.ok(fs.existsSync(path.join(env.ELABORA_HEAVY_SLOTS_DIR!, 'slot-0')), 'the child gives back nothing of its parent\'s');
  const stranger = holder(env, 0);
  assert.ok((await stranger.said).waited >= 1000, 'a process the slot was not handed to waits');
  await Promise.all([parent.ended, stranger.ended]);
});

test('heavy slots: as node --import, a slot for the script\'s life; under node --test, one for each e2e file, none for the runner or a unit file', () => {
  const env = fresh(1);
  const script = `console.log(process.env.ELABORA_HEAVY_SLOT ? 'held' : 'none')`;
  const run = spawnSync(process.execPath, ['--import', module, '--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(run.stdout.trim(), 'held', run.stderr);
  assert.deepEqual(fs.readdirSync(env.ELABORA_HEAVY_SLOTS_DIR!).filter((name) => name.startsWith('slot-')), [], 'given back at exit');
  // Under node --test, each file in turn (one slot): the runner holding one would leave them none.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-slots-files-')), 'e2e');
  fs.mkdirSync(dir);
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(dir, `${name}.test.mjs`), `import { test } from 'node:test'; import assert from 'node:assert'; test('${name}', () => assert.ok(process.env.ELABORA_HEAVY_SLOT));`);
  const files = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--import', module, path.join(dir, 'a.test.mjs'), path.join(dir, 'b.test.mjs')], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(files.status, 0, files.stdout + files.stderr);
  // A unit file takes none.
  const unit = path.join(path.dirname(dir), 'unit.test.mjs');
  fs.writeFileSync(unit, `import { test } from 'node:test'; import assert from 'node:assert'; test('unit', () => assert.ok(!process.env.ELABORA_HEAVY_SLOT));`);
  const light = spawnSync(process.execPath, ['--test', '--import', module, unit], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(light.status, 0, light.stdout + light.stderr);
});
