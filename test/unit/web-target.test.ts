import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWebAdapter, webStorageKey } from '@elabora/player/web';
import type { WebStorage } from '@elabora/player/web';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { validateProject } from '@elabora/core/validate/index';
import { build, WEB_DEFAULTS } from '@elabora/node/build';
import { readZip } from '@elabora/node/zip';
import { createMcpServer } from '@elabora/cli/mcp';
import { openProject } from '@elabora/engine';
import type { BuildView, ResponseMessage } from '@elabora/engine';
import { ROOT, copyExample, readJSON, writeJSON, codes } from '../helpers.ts';
import { narrate } from '../narration.ts';

// The web target (docs/decisions.md D41): a module for a plain web server, its adapter (progress
// local or none), its free navigation, its index.html, and the build, CLI, MCP and engine settings.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temporary.push(dir); return dir; };
const course = () => { const dir = copyExample(); temporary.push(dir); return dir; };

// localStorage as the adapter uses it, with what was written.
function memoryStorage(initial: Record<string, string> = {}): WebStorage & { items: Map<string, string>; writes: number } {
  const items = new Map(Object.entries(initial));
  const storage = {
    items, writes: 0,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.writes++; items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); }
  };
  return storage;
}

// A PNG of a few pixels: a sharing image.
function png(file: string): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.concat([0, 1].map(() => Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 0x60)])));
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}

test('web adapter, progress local: the location, status, score and suspend data are kept for the next visit, not the LMS journal', () => {
  const storage = memoryStorage();
  const first = createWebAdapter('reseau', { progress: 'local', storage });
  assert.equal(first.kind, 'web');
  assert.equal(first.initialize(), true);
  assert.equal(first.get('cmi.core.entry'), 'ab-initio');
  assert.equal(first.get('cmi.core.lesson_status'), 'not attempted');
  assert.equal(first.get('cmi.core.student_name'), '');
  first.set('cmi.core.lesson_status', 'incomplete');
  first.set('cmi.core.lesson_location', 's7');
  first.set('cmi.suspend_data', '{"v":3,"s":"s1.s7"}');
  first.set('cmi.core.score.raw', 80);
  first.set('cmi.core.session_time', '0000:01:00.00');
  first.setAlways('cmi.interactions.0.id', 'q1');
  first.setAlways('cmi.interactions.0.result', 'correct');
  assert.equal(first.get('cmi.interactions._count'), '1');
  assert.equal(storage.writes, 0, 'nothing is written before a commit');
  assert.equal(first.commit(), true);
  const saved = JSON.parse(storage.items.get(webStorageKey('reseau')) ?? '{}');
  assert.equal(typeof saved.savedAt, 'number', 'dated at each save');
  delete saved.savedAt;
  assert.deepEqual(saved, { 'cmi.core.lesson_location': 's7', 'cmi.core.lesson_status': 'incomplete', 'cmi.core.score.raw': '80', 'cmi.suspend_data': '{"v":3,"s":"s1.s7"}' });
  first.finish();
  assert.equal(first.phase, 'finished');

  const next = createWebAdapter('reseau', { progress: 'local', storage });
  next.initialize();
  assert.equal(next.get('cmi.core.entry'), 'resume');
  assert.equal(next.get('cmi.core.lesson_location'), 's7');
  assert.equal(next.get('cmi.suspend_data'), '{"v":3,"s":"s1.s7"}');
  assert.equal(next.get('cmi.interactions._count'), '0', 'interactions are an LMS journal, not kept');
  // Another course on the same site keeps its own progress.
  const other = createWebAdapter('gearset', { progress: 'local', storage });
  other.initialize();
  assert.equal(other.get('cmi.core.entry'), 'ab-initio');
  next.reset?.();
  assert.equal(storage.items.has(webStorageKey('reseau')), false);
});

