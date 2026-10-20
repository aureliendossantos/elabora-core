import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createZip, readZip } from '@elabora/node/zip';
import { planZip, writeZip, ZipLimitError } from '@elabora/node/packaging/zip-writer';

const temporaryDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-zip-'));

// Text large enough to be read in several chunks, with some entropy so deflate has work to do.
function sampleText(lines: number): string {
  let out = '';
  for (let i = 0; i < lines; i++) out += `{"line":${i},"value":"${(i * 2654435761 % 4294967296).toString(36)}","text":"lorem ipsum dolor"}\n`;
  return out;
}

test('streaming ZIP: same bytes as createZip when both choose the same method', async () => {
  const dir = temporaryDir();
  const onDisk: Record<string, Buffer> = {
    'assets/data.json': Buffer.from(sampleText(60000)),           // ~4.5 MB of text: deflated, streamed in chunks
    'assets/noise.bin': crypto.randomBytes(300_000),               // deflate does not help: stored by both
    'assets/photo.png': crypto.randomBytes(5000),                  // stored by both
    'assets/empty.txt': Buffer.alloc(0),
    'assets/éléments.md': Buffer.from('# Éléments\n'.repeat(50))  // UTF-8 name flag
  };
  for (const [name, data] of Object.entries(onDisk)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'src', name)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', name), data);
  }
  // A font in memory is tried like any entry (createZip does): only media read from disk are stored untried.
  const inMemory: Record<string, Buffer> = { 'index.html': Buffer.from('<!doctype html><title>x</title>'.repeat(20)), 'imsmanifest.xml': Buffer.from('<manifest/>'), 'theme/fonts/a.woff2': Buffer.alloc(3000, 1) };
  const inputs = [
    ...Object.keys(onDisk).map((name) => ({ name, file: path.join(dir, 'src', name) })),
    ...Object.entries(inMemory).map(([name, data]) => ({ name, data }))
  ];
  const result = await writeZip(path.join(dir, 'out', 'package.zip'), inputs.reverse());
  const streamed = fs.readFileSync(result.path);
  const reference = createZip(new Map([...Object.entries(onDisk), ...Object.entries(inMemory)]));
  assert.ok(streamed.equals(reference.zip), 'byte-identical to createZip');
  assert.equal(result.size, streamed.length);
  assert.equal(result.entries.length, reference.entries);
  assert.equal(result.uncompressed, reference.uncompressed);
  assert.equal(result.sha256, crypto.createHash('sha256').update(streamed).digest('hex'));

  const back = readZip(streamed);
  for (const [name, data] of [...Object.entries(onDisk), ...Object.entries(inMemory)]) assert.ok(back.files.get(name)?.equals(data), name);
  assert.equal(back.meta.find((m: { name: string }) => m.name === 'assets/data.json')?.method, 8);
  assert.equal(back.meta.find((m: { name: string }) => m.name === 'theme/fonts/a.woff2')?.method, 8);
  if (spawnSync('unzip', ['-v']).status === 0) {
    const check = spawnSync('unzip', ['-t', result.path], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('streaming ZIP: media and fonts are stored, the plan gives the exact size first', async () => {
  const dir = temporaryDir();
  fs.writeFileSync(path.join(dir, 'clip.mp4'), Buffer.alloc(200_000));   // compressible, stored anyway
  fs.writeFileSync(path.join(dir, 'font.woff2'), Buffer.alloc(1000, 7));
  const plan = await planZip([{ name: 'assets/clip.mp4', file: path.join(dir, 'clip.mp4') }, { name: 'fonts/a.woff2', file: path.join(dir, 'font.woff2') }, { name: 'a.css', data: 'body{}'.repeat(100) }]);
  assert.deepEqual(plan.entries.map((e) => [e.name, e.method]), [['a.css', 8], ['assets/clip.mp4', 0], ['fonts/a.woff2', 0]]);
  const result = await writeZip(path.join(dir, 'p.zip'), plan);
  assert.equal(fs.statSync(result.path).size, plan.size);
  assert.equal(readZip(fs.readFileSync(result.path)).files.get('assets/clip.mp4')?.length, 200_000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('streaming ZIP: refuses 4 GB archives before reading, and files changed while writing', async () => {
  const dir = temporaryDir();
  // Sparse files: their size is known without writing or reading gigabytes.
  for (const name of ['a.mp4', 'b.mp4']) {
    fs.writeFileSync(path.join(dir, name), '');
    fs.truncateSync(path.join(dir, name), 2_300_000_000);
  }
  const started = Date.now();
  await assert.rejects(planZip([{ name: 'a.mp4', file: path.join(dir, 'a.mp4') }, { name: 'b.mp4', file: path.join(dir, 'b.mp4') }]), ZipLimitError);
  assert.ok(Date.now() - started < 2000, 'refused from the file sizes');
  await assert.rejects(planZip([{ name: 'x.txt', data: 'a' }, { name: 'x.txt', data: 'b' }]), /Two package entries/);
  await assert.rejects(planZip([{ name: '../x.txt', data: 'a' }]), /Unsafe/);

  fs.writeFileSync(path.join(dir, 'c.txt'), 'version one '.repeat(1000));
  const plan = await planZip([{ name: 'c.txt', file: path.join(dir, 'c.txt') }]);
  fs.writeFileSync(path.join(dir, 'c.txt'), 'version two '.repeat(1000));
  await assert.rejects(writeZip(path.join(dir, 'c.zip'), plan), /changed while the package was written/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('c.zip')), [], 'no partial package left');
  fs.rmSync(dir, { recursive: true, force: true });
});
