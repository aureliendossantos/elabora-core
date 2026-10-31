import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { narrationWords } from '@elabora/core/narration/words';
import { cloudUrl, scrubSecrets, resolveCredential, verifySignIn, chooseHandle, publishCourse, createReview, resolveComments, defaultDevice, CloudError, accountStatus, readSession, setSessionStore, signOut,
  accountSessions, revokeSession, updateAccount, requestDeletionCode, deleteAccount, unpublish, renameReview, handleAvailable, revokeAiKey, setReviewNote } from '@elabora/node/cloud/index';
import type { CloudReview, CommentsAnswer, ResolvedComments, SessionRecord } from '@elabora/node/cloud/index';
import { createMcpServer } from '@elabora/cli/mcp';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';
import { FakeCloud, FAKE_CODE } from '../cloud-fake.ts';

// The core's client of Elabora's hosting (docs/decisions.md D43) against a fake of the API's protocol
// version 3 (test/cloud-fake.ts): signing in by a code read from the input, the token only in its
// 0600 file, publishing by hashes (a second publication sends nothing, big files in parts), the API's
// refusals carried to the author, reviews, and comments placed in the course's sources for an AI.
// No e-mail, no network: the fake listens on 127.0.0.1.
// POSIX mode checks apply only outside Windows, whose file permissions use ACLs.

const BIN = path.join(ROOT, 'bin/elabora.js');
const fake = new FakeCloud();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-cloud-test-'));
const copies: string[] = [];
const copy = (source: string) => { const dir = copyExample(source); copies.push(dir); return dir; };

before(async () => { process.env.ELABORA_CLOUD_URL = await fake.start(); });
after(async () => {
  await fake.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const dir of copies) fs.rmSync(dir, { recursive: true, force: true });
});

// Every test keeps its credentials in a folder of its own.
let credentials = '';
beforeEach(() => {
  credentials = fs.mkdtempSync(path.join(scratch, 'credentials-'));
  process.env.ELABORA_CLOUD_SESSION_FILE = path.join(credentials, 'elabora-session');
  process.env.ELABORA_CLOUD_INVITATION_FILE = path.join(credentials, 'elabora-invitation');
  process.env.ELABORA_CLOUD_AI_KEY_FILE = path.join(credentials, 'elabora-ai-key');
  delete process.env.ELABORA_CLOUD_KEY_FILE;
  delete process.env.ELABORA_CLOUD_SPACE;
  fake.limits = { singlePutMaxBytes: 64 * 1024 * 1024, partBytes: 32 * 1024 * 1024 };
  fake.quota = null;
});

