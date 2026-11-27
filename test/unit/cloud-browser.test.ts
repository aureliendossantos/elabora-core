import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openProject, type Session } from '@elabora/engine/session';
import { openCopy, type BrowserSession } from '@elabora/engine/browser/session';
import { memoryCopy } from '@elabora/engine/browser/store';
import { CloudClient } from '@elabora/node/cloud/client';
import { folderCopy, keepConfirmed, writeLink, type ProjectLink } from '@elabora/node/cloud/projects';
import { readProjectFiles } from '@elabora/node/project-reader';
import { isMediaAsset } from '@elabora/node/store/media';
import { putBytes } from '@elabora/node/blobs';
import type { ProjectSummary, ScreenView, UndoView } from '@elabora/engine/protocol';
import { newCourseFiles } from '@elabora/core/commands/new-course';
import { isTextPath } from '@elabora/core/project/files';
import { copyExample } from '../helpers.ts';
import { Room } from '../sync/room.ts';

// A browser engine's copy (D103, D104) and a desktop's folder on one project, through a room in memory
// placing changes as elabora-cloud's does: each sees the other's changes, a copy offline keeps its
// changes and sends them once back, they converge, and the browser's undo reaches the folder.

const closing: (() => Promise<unknown>)[] = [];
after(async () => { for (const close of closing) await close().catch(() => {}); });

async function desktop(room: Room, dir: string): Promise<Session> {
  const { files } = readProjectFiles(dir);
  const link: ProjectLink = { format: 'elabora-cloud-project/1', api: 'http://localhost:1', team: 'tm_test', project: 'prj_test', client: `c${path.basename(dir)}`, person: { id: 'acc_ada', name: 'Ada' }, head: room.head, confirmed: keepConfirmed(dir, files), waiting: [], journal: 0 };
  writeLink(dir, link);
  const session = await openProject(dir, { cloud: { api: link.api, token: 't', link, store: { ...folderCopy(dir, new CloudClient(link.api, 't'), link), membership: async () => 'member' }, connect: room.connect, backoff: [20] }, backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0, debounceMs: 30 });
  closing.push(() => session.close({ media: 'cancel' }));
  return session;
}

async function browser(room: Room): Promise<BrowserSession> {
  return (await browserCopy(room)).copy;
}

