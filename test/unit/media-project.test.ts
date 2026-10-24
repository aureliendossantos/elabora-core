import { test, before, after } from 'node:test';
import { resources } from '../resources.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Block } from '@elabora/format';
import { commandContext } from '@elabora/core/commands/index';
import { replaceMediaReferences } from '@elabora/core/commands/media';
import { estimateBytes, fileMedia } from '@elabora/core/media/conformance';
import type { MediaInfo } from '@elabora/core/media/conformance';
import { readProjectFiles, validateDir } from '@elabora/node/project-reader';
import { build } from '@elabora/node/build';
import { readZip } from '@elabora/node/zip';
import { serveFile } from '@elabora/node/http/files';
import { findMediaTools } from '@elabora/node/media/tools';
import { probeMedia } from '@elabora/node/media/probe';
import { MediaQueue } from '@elabora/node/media/jobs';
import { optimizeMedia } from '@elabora/node/media/optimize';
import { listVersions, readVersion } from '@elabora/node/backups/index';
import { updateCourseSettings } from '@elabora/node/edit';
import { projectDataDir } from '@elabora/node/data-dir';
import { copyExample, readJSON, writeJSON, ROOT } from '../helpers.ts';

const run = promisify(execFile);
const tools = await findMediaTools().catch(() => null);
const NO_FFMPEG = 'ffmpeg and ffprobe not found';
let fixtures = '';

// A phone-like .mov (H.264, AAC, GPS position), a 2 s MP4 master, an MP3 and a PNG.
before(async () => {
  if (!tools) return;
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-media-project-fixtures-'));
  const ffmpeg = (...args: string[]) => run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const h264 = tools.h264[0] === 'libx264' ? ['-c:v', 'libx264', '-preset', 'veryfast'] : ['-c:v', tools.h264[0]];
  const av = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-shortest', ...h264, '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
  await Promise.all([
    ffmpeg(...av, '-metadata', 'location=+48.8584+002.2945/', '-f', 'mov', path.join(fixtures, 'phone.mov')),
    ffmpeg(...av, '-movflags', '+faststart', '-f', 'mp4', path.join(fixtures, 'master.mp4')),
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1', path.join(fixtures, 'figure.png')),
    ...(tools.encoders.has('libmp3lame') ? [ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(fixtures, 'voice.mp3'))] : [])
  ]);
});
after(() => { if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true }); });

