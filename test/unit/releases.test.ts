import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../helpers.ts';

test('Sampo prepares the core release train and preserves the existing changelog', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sampo-'));
  // The disposable repository owns its branch; inherited CI/Git metadata names the parent PR.
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  const write = (file: string, value: unknown) => { const target = path.join(directory, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`); };
  try {
    const packages = ['format', 'player', 'fonts', 'core', 'node', 'engine', 'cli'];
    write('package.json', { name: 'elabora', private: true, version: '0.1.0', workspaces: packages.map(name => `packages/${name}`) });
    const lock: Record<string, unknown> = { '': { name: 'elabora', version: '0.1.0', workspaces: packages.map(name => `packages/${name}`) } };
    for (const name of packages) {
      const manifest = { name: `@elabora/${name}`, version: '0.1.0', ...(name === 'core' ? { dependencies: { '@elabora/format': '0.1.0' } } : {}) };
      write(`packages/${name}/package.json`, manifest); lock[`packages/${name}`] = manifest;
      lock[`node_modules/@elabora/${name}`] = { resolved: `packages/${name}`, link: true };
    }
    write('package-lock.json', { name: 'elabora', version: '0.1.0', lockfileVersion: 3, requires: true, packages: lock });
    fs.mkdirSync(path.join(directory, '.sampo/changesets'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, '.sampo/config.toml'), path.join(directory, '.sampo/config.toml'));
    fs.writeFileSync(path.join(directory, 'CHANGELOG.md'), '# Changelog\n\nRelease history.\n\n## 0.1.0\n- Existing history.\n');
    fs.writeFileSync(path.join(directory, '.sampo/changesets/fix.md'), '---\nnpm/@elabora/core: patch (Fixed)\n---\n\nPreserve the narration when importing.\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '--initial-branch=main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test'); git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/sampo/bin/sampo.js'), 'release'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const read = (file: string) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    assert.equal(read('package.json').version, '0.1.1');
    for (const name of packages) assert.equal(read(`packages/${name}/package.json`).version, '0.1.1');
    assert.equal(read('packages/core/package.json').dependencies['@elabora/format'], '0.1.1');
    const updated = read('package-lock.json');
    for (const name of packages) assert.equal(updated.packages[`packages/${name}`].version, '0.1.1');
    assert.ok(fs.readFileSync(path.join(directory, 'CHANGELOG.md'), 'utf8').includes('Existing history.'));
    assert.equal(fs.existsSync(path.join(directory, '.sampo/changesets/fix.md')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