interface Run { status: number | null; stdout: string; stderr: string }
function elabora(args: string[], { input = '', env = {} }: { input?: string; env?: Record<string, string> } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

// An author signed in with a space of their own, as elabora account login leaves them.
async function signIn(handle: string): Promise<string> {
  await verifySignIn(`${handle}@example.org`, FAKE_CODE, { device: 'Tests' });
  await chooseHandle(handle);
  return JSON.parse(fs.readFileSync(process.env.ELABORA_CLOUD_SESSION_FILE!, 'utf8')).token;
}

const SECRET = /\b(eas|eik|erl|ear)_[A-Za-z0-9_-]{43}\b/;

test('cloud: the API is HTTPS (http only on this computer) and secrets are masked in messages', () => {
  assert.equal(cloudUrl(undefined), fake.url);
  assert.equal(cloudUrl(''), 'https://api.elabora.studio');
  assert.throws(() => cloudUrl('http://api.example.org'), (error: CloudError) => error.code === 'E_CLOUD_URL');
  assert.throws(() => cloudUrl('https://user:pw@api.example.org'), (error: CloudError) => error.code === 'E_CLOUD_URL');
  assert.equal(cloudUrl('http://localhost:8787/'), 'http://localhost:8787');
  const secret = `eas_${'a'.repeat(43)}`;
  assert.equal(scrubSecrets(`refused ${secret}.`), 'refused eas_…aaaa.');
  assert.equal(new CloudError(401, 'x', `bad key ${secret}`).message, 'bad key eas_…aaaa');
});

test('account login: the code is read from the input, the session kept in a 0600 file, the token in no output', async () => {
  const login = await elabora(['account', 'login', '--email', 'lea@example.org', '--handle', 'lea-morel', '--device', 'MacBook de Léa'], { input: `00000000\n${FAKE_CODE}\n` });
  assert.equal(login.status, 0, login.stderr);
  assert.match(login.stderr, /a code of 8 digits is on its way.*Access is by invitation for now/s);
  assert.match(login.stderr, /Wrong code: 4 tries left/);
  assert.match(login.stdout, /Signed in as lea@example\.org, space https:\/\/lea-morel\.elabora\.page\//);
  assert.deepEqual(fake.sentCodes.at(-1), { email: 'lea@example.org', language: 'fr' });
  const file = process.env.ELABORA_CLOUD_SESSION_FILE!;
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(kept.token, /^eas_/);
  assert.deepEqual([kept.api, kept.email, kept.handle, kept.device], [fake.url, 'lea@example.org', 'lea-morel', 'MacBook de Léa']);
  const status = await elabora(['account', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Signed in as lea@example\.org, space https:\/\/lea-morel\.elabora\.page\//);
  assert.match(status.stdout, /Session eas_….{4} « MacBook de Léa »/);
  const json = await elabora(['account', 'status', '--json']);
  assert.equal(JSON.parse(json.stdout).credential.masked, `eas_…${kept.token.slice(-4)}`);
  for (const run of [login, status, json]) assert.doesNotMatch(run.stdout + run.stderr, SECRET);
  // The code is never an argument.
  assert.equal((await elabora(['account', 'login', '--email', 'lea@example.org', '--code', '1'])).status, 2);

  const logout = await elabora(['account', 'logout']);
  assert.equal(logout.status, 0, logout.stderr);
  assert.ok(!fs.existsSync(file), 'the session file is forgotten');
  assert.ok(!fake.tokens.has(kept.token), 'the session ended on the server');
});

test('setSessionStore: the session lives where the app keeps it, never in the file; read, updated and forgotten there', async () => {
  let kept: SessionRecord | null = null;
  const calls: string[] = [];
  setSessionStore({ read: () => { calls.push('read'); return kept; }, write: (record) => { calls.push('write'); kept = record; }, remove: () => { calls.push('remove'); const had = kept !== null; kept = null; return had; } });
  try {
    const signed = await verifySignIn('store@example.org', FAKE_CODE, { device: 'Elabora · macOS' });
    assert.equal(signed.file, null);
    assert.equal(fs.existsSync(process.env.ELABORA_CLOUD_SESSION_FILE!), false, 'nothing in the file');
    assert.match(kept!.token, /^eas_/);
    assert.deepEqual([readSession()?.email, resolveCredential()?.source, resolveCredential()?.file], ['store@example.org', 'session-store', '']);
    await chooseHandle('store-author');
    assert.equal(kept!.handle, 'store-author', 'the handle written back to the store');
    assert.equal((await accountStatus()).account?.handle, 'store-author');
    // A session the hosting ended is forgotten in the store.
    fake.tokens.delete(kept!.token);
    await assert.rejects(accountStatus(), (error: CloudError) => error.code === 'session-ended');
    assert.equal(kept, null);
    // Signing out forgets it there too.
    await verifySignIn('store@example.org', FAKE_CODE);
    assert.deepEqual(await signOut(), { kind: 'session', source: 'session-store', endedOnServer: true, forgotten: true });
    assert.equal(kept, null);
    assert.ok(calls.includes('write') && calls.includes('remove'));
    // A store that cannot read gives no session (not a crash).
    setSessionStore({ read: () => { throw new Error('locked'); }, write: () => {}, remove: () => false });
    assert.equal(resolveCredential(), null);
  } finally {
    setSessionStore(null);
  }
  assert.equal(resolveCredential(), null, 'back to the file, empty');
});

test('account login names the device « Elabora CLI · <system> », never after the computer', async () => {
  assert.deepEqual(['darwin', 'win32', 'linux', 'freebsd'].map((platform) => defaultDevice(platform)), ['Elabora CLI · macOS', 'Elabora CLI · Windows', 'Elabora CLI · Linux', 'Elabora CLI · freebsd']);
  const login = await elabora(['account', 'login', '--email', 'tess@example.org', '--handle', 'tess-dev'], { input: `${FAKE_CODE}\n` });
  assert.equal(login.status, 0, login.stderr);
  const kept = JSON.parse(fs.readFileSync(process.env.ELABORA_CLOUD_SESSION_FILE!, 'utf8'));
  assert.equal(kept.device, defaultDevice());
  assert.match(kept.device, /^Elabora CLI · (macOS|Windows|Linux)$/);
  assert.match((await elabora(['account', 'status'])).stdout, /Session eas_….{4} « Elabora CLI · (macOS|Windows|Linux) »/);
});

test('publication versions and withdraw: one older version goes, the current one is refused, a review lists it as withdrawn', async () => {
  await signIn('wd-author');
  const dir = copy(path.join(ROOT, 'examples/medieval-charts'));
  const first = await publishCourse(dir, { visibility: 'private' });
  const { review } = await createReview(first.name);
  const screen = readJSON(dir, 'screens/workshop.json');
  screen.title = `${screen.title} (v2)`;
  writeJSON(dir, 'screens/workshop.json', screen);
  const second = await publishCourse(dir, { visibility: 'private' });
  assert.notEqual(first.version, second.version);

  const listed = await elabora(['publication', 'versions', first.name]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`^${first.name} · private · 2 versions kept in the space wd-author\n {2}${first.version}\n {2}${second.version}  current, since `));
  assert.equal(JSON.parse((await elabora(['publication', 'versions', first.name, '--json'])).stdout).versions.length, 2);

  const refusedCurrent = await elabora(['publication', 'withdraw', first.name, second.version, '--yes']);
  assert.equal(refusedCurrent.status, 1);
  assert.match(refusedCurrent.stderr, /current version: publish a newer one first/);
  const unsure = await elabora(['publication', 'withdraw', first.name, first.version]);
  assert.equal(unsure.status, 2);
  assert.match(unsure.stderr, /Again with --yes/);
  assert.equal((await elabora(['publication', 'withdraw', first.name, 'not-a-version', '--yes'])).status, 2);

  const done = await elabora(['publication', 'withdraw', first.name, first.version, '--yes']);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`✔ Version ${first.version} of ${first.name} withdrawn; 1 review lists it as withdrawn; 0 files deleted\\.`));
  assert.deepEqual(JSON.parse((await elabora(['publication', 'versions', first.name, '--json'])).stdout).versions, [second.version]);
  const [shown] = (await elabora(['review', 'list', '--json']).then((run) => JSON.parse(run.stdout))).reviews as CloudReview[];
  assert.equal(shown.id, review.id);
  assert.deepEqual(shown.versions.map((v) => [v.number, v.withdrawn]), [[1, true], [2, false]]);
  const again = await elabora(['publication', 'withdraw', first.name, first.version, '--yes', '--json']);
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(again.stdout).error.code, 'no-version');
});

test('account login --invitation keeps a tester\'s key for its space; ELABORA_CLOUD_KEY_FILE serves too', async () => {
  const key = fake.invite('essai');
  const handed = path.join(credentials, 'cloud-invite-essai');
  fs.writeFileSync(handed, `${key}\n`, { mode: 0o600 });
  const login = await elabora(['account', 'login', '--invitation', handed, '--space', 'essai']);
  assert.equal(login.status, 0, login.stderr);
  assert.doesNotMatch(login.stdout + login.stderr, SECRET);
  if (process.platform !== 'win32') assert.equal(fs.statSync(process.env.ELABORA_CLOUD_INVITATION_FILE!).mode & 0o777, 0o600);
  assert.equal(resolveCredential()?.space, 'essai');
  const fromInput = await elabora(['account', 'login', '--invitation', '-', '--space', 'essai'], { input: key });
  assert.equal(fromInput.status, 0, fromInput.stderr);
  fs.rmSync(process.env.ELABORA_CLOUD_INVITATION_FILE!);
  const env = await elabora(['account', 'status', '--json'], { env: { ELABORA_CLOUD_KEY_FILE: handed, ELABORA_CLOUD_SPACE: 'essai' } });
  assert.equal(env.status, 0, env.stderr);
  assert.deepEqual([JSON.parse(env.stdout).credential.source, JSON.parse(env.stdout).space], ['environment', 'essai']);
  assert.doesNotMatch(env.stdout, SECRET);
});

