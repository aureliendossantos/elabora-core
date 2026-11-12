import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openProject, type Session } from '@elabora/engine/session';
import type { RoomSocket } from '@elabora/engine/session-cloud';
import { acceptChange, type ClientMessage, type Committed, type ServerMessage } from '@elabora/core/sync/index';
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
  constructor(files: Files) { this.files = files; }

  connect = (): RoomSocket => {
    const socket = new FakeSocket(this);
    this.sockets.add(socket);
    queueMicrotask(() => socket.emit('open'));
    return socket;
  };

  receive(from: FakeSocket, message: ClientMessage): void {
    if (message.type === 'hello') return from.deliver({ type: 'welcome', protocol: 'elabora-sync/1', head: this.head, peers: [] });
    if (message.type === 'catchup') return from.deliver({ type: 'catchup', changes: this.log.filter((change) => change.seq > message.since), head: this.head });
    if (message.type !== 'submit') return;
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

  // The connection drops; the copy reconnects by itself.
  drop(): void { for (const socket of [...this.sockets]) socket.close(); }
}

class FakeSocket implements RoomSocket {
  readyState = 0;
  readonly #listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  readonly room: Room;
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

async function settled(room: Room, ...copies: Session[]): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (copies.every((copy) => copy.cloud?.online && copy.cloud.head === room.head && !copy.cloud.pending)) return;
    if (Date.now() - started > 20_000) throw new Error(`not settled: room ${room.head}, ${copies.map((copy) => JSON.stringify({ ...copy.cloud })).join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
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
