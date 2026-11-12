import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openProject, type Session } from '@elabora/engine/session';
import type { RoomSocket } from '@elabora/engine/session-cloud';
import { acceptChange, journalOf, type ClientMessage, type Committed, type ServerMessage } from '@elabora/core/sync/index';
import { changesToUndo } from '@elabora/core/ops/batch';
import type { Presence } from '@elabora/core/sync/protocol';
import type { Files } from '@elabora/core/ops/types';
import { CloudClient } from '@elabora/node/cloud/client';
import { keepConfirmed, projectsApi, writeLink, type ProjectLink } from '@elabora/node/cloud/projects';
import { readProjectFiles } from '@elabora/node/project-reader';
import { copyExample, readJSON } from '../helpers.ts';

// A folder linked to a project in the cloud (D83): two engine sessions on two copies, kept in sync
// through a room in memory that places changes with the core's acceptChange, as the hosting's does.

const sessions: Session[] = [];
after(async () => { for (const session of sessions) await session.close({ media: 'cancel' }); });

class Room {
  head = 0;
  files: Files;
  log: Committed[] = [];
  readonly sockets = new Set<FakeSocket>();
  // The next submissions refused with this code (a room that could not find a medium).
  refuse: { code: 'E_SYNC_BLOB_MISSING'; times: number } | null = null;
  refused = 0;
  constructor(files: Files) { this.files = files; }

  connect = (): RoomSocket => {
    const socket = new FakeSocket(this);
    this.sockets.add(socket);
    queueMicrotask(() => socket.emit('open'));
    return socket;
  };

  receive(from: FakeSocket, message: ClientMessage): void {
    if (message.type === 'hello') {
      from.presence = { actor: message.actor, client: message.client, at: '2026-11-12T09:00:00.000Z' };
      from.deliver({ type: 'welcome', protocol: 'elabora-sync/1', head: this.head, peers: this.peers() });
      return this.tellPresence(from);
    }
    if (message.type === 'catchup') return from.deliver({ type: 'catchup', changes: this.log.filter((change) => change.seq > message.since), head: this.head });
    if (message.type !== 'submit') return;
    if (this.refuse && this.refuse.times-- > 0) {
      this.refused++;
      return from.deliver({ type: 'refused', refusal: { id: message.change.id, code: this.refuse.code, message: 'Send the medium first.' }, head: this.head });
    }
    const accepted = acceptChange({ head: this.head, files: this.files, log: this.log }, message.change);
    if ('refusal' in accepted) return from.deliver({ type: 'refused', refusal: accepted.refusal, head: this.head });
    if (!accepted.duplicate) {
      this.head = accepted.committed.seq;
      this.files = accepted.files;
      this.log.push(accepted.committed);
      for (const other of this.sockets) if (other !== from) other.deliver({ type: 'change', change: accepted.committed });
    }
    from.deliver({ type: 'ack', change: accepted.committed });
  }

  peers(): Presence[] { return [...this.sockets].flatMap((socket) => (socket.presence ? [socket.presence] : [])); }
  tellPresence(except: FakeSocket | null): void {
    for (const other of this.sockets) if (other !== except) other.deliver({ type: 'presence', peers: this.peers() });
  }

  // The connection drops; the copy reconnects by itself.
  drop(): void { for (const socket of [...this.sockets]) socket.close(); }
}

class FakeSocket implements RoomSocket {
  readyState = 0;
  readonly #listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  readonly room: Room;
  presence: Presence | null = null;
  constructor(room: Room) { this.room = room; }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown): void {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
  send(data: string): void {
    if (this.readyState !== 1) return;
    const message = JSON.parse(data) as ClientMessage;
    setTimeout(() => this.room.receive(this, message), 2);
  }
  deliver(message: ServerMessage): void {
    if (this.readyState === 1) setTimeout(() => this.emit('message', JSON.stringify(message)), 2);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.room.sockets.delete(this);
    if (this.presence) this.room.tellPresence(null);
    this.emit('close');
  }
}

async function linked(room: Room, dir: string): Promise<Session> {
  const { files } = readProjectFiles(dir);
  const link: ProjectLink = {
    format: 'elabora-cloud-project/1', api: 'http://localhost:1', team: 'tm_test', project: 'prj_test', client: `c${path.basename(dir)}`,
    person: { id: 'acc_ada', name: 'Ada' }, head: room.head, confirmed: keepConfirmed(dir, files), waiting: [], journal: 0
  };
  writeLink(dir, link);
  const session = await openProject(dir, {
    cloud: { api: link.api, client: new CloudClient(link.api, 't'), token: 't', link, connect: room.connect, backoff: [20] },
    backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0, debounceMs: 30
  });
  sessions.push(session);
  return session;
}

