import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const pkg = read('package.json');
// The workspace's packages: packages/* (pnpm-workspace.yaml).
const manifests = ['package.json', ...fs.readdirSync(path.join(root, 'packages')).map((name) => `packages/${name}/package.json`).filter((file) => fs.existsSync(path.join(root, file)))];
const command = process.argv[2] ?? 'check';
const run = (name: string, args: string[]) => execFileSync(name, args, { cwd: root, stdio: 'inherit' });
const escaped = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const versionHeading = new RegExp(`^## ${escaped}(?:\\s|$)`, 'm');
const changesetsDir = path.join(root, '.sampo/changesets');
const pending = () => fs.readdirSync(changesetsDir).filter(file => file.endsWith('.md'));
try {
  for (const file of manifests) if (read(file).version !== pkg.version) throw new Error(`${file}: the core packages must share version ${pkg.version}`);
  // A release has one tag, v<version> (D56): a package published on its own would need tags of its own.
  for (const file of manifests) if (read(file).private !== true) throw new Error(`${file}: the core packages are private; publishing one needs its own tags and a decision (D56)`);
  if (command === 'check' || command === 'publish') {
    // The packages depend on each other as workspace:*, so the lockfile records no version of theirs:
    // it only has to agree with the manifests, as pnpm checks it (no install).
    const frozen = spawnSync('pnpm', ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (frozen.error) throw frozen.error;
    if (frozen.status !== 0) throw new Error('pnpm-lock.yaml does not agree with the manifests: run pnpm install');
    // A changeset that names only a package puts its text in that package's changelog, and the
    // root changelog (the GitHub Release) says « Bumped due to fixed dependency group policy ».
    for (const file of pending()) {
      const head = fs.readFileSync(path.join(changesetsDir, file), 'utf8').split(/^---$/m)[1] ?? '';
      if (!/^npm\/elabora:/m.test(head)) throw new Error(`.sampo/changesets/${file}: target npm/elabora too, so that the root changelog describes the change`);
    }
    if (process.argv.includes('--required') || command === 'publish') {
      if (!versionHeading.test(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'))) throw new Error('Run Sampo to prepare the versioned changelog first.');
      if (pending().length) throw new Error('Pending changesets must be consumed before publishing.');
    }
    console.log(`Core ${pkg.version}: versions and lockfile agree.`);
  }
  if (command === 'prepare') {
    // Sampo releases only on its release branches, and takes no wildcard: a release is prepared on
    // release/core-<version> (or a detached checkout) for main.
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/sampo/bin/sampo.js'), 'release'], { cwd: root, stdio: 'inherit', env: { ...process.env, SAMPO_RELEASE_BRANCH: 'main' } });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 2) throw new Error(`Sampo release failed (${result.status})`);
  }
  else if (command === 'publish') {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    // One tag per release: the packages share their version and none is published on its own (all are private).
    const tag = `v${pkg.version}`;
    const existing = execFileSync('git', ['tag', '--list', tag], { cwd: root, encoding: 'utf8' }).trim();
    if (existing) {
      const target = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
      if (target !== revision) throw new Error(`Refusing to move existing tag ${tag}`);
    } else run('git', ['tag', '-a', tag, '-m', `Elabora core ${pkg.version}`, revision]);
    run('git', ['push', 'origin', `refs/tags/${tag}`]);
    // GitHub releases only. Publishing packages to npm is a separate, explicit decision.
    const markdown = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const section = markdown.slice(markdown.search(versionHeading)).split(/\n(?=## )/)[0]!;
    const notes = path.resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'elabora-release-notes.md'], { cwd: root, encoding: 'utf8' }).trim());
    fs.writeFileSync(notes, section);
    const repository = process.env.GITHUB_REPOSITORY ?? 'aureliendossantos/elabora-core';
    const found = execFileSync('gh', ['release', 'list', '--repo', repository, '--limit', '100', '--json', 'tagName'], { cwd: root, encoding: 'utf8' });
    if (!JSON.parse(found).some((release: { tagName: string }) => release.tagName === tag)) run('gh', ['release', 'create', tag, '--repo', repository, '--title', `Elabora core ${pkg.version}`, '--notes-file', notes, ...(pkg.version.includes('-') ? ['--prerelease', '--latest=false'] : ['--latest'])]);
  } else if (command !== 'check') throw new Error('Use release.ts prepare|check|publish');
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