const fixture = (name: string) => path.join(fixtures, name);
const longAgo = new Date(Date.now() - 60_000);
// Copies a fixture into the project, dated a minute ago (files written in the last two seconds are
// not cached: their time may not tell a later change).
function place(dir: string, name: string, rel: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.copyFileSync(fixture(name), path.join(dir, rel));
  fs.utimesSync(path.join(dir, rel), longAgo, longAgo);
}
function addBlocks(dir: string, ...blocks: Block[]): void {
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push(...blocks);
  writeJSON(dir, 'screens/accueil.json', screen);
}
const removeProject = (dir: string) => { fs.rmSync(projectDataDir(dir), { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); };
const findings = (dir: string) => validateDir(dir).diagnostics;

test('snapshot and validation: media verdicts, GPS as privacy, unreadable files, jobs under way, no ffprobe', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = resources(t).own(copyExample(), removeProject);
  place(dir, 'phone.mov', 'assets/video/phone.mov');
  place(dir, 'master.mp4', 'assets/video/master.mp4');
  fs.writeFileSync(path.join(dir, 'assets/video/broken.mp4'), 'not a video');
  fs.utimesSync(path.join(dir, 'assets/video/broken.mp4'), longAgo, longAgo);
  addBlocks(dir, { id: 'coming', type: 'video', props: { asset: 'video/coming.mp4', captions: 'video/coming.vtt', title: 'Coming', transcript: 'Soon.' } } as Block);
  fs.writeFileSync(path.join(dir, 'assets/video/coming.vtt'), 'WEBVTT\n');

  const { files, media } = readProjectFiles(dir);
  const phone = files.get('assets/video/phone.mov');
  assert.ok(phone?.kind === 'binary' && phone.media);
  assert.deepEqual([phone.media.conformant, phone.media.reasons.map((r) => r.code)], [false, ['container', 'location']]);
  const master = files.get('assets/video/master.mp4');
  assert.ok(master?.kind === 'binary' && master.media?.conformant);
  assert.deepEqual(media.unreadable.map((u) => u.path), ['assets/video/broken.mp4']);

  let diagnostics = findings(dir);
  const notOptimized = diagnostics.find((d) => d.code === 'W_MEDIA_NOT_OPTIMIZED');
  assert.equal(notOptimized?.file, 'assets/video/phone.mov');
  assert.match(notOptimized?.message ?? '', /Privacy: the file holds the GPS position/);
  assert.match(notOptimized?.message ?? '', /elabora media optimize assets\/video\/phone\.mov/);
  assert.ok(diagnostics.some((d) => d.code === 'E_MEDIA_UNREADABLE' && d.file === 'assets/video/broken.mp4'));
  assert.ok(diagnostics.some((d) => d.code === 'E_ASSET_MISSING' && /coming\.mp4/.test(d.message)));

  // A media job writing the file: expected, not missing.
  new MediaQueue(dir, { autoStart: false }).add({ type: 'import', input: fixture('master.mp4'), output: 'assets/video/coming.mp4' });
  diagnostics = findings(dir);
  assert.ok(diagnostics.some((d) => d.code === 'I_MEDIA_PROCESSING' && /coming\.mp4/.test(d.message)));
  assert.ok(!diagnostics.some((d) => d.code === 'E_ASSET_MISSING' && /coming\.mp4/.test(d.message)));

  // Without ffprobe, cached verdicts stay and new files are not checked.
  const saved = process.env.ELABORA_FFPROBE;
  process.env.ELABORA_FFPROBE = path.join(dir, 'no-ffprobe');
  try {
    place(dir, 'master.mp4', 'assets/video/new.mp4');
    const offline = readProjectFiles(dir);
    assert.equal(offline.media.toolsMissing, true);
    assert.ok((offline.files.get('assets/video/phone.mov') as { media?: unknown }).media, 'cached verdict kept');
    assert.ok(findings(dir).some((d) => d.code === 'I_MEDIA_TOOLS_MISSING'));
  } finally {
    if (saved === undefined) delete process.env.ELABORA_FFPROBE;
    else process.env.ELABORA_FFPROBE = saved;
  }
});