// Every copy has the room's head and sends nothing, and its folder is written: a copy's head moves
// when it takes a change in, the folder in the same step of its queue a moment later, so the head
// alone says the change arrived, not that the folder holds it. flush() waits behind that step.
async function settled(room: Room, ...copies: Session[]): Promise<void> {
  const started = Date.now();
  const caughtUp = () => copies.every((copy) => copy.cloud?.online && copy.cloud.head === room.head && !copy.cloud.pending);
  for (;;) {
    if (Date.now() - started > 20_000) throw new Error(`not settled: room ${room.head}, ${copies.map((copy) => JSON.stringify({ ...copy.cloud })).join(' ')}`);
    if (caughtUp()) {
      await Promise.all(copies.map((copy) => copy.flush()));
      if (caughtUp()) return;
    } else await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const screen = (dir: string, id: string) => readJSON(dir, `screens/${id}.json`);
const sameFolders = (a: string, b: string) => {
  for (const rel of [...readProjectFiles(a).files.keys(), ...readProjectFiles(b).files.keys()]) {
    const [x, y] = [fs.readFileSync(path.join(a, rel)), fs.readFileSync(path.join(b, rel))];
    if (rel.endsWith('.json') ? JSON.stringify(JSON.parse(x.toString())) !== JSON.stringify(JSON.parse(y.toString())) : !x.equals(y)) return rel;
  }
  return null;
};

test('projects in the cloud are on a test server only: no address, or Elabora\'s hosting, is refused', () => {
  assert.throws(() => projectsApi(''), /test server/);
  assert.throws(() => projectsApi('https://api.elabora.studio'), /not open/);
  assert.equal(projectsApi('https://staging.example.test'), 'https://staging.example.test');
});

test('two linked folders stay the same: a person\'s edit, a file an agent writes, offline and back, an agent\'s run sent as one', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  const b = await linked(room, B);
  await settled(room, a, b);

  // A person in A, through the session.
  await a.run('update_screen', { id: 'chemin', title: 'Titre de la personne' }, { kind: 'human' });
  await settled(room, a, b);
  assert.equal(screen(B, 'chemin').title, 'Titre de la personne');

  // A file written in B by a program that is not an Elabora tool.
  const written = screen(B, 'accueil');
  written.title = 'Titre écrit dans le fichier';
  fs.writeFileSync(path.join(B, 'screens/accueil.json'), JSON.stringify(written, null, 4));
  await b.flush({ rescan: true });
  await settled(room, a, b);
  assert.equal(screen(A, 'accueil').title, 'Titre écrit dans le fichier');

  // Offline: both write meanwhile; back, they meet.
  room.drop();
  await a.run('update_screen', { id: 'chemin', title: 'Pendant la coupure (A)' }, { kind: 'human' });
  await b.run('update_screen', { id: 'simulation', title: 'Pendant la coupure (B)' }, { kind: 'human' });
  await settled(room, a, b);
  assert.deepEqual([screen(B, 'chemin').title, screen(A, 'simulation').title], ['Pendant la coupure (A)', 'Pendant la coupure (B)']);

  // An agent's run of changes in one batch goes in fewer submissions than changes.
  const before = room.log.length;
  const agent = { kind: 'agent' as const, name: 'claude-code' };
  await Promise.all(Array.from({ length: 12 }, (_, n) => b.run('update_screen', { id: 'chemin', title: `Agent ${n}` }, agent)));
  await settled(room, a, b);
  assert.equal(screen(A, 'chemin').title, 'Agent 11');
  assert.ok(room.log.length - before < 12, `${room.log.length - before} submissions for 12 changes`);
  assert.equal(sameFolders(A, B), null);
  // The journal of each folder names its person (D78), and the room's changes are journaled as sync.
  const journal = fs.readdirSync(path.join(A, '.elabora/journal')).flatMap((file) => fs.readFileSync(path.join(A, '.elabora/journal', file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
  assert.ok(journal.some((entry) => entry.command?.name === 'update_screen' && entry.author.id === 'acc_ada'));
  assert.ok(journal.some((entry) => entry.command?.name === 'sync'));
});

test('a change the room refused for a missing medium goes again, and is placed', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  const b = await linked(room, B);
  await settled(room, a, b);
  const refusals: unknown[] = [];
  a.subscribe((message) => { if (message.kind === 'event' && message.event.type === 'cloudOutcome' && 'refused' in message.event.outcome) refusals.push(message.event.outcome); });
  room.refuse = { code: 'E_SYNC_BLOB_MISSING', times: 2 };
  await a.run('update_screen', { id: 'chemin', title: 'Après deux refus' }, { kind: 'human' });
  await settled(room, a, b);
  assert.equal(room.refused, 2);
  assert.equal(screen(B, 'chemin').title, 'Après deux refus');
  assert.deepEqual(refusals, []);
});

test('an undo in a linked folder sends what it left out, and the room keeps it (D87)', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  const b = await linked(room, B);
  await settled(room, a, b);
  const agent = { kind: 'agent' as const, name: 'claude-code' };
  await a.run('update_screen', { id: 'chemin', title: 'Titre de l\'agent' }, agent);
  await a.run('update_screen', { id: 'accueil', title: 'Accueil de l\'agent' }, agent);
  await settled(room, a, b);
  await b.run('update_screen', { id: 'chemin', title: 'Titre de la personne' }, { kind: 'human' });
  await settled(room, a, b);
  const batch = room.log.at(-2)?.batch as string;
  await a.undoBatch(batch, { kind: 'human' });
  await settled(room, a, b);
  assert.deepEqual([screen(B, 'chemin').title, screen(B, 'accueil').title === 'Accueil de l\'agent'], ['Titre de la personne', false]);
  const undo = room.log.at(-1);
  assert.ok(undo?.undoes, JSON.stringify(undo));
  assert.equal(undo?.undoes?.skipped?.length, 1, JSON.stringify(undo?.undoes));
  assert.ok(undo?.undoes?.changes.every((id) => room.log.some((change) => change.id === id)), 'its targets as the room knows them');
});

test('a folder linked while its session is open starts syncing; each copy sees who is there', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  // B is open before it is linked (the app links an open module).
  const b = await openProject(B, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0, debounceMs: 30 });
  sessions.push(b);
  // Read through a function: an assertion on the getter would narrow it for what follows.
  const cloudOf = (session: Session) => session.cloud;
  assert.equal(cloudOf(b), null);
  const { files } = readProjectFiles(B);
  const link: ProjectLink = {
    format: 'elabora-cloud-project/1', api: 'http://localhost:1', team: 'tm_test', project: 'prj_test', client: 'cB2',
    person: { id: 'acc_bea', name: 'Béa' }, head: room.head, confirmed: keepConfirmed(B, files), waiting: [], journal: 0
  };
  writeLink(B, link);
  const statuses: { peers: Presence[]; client: string }[] = [];
  b.subscribe((message) => { if (message.kind === 'event' && message.event.type === 'cloudStatus') statuses.push(message.event); });
  await b.linkCloud({ api: link.api, client: new CloudClient(link.api, 't'), token: 't', link, connect: room.connect, backoff: [20] });
  await settled(room, a, b);
  await a.run('update_screen', { id: 'chemin', title: 'Après le lien' }, { kind: 'human' });
  await settled(room, a, b);
  assert.equal(screen(B, 'chemin').title, 'Après le lien');
  assert.deepEqual(cloudOf(b)?.peers.map((peer) => peer.actor.name).sort(), ['Ada', 'Béa']);
  assert.equal(statuses.at(-1)?.client, 'cB2');
  assert.deepEqual([cloudOf(b)?.team, cloudOf(b)?.project], ['tm_test', 'prj_test']);
  await assert.rejects(b.linkCloud({ api: link.api, client: new CloudClient(link.api, 't'), token: 't', link, connect: room.connect }), /already syncs/);
  // A leaves: B sees it go.
  await a.close({ media: 'cancel' });
  sessions.splice(sessions.indexOf(a), 1);
  for (let wait = 0; wait < 80 && cloudOf(b)?.peers.length !== 1; wait++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(cloudOf(b)?.peers.map((peer) => peer.actor.name), ['Béa']);
});

test('an agent\'s run sent as one change, then undone whole in the folder: the room\'s log knows it undone (D87)', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  const b = await linked(room, B);
  await settled(room, a, b);
  const agent = { kind: 'agent' as const, name: 'claude-code' };
  const before = room.log.length;
  await Promise.all(Array.from({ length: 8 }, (_, n) => a.run('update_screen', { id: n % 2 ? 'chemin' : 'accueil', title: `Agent ${n}` }, agent)));
  await settled(room, a, b);
  const grouped = room.log.slice(before).find((change) => change.command?.name === 'changes');
  assert.ok(grouped, 'the run went grouped');
  await a.undoBatch(grouped.batch, { kind: 'human' });
  await settled(room, a, b);
  assert.notEqual(screen(B, 'chemin').title, 'Agent 7');
  assert.deepEqual(changesToUndo(journalOf(room.log), { batch: grouped.batch }).map((change) => change.id), [], 'nothing of the run left to undo in the room\'s log');
});

