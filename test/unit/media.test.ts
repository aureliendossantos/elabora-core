import { test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PRESETS, presetHash, fitWithin, conformance, masterPlan, renditionPlan, canonicalPath, presetDimensions,
  findMediaTools, MediaToolsError, probeMedia, probeProjectMedia, readMp4Layout, encodeAttempts, runFfmpeg,
  importMedia, optimizeInPlace, ensureRendition, renditionPath, renditionsDir, MediaQueue, readJobs, jobsDir, probeCachePath
} from '@elabora/node/media/index';
import { projectDataDir } from '@elabora/node/data-dir';
import type { MediaInfo, MediaTools } from '@elabora/node/media/index';

const run = promisify(execFile);
const tools: MediaTools | null = await findMediaTools().catch(() => null);
const NO_FFMPEG = 'ffmpeg and ffprobe not found';
let fixtures = '';

// Tiny inputs made by ffmpeg's lavfi sources: a phone-like .mov (H.264, AAC, a GPS position),
// an MP4 with its index at the end, a PNG too large for a master, an MP3 and a JPEG with EXIF.
before(async () => {
  if (!tools) return;
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-media-fixtures-'));
  const ffmpeg = (...args: string[]) => run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const h264 = tools.h264[0] === 'libx264' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high'] : ['-c:v', tools.h264[0]];
  const av = (seconds: number) => ['-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-shortest', ...h264, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k'];
  await Promise.all([
    ffmpeg(...av(2), '-metadata', 'title=Private', '-metadata', 'location=+48.8584+002.2945/', '-f', 'mov', path.join(fixtures, 'Clip Démo.mov')),
    ffmpeg(...av(2), '-f', 'mp4', path.join(fixtures, 'slow.mp4')),
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=4000x2250', '-frames:v', '1', path.join(fixtures, 'large.png')),
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=640x320', '-frames:v', '1', '-q:v', '3', path.join(fixtures, 'plain.jpg')),
    ...(tools.encoders.has('libmp3lame') ? [ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(fixtures, 'voice.mp3'))] : [])
  ]);
  fs.writeFileSync(path.join(fixtures, 'Logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
  const jpeg = fs.readFileSync(path.join(fixtures, 'plain.jpg'));
  fs.writeFileSync(path.join(fixtures, 'photo.jpg'), Buffer.concat([jpeg.subarray(0, 2), exifSegment(6), jpeg.subarray(2)]));
});

after(() => { if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true }); });

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-media-project-'));
// The project's data folder may be elsewhere (ELABORA_DATA_DIR, synced folders): removed too.
const removeProject = (dir: string) => {
  fs.rmSync(projectDataDir(dir), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
};
const fixture = (name: string) => path.join(fixtures, name);

// APP1 EXIF segment: orientation and a GPS latitude, as phones write them.
function exifSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4 + 2 + 12 + 4 + 24);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8);
  const gpsIfd = 8 + 2 + 2 * 12 + 4;
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt16BE(0x8825, 22); tiff.writeUInt16BE(4, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt32BE(gpsIfd, 30);
  tiff.writeUInt16BE(1, gpsIfd);
  tiff.writeUInt16BE(0x0002, gpsIfd + 2); tiff.writeUInt16BE(5, gpsIfd + 4); tiff.writeUInt32BE(3, gpsIfd + 6); tiff.writeUInt32BE(gpsIfd + 18, gpsIfd + 10);
  for (let i = 0; i < 3; i++) { tiff.writeUInt32BE([48, 51, 30][i], gpsIfd + 18 + i * 8); tiff.writeUInt32BE(1, gpsIfd + 22 + i * 8); }
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function info(overrides: Partial<MediaInfo>): MediaInfo {
  return {
    kind: 'video', container: 'mp4', size: 1_000_000, duration: 10, bitrate: 2_000_000,
    videoCodec: 'h264', profile: 'High', pixelFormat: 'yuv420p', width: 1280, height: 720, rotation: 0, pixelAspect: 1, fps: 30, videoBitrate: 1_870_000,
    hdr: null, alpha: false, animated: false, audioCodec: 'aac', audioBitrate: 128_000, channels: 2, sampleRate: 48000, coverArt: false,
    faststart: true, location: false, ...overrides
  };
}

const codes = (i: MediaInfo) => conformance(i).reasons.map((r) => r.code);

test('presets: downscale only, aspect kept, even sides; parameters hashed per kind', () => {
  assert.deepEqual(fitWithin(1920, 1080, PRESETS.medium.video.maxLongSide), { width: 1280, height: 720, scaled: true });
  assert.deepEqual(fitWithin(1920, 1080, PRESETS.low.video.maxLongSide), { width: 854, height: 480, scaled: true });
  assert.deepEqual(fitWithin(1080, 1920, PRESETS.low.video.maxLongSide), { width: 480, height: 854, scaled: true });
  assert.deepEqual(fitWithin(1281, 721, 1920), { width: 1280, height: 720, scaled: true });
  assert.deepEqual(fitWithin(640, 360, 854), { width: 640, height: 360, scaled: false });
  assert.deepEqual(presetDimensions(info({ kind: 'image', width: 5000, height: 2500 }), 'high'), { width: 3200, height: 1600 });
  assert.equal(presetHash('medium', 'video'), presetHash('medium', 'video'));
  assert.match(presetHash('medium', 'video'), /^[0-9a-f]{12}$/);
  assert.equal(new Set(['high', 'medium', 'low'].flatMap((p) => ['video', 'audio', 'image'].map((k) => presetHash(p as 'high', k as 'video')))).size, 9);
});

test('conformance: what a master must be, and how to get there', () => {
  assert.deepEqual(codes(info({})), []);
  assert.deepEqual(codes(info({ container: 'mov', location: true })), ['container', 'location']);
  assert.deepEqual(codes(info({ faststart: false })), ['faststart']);
  assert.deepEqual(codes(info({ videoCodec: 'hevc', profile: 'Main 10', pixelFormat: 'yuv420p10le', hdr: 'hlg', width: 3840, height: 2160, bitrate: 40_000_000 })), ['video-codec', 'hdr', 'dimensions', 'bitrate']);
  assert.deepEqual(codes(info({ kind: 'audio', container: 'mp3', audioCodec: 'mp3', audioBitrate: 256_000, coverArt: true })), ['audio-bitrate', 'cover-art']);
  assert.deepEqual(codes(info({ kind: 'audio', container: 'mp3', audioCodec: 'mp3', audioBitrate: 128_000 })), []);
  assert.deepEqual(codes(info({ kind: 'image', container: 'png', width: 5000, height: 3000, size: 9_000_000 })), ['dimensions', 'file-size']);
  assert.deepEqual(codes(info({ kind: 'image', container: 'heif' })), ['image-format']);
  assert.deepEqual(codes(info({ kind: 'vector', container: 'svg' })), []);

  // A .mov with H.264 and AAC is rewrapped, never re-encoded; PCM audio alone is re-encoded.
  assert.deepEqual(pick(masterPlan(info({ container: 'mov' }))), { action: 'remux', extension: '.mp4', video: 'copy', audio: 'copy' });
  assert.deepEqual(pick(masterPlan(info({ container: 'mov', audioCodec: 'pcm_s16le' }))), { action: 'encode', extension: '.mp4', video: 'copy', audio: 'encode' });
  assert.deepEqual(pick(masterPlan(info({}))), { action: 'copy', extension: null, video: 'copy', audio: 'copy' });
  assert.deepEqual(pick(masterPlan(info({}), { importing: true })), { action: 'remux', extension: '.mp4', video: 'copy', audio: 'copy' });
  assert.equal(masterPlan(info({ kind: 'image', container: 'jpeg' }), { importing: true }).action, 'remux');

  assert.equal(canonicalPath('assets/video/intro.mov', info({ container: 'mov' })), 'assets/video/intro.mp4');
  assert.equal(canonicalPath('assets/images/photo.heic', info({ kind: 'image', container: 'heif' })), 'assets/images/photo.webp');
  assert.equal(canonicalPath('assets/images/scan.tif', info({ kind: 'image', container: 'tiff' })), 'assets/images/scan.webp');
  assert.equal(canonicalPath('assets/images/old.bmp', info({ kind: 'image', container: 'bmp' }), { webp: false }), 'assets/images/old.jpg');
  assert.equal(canonicalPath('assets/images/logo.gif', info({ kind: 'image', container: 'gif', alpha: true }), { webp: false }), 'assets/images/logo.png');
  assert.equal(canonicalPath('assets/audio/voice.wav', info({ kind: 'audio', container: 'wav', audioCodec: 'pcm_s16le', audioBitrate: 1_536_000 })), 'assets/audio/voice.m4a');
  assert.equal(canonicalPath('assets/images/ok.png', info({ kind: 'image', container: 'png' })), 'assets/images/ok.png');

  // Renditions copy the streams that already fit the preset.
  assert.equal(renditionPlan(info({}), 'medium').action, 'reuse');
  assert.deepEqual(pick(renditionPlan(info({ audioBitrate: 160_000 }), 'medium')), { action: 'encode', extension: '.mp4', video: 'copy', audio: 'encode' });
  assert.deepEqual(pick(renditionPlan(info({}), 'low')), { action: 'encode', extension: '.mp4', video: 'encode', audio: 'encode' });
  assert.equal(renditionPlan(info({ kind: 'audio', container: 'mp4', audioBitrate: 160_000 }), 'low').action, 'encode');
});

const pick = ({ action, extension, video, audio }: { action: string; extension: string | null; video: string | null; audio: string | null }) => ({ action, extension, video, audio });

test('MP4 layout: faststart read from the top-level boxes, 64-bit sizes included', async () => {
  const dir = project();
  const box = (type: string, size: number) => { const b = Buffer.alloc(size); b.writeUInt32BE(size, 0); b.write(type, 4, 'latin1'); return b; };
  const ftyp = (brand: string) => { const b = box('ftyp', 16); b.write(brand, 8, 'latin1'); return b; };
  const large = Buffer.alloc(24); large.writeUInt32BE(1, 0); large.write('mdat', 4, 'latin1'); large.writeBigUInt64BE(24n, 8);
  fs.writeFileSync(path.join(dir, 'fast.mp4'), Buffer.concat([ftyp('isom'), box('moov', 40), box('mdat', 100)]));
  fs.writeFileSync(path.join(dir, 'slow.mov'), Buffer.concat([ftyp('qt  '), box('free', 8), large, box('moov', 40)]));
  assert.deepEqual(await readMp4Layout(path.join(dir, 'fast.mp4')), { brand: 'isom', faststart: true, boxes: ['ftyp', 'moov', 'mdat'] });
  assert.deepEqual(await readMp4Layout(path.join(dir, 'slow.mov')), { brand: 'qt  ', faststart: false, boxes: ['ftyp', 'free', 'mdat', 'moov'] });
  removeProject(dir);
});

test('tools: a missing ffmpeg is a typed error', async () => {
  await assert.rejects(findMediaTools({ env: { ...process.env, ELABORA_FFMPEG: '/nonexistent/ffmpeg' } }), (error: unknown) => error instanceof MediaToolsError && error.code === 'E_MEDIA_TOOLS_MISSING' && error.missing.includes('ffmpeg'));
  await assert.rejects(findMediaTools({ env: { PATH: '' } }), MediaToolsError);
});

test('encode arguments: H.264 High, faststart, no metadata, downscale only, encoder fallbacks', () => {
  const fake: MediaTools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: '9.0', major: 9, encoders: new Set(), filters: new Set(), h264: ['libx264', 'h264_videotoolbox'], webp: true, toneMapping: null };
  const source = info({ container: 'mov', videoCodec: 'prores', profile: 'HQ', pixelFormat: 'yuv422p10le', width: 3840, height: 2160, audioCodec: 'pcm_s24le' });
  const attempts = encodeAttempts({ input: 'in.mov', output: 'out.mp4', info: source, plan: masterPlan(source), preset: 'high' }, fake);
  assert.deepEqual(attempts.map((a) => a.encoder), ['libx264', 'h264_videotoolbox'], 'hardware encoder as fallback');
  const args = attempts[0].args.join(' ');
  for (const part of ['-c:v libx264', '-crf 21', '-maxrate 8000000', '-profile:v high', '-map_metadata -1', '-movflags +faststart', "scale=w='min(iw,1920)':h='min(ih,1920)'", 'format=yuv420p', '-c:a aac', '-b:a 160000', '-f mp4 out.mp4']) {
    assert.ok(args.includes(part), `${part} in ${args}`);
  }
  const hdr = info({ videoCodec: 'hevc', profile: 'Main 10', pixelFormat: 'yuv420p10le', hdr: 'hlg' });
  assert.match(encodeAttempts({ input: 'in.mov', output: 'out.mp4', info: hdr, plan: masterPlan(hdr), preset: 'high' }, fake)[0].warnings[0], /without tone mapping/);
  const zscale = encodeAttempts({ input: 'in.mov', output: 'out.mp4', info: hdr, plan: masterPlan(hdr), preset: 'high' }, { ...fake, toneMapping: 'zscale' });
  assert.ok(zscale[0].args.join(' ').includes('tonemap=tonemap=hable'), 'tone-mapped first, plain conversion last');
  assert.equal(zscale.length, 4);
  const png = info({ kind: 'image', container: 'png', alpha: true, width: 5000, height: 2000, audioCodec: null });
  const image = encodeAttempts({ input: 'in.png', output: 'out.webp', info: png, plan: masterPlan(png), preset: 'medium' }, fake)[0].args.join(' ');
  for (const part of ['-c:v libwebp', '-quality 80', "scale=w='min(iw,2400)'", '-frames:v 1', '-map_metadata -1']) assert.ok(image.includes(part), `${part} in ${image}`);
});