// The browser's copy with its store, and the media it took (none: it takes one when something needs it).
async function browserCopy(room: Room) {
  const taken: string[] = [];
  const kept = memoryCopy({ link: { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_bea', name: 'Béa' }, head: room.head, epoch: null, waiting: [], journal: 0 }, confirmed: room.files });
  const store = { ...kept, fetchMedium: async (hash: string) => { taken.push(hash); } };
  const copy = await openCopy({ id: 'cloud:tm_test.prj_test', store, api: 'http://localhost:1', connect: room.connect, backoff: [20] });
  closing.push(() => copy.close());
  return { copy, kept: kept.kept, taken };
}

const ask = async <T>(session: Session | BrowserSession, type: string, params: unknown): Promise<T> => {
  const answer = await session.handle({ kind: 'request', id: type, type, params });
  if (!answer.ok) throw Object.assign(new Error(answer.error.message), answer.error);
  return answer.result as T;
};

// Both copies have the room's head and send nothing; the desktop's folder written.
async function settled(room: Room, folder: Session, copy: BrowserSession): Promise<void> {
  const started = Date.now();
  const caughtUp = () => [folder.cloud, copy.cloud].every((cloud) => cloud?.online && cloud.head === room.head && !cloud.pending);
  for (;;) {
    if (Date.now() - started > 20_000) throw new Error(`not settled: room ${room.head}, ${JSON.stringify(folder.cloud)} ${JSON.stringify(copy.cloud)}`);
    if (caughtUp()) {
      await folder.flush();
      if (caughtUp()) return;
    } else await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// A wait bounded for failures only.
async function waitFor(done: () => boolean): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > 20_000) throw new Error('not reached in 20 s');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const title = async (session: Session | BrowserSession, screen: string) => (await ask<ScreenView>(session, 'readScreen', { screen })).data.title;
const block = async (session: Session | BrowserSession, screen: string, id: string) => ((await ask<ScreenView>(session, 'readScreen', { screen })).data.blocks?.find((each) => each.id === id)?.props as { markdown?: string } | undefined)?.markdown;

test('a browser\'s copy and a desktop\'s folder converge, the browser offline then back, and its undo reaches the folder', async () => {
  const dir = copyExample();
  const room = new Room(readProjectFiles(dir).files);
  const folder = await desktop(room, dir);
  const copy = await browser(room);
  await settled(room, folder, copy);

  await ask(folder, 'run', { command: 'update_screen', args: { id: 'chemin', title: 'Du bureau' } });
  await ask(copy, 'run', { command: 'update_block', args: { block: 'chemin-intro', props: { markdown: 'Du navigateur' } } });
  await settled(room, folder, copy);
  assert.deepEqual([await title(copy, 'chemin'), await block(folder, 'chemin', 'chemin-intro')], ['Du bureau', 'Du navigateur']);

  // The browser offline: its changes wait in its copy, then go once back.
  room.out('cbrowser');
  await ask(copy, 'run', { command: 'update_screen', args: { id: 'accueil', title: 'Hors ligne' } });
  await ask(folder, 'run', { command: 'update_screen', args: { id: 'chemin', title: 'Pendant ce temps' } });
  assert.equal(copy.cloud?.pending, 1);
  assert.equal((await ask<ProjectSummary>(copy, 'summary', {})).outline.flatMap((section) => section.screens).find((one) => one.id === 'accueil')?.title, 'Hors ligne');
  room.back('cbrowser');
  await settled(room, folder, copy);
  assert.deepEqual([await title(folder, 'accueil'), await title(copy, 'chemin')], ['Hors ligne', 'Pendant ce temps']);

  // The browser's ⌘Z takes back its own last step, and the folder follows.
  const undone = await ask<UndoView>(copy, 'undo', {});
  assert.equal(undone.change?.type, 'undo');
  await settled(room, folder, copy);
  assert.notEqual(await title(folder, 'accueil'), 'Hors ligne');
  assert.equal(await title(folder, 'chemin'), 'Pendant ce temps', 'the desktop\'s change stays');
});

test('a browser\'s copy knows the size and the facts of the media it never took, which the desktop gave in passing (D125, D126)', async () => {
  const dir = copyExample();
  // A picture of the folder's, sent to the room before (the sample's are SVG, texts), in its blob store as a
  // folder cloned or pushed keeps it.
  const point = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(dir, 'assets/images/point.png'), point);
  putBytes(dir, point);
  const room = new Room(readProjectFiles(dir).files);
  const media = [...room.files].flatMap(([rel, file]) => (file.kind === 'binary' && file.hash && isMediaAsset(rel) ? [{ rel, hash: file.hash, size: file.size }] : []));
  assert.ok(media.length > 0);
  const { copy, kept, taken } = await browserCopy(room);
  // The desktop's folder joins: it gives the facts of its probe for the media the room holds without them.
  const folder = await desktop(room, dir);
  await settled(room, folder, copy);
  const started = Date.now();
  while (!media.every(({ hash }) => kept.link.media?.[hash]?.facts) && Date.now() - started < 20_000) await new Promise((resolve) => setTimeout(resolve, 25));
  for (const { rel, hash, size } of media) {
    const known = kept.link.media?.[hash];
    assert.equal(known?.size, size, rel);
    assert.equal(known?.facts?.kind, room.facts.get(hash)?.kind, rel);
    assert.ok(known?.facts && known.facts.version >= 1, rel);
  }
  assert.equal(kept.link.media?.[media[0]!.hash]?.facts?.width, 1);
  assert.deepEqual(taken, []);
});

test('a project of a team just made: its new module\'s files made at once by two copies, the browser offline, give one module, the last placed person\'s values winning (D74)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-empty-'));
  const room = new Room(new Map());
  const folder = await desktop(room, dir);
  const copy = await browser(room);
  await settled(room, folder, copy);
  const course = { id: 'premier-module', title: 'Premier module', language: 'fr' };

  room.out('cbrowser');
  await ask(copy, 'run', { command: 'create_course', args: { ...course, title: 'Du navigateur' } });
  await ask(folder, 'run', { command: 'create_course', args: course });
  // The desktop's placed first, then the browser back: its change merged over it, the same module, its title.
  await waitFor(() => room.head === 1);
  room.back('cbrowser');
  await settled(room, folder, copy);
  for (const [rel, text] of newCourseFiles({ ...course, title: 'Du navigateur' })) {
    if (!isTextPath(rel)) continue;
    const written = fs.readFileSync(path.join(dir, rel), 'utf8');
    if (rel.endsWith('.json')) assert.deepEqual(JSON.parse(written), JSON.parse(text), rel);
    else assert.equal(written, text, rel);
  }
  assert.deepEqual([await title(copy, 'intro'), await title(folder, 'intro'), (await ask<ProjectSummary>(copy, 'summary', {})).course?.id], ['Du navigateur', 'Du navigateur', 'premier-module']);
});

