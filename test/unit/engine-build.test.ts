import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openProject } from '@elabora/engine';
import type { BuildView, EngineEvent, OpenOptions, Session, ResponseMessage } from '@elabora/engine';
import { readJournal } from '@elabora/node/journal/index';
import type { Author, ChangeEntry } from '@elabora/core/ops/types';
import { copyExample, readJSON } from '../helpers.ts';

// The engine's build request: the package as `elabora build` makes it, the state keys it adds to
// elabora.lock.json journaled as the session's own system change (never as an agent's external
// edit), and a publish version.

const temporary: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) await session.close().catch(() => {});
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

const QUIET: OpenOptions = { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 };
const agent: Author = { kind: 'agent', name: 'claude-code' };

async function open(): Promise<{ dir: string; session: Session; events: EngineEvent[] }> {
  const dir = copyExample();
  temporary.push(dir);
  const session = await openProject(dir, QUIET);
  sessions.push(session);
  const events: EngineEvent[] = [];
  session.subscribe(({ event }) => events.push(event));
  await session.flush();
  return { dir, session, events };
}

const changes = (dir: string) => readJournal(dir).filter((entry): entry is ChangeEntry => entry.type === 'change');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Long enough for the watcher to report the lock the build wrote, then everything is read again.
async function settle(session: Session): Promise<void> {
  await sleep(300);
  await session.flush({ rescan: true });
}

test('build: the package, the new state keys as a system change, a publish version, and no external change', async () => {
  const { dir, session, events } = await open();
  const lockBefore = readJSON(dir, 'elabora.lock.json');
  // An agent adds a screen: it needs a state key, which only a build assigns.
  await session.run('create_screen', { id: 'chemin-suite', title: 'La suite du chemin', covers: ['ITEM-2'], section: 'decouvrir', after: 'chemin', blocks: [{ id: 'chemin-suite-texte', type: 'text', props: { markdown: 'Chaque équipement relaie la demande au suivant.' } }] }, agent);
  assert.equal(session.openBatch !== null, true, 'the agent\'s batch is open');

  const built = await session.build();
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.ok(built.zip && fs.existsSync(built.zip), 'the package is written');
  assert.equal(path.dirname(built.zip), path.join(dir, 'dist'));
  assert.equal(built.size, fs.statSync(built.zip).size);
  assert.ok(built.report && fs.existsSync(built.report));
  assert.deepEqual(built.errors, []);

  // The lock as the build wrote it, journaled by the session as a system change.
  const lock = readJSON(dir, 'elabora.lock.json');
  assert.equal(lock.keys['screen:chemin-suite'], lockBefore.next.toString(36));
  assert.ok(built.change, 'the new key is a change');
  assert.deepEqual(built.change.author, { kind: 'system' });
  assert.equal(built.change.command?.name, 'build');
  assert.deepEqual(built.change.files, ['elabora.lock.json']);
  assert.equal(session.readFile('elabora.lock.json').kind === 'text' && JSON.parse((session.readFile('elabora.lock.json') as { text: string }).text).keys['screen:chemin-suite'], lock.keys['screen:chemin-suite']);
  assert.ok(events.some((event) => event.type === 'changed' && event.source === 'engine' && event.change.id === built.change?.id));

  // Publishing closed the agent's batch (its after-ai version first), then took the publish version.
  assert.equal(session.openBatch, null);
  assert.ok(events.some((event) => event.type === 'batchClosed'));
  assert.ok(built.version);
  const publish = session.backups().find((version) => version.id === built.version);
  assert.equal(publish?.reason, 'publish');
  assert.match(publish?.name ?? '', /^Publié le \d{1,2} \S+ \d{4}$/, 'named after the date, in the course language');
  assert.ok(session.backups().findIndex((version) => version.reason === 'after-ai') < session.backups().findIndex((version) => version.id === built.version));

  // The watcher sees the lock the build wrote, and settles it as the session's own write.
  await settle(session);
  const journal = changes(dir);
  assert.deepEqual(journal.filter((entry) => entry.author.kind === 'external').map((entry) => entry.files.map((file) => file.path)), [], 'no external change');
  assert.equal(journal.filter((entry) => entry.command?.name === 'build').length, 1);
  assert.equal(events.filter((event) => event.type === 'changed' && event.source === 'watcher').length, 0);

  // Built again with nothing new: no change, a new publish version all the same, under the name given.
  const again = await session.build({ name: 'Livraison client', mediaQuality: 'high' });
  assert.equal(again.ok, true);
  assert.equal(again.change, null);
  assert.equal(session.backups().find((version) => version.id === again.version)?.name, 'Livraison client');
  await settle(session);
  assert.equal(changes(dir).filter((entry) => entry.author.kind === 'external').length, 0);
});

test('build: a build that stops gives its errors and takes no publish version', async () => {
  const { dir, session } = await open();
  await session.run('add_block', { screen: 'chemin', block: { id: 'chemin-plan', type: 'image', props: { asset: 'images/absent.svg', alt: 'Plan du réseau' } }, after: 'chemin-intro' });
  const versions = session.backups().length;

  const built: BuildView = await session.build();
  assert.equal(built.ok, false);
  assert.equal(built.zip, null);
  assert.equal(built.size, 0);
  assert.equal(built.version, null);
  assert.ok(built.errors.some((d) => d.code === 'E_ASSET_MISSING'), JSON.stringify(built.errors.map((d) => d.code)));
  assert.ok(built.errors.every((d) => d.severity === 'error'));
  assert.equal(built.summary.errors >= built.errors.length, true);
  assert.equal(session.backups().filter((version) => version.reason === 'publish').length, 0);
  assert.ok(session.backups().length >= versions);
  await settle(session);
  assert.equal(changes(dir).filter((entry) => entry.author.kind === 'external').length, 0);
});

test('build over the protocol: typed result, bad parameters refused', async () => {
  const { session } = await open();
  const response = await session.handle({ kind: 'request', id: 'b1', type: 'build', params: { profiles: ['moodle'] } }) as ResponseMessage;
  assert.equal(response.ok, true, JSON.stringify(response));
  if (response.ok && response.type === 'build') assert.equal((response.result as BuildView).ok, true);
  const bare = await session.handle({ kind: 'request', id: 'b0', type: 'build', params: null }) as ResponseMessage;
  assert.equal(bare.ok, true, JSON.stringify(bare));

  for (const params of [{ mediaQuality: 'ultra' }, { profiles: 'moodle' }, { release: 'yes' }, { name: 3 }]) {
    const refused = await session.handle({ kind: 'request', id: 'b2', type: 'build', params }) as ResponseMessage;
    assert.equal(refused.ok, false, JSON.stringify(params));
    if (!refused.ok) assert.equal(refused.error.kind, 'bad-request');
  }
});