test('build: masters stream into the ZIP; renditions below high, with references following a new extension', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = resources(t).own(copyExample(), removeProject);
  place(dir, 'master.mp4', 'assets/video/master.mp4');
  place(dir, 'figure.png', 'assets/images/figure.png');
  fs.writeFileSync(path.join(dir, 'assets/video/master.vtt'), 'WEBVTT\n');
  const voice = fs.existsSync(fixture('voice.mp3'));
  if (voice) place(dir, 'voice.mp3', 'assets/audio/voice.mp3');
  addBlocks(dir,
    { id: 'clip', type: 'video', props: { asset: 'video/master.mp4', captions: 'video/master.vtt', title: 'Clip', transcript: 'A test clip.' } } as Block,
    { id: 'figure', type: 'image', props: { asset: 'images/figure.png', alt: 'A test pattern with colour bars.' } } as Block,
    ...(voice ? [{ id: 'voice', type: 'audio', props: { asset: 'audio/voice.mp3', title: 'Voice', transcript: 'A tone.' } } as Block] : []));
  const out = (name: string) => path.join(dir, 'out', name);

  const high = await build(dir, { out: out('high'), emit: 'both' });
  assert.ok(high.ok, JSON.stringify(high.diagnostics.filter((d) => d.severity === 'error')));
  const again = await build(dir, { out: out('again') });
  assert.equal(again.report?.package.sha256, high.report.package.sha256, 'deterministic');
  const zip = readZip(fs.readFileSync(high.zipPath!));
  assert.equal(zip.meta.find((m) => m.name === 'assets/video/master.mp4')?.method, 0, 'media stored as they are');
  assert.ok(zip.files.get('assets/video/master.mp4')?.equals(fs.readFileSync(path.join(dir, 'assets/video/master.mp4'))));
  assert.equal(high.media.get('assets/video/master.mp4'), path.join(dir, 'assets/video/master.mp4'));
  assert.ok(fs.statSync(path.join(high.dirPath!, 'assets/video/master.mp4')).size > 0, 'media cloned into the folder');
  assert.deepEqual(high.report.media?.files.map((f) => [f.path, f.rendition]), [['assets/audio/voice.mp3', false], ['assets/images/figure.png', false], ['assets/video/master.mp4', false]].filter(([p]) => voice || p !== 'assets/audio/voice.mp3'));

  const low = await build(dir, { out: out('low'), emit: 'both', mediaQuality: 'low' });
  assert.ok(low.ok, JSON.stringify(low.diagnostics.filter((d) => d.severity === 'error')));
  assert.equal(low.report.media?.quality, 'low');
  const video = await probeMedia(path.join(low.dirPath!, 'assets/video/master.mp4'), { tools });
  assert.deepEqual([video.width, video.height], [854, 480]);
  const course = fs.readFileSync(path.join(low.dirPath!, 'elabora/course.js'), 'utf8');
  if (voice) {
    // MP3 at 128 kb/s is above the low preset: the rendition is M4A, and the course points at it.
    assert.ok(fs.existsSync(path.join(low.dirPath!, 'assets/audio/voice.m4a')));
    assert.ok(!fs.existsSync(path.join(low.dirPath!, 'assets/audio/voice.mp3')));
    assert.match(course, /"src":"assets\/audio\/voice\.m4a"/);
    assert.ok(readZip(fs.readFileSync(low.zipPath!)).files.has('assets/audio/voice.m4a'));
  }
  assert.notEqual(low.report.buildId, high.report.buildId, 'the quality is part of the build');
  const lowAgain = await build(dir, { out: out('low-again'), mediaQuality: 'low' });
  assert.equal(lowAgain.report?.package.sha256, low.report.package.sha256, 'renditions are cached: same package');
  // The quality of the course: delivery.mediaQuality.
  const settings = readJSON(dir, 'course.json');
  writeJSON(dir, 'course.json', { ...settings, delivery: { mediaQuality: 'low' } });
  const delivered = await build(dir, { out: out('delivered') });
  assert.equal(delivered.report?.media?.quality, 'low');
  assert.deepEqual([...(delivered.media ?? [])], [...low.media]);
  writeJSON(dir, 'course.json', settings);

  // A media job still writing a referenced file: builds stop, the preview shows a placeholder.
  addBlocks(dir, { id: 'coming', type: 'image', props: { asset: 'images/coming.png', alt: 'Coming soon.' } } as Block);
  new MediaQueue(dir, { autoStart: false }).add({ type: 'import', input: fixture('figure.png'), output: 'assets/images/coming.png' });
  const waiting = await build(dir, { out: out('waiting') });
  assert.equal(waiting.ok, false);
  assert.ok(waiting.diagnostics.some((d) => d.code === 'E_ASSET_MISSING' && /still being converted/.test(d.message)));
  const linked = await build(dir, { out: out('linked'), emit: 'dir', media: 'link' });
  assert.ok(linked.ok);
  assert.equal(linked.media.get('assets/images/coming.png'), null);
  assert.ok(!fs.existsSync(path.join(linked.dirPath!, 'assets/video/master.mp4')), 'the preview never copies media');
});