test('web adapter, progress local: forgotten a year after the last save, renewed by each visit (D41, 29 Oct 2026)', () => {
  const storage = memoryStorage();
  const DAY = 86_400_000;
  let clock = Date.UTC(2026, 0, 1);
  const visit = () => createWebAdapter('reseau', { progress: 'local', storage, now: () => clock });
  const first = visit();
  first.initialize();
  first.set('cmi.core.lesson_location', 's4');
  first.commit();
  clock += 300 * DAY;
  const again = visit();
  again.initialize();
  assert.equal(again.get('cmi.core.lesson_location'), 's4', 'within the year');
  again.finish(); // a visit saves, and dates the progress again
  clock += 300 * DAY;
  const later = visit();
  later.initialize();
  assert.equal(later.get('cmi.core.lesson_location'), 's4', 'a year after the last visit, not the first');
  clock += 366 * DAY;
  const gone = visit();
  gone.initialize();
  assert.equal(gone.get('cmi.core.entry'), 'ab-initio');
  assert.equal(gone.get('cmi.core.lesson_location'), '');
  assert.equal(storage.items.has(webStorageKey('reseau')), false, 'removed from the browser too');
});

test('web adapter, progress local: unreadable, foreign or refused storage gives a fresh start and never throws', () => {
  const storage = memoryStorage({ [webStorageKey('reseau')]: '{not json', [webStorageKey('other')]: JSON.stringify({ 'cmi.core.lesson_location': 3, 'cmi.launch_data': 'x' }) });
  const broken = createWebAdapter('reseau', { progress: 'local', storage });
  broken.initialize();
  assert.equal(broken.get('cmi.core.entry'), 'ab-initio');
  const foreign = createWebAdapter('other', { progress: 'local', storage });
  foreign.initialize();
  assert.equal(foreign.get('cmi.core.lesson_location'), '', 'only kept elements, as strings, are read');
  assert.equal(foreign.get('cmi.launch_data'), '');
  const refusing: WebStorage = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('SecurityError'); } };
  const refused = createWebAdapter('reseau', { progress: 'local', storage: refusing });
  assert.equal(refused.initialize(), true);
  refused.set('cmi.core.lesson_location', 's2');
  assert.equal(refused.commit(), true);
  assert.equal(refused.get('cmi.core.lesson_location'), 's2', 'the visit keeps it in memory');
  assert.doesNotThrow(() => refused.reset?.());
  // No storage at all (localStorage refused by the browser).
  const none = createWebAdapter('reseau', { progress: 'local', storage: null });
  none.initialize();
  assert.equal(none.commit(), true);
});

test('web adapter, progress none: nothing is read or written, even with storage at hand', () => {
  const storage = memoryStorage({ [webStorageKey('reseau')]: JSON.stringify({ 'cmi.core.lesson_location': 's7', 'cmi.suspend_data': 'x' }) });
  const visit = createWebAdapter('reseau', { progress: 'none', storage });
  visit.initialize();
  assert.equal(visit.get('cmi.core.entry'), 'ab-initio');
  assert.equal(visit.get('cmi.core.lesson_location'), '', 'what another setting kept is not read');
  visit.set('cmi.core.lesson_location', 's2');
  visit.commit();
  visit.finish();
  assert.equal(storage.writes, 0);
  assert.equal(visit.get('cmi.core.lesson_location'), 's2', 'the page keeps it while it is open');
});

test('free navigation opens the course data: mode free, no lock, the outline shown, narrations seekable; authored keeps the course rules', () => {
  const dir = course();
  const source = readJSON(dir, 'course.json');
  source.navigation = { ...source.navigation, mode: 'linear', lockUntilComplete: true };
  source.player = { bottom: { items: [{ id: 'outline', enabled: false }, { id: 'previous' }, { id: 'next' }] } };
  writeJSON(dir, 'course.json', source);
  const [first, second] = source.sections.flatMap((section: { screens: string[] }) => section.screens);
  narrate(dir, first, [{ id: 'l1', text: 'Bonjour et bienvenue.' }]);
  narrate(dir, second, [{ id: 'l1', text: 'Sans barre.' }], { seek: 'none' });
  const project = loadProjectFromDir(dir);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  const authored = compileCourseData(project, keys, { buildId: 'b', delivery: { target: 'web', progress: 'local', navigation: 'authored' } });
  assert.deepEqual(authored.navigation, { mode: 'linear', lockUntilComplete: true });
  assert.deepEqual(authored.player.bottom?.items.map((item) => item.id), ['previous', 'next']);
  assert.deepEqual(authored.delivery, { target: 'web', progress: 'local', navigation: 'authored' });
  assert.equal(authored.screens[0].narration?.seek, 'seen');
  const free = compileCourseData(project, keys, { buildId: 'b', delivery: { target: 'web', progress: 'none', navigation: 'free' } });
  assert.deepEqual(free.navigation, { mode: 'free', lockUntilComplete: false });
  assert.deepEqual(free.player.bottom?.items.map((item) => item.id), ['outline', 'previous', 'next'], 'free navigation shows the outline');
  assert.equal(free.screens[0].narration?.seek, 'free');
  assert.equal(free.screens[1].narration?.seek, 'none', 'a narration without a bar stays so');
  // A SCORM package's data says nothing of the web.
  assert.equal(compileCourseData(project, keys, { buildId: 'b' }).delivery, undefined);
  // A SCORM package opened the same way (the Aperçu's « Déverrouiller la progression »): the same
  // course data, nothing said of the web.
  const unlocked = compileCourseData(project, keys, { buildId: 'b', navigation: 'free' });
  assert.deepEqual([unlocked.navigation, unlocked.player.bottom?.items.map((item) => item.id), unlocked.screens[0].narration?.seek, unlocked.delivery], [free.navigation, ['outline', 'previous', 'next'], 'free', undefined]);
});