test('probe: kinds, codecs, rotation, faststart, location; cached by path, size and mtime', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const mov = await probeMedia(fixture('Clip Démo.mov'), { tools });
  assert.equal(mov.kind, 'video');
  assert.equal(mov.container, 'mov');
  assert.equal(mov.videoCodec, 'h264');
  assert.equal(mov.pixelFormat, 'yuv420p');
  assert.deepEqual([mov.width, mov.height, mov.fps, mov.audioCodec], [1280, 720, 30, 'aac']);
  assert.ok(Math.abs((mov.duration ?? 0) - 2) < 0.1);
  assert.equal(mov.location, true);
  assert.equal((await probeMedia(fixture('slow.mp4'), { tools })).faststart, false);
  const png = await probeMedia(fixture('large.png'), { tools });
  assert.deepEqual([png.kind, png.container, png.width, png.height, png.alpha, png.animated], ['image', 'png', 4000, 2250, false, false]);
  const photo = await probeMedia(fixture('photo.jpg'), { tools });
  assert.deepEqual([photo.container, photo.width, photo.height, photo.rotation, photo.location], ['jpeg', 320, 640, 90, true]);

  const dir = project();
  fs.copyFileSync(fixture('slow.mp4'), path.join(dir, 'clip.mp4'));
  // Files written in the last two seconds are not cached (their time may not tell a later change).
  fs.utimesSync(path.join(dir, 'clip.mp4'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const first = await probeProjectMedia(dir, ['clip.mp4', 'logo.svg', 'missing.mp4'], { tools });
  assert.equal((first.get('logo.svg') as MediaInfo).kind, 'vector');
  assert.ok(first.get('missing.mp4') instanceof Error);
  assert.ok(fs.existsSync(probeCachePath(dir)));
  // A broken ffprobe proves the second answer comes from the cache, until the file changes.
  const broken = { ...tools, ffprobe: path.join(dir, 'no-ffprobe') };
  assert.equal(((await probeProjectMedia(dir, ['clip.mp4'], { tools: broken })).get('clip.mp4') as MediaInfo).faststart, false);
  fs.utimesSync(path.join(dir, 'clip.mp4'), new Date(), new Date(Date.now() - 30_000));
  assert.ok((await probeProjectMedia(dir, ['clip.mp4'], { tools: broken })).get('clip.mp4') instanceof Error);
  removeProject(dir);
});

test('import --to: a folder of assets/, named with or without its prefix', async () => {
  const dir = project();
  const queue = new MediaQueue(dir, {});
  assert.equal((await importMedia(dir, fixture('Logo.svg'), { queue, to: 'images/logos', name: 'Marque' })).path, 'assets/images/logos/marque.svg');
  assert.equal((await importMedia(dir, fixture('Logo.svg'), { queue, to: 'assets/images/', name: 'Marque' })).path, 'assets/images/marque.svg');
  await assert.rejects(importMedia(dir, fixture('Logo.svg'), { queue, to: 'images/../../elsewhere' }), /such as "images" or "assets\/images"/);
  await queue.wait();
});

test('import: masters in a web format, metadata gone, originals never copied', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = project();
  const queue = new MediaQueue(dir, { tools });
  const clip = await importMedia(dir, fixture('Clip Démo.mov'), { queue, tools });
  const again = await importMedia(dir, fixture('Clip Démo.mov'), { queue, tools });
  const slow = await importMedia(dir, fixture('slow.mp4'), { queue, tools, to: 'assets/video/raw', name: 'Index à la fin' });
  const large = await importMedia(dir, fixture('large.png'), { queue, tools });
  const photo = await importMedia(dir, fixture('photo.jpg'), { queue, tools });
  const voice = fs.existsSync(fixture('voice.mp3')) ? await importMedia(dir, fixture('voice.mp3'), { queue, tools }) : null;
  const logo = await importMedia(dir, fixture('Logo.svg'), { queue });
  await assert.rejects(importMedia(dir, fixture('large.png'), { queue, tools, to: '../elsewhere' }), /under assets/);
  assert.deepEqual([clip.path, again.path, slow.path], ['assets/video/clip-demo.mp4', 'assets/video/clip-demo-2.mp4', 'assets/video/raw/index-a-la-fin.mp4']);
  const jobs = await queue.wait();
  assert.deepEqual(jobs.map((j) => j.status), jobs.map(() => 'done'), JSON.stringify(jobs.map((j) => j.error)));

  const master = await probeMedia(path.join(dir, clip.path), { tools });
  assert.deepEqual([master.container, master.videoCodec, master.faststart, master.location, master.width, master.height], ['mp4', 'h264', true, false, 1280, 720]);
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', path.join(dir, clip.path)]);
  assert.doesNotMatch(stdout, /Private|location|48\.85/, 'title and GPS position removed');
  assert.equal(queue.get(clip.job.id)?.action, 'remux', 'H.264 and AAC are rewrapped, not re-encoded');
  assert.match(queue.get(clip.job.id)?.inputHash ?? '', /^sha256:/);
  assert.match(queue.get(clip.job.id)?.outputHash ?? '', /^sha256:/);

  assert.equal((await probeMedia(path.join(dir, slow.path), { tools })).faststart, true);
  const image = await probeMedia(path.join(dir, large.path), { tools });
  assert.equal(queue.get(large.job.id)?.action, 'encode');
  assert.ok(Math.max(image.width ?? 0, image.height ?? 0) <= PRESETS.high.image.maxLongSide);
  assert.match(large.path, tools.webp ? /\.webp$/ : /\.jpg$/);
  const cleaned = await probeMedia(path.join(dir, photo.path), { tools });
  assert.deepEqual([queue.get(photo.job.id)?.action, cleaned.location, cleaned.rotation], ['remux', false, 90], 'GPS removed losslessly, orientation kept');
  assert.deepEqual([logo.path, queue.get(logo.job.id)?.action], ['assets/images/logo.svg', 'copy']);
  if (voice) {
    assert.equal(voice.path, 'assets/audio/voice.mp3');
    assert.ok(fs.readFileSync(path.join(dir, voice.path)).equals(fs.readFileSync(fixture('voice.mp3'))), 'conformant MP3 copied as is');
  }
  // Only masters in assets/: no original, no temporary file.
  const files = fs.readdirSync(path.join(dir, 'assets'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  assert.deepEqual(files, ['clip-demo-2.mp4', 'clip-demo.mp4', 'index-a-la-fin.mp4', path.basename(large.path), 'logo.svg', 'photo.jpg', ...(voice ? ['voice.mp3'] : [])].sort());
  assert.deepEqual(fs.readdirSync(path.join(projectDataDir(dir), 'media', 'tmp')), []);

  // Renditions: encoded once from the master, cached under its hash and the preset's parameters.
  assert.equal(await renditionPath(dir, clip.path, 'high', { tools }), path.join(dir, clip.path));
  const medium = await ensureRendition(dir, clip.path, 'medium', { queue, tools });
  assert.equal(path.dirname(medium.file), renditionsDir(dir));
  assert.match(path.basename(medium.file), /^[0-9a-f]{32}-medium-[0-9a-f]{12}\.mp4$/);
  const mediumInfo = await probeMedia(medium.file, { tools });
  assert.deepEqual([mediumInfo.width, mediumInfo.height, mediumInfo.faststart], [1280, 720, true]);
  const low = await ensureRendition(dir, clip.path, 'low', { queue, tools });
  const lowInfo = await probeMedia(low.file, { tools });
  assert.deepEqual([lowInfo.width, lowInfo.height], [854, 480]);
  assert.ok((lowInfo.audioBitrate ?? 0) <= PRESETS.low.audio.bitrate * 1.1);
  assert.deepEqual(await ensureRendition(dir, clip.path, 'low', { queue, tools }), { file: low.file, reused: false, job: null }, 'second call: from the cache');

  // A .mov dropped into assets/ by hand becomes an MP4 next to it; the .mov goes away.
  fs.copyFileSync(fixture('Clip Démo.mov'), path.join(dir, 'assets/video/dropped.mov'));
  const optimized = await optimizeInPlace(dir, 'assets/video/dropped.mov', { queue, tools });
  assert.equal(optimized.to, 'assets/video/dropped.mp4');
  await queue.wait([optimized.job!.id]);
  assert.ok(fs.existsSync(path.join(dir, 'assets/video/dropped.mp4')));
  assert.ok(!fs.existsSync(path.join(dir, 'assets/video/dropped.mov')));
  assert.equal((await optimizeInPlace(dir, 'assets/video/dropped.mp4', { queue, tools })).job, null, 'already a master');
  removeProject(dir);
});

test('jobs: persisted, resumed after a crash, cancelled', async (t: TestContext) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = project();
  fs.mkdirSync(path.join(dir, 'assets/video'), { recursive: true });
  fs.copyFileSync(fixture('slow.mp4'), path.join(dir, 'assets/video/clip.mp4'));

  // A job left running by a process that died: the next queue puts it back and runs it.
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid!;
  const job = new MediaQueue(dir, { tools, autoStart: false }).add({ type: 'optimize', input: 'assets/video/clip.mp4', output: 'assets/video/clip.mp4', replaces: 'assets/video/clip.mp4' });
  const file = path.join(jobsDir(dir), `${job.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...job, status: 'running', progress: 0.4, owner: { pid: deadPid, host: os.hostname() } }));
  fs.writeFileSync(path.join(jobsDir(dir), `${job.id}.lock`), JSON.stringify({ pid: deadPid, host: os.hostname() }));
  const queue = new MediaQueue(dir, { tools });
  queue.start();
  const [resumed] = await queue.wait([job.id]);
  assert.equal(resumed.status, 'done', resumed.error ?? '');
  assert.equal((await probeMedia(path.join(dir, 'assets/video/clip.mp4'), { tools })).faststart, true);
  assert.ok(!fs.existsSync(path.join(jobsDir(dir), `${job.id}.lock`)));

  // Cancelled while running, and while waiting in the queue: no output, no temporary file.
  const running = queue.add({ type: 'rendition', input: 'assets/video/clip.mp4', output: 'cache/media/a-low.mp4', preset: 'low' });
  const waiting = queue.add({ type: 'rendition', input: 'assets/video/clip.mp4', output: 'cache/media/b-low.mp4', preset: 'low' });
  queue.cancel(waiting.id);
  assert.equal(queue.get(waiting.id)?.status, 'cancelled');
  await new Promise<void>((resolve) => {
    if (queue.get(running.id)?.status === 'running') resolve();
    else queue.on('start', (j) => { if (j.id === running.id) resolve(); });
  });
  queue.cancel(running.id);
  const [cancelled] = await queue.wait([running.id]);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!fs.existsSync(path.join(renditionsDir(dir), 'a-low.mp4')));
  assert.ok(!fs.existsSync(path.join(renditionsDir(dir), 'b-low.mp4')));
  assert.deepEqual(fs.readdirSync(path.join(projectDataDir(dir), 'media', 'tmp')), []);
  assert.deepEqual(readJobs(dir).map((j) => j.status), ['done', 'cancelled', 'cancelled']);

  // Cancelling kills ffmpeg at once.
  const controller = new AbortController();
  const endless = runFfmpeg(tools, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-f', 'null', '-'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(endless, { name: 'AbortError' });
  removeProject(dir);
});
