import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const module = new URL('../../scripts/heavy-slots.ts', import.meta.url).href;

// A process that takes a slot, says so with the time it got it, holds it ms milliseconds, then ends
// (killed with SIGKILL when kill is set: it gives nothing back). given is the time it gave its slot
// back: a test of waiting compares a waiter's time with it, not a number of milliseconds waited,
// which leaves out how long the waiter took to start (a Node and a TypeScript script: over half a
// second on CI's macOS, 27 Nov 2026).
function holder(env: NodeJS.ProcessEnv, ms: number, kill = false) {
  const code = `const { acquire } = await import(${JSON.stringify(module)});
    const slot = await acquire('holder');
    console.log(JSON.stringify({ waited: slot.waited, env: slot.env, at: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, ${ms}));
    ${kill ? "process.kill(process.pid, 'SIGKILL');" : 'console.log(JSON.stringify({ given: Date.now() })); slot.release();'}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (data: Buffer) => { out += data.toString(); });
  const lines = () => out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const said = new Promise<{ waited: number; env: Record<string, string>; at: number }>((resolve) => {
    const look = () => { const first = out.includes('\n') && lines()[0]; if (first) { child.stdout.off('data', look); resolve(first as { waited: number; env: Record<string, string>; at: number }); } };
    child.stdout.on('data', look);
  });
  const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const given = ended.then(() => lines().find((line) => typeof line.given === 'number')?.given as number | undefined);
  return { said, ended, given };
}

const fresh = (slots: number): NodeJS.ProcessEnv => ({ ...process.env, ELABORA_HEAVY_SLOTS: String(slots), ELABORA_HEAVY_SLOTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-slots-test-')), ELABORA_HEAVY_SLOT: '', NODE_TEST_CONTEXT: undefined });

test('heavy slots: a process waits while every slot is taken, then takes the one given back', { timeout: 30_000 }, async () => {
  const env = fresh(1);
  const first = holder(env, 1500);
  assert.ok((await first.said).waited < 1000);
  const second = holder(env, 0);
  const { waited, at } = await second.said;
  const given = await first.given;
  assert.ok(given !== undefined && at >= given, `the second took the slot once the first gave it back (${at - given!} ms after, ${waited} ms waited)`);
  assert.ok(waited > 0, 'the second waited');
  await second.ended;
});

test('heavy slots: two slots run two at once', { timeout: 30_000 }, async () => {
  const env = fresh(2);
  const first = holder(env, 1500);
  await first.said;
  const second = holder(env, 0);
  assert.ok((await second.said).waited < 1000);
  await Promise.all([first.ended, second.ended]);
});

test('heavy slots: the slot of a process killed is taken back', { timeout: 30_000 }, async () => {
  const env = fresh(1);
  const killed = holder(env, 0, true);
  await killed.said;
  await killed.ended;
  assert.equal(fs.readdirSync(env.ELABORA_HEAVY_SLOTS_DIR!).filter((name) => name.startsWith('slot-')).length, 1, 'the dead process left its slot');
  const next = holder(env, 0);
  assert.ok((await next.said).waited < 2000);
  await next.ended;
});

test('heavy slots: a child of the holder takes its slot at once, a stranger waits', { timeout: 30_000 }, async () => {
  const env = fresh(1);
  const parent = holder(env, 2500);
  const handed = (await parent.said).env;
  const child = holder({ ...env, ...handed }, 0);
  assert.ok((await child.said).waited < 500, 'the child waits for nothing');
  await child.ended;
  assert.ok(fs.existsSync(path.join(env.ELABORA_HEAVY_SLOTS_DIR!, 'slot-0')), 'the child gives back nothing of its parent\'s');
  const stranger = holder(env, 0);
  const { at } = await stranger.said;
  const given = await parent.given;
  assert.ok(given !== undefined && at >= given, `a process the slot was not handed to waits for it to be given back (${at - given!} ms after)`);
  await stranger.ended;
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