test('a SCORM build takes navigation free; a module for the web says it in web.navigation', async () => {
  const dir = course();
  const out = tmp('elabora-free-');
  const unlocked = await build(dir, { emit: 'dir', out, writeLock: false, navigation: 'free' });
  assert.ok(unlocked.ok && unlocked.dirPath, JSON.stringify(unlocked.diagnostics.filter((d) => d.severity === 'error')));
  assert.match(fs.readFileSync(path.join(unlocked.dirPath, 'elabora/course.js'), 'utf8'), /"navigation":\{"mode":"free","lockUntilComplete":false\}/);
  await assert.rejects(build(dir, { emit: 'dir', out, writeLock: false, target: 'web', navigation: 'free' }), /web\.navigation/);
  await assert.rejects(build(dir, { emit: 'dir', out, writeLock: false, navigation: 'open' as 'free' }), /authored or free/);
});

test('a module for the web is checked against no LMS: no profile, suspend data budget or LMS of delivery.lms', () => {
  const dir = course();
  const source = readJSON(dir, 'course.json');
  source.delivery = { ...source.delivery, lms: ['no-such-lms'] };
  writeJSON(dir, 'course.json', source);
  const project = loadProjectFromDir(dir);
  assert.ok(codes(validateProject(project).diagnostics).includes('E_LMS_UNKNOWN'));
  const web = validateProject(project, { target: 'web' });
  assert.deepEqual(codes(web.diagnostics).filter((code) => code.startsWith('E_') || /LMS|SUSPEND|PROFILE/.test(code)), []);
  assert.deepEqual(web.context.options.profiles, []);
});