test('a credential kept for another API is never sent to this one', async () => {
  const token = `eas_${'b'.repeat(43)}`;
  fs.writeFileSync(process.env.ELABORA_CLOUD_SESSION_FILE!, JSON.stringify({ format: 'elabora-session/1', api: 'https://api.elabora.studio', token, session: null, email: 'x@example.org', handle: 'x', device: 'd', createdAt: '' }), { mode: 0o600 });
  const before = fake.requests.length;
  const list = await elabora(['review', 'list', '--all']);
  assert.equal(list.status, 1);
  assert.match(list.stderr, /Not signed in to Elabora's hosting/);
  assert.equal(fake.requests.length, before, 'nothing reached the server');
  const status = await elabora(['account', 'status']);
  assert.match(status.stdout, /a session is kept for https:\/\/api\.elabora\.studio/);
});

test('publish: only what the space lacks is sent; publishing the same content again sends nothing', async () => {
  await signIn('pub-author');
  const dir = copy(path.join(ROOT, 'examples/medieval-charts'));
  const first = await elabora(['publish', dir, '--json']);
  assert.equal(first.status, 0, first.stderr);
  const published = JSON.parse(first.stdout);
  assert.equal(published.visibility, 'public');
  assert.equal(published.name, 'medieval-charts');
  assert.equal(published.url, 'https://pub-author.elabora.page/medieval-charts/');
  assert.equal(published.sentFiles, published.files, 'everything the first time');
  const stored = fake.publications.get('pub-author')!.get('medieval-charts')!;
  assert.equal(stored.manifest.noindex, true, 'noindex unless asked');
  assert.deepEqual(stored.manifest.meta.course, { id: 'medieval-charts', version: readJSON(dir, 'course.json').version });

  const blobsBefore = fake.blobRequests().length;
  const again = await elabora(['publish', dir]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Unchanged: https:\/\/pub-author\.elabora\.page\/medieval-charts\/ already serves version [0-9a-f]{16}; nothing sent\./);
  assert.equal(fake.blobRequests().length, blobsBefore, 'no byte sent the second time');

  // One screen changed: its course data and the page, not the player, the theme nor the media.
  const screen = readJSON(dir, 'screens/workshop.json');
  screen.title = `${screen.title} (revu)`;
  writeJSON(dir, 'screens/workshop.json', screen);
  const changed = JSON.parse((await elabora(['publish', dir, '--json'])).stdout);
  assert.ok(changed.sentFiles >= 1 && changed.sentFiles <= 3, `sent ${changed.sentFiles} of ${changed.files}`);
  assert.equal(changed.previous, published.version);
});

test('publish --languages all: one package of every approved language, its languages in the publication; a review keeps one language', async () => {
  await signIn('lang-author');
  const dir = copy(path.join(ROOT, 'examples/orbital-rendezvous'));
  const run = await elabora(['publish', dir, '--languages', 'all', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const published = JSON.parse(run.stdout);
  assert.deepEqual(published.languages, ['en', 'fr']);
  const stored = fake.publications.get('lang-author')!.get('orbital-rendezvous')!;
  assert.deepEqual(stored.manifest.meta.languages, ['en', 'fr']);
  assert.ok(Object.keys(stored.manifest.files).includes('elabora/course.fr.js'), 'the French course data is published');
  assert.match((await elabora(['publish', dir, '--languages', 'all'])).stdout, /In en, fr: learners switch languages in the player\./);
  // A review shows one language per build: refused, by the API and the command.
  await assert.rejects(publishCourse(dir, { visibility: 'private', languages: 'all' }), { code: 'E_CLOUD_PRIVATE_LANGUAGES' });
  assert.equal((await elabora(['publish', dir, '--private', '--languages', 'all'])).status, 2);
  assert.equal((await elabora(['publish', dir, '--languages', 'fr'])).status, 2);
  // Without it, the course's own language.
  const single = JSON.parse((await elabora(['publish', dir, '--name', 'orbital-en', '--json'])).stdout);
  assert.equal(single.languages, undefined);
  assert.deepEqual(fake.publications.get('lang-author')!.get('orbital-en')!.manifest.meta.languages, ['en']);
});

test('publish: a file above the API\'s limit goes in parts, assembled and checked by its hash', async () => {
  await signIn('parts-author');
  fake.limits = { singlePutMaxBytes: 40_000, partBytes: 16_000 };
  const dir = copy(path.join(ROOT, 'examples/medieval-charts'));
  const result = await publishCourse(dir, { visibility: 'private' });
  assert.equal(result.name, 'medieval-charts-review');
  assert.equal(result.url, null, 'a private publication has no address');
  assert.ok(result.multipartFiles >= 1, 'player.js is above 40 KB');
  const parts = fake.requests.filter((r) => r.method === 'PUT' && /\/multipart\//.test(r.path));
  assert.ok(parts.length >= 8, `${parts.length} parts`);
  assert.ok(parts.every((r) => r.bytes <= 16_000));
  assert.ok(parts.some((r) => r.path.includes('%2F')), 'the multipart id is URL-encoded');
  const player = fake.publications.get('parts-author')!.get('medieval-charts-review')!.manifest.files['elabora/player.js'];
  assert.equal(fake.blobs.get('parts-author')!.get(player.sha256)!.byteLength, player.size);
});

test('publish: the API\'s refusals reach the author as their messages say (quota, rights, indexing, a session over)', async () => {
  const token = await signIn('full-author');
  const dir = copy(path.join(ROOT, 'examples/medieval-charts'));
  fake.quota = { storageBytes: 1000 };
  const quota = await elabora(['publish', dir]);
  assert.equal(quota.status, 1);
  assert.match(quota.stderr, /✘ Your space is full: unpublish an old publication.*\n {2}\d+ KB used of 1 KB, [\d.]+ (KB|MB) to add\./s);
  const json = JSON.parse((await elabora(['publish', dir, '--json'])).stdout);
  assert.deepEqual([json.ok, json.error.status, json.error.code, json.error.details.limit], [false, 403, 'quota-storage', 1000]);
  fake.quota = null;

  const indexed = await elabora(['publish', dir, '--index']);
  assert.equal(indexed.status, 1);
  assert.match(indexed.stderr, /Publish without --index/);

  // A tester's key used on another space than its own.
  const key = path.join(credentials, 'other-key');
  fs.writeFileSync(key, fake.invite('autre'));
  const forbidden = await elabora(['review', 'list', '--all'], { env: { ELABORA_CLOUD_KEY_FILE: key, ELABORA_CLOUD_SPACE: 'essai' } });
  assert.equal(forbidden.status, 1);
  assert.match(forbidden.stderr, /This key may not act on this space/);

  // The session revoked elsewhere: forgotten here, the author signs in again.
  fake.tokens.delete(token);
  const over = await elabora(['review', 'list', '--all']);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /Your session with Elabora's hosting has ended.*elabora account login/);
  assert.ok(!fs.existsSync(process.env.ELABORA_CLOUD_SESSION_FILE!));
});

// A comment as the review page writes it, on a private publication of examples/diagnostic-reseau.
async function reviewedCourse(handle: string): Promise<{ dir: string; review: string; version: string }> {
  await signIn(handle);
  const dir = copy(path.join(ROOT, 'examples/diagnostic-reseau'));
  const published = await publishCourse(dir, { visibility: 'private' });
  const { review } = await createReview(published.name);
  return { dir, review: review.id, version: published.version };
}

test('review: create prints the link once or writes it to a 0600 file; list, link, close, open, delete', async () => {
  await signIn('rev-author');
  const dir = copy(path.join(ROOT, 'examples/medieval-charts'));
  assert.match((await elabora(['review', 'create', dir])).stderr, /medieval-charts-review is not published\..*elabora publish --private/s);
  const priv = await elabora(['publish', dir, '--private']);
  assert.equal(priv.status, 0, priv.stderr);
  assert.match(priv.stdout, /Published privately as medieval-charts-review .*\n {2}Only a review shows it: elabora review create --name medieval-charts-review/);

  const shown = await elabora(['review', 'create', dir, '--title', 'Relecture des cartes']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /✔ Review rv_[0-9a-f]{20} « Relecture des cartes » shares medieval-charts-review, version 1\.\n {2}Link for reviewers, shown this once.*\n {2}https:\/\/revue\.elabora\.studio\/#erl_/);
  const linkFile = path.join(credentials, 'link');
  const written = JSON.parse((await elabora(['review', 'create', dir, '--link-out', linkFile, '--json'])).stdout);
  assert.ok(written.linkWrittenTo && !('link' in written));
  if (process.platform !== 'win32') assert.equal(fs.statSync(linkFile).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(linkFile, 'utf8'), /^https:\/\/revue\.elabora\.studio\/#erl_/);
  const id: string = written.review.id;

  const list = await elabora(['review', 'list', dir]);
  assert.equal(list.stdout.trim().split('\n').length, 2);
  assert.match(list.stdout, /rv_[0-9a-f]{20} « Relecture des cartes » · open · medieval-charts-review v1 · 0 open, 0 resolved · 0 reviewers\n/);
  assert.match(list.stdout, new RegExp(`${id} « Drawing the sea[^»]*» · open`));

  // A new private version goes to the open reviews.
  const screen = readJSON(dir, 'screens/workshop.json');
  screen.title = `${screen.title} (v2)`;
  writeJSON(dir, 'screens/workshop.json', screen);
  const second = await elabora(['publish', dir, '--private']);
  assert.match(second.stdout, new RegExp(`\n  Sent to review ${id} « Drawing the sea[^»]*» as version 2\.`));
  assert.equal(fake.reviews.get(id)!.versions.length, 2);

  const oldLink = fs.readFileSync(linkFile, 'utf8').trim();
  const relinked = JSON.parse((await elabora(['review', 'link', id, '--json'])).stdout);
  assert.notEqual(relinked.link, oldLink);
  assert.match((await elabora(['review', 'close', id, '--read-only'])).stdout, /is read-only/);
  assert.equal(fake.reviews.get(id)!.state, 'read-only');
  assert.match((await elabora(['review', 'close', id])).stdout, /is closed/);
  assert.match((await elabora(['review', 'open', id])).stdout, /is open again/);
  const refused = await elabora(['review', 'delete', id]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Again with --yes/);
  assert.equal((await elabora(['review', 'delete', id, '--yes'])).status, 0);
  assert.ok(!fake.reviews.has(id));
});

test('review comments: each comment placed in the course\'s sources, with what changed since the version commented', async () => {
  const { dir, review, version } = await reviewedCourse('ai-author');
  const marc = readJSON(dir, 'screens/accueil.json').narration.lines.find((line: { id: string }) => line.id === 'marc-appel');
  const words = narrationWords(marc.text, 'fr');
  const onWelcome = fake.reviewerComment(review, { version, language: 'fr', screen: '0', block: 'accueil-situation', step: 0, line: 'marc-appel', word: 3, point: { x: 0.42, y: 0.61 }, frame: { width: 1600, height: 744 } }, 'Le texte est trop long.\nCouper la deuxième phrase ?');
  fake.reviewerComment(review, { version, language: 'fr', screen: '2', block: 'rappel-chemin', layer: 'rappel-regle', frame: { width: 375, height: 700 } }, 'Illisible sur téléphone.', 'Paul');
  fake.reviewerComment(review, { version, language: 'fr', screen: 'zz', block: 'gone', frame: { width: 1280, height: 720 } }, 'Écran supprimé ?');
  fake.reviewerReply(review, onWelcome.id, 'Oui, et le titre aussi.');

  const run = await elabora(['review', 'comments', dir, '--json']);
  assert.equal(run.status, 0, run.stderr);
  const [result] = JSON.parse(run.stdout).reviews as ResolvedComments[];
  assert.equal(result.review.id, review);
  assert.deepEqual(result.course, { id: 'diagnostic-reseau', dir: fs.realpathSync(dir) === dir ? dir : path.resolve(dir), version: readJSON(dir, 'course.json').version });
  const [first, second, third] = result.comments;
  assert.deepEqual(first.place!.screen, { key: '0', id: 'accueil', title: readJSON(dir, 'screens/accueil.json').title, file: 'screens/accueil.json' });
  assert.deepEqual(first.place!.block, { id: 'accueil-situation', type: 'text', path: '/blocks/0', layer: null });
  assert.deepEqual(first.place!.step, { number: 0, label: null });
  assert.deepEqual(first.place!.line, { id: 'marc-appel', speaker: 'marc', text: marc.text, word: { index: 3, text: words[3].text, occurrence: 1 } });
  assert.deepEqual([first.place!.point, first.place!.frame, first.place!.translation], [{ x: 0.42, y: 0.61 }, { width: 1600, height: 744 }, null]);
  assert.deepEqual(first.version, { id: version, number: 1, latest: 1, course: readJSON(dir, 'course.json').version, newerInReview: false, screenChanged: false });
  assert.deepEqual([first.state, first.by, first.text], ['open', { kind: 'reviewer', name: 'Léa Morel' }, 'Le texte est trop long.\nCouper la deuxième phrase ?']);
  assert.deepEqual(first.replies.map((reply) => [reply.by.name, reply.text]), [['Léa Morel', 'Oui, et le titre aussi.']]);
  assert.deepEqual(second.place!.block, { id: 'rappel-chemin', type: 'network-path', path: '/layers/0/blocks/0', layer: 'rappel-regle' });
  assert.deepEqual(second.place!.layer, { id: 'rappel-regle', title: 'Rappel : la règle SUP-NET-04', found: true });
  assert.deepEqual([third.place!.screen.id, third.place!.screen.file, third.place!.block!.type], [null, null, null]);

  // The welcome screen edited and a second version sent to the review.
  const welcome = readJSON(dir, 'screens/accueil.json');
  welcome.title = 'Le ticket de Marc, revu';
  writeJSON(dir, 'screens/accueil.json', welcome);
  await publishCourse(dir, { visibility: 'private' });
  const text = await elabora(['review', 'comments', dir]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`^Review ${review} « .+ » \\(open\\) · diagnostic-reseau-review, latest v2 · 3 open, 0 resolved\\n`));
  assert.match(text.stdout, /#1 open · on v1 [0-9a-f]{16} \(course [\d.]+\) · v2 is newer, the screen changed since\n {3}screen {2}accueil « Le ticket de Marc, revu » → screens\/accueil\.json \(key 0\)\n {3}block {3}accueil-situation \(text\) at \/blocks\/0\n {3}line {4}marc-appel \(marc\): « Bonjour, c'est Marc\./);
  assert.match(text.stdout, /#2 open · on v1 [0-9a-f]{16} \(course [\d.]+\) · v2 is newer, the screen is unchanged since\n {3}screen {2}premier-reflexe/);
  assert.match(text.stdout, /block {3}rappel-chemin \(network-path\) at \/layers\/0\/blocks\/0 in layer rappel-regle\n {3}layer rappel-regle « Rappel : la règle SUP-NET-04 »\n {3}in a 375×700 frame\n {3}Paul \(reviewer\)/);
  assert.match(text.stdout, /#3 open .*\n {3}screen {2}key zz: no screen has this key now \(removed\?\)\n {3}block {3}gone — not in this screen now/);
  assert.match(text.stdout, / {3}Léa Morel \(reviewer\), [\d-]+ [\d:]+ UTC: Le texte est trop long\.\n {5}Couper la deuxième phrase \?\n {5}↳ Léa Morel \(reviewer\), [\d-]+ [\d:]+ UTC: Oui, et le titre aussi\./);
  const rev = Number(/--since (\d+)$/.exec(text.stdout.trim())![1]);

  // Answered and resolved by the author; --since gives only what changed, under its thread.
  assert.equal((await elabora(['review', 'reply', review, '1', 'Coupé', 'dans', 'la', 'v2.'])).status, 0);
  const resolved = await elabora(['review', 'resolve', review, '#1']);
  assert.match(resolved.stdout, /Thread #1 is resolved\./);
  fake.reviewerReply(review, fake.comments.find((c) => c.number === 2)!.id, 'Toujours petit.', 'Paul');
  const since = JSON.parse((await elabora(['review', 'comments', dir, '--since', String(rev), '--json'])).stdout).reviews[0] as ResolvedComments;
  assert.deepEqual(since.comments.map((c) => [c.number, c.state, c.replies.map((r) => r.text)]), [[1, 'resolved', ['Coupé dans la v2.']], [2, 'open', ['Toujours petit.']]]);
  assert.equal(since.since, rev);
  assert.equal((await elabora(['review', 'reopen', review, '1'])).status, 0);
  assert.equal(fake.comments.find((c) => c.number === 1)!.state, 'open');
  assert.deepEqual(fake.comments.filter((c) => c.by.kind === 'author').map((c) => [c.text, c.by.name]), [['Coupé dans la v2.', 'ai-author@example.org']]);
});

test('MCP: the author\'s AI reads reviews and placed comments; no tool publishes, shares, answers or resolves', async () => {
  const { dir, review, version } = await reviewedCourse('mcp-author');
  fake.reviewerComment(review, { version, language: 'fr', screen: '0', block: 'accueil-situation', frame: { width: 1600, height: 900 } }, 'Objectifs : trop vagues.');
  for (const readOnly of [false, true]) {
    const server = createMcpServer(dir, { readOnly });
    const client = new Client({ name: 'cloud-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const cloud = tools.filter((tool) => tool.name.startsWith('elabora_review'));
    assert.deepEqual(cloud.map((tool) => [tool.name, tool.annotations?.readOnlyHint, tool.annotations?.openWorldHint]), [['elabora_review_list', true, true], ['elabora_review_comments', true, true]]);
    assert.ok(!tools.some((tool) => /^elabora_(publish(?!_component)|share|account|review_(create|reply|resolve|reopen|open|close|delete|link))/.test(tool.name)), tools.map((tool) => tool.name).join());
    const list = JSON.parse(((await client.callTool({ name: 'elabora_review_list', arguments: {} })).content as { text: string }[])[0].text);
    assert.deepEqual([list.space, list.course, list.reviews.map((r: { id: string }) => r.id)], ['mcp-author', 'diagnostic-reseau', [review]]);
    const answer = JSON.parse(((await client.callTool({ name: 'elabora_review_comments', arguments: { state: 'open' } })).content as { text: string }[])[0].text);
    const [comment] = answer.reviews[0].comments;
    assert.deepEqual([comment.place.screen.file, comment.place.block.type, comment.text], ['screens/accueil.json', 'text', 'Objectifs : trop vagues.']);
    await client.close();
  }
  // Signed out: the tool says to ask the author, never for a code.
  fs.rmSync(process.env.ELABORA_CLOUD_SESSION_FILE!);
  const server = createMcpServer(dir);
  const client = new Client({ name: 'cloud-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const refused = await client.callTool({ name: 'elabora_review_comments', arguments: {} });
  assert.equal(refused.isError, true);
  assert.match((refused.content as { text: string }[])[0].text, /Ask the author to give you a read-only AI key .*or to sign in from a terminal/);
  await client.close();
});

test('AI key: made with the session and kept in a 0600 file; agents read with it, and everything else says a session is needed', async () => {
  const { dir, review, version } = await reviewedCourse('ai-key-author');
  const session = JSON.parse(fs.readFileSync(process.env.ELABORA_CLOUD_SESSION_FILE!, 'utf8')).token as string;
  fake.reviewerComment(review, { version, language: 'fr', screen: '0', block: 'accueil-situation', line: 'marc-appel', word: 'Marc', said: 'Bonjour, c\'est Marc.', speaker: 'Marc', frame: { width: 1600, height: 900 } }, 'Trop long.');

  const made = await elabora(['account', 'ai-key', 'create', '--name', 'Claude · macOS', '--json']);
  assert.equal(made.status, 0, made.stderr);
  assert.doesNotMatch(made.stdout + made.stderr, SECRET, 'the key is in no output');
  const first = JSON.parse(made.stdout);
  assert.deepEqual([first.aiKey.name, first.space, first.file, first.forgotSession], ['Claude · macOS', 'ai-key-author', process.env.ELABORA_CLOUD_AI_KEY_FILE, false]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  const kept = JSON.parse(fs.readFileSync(first.file, 'utf8'));
  assert.deepEqual([kept.format, kept.id, kept.space, kept.api], ['elabora-ai-key/1', first.aiKey.id, 'ai-key-author', fake.url]);
  assert.match(kept.key, /^ear_[A-Za-z0-9_-]{43}$/);
  // Both kept: the author's commands use the session, agents' read tools the key.
  assert.equal(resolveCredential()!.kind, 'session');
  assert.equal(resolveCredential(undefined, { readOnly: true })!.kind, 'ai');
  const listed = JSON.parse((await elabora(['account', 'ai-key', 'list', '--json'])).stdout);
  assert.deepEqual(listed.aiKeys.map((key: { id: string; here: boolean; lastUsedAt: string | null }) => [key.id, key.here, key.lastUsedAt]), [[first.aiKey.id, true, null]]);
  assert.match((await elabora(['account', 'status'])).stdout, /A read-only AI key « Claude · macOS » is kept too/);
  assert.deepEqual((await accountSessions()).aiKeys.map((key) => key.id), [first.aiKey.id], 'listed with the devices');

  const server = createMcpServer(dir, { readOnly: true });
  const client = new Client({ name: 'cloud-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const list = JSON.parse(((await client.callTool({ name: 'elabora_review_list', arguments: {} })).content as { text: string }[])[0].text);
  assert.deepEqual([list.space, list.publications, list.reviews.map((r: { id: string }) => r.id)], ['ai-key-author', [], [review]], 'found by the versions\' course, without the publications');
  const answer = JSON.parse(((await client.callTool({ name: 'elabora_review_comments', arguments: {} })).content as { text: string }[])[0].text);
  assert.deepEqual([answer.reviews[0].comments[0].place.line.id, answer.reviews[0].comments[0].text], ['marc-appel', 'Trop long.']);
  await client.close();
  assert.ok(fake.aiKeys.get(first.aiKey.id)!.lastUsedAt, 'the MCP tools read with the AI key');

  // In place of the session: what agents can reach here only reads.
  const second = JSON.parse((await elabora(['account', 'ai-key', 'create', '--replace-session', '--json'])).stdout);
  assert.equal(second.forgotSession, true);
  assert.equal(second.aiKey.name, `AI · ${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform as string] ?? process.platform}`);
  assert.equal(fs.existsSync(process.env.ELABORA_CLOUD_SESSION_FILE!), false);
  assert.equal(resolveCredential()!.kind, 'ai');
  const reads = await elabora(['review', 'comments', dir, '--json']);
  assert.equal(reads.status, 0, reads.stderr);
  assert.equal(JSON.parse(reads.stdout).reviews[0].comments[0].text, 'Trop long.');
  assert.equal((await elabora(['review', 'list', dir])).status, 0);
  const status = await elabora(['account', 'status']);
  assert.match(status.stdout, /^Read-only AI key ear_…\S+ « AI · .+ » for the space ai-key-author \(1 review\(s\)\)/);
  for (const args of [['publish', dir, '--private'], ['review', 'resolve', review, '1'], ['review', 'reply', review, '1', 'Corrigé.'], ['review', 'close', review], ['review', 'link', review], ['review', 'create', dir], ['publication', 'versions', 'diagnostic-reseau-review'], ['account', 'handle', 'autre']]) {
    const refused = await elabora(args);
    assert.equal(refused.status, 1, `${args.join(' ')}: ${refused.stdout}`);
    assert.match(refused.stderr, /read-only AI key \(« AI · .+ »\): it lists reviews and reads their comments, nothing else\. .*need the author's session: the author signs in with elabora account login/, args.join(' '));
  }
  // Refused by the hosting too (403 read-only-key), said the same way.
  await assert.rejects(handleAvailable('autre'), (error: CloudError) => error.code === 'E_CLOUD_SESSION_REQUIRED');
  assert.equal(fake.comments.find((c) => c.number === 1)!.state, 'open', 'nothing was resolved');

  // The note, set with the session (the app's), comes back in the review.
  assert.equal((await setReviewNote(review, 'Merci !', fake.url).catch((error: CloudError) => error.code)), 'E_CLOUD_SESSION_REQUIRED');

  // Revoked with the session: refused at once, and forgotten here.
  const key = JSON.parse(fs.readFileSync(process.env.ELABORA_CLOUD_AI_KEY_FILE!, 'utf8')).key as string;
  const revoked = await revokeAiKey(second.aiKey.id, { token: session });
  assert.deepEqual(revoked, { revoked: true, aiKey: second.aiKey.id, forgotten: true });
  assert.equal(resolveCredential(), null);
  const keyFile = path.join(credentials, 'handed-over');
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  const gone = await elabora(['review', 'list', '--all'], { env: { ELABORA_CLOUD_KEY_FILE: keyFile, ELABORA_CLOUD_SPACE: 'ai-key-author' } });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /refused the read-only AI key \(revoked, or the account closed\)/);
  assert.doesNotMatch(gone.stderr, SECRET);
});

test('review create --note: a word to reviewers under the inviter\'s name', async () => {
  const author = 'note-author';
  await signIn(author);
  const dir = copy(path.join(ROOT, 'examples/diagnostic-reseau'));
  await publishCourse(dir, { visibility: 'private' });
  const made = await elabora(['review', 'create', dir, '--note', 'Surtout les scènes 3 et 4. Merci d’ici vendredi !']);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /\n {2}Your note to reviewers: « Surtout les scènes 3 et 4\. Merci d’ici vendredi ! »\n/);
  const id = /Review (rv_[0-9a-f]{20})/.exec(made.stdout)![1];
  assert.equal(fake.reviews.get(id)!.note, 'Surtout les scènes 3 et 4. Merci d’ici vendredi !');
  assert.equal((await setReviewNote(id, null)).note, null);
});

test('resolveComments: steps with their labels, a word named by the bridge, comments on a translation', () => {
  const dir = copy(path.join(ROOT, 'examples/medieval-charts'));
  const lock = readJSON(dir, 'elabora.lock.json').keys as Record<string, string>;
  const workshop = readJSON(dir, 'screens/workshop.json');
  const block = workshop.blocks.find((b: { step?: number }) => b.step === 2);
  const thread = (n: number, anchor: { language: string; screen: string } & Record<string, unknown>) => ({ id: `cm_${n}`, number: n, parent: null, version: '0123456789abcdef', versionNumber: 1, screen: String(anchor.screen), anchor: { version: '0123456789abcdef', frame: { width: 1600, height: 900 }, ...anchor }, text: `t${n}`, by: { kind: 'reviewer', name: 'R' }, mine: false, state: 'open' as const, resolvedAt: null, createdAt: '2026-10-14T10:00:00Z', editedAt: null, deleted: false, rev: n });
  const review: CloudReview = { id: 'rv_00000000000000000000', space: 's', publication: 'medieval-charts-review', title: 'T', state: 'open', languages: ['en'], latest: 1, versions: [], comments: { open: 2, resolved: 0 }, reviewers: 1, rev: 2, createdAt: '', updatedAt: '' };
  const answer: CommentsAnswer = {
    review: review.id,
    rev: 2,
    comments: [
      thread(1, { language: 'en', screen: lock['screen:workshop'], block: block.id, step: 2, line: 'nope', word: 'chart', occurrence: 2 }),
      thread(2, { language: 'fr', screen: 'workshop', courseVersion: '1.0.0' })
    ]
  };
  const result = resolveComments(answer, review, { courseDir: dir, api: 'http://127.0.0.1:1', space: 's' });
  const [stepped, translated] = result.comments;
  assert.deepEqual(stepped.place!.step, { number: 2, label: workshop.steps['2'].label });
  assert.deepEqual(stepped.place!.block, { id: block.id, type: block.type, path: `/blocks/${workshop.blocks.indexOf(block)}`, layer: null });
  assert.deepEqual(stepped.place!.line, { id: 'nope', speaker: null, text: null, word: { index: null, text: 'chart', occurrence: 2 } });
  assert.equal(stepped.version.screenChanged, null, 'not published from this computer');
  assert.deepEqual([translated.place!.screen.id, translated.place!.translation], ['workshop', 'translations/fr.xlf']);
  assert.deepEqual([stepped.version.course, translated.version.course], [null, '1.0.0'], 'the course version from the anchor without a record');
});

test('the account for Réglages › Compte: devices, the display name, the handle with a name, and erasure by a fresh code', async () => {
  const email = 'settings@example.org';
  await verifySignIn(email, FAKE_CODE, { device: 'Elabora · macOS' });
  const account = await chooseHandle('settings-author', { displayName: 'Claire Martin' });
  assert.deepEqual([account.handle, account.displayName], ['settings-author', 'Claire Martin']);
  // A second device, signed in elsewhere (its token kept aside).
  const here = readSession()!;
  await verifySignIn(email, FAKE_CODE, { device: 'Elabora CLI · Linux' });
  const other = readSession()!;
  fs.writeFileSync(process.env.ELABORA_CLOUD_SESSION_FILE!, JSON.stringify(here));
  const { sessions } = await accountSessions();
  assert.deepEqual(sessions.map((s) => [s.device, s.current]), [['Elabora · macOS', true], ['Elabora CLI · Linux', false]]);
  assert.deepEqual(Object.keys(sessions[0]!).sort(), ['createdAt', 'current', 'device', 'expiresAt', 'id', 'lastUsedAt']);
  const revoked = await revokeSession(sessions[1]!.id);
  assert.deepEqual([revoked.revoked, revoked.current, revoked.forgotten], [true, false, false]);
  assert.equal(fake.tokens.has(other.token), false, 'that device is signed out');
  await assert.rejects(revokeSession('ses_nope'), (error: CloudError) => error.code === 'E_CLOUD_SESSION_ID');

  const renamed = await updateAccount({ displayName: 'Claire M.', language: 'en' });
  assert.deepEqual([renamed.displayName, renamed.language], ['Claire M.', 'en']);
  assert.equal((await updateAccount({ displayName: null })).displayName, null);

  // Erasure: the code first; the handle confirms; a wrong code says the tries left.
  await assert.rejects(deleteAccount('settings-author', FAKE_CODE), (error: CloudError) => error.code === 'code-expired');
  assert.deepEqual(await requestDeletionCode(), { sent: true, expiresIn: 600, codeLength: 8 });
  await assert.rejects(deleteAccount('autre', FAKE_CODE), (error: CloudError) => error.code === 'confirmation-required');
  await assert.rejects(deleteAccount('settings-author', '00000000'), (error: CloudError) => error.code === 'invalid-code' && (error.details as { attemptsLeft: number }).attemptsLeft === 4);
  assert.ok(readSession(), 'a refused code keeps the session');
  const erased = await deleteAccount('settings-author', '1234-5678');
  assert.deepEqual([erased.deleted, erased.space, erased.forgotten], [true, 'settings-author', true]);
  assert.equal(readSession(), null, 'the session is forgotten here');
  assert.equal(fake.tokens.has(here.token), false);
});

test('the handle changes once in 30 days (protocol 7): the command line asks for --change, the session follows the new name', async () => {
  await signIn('rename-author');
  const refused = await elabora(['account', 'handle', 'rename-other']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /stops the old address at once[\s\S]*--change/);
  assert.equal((await accountStatus()).account!.handle, 'rename-author', 'nothing changed without --change');
  const changed = await elabora(['account', 'handle', 'rename-other', '--change', '--json']);
  assert.equal(changed.status, 0, changed.stderr);
  const account = JSON.parse(changed.stdout).account;
  assert.equal(account.handle, 'rename-other');
  assert.ok(Date.parse(account.nextHandleChangeAt) > Date.now() + 29 * 86_400_000);
  assert.equal(JSON.parse(fs.readFileSync(process.env.ELABORA_CLOUD_SESSION_FILE!, 'utf8')).handle, 'rename-other', 'the session file names the new space');
  await assert.rejects(chooseHandle('rename-third'), (error: CloudError) => error.code === 'handle-change-too-soon');
  const status = await elabora(['account', 'status']);
  assert.match(status.stdout, /may change again from \d{4}-\d{2}-\d{2}/);
});

test('unpublish (« Retirer du web ») and a review\'s title', async () => {
  await signIn('unpublish-author');
  const dir = copy(path.join(ROOT, 'examples/medieval-charts'));
  const published = await publishCourse(dir);
  assert.deepEqual(published.checks, [], 'a public build has no check let through');
  const gone = await unpublish(published.name);
  assert.deepEqual(gone, { unpublished: true, versionsDeleted: 1, blobsDeleted: 0, uploadsExpired: 0, space: 'unpublish-author', name: published.name });
  assert.equal(fake.publications.get('unpublish-author')!.has(published.name), false);
  await assert.rejects(unpublish(published.name), (error: CloudError) => error.code === 'not-published');
  await assert.rejects(unpublish('Pas un nom'), (error: CloudError) => error.code === 'E_CLOUD_NAME');
  // A private one a review shows is refused until the review goes.
  const reviewed = await publishCourse(dir, { visibility: 'private' });
  const { review } = await createReview(reviewed.name);
  await assert.rejects(unpublish(reviewed.name), (error: CloudError) => error.code === 'in-review');
  assert.equal((await renameReview(review.id, 'Relecture des cartes, v2')).title, 'Relecture des cartes, v2');
  assert.equal(fake.reviews.get(review.id)!.title, 'Relecture des cartes, v2');
  await assert.rejects(renameReview(review.id, '  '), (error: CloudError) => error.code === 'invalid-name');
});

test('publish: red checks stop the web, never the reviewers; errors of the course stop both', async () => {
  await signIn('checks-author');
  const dir = copy(path.join(ROOT, 'examples/diagnostic-reseau'));
  // An image without alt (a guardrail) and a plan item that does not exist (the delivery checklist).
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.covers.push('ITEM-99');
  screen.blocks.push({ id: 'chemin-sans-alt', type: 'image', props: { asset: 'images/ticket-marc.svg' } });
  writeJSON(dir, 'screens/chemin.json', screen);
  await assert.rejects(publishCourse(dir), (error: CloudError) => error.code === 'E_CLOUD_BUILD' && /E_IMAGE_ALT_MISSING|E_PLAN_REFERENCE/.test(error.message));
  const sent = await publishCourse(dir, { visibility: 'private' });
  assert.deepEqual(sent.checks.map((check) => check.code).sort(), ['E_IMAGE_ALT_MISSING', 'E_PLAN_REFERENCE']);
  assert.ok(sent.checks.every((check) => check.rule && check.message), JSON.stringify(sent.checks));
  // The command line says what it let through.
  screen.title = `${screen.title} (v2)`;
  writeJSON(dir, 'screens/chemin.json', screen);
  const run = await elabora(['publish', dir, '--private']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\n {2}2 check\(s\) still fail: reviewers see it anyway, the web and the package wait for them\.\n {3}· E_/);
  // An error of the course itself stops the review build too.
  screen.blocks[0].props.level = 'huge';
  writeJSON(dir, 'screens/chemin.json', screen);
  await assert.rejects(publishCourse(dir, { visibility: 'private' }), (error: CloudError) => error.code === 'E_CLOUD_BUILD');
});
