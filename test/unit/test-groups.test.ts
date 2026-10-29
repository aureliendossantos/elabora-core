import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { mapProblems, select } from '../../scripts/affected.ts';
import { groups } from '../groups.ts';

const root = path.resolve(import.meta.dirname, '../..');
const all = ['e2e', 'matrix'].flatMap((kind) => fs.readdirSync(path.join(root, 'test', kind)).filter((file) => file.endsWith('.test.ts')).map((file) => `${kind}/${file.slice(0, -'.test.ts'.length)}`));

test('test:affected\'s map: every e2e and matrix file in a group, every name it gives a file', () => {
  assert.deepEqual(mapProblems(groups, all), []);
});

test('test:affected: a group\'s file runs its checks and the smoke set; a changed test runs; documents run nothing; shared or unknown code widens', () => {
  const charts = select(['packages/player/src/charts/bars.ts'], groups);
  assert.deepEqual(charts.checks, ['e2e/charts', 'e2e/lms', 'e2e/player']);
  assert.equal(charts.widened, false);
  assert.deepEqual(select(['test/e2e/fonts.test.ts'], groups).checks, ['e2e/fonts', 'e2e/lms', 'e2e/player']);
  assert.deepEqual(select(['docs/decisions.md', 'test/unit/edit.test.ts'], groups).checks, []);
  const shared = select(['packages/player/src/player.ts'], groups);
  assert.ok(shared.widened && shared.checks.includes('matrix/lms-matrix'));
  const unknown = select(['somewhere/new.ts'], groups);
  assert.deepEqual(unknown.unknown, ['somewhere/new.ts']);
  assert.ok(unknown.widened && unknown.checks.length === new Set(groups.wideChecks).size);
});