test('build --target web: a folder to serve and its ZIP, no manifest, its own index.html, deterministic', async () => {
  const dir = course();
  const image = png(path.join(tmp('elabora-share-'), 'cover.png'));
  const web = { progress: 'none', navigation: 'free', noindex: true, url: 'https://example.org/modules/reseau', image } as const;
  const [a, b] = [await build(dir, { target: 'web', web, out: tmp('elabora-w1-') }), await build(dir, { target: 'web', web, out: tmp('elabora-w2-') })];
  assert.ok(a.ok && b.ok && a.zipPath && a.dirPath, JSON.stringify(a.diagnostics.filter((d) => d.severity === 'error')));
  assert.ok(a.zipPath.endsWith('diagnostic-reseau-1.0.0-web.zip') && a.dirPath?.endsWith('diagnostic-reseau-1.0.0-web'), `${a.zipPath} ${a.dirPath}`);
  assert.equal(a.report.package.sha256, b.report.package.sha256, 'deterministic');
  const { files } = readZip(fs.readFileSync(a.zipPath));
  assert.equal(files.has('imsmanifest.xml'), false);
  for (const name of ['index.html', 'elabora/player.js', 'elabora/course.js', 'share.png', 'objects/diagnostic-reseau/frame.html']) assert.ok(files.has(name), name);
  // The folder holds what the ZIP holds, byte for byte.
  const listed = (root: string): string[] => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
  assert.deepEqual(listed(a.dirPath), [...files.keys()].sort());
  for (const [name, content] of files) assert.ok(content.equals(fs.readFileSync(path.join(a.dirPath, name))), name);
  const html = files.get('index.html')?.toString() ?? '';
  const source = readJSON(dir, 'course.json');
  const escaped = (text: string) => text.replace(/'/g, '&#39;');
  assert.ok(html.includes(`<title>${escaped(source.title)}</title>`));
  assert.ok(html.includes(`<meta name="description" content="${escaped(source.description)}">`));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(html.includes('<link rel="canonical" href="https://example.org/modules/reseau/">'), 'an address without a file name is a folder');
  assert.ok(html.includes('<meta property="og:url" content="https://example.org/modules/reseau/">'));
  assert.ok(html.includes('<meta property="og:image" content="https://example.org/modules/reseau/share.png">'));
  assert.ok(html.includes(`<meta property="og:title" content="${escaped(source.title)}">`));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
  const data = JSON.parse((files.get('elabora/course.js')?.toString() ?? '').replace(/^window\.ELABORA_COURSE = /, '').replace(/;\n$/, ''));
  assert.deepEqual(data.delivery, { target: 'web', progress: 'none', navigation: 'free' });
  assert.equal(data.navigation.mode, 'free');
  // The report and the proof dossier say what was built.
  assert.equal(a.report.target, 'web');
  assert.deepEqual(a.report.web, { progress: 'none', navigation: 'free', noindex: true, url: 'https://example.org/modules/reseau/', image: 'share.png' });
  assert.deepEqual(a.report.profiles, []);
  assert.equal(a.report.budget.suspendDataLimit, null);
  assert.ok(a.report.pending.includes('web-smoke') && !a.report.pending.includes('lms-smoke'));
  const proof = fs.readFileSync(a.reportPath.replace('.report.json', '.proof.md'), 'utf8');
  assert.match(proof, /Web \(serveur statique, sans LMS\)/);
  assert.match(proof, /Navigation : libre/);
  assert.doesNotMatch(proof, /LMS ciblés/);

  // The defaults: a publication, as designed, kept in the browser; indexable; a SCORM package of
  // the same course is unchanged by all this.
  const plain = await build(dir, { target: 'web', out: tmp('elabora-w3-') });
  assert.ok(plain.ok);
  assert.deepEqual(plain.report.web, { ...WEB_DEFAULTS, noindex: false, url: null, image: null });
  const plainHtml = fs.readFileSync(path.join(plain.dirPath ?? '', 'index.html'), 'utf8');
  assert.doesNotMatch(plainHtml, /robots|canonical|og:image|og:url/);
  assert.match(plainHtml, /<meta name="twitter:card" content="summary">/);
  const scorm = await build(dir, { profiles: ['moodle'], out: tmp('elabora-w4-') });
  assert.ok(scorm.ok && scorm.zipPath && scorm.zipPath.endsWith('-scorm12.zip'));
  const scormFiles = readZip(fs.readFileSync(scorm.zipPath)).files;
  assert.ok(scormFiles.has('imsmanifest.xml'));
  assert.doesNotMatch(scormFiles.get('index.html')?.toString() ?? '', /og:|description/);
  assert.doesNotMatch(scormFiles.get('elabora/course.js')?.toString() ?? '', /"delivery"/);
  assert.equal(scorm.report.target, 'scorm12');
  assert.equal(scorm.report.web, undefined);
});

test('build --target web: a wrong address or image stops it, an image without address warns, wrong settings are refused', async () => {
  const dir = course();
  const out = tmp('elabora-w5-');
  const svg = path.join(dir, 'assets/images', fs.readdirSync(path.join(dir, 'assets/images')).find((name) => name.endsWith('.svg')) ?? '');
  for (const web of [{ url: 'example.org/reseau' }, { url: 'ftp://example.org/' }, { url: 'https://example.org/?a=1' }, { image: 'assets/none.png' }, { image: svg }]) {
    const result = await build(dir, { target: 'web', web, out });
    assert.equal(result.ok, false, JSON.stringify(web));
    assert.deepEqual(codes(result.diagnostics).filter((code) => code.startsWith('E_WEB')), [web.url ? 'E_WEB_URL' : 'E_WEB_IMAGE'], JSON.stringify(web));
  }
  // A path in the course folder; no address: a warning.
  png(path.join(dir, 'assets/cover.png'));
  const relative = await build(dir, { target: 'web', web: { image: 'assets/cover.png' }, out });
  assert.ok(relative.ok);
  assert.ok(codes(relative.diagnostics).includes('W_WEB_IMAGE_WITHOUT_URL'));
  assert.match(fs.readFileSync(path.join(relative.dirPath ?? '', 'index.html'), 'utf8'), /<meta property="og:image" content="share.png">/);
  await assert.rejects(build(dir, { target: 'web', web: { progress: 'session' as 'local' } }), /progress is local or none/);
  await assert.rejects(build(dir, { target: 'web', web: { navigation: 'open' as 'free' } }), /navigation is authored or free/);
  await assert.rejects(build(dir, { web: { progress: 'none' } }), /for the web target/);
  await assert.rejects(build(dir, { target: 'web', profiles: ['moodle'] }), /LMS profiles are for the scorm12 target/);
  await assert.rejects(build(dir, { target: 'xapi' as 'web' }), /target is scorm12 or web/);
});

function elabora(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: ROOT, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

test('elabora build --target web: the settings as flags, checked before building', async () => {
  const dir = course();
  const out = tmp('elabora-w6-');
  const refused = await Promise.all([
    elabora(['build', dir, '--progress', 'none']), elabora(['build', dir, '--target', 'web', '--profile', 'moodle']), elabora(['build', dir, '--target', 'web', '--progress', 'session']),
    elabora(['build', dir, '--target', 'web', '--navigation', 'open']), elabora(['build', dir, '--target', 'cmi5']), elabora(['build', dir, '--noindex'])
  ]);
  assert.deepEqual(refused.map((run) => run.status), [2, 2, 2, 2, 2, 2], refused.map((run) => run.stderr).join(''));
  assert.match(refused[0].stderr, /--progress: for --target web only/);
  assert.match(refused[1].stderr, /--profile: LMS profiles are for SCORM packages/);
  const made = await elabora(['build', dir, '--target', 'web', '--progress', 'none', '--navigation', 'free', '--noindex', '--out', out, '--json']);
  assert.equal(made.status, 0, made.stderr);
  const printed = JSON.parse(made.stdout);
  assert.deepEqual(printed.web, { progress: 'none', navigation: 'free', noindex: true, url: null, image: null });
  assert.ok(fs.existsSync(path.join(printed.dir, 'index.html')) && fs.existsSync(printed.zip));
});

test('MCP elabora_build target web, and the engine build request with web settings', async () => {
  const dir = course();
  const server = createMcpServer(dir);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'elabora_build', arguments: args });
    const [first] = result.content as { type: 'text'; text: string }[];
    return { isError: result.isError === true, body: JSON.parse(first.text) };
  };
  const built = await call({ target: 'web', web: { progress: 'none', navigation: 'free' } });
  assert.equal(built.body.ok, true, JSON.stringify(built.body));
  assert.deepEqual(built.body.web, { progress: 'none', navigation: 'free', noindex: false, url: null, image: null });
  assert.ok(fs.existsSync(path.join(built.body.dir, 'index.html')));
  assert.equal((await call({ web: { progress: 'none' } })).isError, true);
  assert.equal((await call({ target: 'web', profiles: ['moodle'] })).isError, true);
  await client.close();

  const session = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 });
  try {
    const response = await session.handle({ kind: 'request', id: 'w1', type: 'build', params: { target: 'web', web: { progress: 'local', noindex: true } } }) as ResponseMessage;
    assert.equal(response.ok, true, JSON.stringify(response));
    const view = (response.ok ? response.result : null) as BuildView;
    assert.equal(view.ok, true);
    assert.ok(view.zip?.endsWith('-web.zip') && view.dir && fs.existsSync(path.join(view.dir, 'index.html')));
    assert.match(fs.readFileSync(path.join(view.dir, 'index.html'), 'utf8'), /noindex/);
    const scorm = await session.handle({ kind: 'request', id: 'w2', type: 'build', params: {} }) as ResponseMessage;
    assert.equal(scorm.ok && (scorm.result as BuildView).dir, null);
    for (const params of [{ target: 'xapi' }, { target: 'web', profiles: ['moodle'] }, { web: { progress: 'none' } }, { target: 'web', web: { progress: 'session' } }, { target: 'web', web: { navigation: 1 } }, { target: 'web', web: { noindex: 'yes' } }, { target: 'web', web: { colour: 'red' } }, { target: 'web', web: 'free' }]) {
      const refused = await session.handle({ kind: 'request', id: 'w3', type: 'build', params }) as ResponseMessage;
      assert.equal(refused.ok, false, JSON.stringify(params));
      if (!refused.ok) assert.equal(refused.error.kind, 'bad-request', JSON.stringify(params));
    }
  } finally {
    await session.close();
  }
});