test('what is done in a module while its first upload runs goes to the room as its author\'s, once linked (D88)', async () => {
  const A = copyExample();
  const a = await openProject(A, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0, debounceMs: 30 });
  sessions.push(a);
  // The upload reads the module; the author goes on working before it is linked.
  const source = await a.cloudSnapshot();
  await a.run('update_screen', { id: 'chemin', title: 'Pendant l\'envoi' }, { kind: 'human' });
  const room = new Room(source.files);
  const link: ProjectLink = {
    format: 'elabora-cloud-project/1', api: 'http://localhost:1', team: 'tm_test', project: 'prj_test', client: 'cA',
    person: { id: 'acc_ada', name: 'Ada' }, head: room.head, confirmed: keepConfirmed(A, source.files), waiting: [], journal: source.journal
  };
  writeLink(A, link);
  await a.linkCloud({ api: link.api, client: new CloudClient(link.api, 't'), token: 't', link, connect: room.connect, backoff: [20] });
  await settled(room, a);
  const sent = room.log.at(-1);
  assert.equal(room.log.length, 1, JSON.stringify(room.log.map((change) => change.command)));
  assert.deepEqual([sent?.author.kind, sent?.command?.name], ['human', 'update_screen']);
  const placed = room.files.get('screens/chemin.json');
  assert.equal(placed?.kind === 'text' && JSON.parse(placed.text).title, 'Pendant l\'envoi');
});