test('optimize: the master next to the file, references follow, old file removed, all in one undoable change', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = resources(t).own(copyExample(), removeProject);
  place(dir, 'phone.mov', 'assets/video/phone.mov');
  fs.writeFileSync(path.join(dir, 'assets/video/phone.vtt'), 'WEBVTT\n');
  addBlocks(dir, { id: 'clip', type: 'video', props: { asset: 'video/phone.mov', captions: 'video/phone.vtt', title: 'Clip', transcript: 'A test clip.' } } as Block);
  const result = await optimizeMedia(dir, ['assets/video/phone.mov'], { queue: new MediaQueue(dir, { tools }), tools });
  assert.deepEqual(result.files.map((f) => [f.from, f.to, f.status]), [['assets/video/phone.mov', 'assets/video/phone.mp4', 'done']]);
  assert.ok(result.change?.change);
  assert.equal(readJSON(dir, 'screens/accueil.json').blocks.find((b: Block) => b.id === 'clip').props.asset, 'video/phone.mp4');
  assert.ok(!fs.existsSync(path.join(dir, 'assets/video/phone.mov')));
  const optimised = await probeMedia(path.join(dir, 'assets/video/phone.mp4'), { tools });
  assert.deepEqual([optimised.container, optimised.location, optimised.faststart], ['mp4', false, true]);
  assert.ok(!findings(dir).some((d) => d.code === 'W_MEDIA_NOT_OPTIMIZED' || d.severity === 'error'));
});

test('backups before edits leave out media that are not masters yet', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = resources(t).own(copyExample(), removeProject);
  place(dir, 'phone.mov', 'assets/video/phone.mov');
  place(dir, 'master.mp4', 'assets/video/master.mp4');
  updateCourseSettings(dir, { description: 'Edited.' });
  const [summary] = listVersions(dir);
  assert.ok(summary, 'an automatic version was taken');
  const version = readVersion(dir, summary.id);
  assert.ok(version.files['assets/video/master.mp4'], 'masters are sources');
  assert.ok(!version.files['assets/video/phone.mov'], 'raw media waiting for conversion are inputs');
  assert.ok(version.skipped.some((s) => s.path === 'assets/video/phone.mov'));
});

test('elabora media import, status and optimize from the command line', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = resources(t).own(copyExample(), removeProject);
  const elabora = (...args: string[]) => run(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: dir }).then((r) => r.stdout, (e: { stdout: string; stderr: string; code: number }) => { throw new Error(`exit ${e.code}: ${e.stderr}${e.stdout}`); });
  const imported = JSON.parse(await elabora('media', 'import', dir, fixture('phone.mov'), '--name', 'Démo téléphone', '--json'));
  assert.deepEqual(imported.files.map((f: { path: string; status: string; action: string }) => [f.path, f.status, f.action]), [['assets/video/demo-telephone.mp4', 'done', 'remux']]);
  const status = JSON.parse(await elabora('media', 'status', dir, '--json'));
  assert.deepEqual([status.jobs.length, status.jobs[0].status, status.toOptimize], [1, 'done', []]);
  place(dir, 'phone.mov', 'assets/video/dropped.mov');
  assert.deepEqual(JSON.parse(await elabora('media', 'status', dir, '--json')).toOptimize, ['assets/video/dropped.mov']);
  const optimised = JSON.parse(await elabora('media', 'optimize', dir, '--all', '--json'));
  assert.deepEqual(optimised.files.map((f: { from: string; to: string; status: string }) => [f.from, f.to, f.status]), [['assets/video/dropped.mov', 'assets/video/dropped.mp4', 'done']]);
  assert.ok(optimised.change, 'the old file was removed in a journaled change');
});

