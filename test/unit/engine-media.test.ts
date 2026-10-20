import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openProject, rewriteAssetReferences } from '@elabora/engine';
import type { EngineEvent, OpenOptions, Session } from '@elabora/engine';
import { findMediaTools } from '@elabora/node/media/tools';
import { MediaQueue } from '@elabora/node/media/jobs';
import type { MediaTools } from '@elabora/node/media/tools';
import { readJournal } from '@elabora/node/journal/index';
import { createProjectFiles } from '@elabora/core/project/files';
import { FsStore } from '@elabora/node/store/index';
import type { ChangeLike } from '@elabora/core/ops/types';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';

// Media in a session: references rewritten when a conversion changes a file's extension, media
// dropped into assets/ converted automatically, imports journaled when their job is done.

const run = promisify(execFile);
const tools: MediaTools | null = await findMediaTools().catch(() => null);
const NO_FFMPEG = 'ffmpeg and ffprobe are not installed';
const temporary: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) await session.close({ media: 'cancel' }).catch(() => {});
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor<T extends EngineEvent>(events: EngineEvent[], match: (event: EngineEvent) => event is T, timeoutMs = 60000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`No matching event in ${timeoutMs} ms: ${JSON.stringify(events.map((event) => event.type))}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const QUIET: OpenOptions = { backups: { onOpen: false, prune: false }, rescanIntervalMs: 0 };
type Changed = Extract<EngineEvent, { type: 'changed' }>;
const isChanged = (source: string) => (event: EngineEvent): event is Changed => event.type === 'changed' && event.source === source;
const changes = (dir: string) => readJournal(dir).filter((entry): entry is ChangeLike => entry.type !== 'mark');

test('references to a converted asset are rewritten: block props, project paths, stylesheet urls', () => {
  const files = createProjectFiles([
    ['screens/a.json', JSON.stringify({ id: 'a', blocks: [{ id: 'v', type: 'video', props: { asset: 'video/clip.mov', poster: 'images/p.png' } }] })],
    ['course.json', JSON.stringify({ theme: { background: 'assets/video/clip.mov' }, title: 'video/clip.mov is a name' })],
    ['theme/theme.css', '.hero { background: url("../assets/video/clip.mov#t=1"); } .other { background: url(../assets/video/other.mov); }'],
    ['notes.md', 'video/clip.mov']
  ]);
  const changed = rewriteAssetReferences(files, 'assets/video/clip.mov', 'assets/video/clip.mp4');
  assert.deepEqual([...changed.keys()].sort(), ['course.json', 'screens/a.json', 'theme/theme.css']);
  const text = (rel: string) => (changed.get(rel) as { text: string }).text;
  assert.equal(JSON.parse(text('screens/a.json')).blocks[0].props.asset, 'video/clip.mp4');
  assert.equal(JSON.parse(text('screens/a.json')).blocks[0].props.poster, 'images/p.png');
  assert.equal(JSON.parse(text('course.json')).theme.background, 'assets/video/clip.mp4');
  assert.equal(JSON.parse(text('course.json')).title, 'video/clip.mov is a name', 'only whole values are references');
  assert.equal(text('theme/theme.css'), '.hero { background: url("../assets/video/clip.mp4#t=1"); } .other { background: url(../assets/video/other.mov); }');
});

test('a media file dropped into assets/ that is not conformant is converted, its references rewritten in one system change', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  temporary.push(dir);
  // A screen already names the picture the agent is about to drop (BMP: not a web format).
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push({ id: 'accueil-photo', type: 'image', props: { asset: 'images/photo.bmp', alt: 'Photo du poste de Marc' } });
  writeJSON(dir, 'screens/accueil.json', screen);
  const session = await openProject(dir, { ...QUIET, media: { tools } });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  await session.flush();
  assert.ok(session.readScreen('accueil').diagnostics.some((d) => d.code === 'E_ASSET_MISSING'));

  const source = path.join(os.tmpdir(), `elabora-engine-${process.pid}-photo.bmp`);
  await run(tools.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x200', '-frames:v', '1', source]);
  fs.copyFileSync(source, path.join(dir, 'assets/images/photo.bmp'));
  fs.rmSync(source, { force: true });

  const dropped = await waitFor(events, isChanged('watcher'));
  assert.deepEqual(dropped.change.files, ['assets/images/photo.bmp']);
  const converted = await waitFor(events, isChanged('media'));
  assert.deepEqual(converted.change.author, { kind: 'system' });
  assert.equal(converted.change.command?.name, 'optimize_media');
  const output = (converted.change.command?.args as { to: string }).to;
  assert.match(output, /^assets\/images\/photo\.(webp|jpg|png)$/);
  assert.deepEqual([...converted.change.files].sort(), ['assets/images/photo.bmp', output, 'screens/accueil.json'].sort());
  // On disk and in the snapshot: the master, no original, the reference rewritten.
  assert.ok(fs.existsSync(path.join(dir, output)));
  assert.ok(!fs.existsSync(path.join(dir, 'assets/images/photo.bmp')));
  const asset = output.slice('assets/'.length);
  assert.equal(readJSON(dir, 'screens/accueil.json').blocks.at(-1).props.asset, asset);
  assert.equal(session.readScreen('accueil').data.blocks?.at(-1)?.props?.asset, asset);
  assert.ok(session.files.has(output) && !session.files.has('assets/images/photo.bmp'));
  await waitFor(events, (event): event is Extract<EngineEvent, { type: 'diagnostics' }> => event.type === 'diagnostics' && !(event.screens.accueil ?? []).some((d) => d.code === 'E_ASSET_MISSING'));
  // Nothing else journaled when the watcher reports the job's files.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await session.flush({ rescan: true });
  assert.deepEqual(changes(dir).map((change) => [change.author.kind, change.command?.name ?? null]), [['external', null], ['system', 'optimize_media']]);
  // The conversion can be undone: the original comes back from the blob store.
  await session.undo();
  assert.ok(fs.existsSync(path.join(dir, 'assets/images/photo.bmp')));
  assert.equal(readJSON(dir, 'screens/accueil.json').blocks.at(-1).props.asset, 'images/photo.bmp');
});

test('an import requested through the session is journaled as the requester\'s change when its job is done', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  temporary.push(dir);
  const session = await openProject(dir, { ...QUIET, media: { tools } });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-engine-import-'));
  temporary.push(folder);
  const source = path.join(folder, 'Schéma Réseau.png');
  await run(tools.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1', source]);
  const imported = await session.importMedia(source);
  assert.match(imported.path, /^assets\/images\/schema-reseau\.(png|webp)$/);
  const changed = await waitFor(events, isChanged('media'));
  assert.deepEqual(changed.change.author, { kind: 'human' });
  assert.equal(changed.change.command?.name, 'import_media');
  assert.deepEqual(changed.change.files, [imported.path]);
  assert.ok(session.files.get(imported.path)?.kind === 'binary');
  assert.ok(events.some((event) => event.type === 'mediaJob' && event.job.status === 'done'));
  assert.equal(session.mediaJobs().find((job) => job.id === imported.job.id)?.status, 'done');
});

test('an asset that a media job will write is reported as processing, not missing, while the job is under way', async () => {
  const dir = copyExample();
  temporary.push(dir);
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push({ id: 'accueil-video', type: 'video', props: { asset: 'video/accueil.mp4', title: 'Accueil' } });
  writeJSON(dir, 'screens/accueil.json', screen);
  const session = await openProject(dir, { ...QUIET, media: { enabled: false } });
  sessions.push(session);
  const codes = () => session.readScreen('accueil').diagnostics.map((d) => d.code);
  assert.ok(codes().includes('E_ASSET_MISSING'));
  // Another process (the CLI) queues an import whose output is that file.
  const queue = new MediaQueue(dir, { autoStart: false });
  const job = queue.add({ type: 'import', input: path.join(os.tmpdir(), 'nowhere.mov'), output: 'assets/video/accueil.mp4' });
  await session.flush({ rescan: true });
  assert.ok(codes().includes('I_MEDIA_PROCESSING'), codes().join(', '));
  assert.ok(!codes().includes('E_ASSET_MISSING'));
  queue.cancel(job.id);
  await session.flush({ rescan: true });
  assert.ok(codes().includes('E_ASSET_MISSING'), 'the job is over and the file did not come');
});

test('media files carry their verdict in the snapshot: a dropped file that is not a master is reported', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  temporary.push(dir);
  const session = await openProject(dir, { ...QUIET, media: { tools, autoOptimize: false } });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-engine-bmp-'));
  temporary.push(folder);
  await run(tools.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x100', '-frames:v', '1', path.join(folder, 'old.bmp')]);
  fs.copyFileSync(path.join(folder, 'old.bmp'), path.join(dir, 'assets/images/old.bmp'));
  await waitFor(events, (event): event is Extract<EngineEvent, { type: 'diagnostics' }> => event.type === 'diagnostics' && (event.project ?? []).some((d) => d.code === 'W_MEDIA_NOT_OPTIMIZED' && d.file === 'assets/images/old.bmp'));
  const file = session.files.get('assets/images/old.bmp');
  assert.equal(file?.kind === 'binary' && file.media?.conformant, false);
  assert.equal(file?.kind === 'binary' && file.media?.container, 'bmp');
});

// Windows reports the folder of a file that changes, too. A reported folder brings its files to be
// read again; a file a media job replaces stays the job's, so its removal is in the job's change.
class FolderReportingStore extends FsStore {
  report: (paths: string[]) => void = () => {};
  override watch(onChange: (paths: string[]) => void, onReady?: () => void): () => void {
    this.report = onChange;
    return super.watch((paths) => onChange([...paths, ...paths.map((rel) => path.posix.dirname(rel)).filter((folder) => folder !== '.')]), onReady);
  }
}

test('a folder reported as soon as a conversion removes the original leaves the removal to the conversion', async (t) => {
  if (!tools) return t.skip(NO_FFMPEG);
  const dir = copyExample();
  temporary.push(dir);
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push({ id: 'accueil-photo', type: 'image', props: { asset: 'images/photo.bmp', alt: 'Photo du poste de Marc' } });
  writeJSON(dir, 'screens/accueil.json', screen);
  const store = new FolderReportingStore(dir);
  const session = await openProject(dir, { ...QUIET, media: { tools }, store });
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => {
    events.push(event);
    // The job is done and the original gone: its folder is reported before the job's change is journaled.
    if (event.type === 'mediaJob' && event.job.status === 'done') { store.report(['assets/images']); void session.flush(); }
  });
  await session.flush();
  const source = path.join(os.tmpdir(), `elabora-engine-${process.pid}-folder.bmp`);
  await run(tools.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x200', '-frames:v', '1', source]);
  fs.copyFileSync(source, path.join(dir, 'assets/images/photo.bmp'));
  fs.rmSync(source, { force: true });
  const converted = await waitFor(events, isChanged('media'));
  const output = (converted.change.command?.args as { to: string }).to;
  assert.deepEqual([...converted.change.files].sort(), ['assets/images/photo.bmp', output, 'screens/accueil.json'].sort());
  await session.flush({ rescan: true });
  assert.deepEqual(changes(dir).map((change) => [change.author.kind, change.command?.name ?? null]), [['external', null], ['system', 'optimize_media']]);
});
