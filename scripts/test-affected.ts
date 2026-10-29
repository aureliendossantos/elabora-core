// pnpm run test:affected [-- --base <ref>] [--dry-run]: a session's checks before it reports. The
// typecheck and the unit suite, then the e2e and matrix files of what the change touches (against
// origin/main, committed or not), read in test/groups.ts: the changed test files, the files of the
// groups they touch, the smoke set; shared code widens them (scripts/affected.ts). It says what runs,
// what does not and why. The whole suite runs on main once per batch, not here.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedFiles, describe, mapProblems, select } from './affected.ts';
import { groups } from '../test/groups.ts';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1]! : 'origin/main';
const all = ['e2e', 'matrix'].flatMap((kind) => fs.readdirSync(path.join(root, 'test', kind)).filter((file) => file.endsWith('.test.ts')).map((file) => `${kind}/${file.slice(0, -'.test.ts'.length)}`));

const problems = mapProblems(groups, all);
if (problems.length) console.log(`test/groups.ts: ${problems.join('; ')}.`);
const selection = select(changedFiles(root, base), groups, all);
console.log(describe(selection, all));
if (args.includes('--dry-run')) process.exit(0);

const run = (label: string, command: string[]): boolean => {
  console.log(`\n── ${label}`);
  const started = Date.now();
  const status = spawnSync(command[0]!, command.slice(1), { cwd: root, stdio: 'inherit' }).status;
  console.log(`── ${label}: ${status === 0 ? 'ok' : 'FAIL'} in ${Math.round((Date.now() - started) / 1000)} s`);
  return status === 0;
};
const node = process.execPath;
const results = [
  run('typecheck', ['pnpm', 'run', 'typecheck']),
  run('unit tests', ['pnpm', 'test'])
];
if (selection.checks.length) results.push(run(`${selection.checks.length} e2e and matrix file(s)`, [node, '--test', '--test-global-setup=test/isolate.ts', '--import', './scripts/heavy-slots.ts', '--test-concurrency=2', ...selection.checks.map((check) => `test/${check}.test.ts`)]));
console.log(`\n${results.every(Boolean) ? 'The checks of this change pass' : 'A check failed'}${selection.widened ? '; shared code changed: the batch run on main covers the rest' : ''}.`);
process.exitCode = results.every(Boolean) ? 0 : 1;