test('a new module made by a browser\'s copy, taken by a desktop\'s folder: a file edited there by hand goes to the room alone, and nothing else waits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-empty-'));
  const room = new Room(new Map());
  const folder = await desktop(room, dir);
  const copy = await browser(room);
  await settled(room, folder, copy);
  await ask(copy, 'run', { command: 'create_course', args: { id: 'premier-module', title: 'Premier module', language: 'fr' } });
  await settled(room, folder, copy);
  // The folder read again from the disk, as a computer reads a module: every file as the room has it.
  const screen = path.join(dir, 'screens', 'intro.json');
  fs.writeFileSync(screen, fs.readFileSync(screen, 'utf8').replace('"title": "Premier module"', '"title": "À la main"'));
  await waitFor(() => room.head === 2);
  await settled(room, folder, copy);
  assert.deepEqual([room.head, room.log[1]!.ops.map((op) => op.file), await title(copy, 'intro')], [2, ['screens/intro.json'], 'À la main']);
});

test('a browser\'s copy held as its session ended is tried again once someone signed in, without reloading: held again for another account, synced for its own (cloudRestart)', async () => {
  const room = new Room(readProjectFiles(copyExample()).files);
  const copy = await browser(room);
  const held: (string | null)[] = [];
  copy.subscribe((message) => { if (message.kind === 'event' && message.event.type === 'cloudStatus') held.push(message.event.held ?? null); });
  await waitFor(() => !!copy.cloud?.online);
  assert.deepEqual(await ask(copy, 'cloudRestart', {}), { restarted: false }, 'not held: nothing to try again');
  room.hold = true;
  await ask(copy, 'run', { command: 'update_screen', args: { id: 'chemin', title: 'Avant la déconnexion' } });
  await waitFor(() => copy.cloud?.pending === 1);
  // The session ends (a sign-out elsewhere): the room closes it and would refuse its hello.
  room.refuseHello = { code: 4009, reason: 'session ended' };
  room.end('cbrowser', 4009);
  await waitFor(() => held.at(-1) === 'signed-out');
  // Someone else signs in, in the same tab: held again, nothing sent under their session.
  const hellos = room.hellos;
  assert.deepEqual(await ask(copy, 'cloudRestart', { account: 'acc_ada' }), { restarted: true });
  await waitFor(() => held.at(-1) === 'other-account');
  assert.equal(room.hellos, hellos, 'never connected for another account');
  // The copy's own account signs in again: it syncs, and its change goes.
  room.refuseHello = null;
  room.hold = false;
  assert.deepEqual(await ask(copy, 'cloudRestart', { account: 'acc_bea' }), { restarted: true });
  await waitFor(() => !!copy.cloud?.online && copy.cloud.pending === 0);
  assert.equal(await title(copy, 'chemin'), 'Avant la déconnexion');
  assert.ok(room.log.some((change) => JSON.stringify(change).includes('Avant la déconnexion')), 'placed by the room');
  await assert.rejects(ask(copy, 'cloudRestart', { account: 42 }), (error: { kind?: string }) => error.kind === 'bad-request');
});