test('replaceMediaReferences rewrites the asset props naming moved files and removes the old files', (t) => {
  const dir = resources(t).own(copyExample(), removeProject);
  addBlocks(dir,
    { id: 'clip', type: 'video', props: { asset: 'video/a.mov', captions: 'video/a.vtt', poster: 'images/a.heic', title: 'A', transcript: 'A.' } } as Block,
    { id: 'other', type: 'image', props: { asset: 'images/keep.png', alt: 'Kept.' } } as Block);
  fs.mkdirSync(path.join(dir, 'assets/video'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/video/a.mov'), 'x');
  const { files } = readProjectFiles(dir);
  const output = replaceMediaReferences(commandContext(files), { moves: [{ from: 'assets/video/a.mov', to: 'assets/video/a.mp4' }, { from: 'assets/images/a.heic', to: 'assets/images/a.webp' }] });
  assert.ok(output.files);
  const screen = JSON.parse((output.files.get('screens/accueil.json') as { text: string }).text);
  assert.deepEqual(screen.blocks.find((b: Block) => b.id === 'clip').props, { asset: 'video/a.mp4', captions: 'video/a.vtt', poster: 'images/a.webp', title: 'A', transcript: 'A.' });
  assert.equal(screen.blocks.find((b: Block) => b.id === 'other').props.asset, 'images/keep.png');
  assert.deepEqual(output.result, { files: ['screens/accueil.json'], removed: ['assets/video/a.mov'] });
  assert.ok(!output.files.has('assets/video/a.mov'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('size of a package at each preset: estimated from bitrates, never above the master', (t) => {
  const video: MediaInfo = {
    kind: 'video', container: 'mp4', size: 50_000_000, duration: 49, bitrate: 8_200_000, videoCodec: 'h264', profile: 'High', pixelFormat: 'yuv420p',
    width: 1920, height: 1080, rotation: 0, pixelAspect: 1, fps: 30, videoBitrate: 8_050_000, hdr: null, alpha: false, animated: false,
    audioCodec: 'aac', audioBitrate: 150_000, channels: 2, sampleRate: 48000, coverArt: false, faststart: true, location: false
  };
  assert.equal(estimateBytes(video, 'high'), video.size);
  const medium = estimateBytes(video, 'medium');
  const low = estimateBytes(video, 'low');
  assert.ok(low < medium && medium < video.size, `${low} < ${medium} < ${video.size}`);
  assert.ok(medium <= (49 * (4_000_000 + 128_000) * 1.01) / 8 + 1, 'capped by the preset');
  assert.equal(estimateBytes({ ...video, width: 640, height: 360, videoBitrate: 900_000, bitrate: 1_000_000, audioBitrate: 96_000, size: 6_000_000 }, 'low'), 6_000_000, 'a master within the preset ships as it is');
  assert.equal(fileMedia(video).conformant, true);
});

test('files are served with range requests', async (t) => {
  const dir = resources(t).tempDir('elabora-serve-');
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  const server = resources(t).own(http.createServer((request, response) => serveFile(request, response, file)), value => new Promise<void>((resolve, reject) => { if (!value.listening) return resolve(); value.close(error => error ? reject(error) : resolve()); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const get = (headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path: '/', method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
  try {
    const whole = await get();
    assert.deepEqual([whole.status, whole.headers['accept-ranges'], whole.headers['content-type'], whole.body.length], [200, 'bytes', 'video/mp4', 1000]);
    const part = await get({ range: 'bytes=10-19' });
    assert.deepEqual([part.status, part.headers['content-range'], [...part.body]], [206, 'bytes 10-19/1000', [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]]);
    const open = await get({ range: 'bytes=990-' });
    assert.deepEqual([open.status, open.headers['content-range'], open.body.length], [206, 'bytes 990-999/1000', 10]);
    const suffix = await get({ range: 'bytes=-5' });
    assert.deepEqual([suffix.status, suffix.headers['content-range']], [206, 'bytes 995-999/1000']);
    assert.equal((await get({ range: 'bytes=2000-' })).status, 416);
    const head = await get({}, 'HEAD');
    assert.deepEqual([head.status, head.headers['content-length'], head.body.length], [200, '1000', 0]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
