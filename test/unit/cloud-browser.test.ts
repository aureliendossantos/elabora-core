import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openProject, type Session } from '@elabora/engine/session';
import { openCopy, type BrowserSession } from '@elabora/engine/browser/session';
import { memoryCopy } from '@elabora/engine/browser/store';
import { CloudClient } from '@elabora/node/cloud/client';
import { folderCopy, keepConfirmed, writeLink, type ProjectLink } from '@elabora/node/cloud/projects';
import { readProjectFiles } from '@elabora/node/project-reader';
import type { ProjectSummary, ScreenView, UndoView } from '@elabora/engine/protocol';
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
  const store = memoryCopy({ link: { team: 'tm_test', project: 'prj_test', client: 'cbrowser', person: { id: 'acc_bea', name: 'Béa' }, head: room.head, epoch: null, waiting: [], journal: 0 }, confirmed: room.files });
  const session = await openCopy({ id: 'cloud:tm_test.prj_test', store, api: 'http://localhost:1', connect: room.connect, backoff: [20] });
  closing.push(() => session.close());
  return session;
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
