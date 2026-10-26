import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readZip } from '@elabora/node/zip';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData, compileScreen, createCompileContext } from '@elabora/core/compile/course-data';
import type { AudioProps } from '@elabora/player/course-data';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';
import { build } from '@elabora/node/build';
import { preview } from '@elabora/node/preview';

test('build is deterministic and produces a valid SCORM 1.2 package', async () => {
  const dir = copyExample();
  const out1 = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-b1-'));
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-b2-'));
  const a = await build(dir, { profiles: ['moodle'], out: out1 });
  const b = await build(dir, { profiles: ['moodle'], out: out2 });
  assert.ok(a.ok && b.ok && a.zipPath, JSON.stringify(a.diagnostics.filter((d) => d.severity === 'error')));
  assert.equal(a.report.package.sha256, b.report.package.sha256);
  const { files } = readZip(fs.readFileSync(a.zipPath));
  const text = (name: string) => { const file = files.get(name); assert.ok(file, name); return file.toString(); };
  const manifest = text('imsmanifest.xml');
  assert.match(manifest, /<schemaversion>1\.2<\/schemaversion>/);
  assert.match(manifest, /adlcp:scormtype="sco" href="index.html"/);
  assert.match(manifest, /<adlcp:masteryscore>70<\/adlcp:masteryscore>/);
  for (const f of ['index.html', 'elabora/player.js', 'elabora/course.js', 'objects/diagnostic-reseau/frame.html', 'elabora/vendor/three-r186.js']) assert.ok(files.has(f), f);
  for (const name of files.keys()) assert.match(name, /^[A-Za-z0-9._/-]+$/);
  // No dependence on unload, anywhere in the player.
  assert.ok(!/addEventListener\(["']unload|onunload|beforeunload/.test(text('elabora/player.js')));
  // The frame of a free object is sandboxed by the player and has no network.
  assert.match(text('objects/diagnostic-reseau/frame.html'), /connect-src 'none'/);
  try { execFileSync('xmllint', ['--noout', '-'], { input: manifest }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  // The proof dossier lists every plan item.
  const proof = fs.readFileSync(a.reportPath.replace('.report.json', '.proof.md'), 'utf8');
  for (const item of ['ITEM-1', 'ITEM-2', 'ITEM-3', 'ITEM-4', 'ITEM-5', 'ITEM-6']) assert.ok(proof.includes(item), item);
});

test('build stops on validation errors', async () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.covers = ['ITEM-99'];
  writeJSON(dir, 'screens/chemin.json', s);
  const r = await build(dir, { out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-b3-')) });
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.some((d) => d.code === 'E_PLAN_REFERENCE'));
});

test('a preview shows the course with the errors that only stop a delivery; when it cannot be built, its page says why until a change builds', { timeout: 60000 }, async () => {
  const dir = copyExample();
  // An image without alt (rule F3), a plan item that does not exist (A1), a file Docebo refuses (LMS-8).
  fs.writeFileSync(path.join(dir, 'assets/images/schema.php'), '<?php echo 1;');
  const s = readJSON(dir, 'screens/chemin.json');
  s.covers.push('ITEM-99');
  s.blocks.push({ id: 'chemin-sans-alt', type: 'image', props: { asset: 'images/ticket-marc.svg' } }, { id: 'chemin-php', type: 'image', props: { asset: 'images/schema.php', alt: 'Schéma' } });
  writeJSON(dir, 'screens/chemin.json', s);
  const errors = (r: { diagnostics: { severity: string; code: string }[] }) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code).sort();
  const options = { profiles: ['docebo'], emit: 'dir' as const, writeLock: false, media: 'link' as const };
  const shown = await build(dir, { ...options, out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-p1-')), preview: true });
  assert.ok(shown.ok && shown.dirPath && fs.existsSync(path.join(shown.dirPath, 'index.html')));
  assert.deepEqual(errors(shown), ['E_FORBIDDEN_EXTENSION', 'E_IMAGE_ALT_MISSING', 'E_PLAN_REFERENCE']);
  const delivered = await build(dir, { ...options, out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-p2-')) });
  assert.equal(delivered.ok, false);

  // An error of the course itself (a prop the schema does not know) stops the preview too: its
  // page lists that error alone, and the course comes back once it is fixed.
  s.blocks[0].props.level = 'huge';
  writeJSON(dir, 'screens/chemin.json', s);
  let rebuilt: () => void = () => {};
  const session = await preview(dir, { port: 0, onRebuild: () => rebuilt() });
  try {
    assert.equal(session.result.ok, false);
    const page = await (await fetch(session.urls.standalone)).text();
    assert.match(page, /An error is preventing this course from being shown/);
    assert.match(page, /Please ask your agent to fix this error/);
    assert.match(page, /Does not match the schema<\/strong> <code>screens\/chemin\.json<\/code>/);
    assert.doesNotMatch(page, /without text alternative/);
    assert.match(page, /\/preview-events\/preview/);
    const done = new Promise<void>((resolve) => { rebuilt = resolve; });
    delete s.blocks[0].props.level;
    writeJSON(dir, 'screens/chemin.json', s);
    await done;
    assert.match(await (await fetch(session.urls.standalone)).text(), /elabora\/course\.js/);
  } finally {
    await session.close();
  }
});

test('package rules of the target LMS are enforced', async () => {
  const dir = copyExample();
  fs.writeFileSync(path.join(dir, 'assets/images/schema.php'), '<?php echo 1;');
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push({ id: 'chemin-php', type: 'image', props: { asset: 'images/schema.php', alt: 'Schéma' } });
  writeJSON(dir, 'screens/chemin.json', s);
  const docebo = await build(dir, { profiles: ['docebo'], out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-b4-')) });
  assert.equal(docebo.ok, false);
  assert.ok(docebo.diagnostics.some((d) => d.code === 'E_FORBIDDEN_EXTENSION'));
  const moodle = await build(dir, { profiles: ['moodle'], out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-b5-')) });
  assert.ok(moodle.ok, 'Moodle documents no forbidden extension');
});

test('one screen compiles on its own, as the course data holds it', () => {
  for (const example of ['diagnostic-reseau', 'planetary-gearset', 'orbital-rendezvous', 'coffee-in-brief']) {
    const project = loadProjectFromDir(path.join(ROOT, 'examples', example));
    const { keys } = assignKeys(project, readLock(project), { dryRun: true });
    const data = compileCourseData(project, keys, { buildId: 'test' });
    const context = createCompileContext(project, keys);
    for (const screen of data.screens) {
      const compiled = compileScreen(project, screen.id, context);
      assert.deepEqual(compiled.screen, screen, screen.id);
      for (const [id, definition] of compiled.objects) assert.deepEqual(definition, data.objects[id], `${screen.id}: ${id}`);
    }
  }
  // An event whose action lacks a field its type requires is left out (the validator reports it).
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.events = [...(s.events || []), { id: 'chemin-broken', on: { type: 'screen.enter' }, do: [{ type: 'go-to' }] }];
  writeJSON(dir, 'screens/chemin.json', s);
  const project = loadProjectFromDir(dir);
  const { screen } = compileScreen(project, 'chemin', createCompileContext(project, assignKeys(project, readLock(project), { dryRun: true }).keys));
  assert.deepEqual(screen.events.map((event) => event.id), s.events.slice(0, -1).map((event: { id: string }) => event.id));
  // hide-layer needs no layer (the one open on top): its event is kept.
  s.events = [{ id: 'chemin-close', on: { type: 'screen.enter' }, do: [{ type: 'hide-layer' }] }];
  writeJSON(dir, 'screens/chemin.json', s);
  const closing = loadProjectFromDir(dir);
  const compiled = compileScreen(closing, 'chemin', createCompileContext(closing, assignKeys(closing, readLock(closing), { dryRun: true }).keys)).screen;
  assert.deepEqual(compiled.events.map((event) => event.do), [[{ type: 'hide-layer' }]]);
});

test('a decorative sound says so in the course data', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(
    { id: 'chemin-recit', type: 'audio', props: { asset: 'audio/recit.mp3', title: 'Le récit', transcript: 'Marc raconte.' } },
    { id: 'chemin-ambiance', type: 'audio', props: { asset: 'audio/ambiance.mp3', title: 'Ambiance', decorative: true } }
  );
  writeJSON(dir, 'screens/chemin.json', s);
  const project = loadProjectFromDir(dir);
  const { screen } = compileScreen(project, 'chemin', createCompileContext(project, assignKeys(project, readLock(project), { dryRun: true }).keys));
  const audio = screen.blocks.flatMap((block) => { const props = block.props as AudioProps; return block.type === 'audio' ? [[block.id, props.decorative, props.transcriptHtml]] : []; });
  assert.deepEqual(audio, [['chemin-recit', false, '<p>Marc raconte.</p>'], ['chemin-ambiance', true, '']]);
});

test('a package folder left in dist by an earlier build is written again with the ZIP', async () => {
  const dir = copyExample();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-dist-'));
  const first = await build(dir, { emit: 'both', out, writeLock: false });
  assert.ok(first.ok && first.dirPath);
  fs.writeFileSync(path.join(first.dirPath, 'index.html'), 'stale');
  const second = await build(dir, { emit: 'zip', out, writeLock: false });
  assert.ok(second.ok);
  assert.notEqual(fs.readFileSync(path.join(first.dirPath, 'index.html'), 'utf8'), 'stale');
});
