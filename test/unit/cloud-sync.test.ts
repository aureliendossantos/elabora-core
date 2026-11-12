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
import { keepConfirmed, linkFile, projectsApi, writeLink, type ProjectLink } from '@elabora/node/cloud/projects';
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
  // Copies kept out (their hello closes the connection): offline until let back in.
  readonly away = new Set<string>();
  // Submissions taken but not answered while true (a change waiting in the copy).
  hold = false;
  // Each copy's role in the project, by client (C37): a viewer's submissions refused; said in welcome
  // (D94) unless sayRole is false, as a room before it.
  readonly roles = new Map<string, 'owner' | 'editor' | 'viewer'>();
  sayRole = true;
  // Every hello closed with this code (elabora-cloud C80, C83: another protocol, a newer storage, every
  // connection taken), and how many hellos came.
  refuseHello: { code: 4005 | 4006 | 4007; reason?: string } | null = null;
  hellos = 0;
  constructor(files: Files) { this.files = files; }

  connect = (): RoomSocket => {
    const socket = new FakeSocket(this);
    this.sockets.add(socket);
    queueMicrotask(() => socket.emit('open'));
    return socket;
  };

  receive(from: FakeSocket, message: ClientMessage): void {
    if (message.type === 'hello') {
      this.hellos++;
      if (this.refuseHello) return from.close(this.refuseHello.code, this.refuseHello.reason);
      if (this.away.has(message.client)) return from.close();
      from.presence = { actor: message.actor, client: message.client, at: '2026-11-12T09:00:00.000Z' };
      const role = this.roles.get(message.client);
      from.deliver({ type: 'welcome', protocol: 'elabora-sync/1', head: this.head, peers: this.peers(), ...(role && this.sayRole ? { role } : {}) });
      return this.tellPresence(from);
    }
    if (message.type === 'catchup') return from.deliver({ type: 'catchup', changes: this.log.filter((change) => change.seq > message.since), head: this.head });
    // The room relays where a copy is, as elabora-cloud's does (screen, selection, and the view, D91).
    if (message.type === 'presence') {
      if (!from.presence) return;
      const { screen, selection, view } = message.presence;
      from.presence = { actor: from.presence.actor, client: from.presence.client, at: from.presence.at, ...(screen ? { screen } : {}), ...(selection ? { selection } : {}), ...(view ? { view } : {}) };
      return this.tellPresence(null);
    }
    if (message.type !== 'submit' || this.hold) return;
    if (from.presence && this.roles.get(from.presence.client) === 'viewer') return from.deliver({ type: 'refused', refusal: { id: message.change.id, code: 'E_SYNC_READ_ONLY', message: 'A viewer reads this project.' }, head: this.head });
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
  // One copy offline until back() (its reconnections closed meanwhile).
  out(client: string): void { this.away.add(client); for (const socket of [...this.sockets]) if (socket.presence?.client === client) socket.close(); }
  back(client: string): void { this.away.delete(client); }
  // The person's role changed while connected (D93), as the room tells its open connections.
  role(client: string, role: 'owner' | 'editor' | 'viewer'): void {
    this.roles.set(client, role);
    for (const socket of this.sockets) if (socket.presence?.client === client) socket.deliver({ type: 'role', role });
  }
  // A copy sent away for good: its membership ended (4003), or the project was deleted (4004).
  end(client: string, code: 4003 | 4004): void { for (const socket of [...this.sockets]) if (socket.presence?.client === client) socket.close(code); }
}

class FakeSocket implements RoomSocket {
  readyState = 0;
  readonly #listeners = new Map<string, ((event: { data: unknown; code?: number; reason?: string }) => void)[]>();
  readonly room: Room;
  presence: Presence | null = null;
  constructor(room: Room) { this.room = room; }
  addEventListener(type: string, listener: (event: { data: unknown; code?: number; reason?: string }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown, code?: number, reason?: string): void {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.#listeners.get(type) ?? []) listener({ data, ...(code ? { code } : {}), ...(reason ? { reason } : {}) });
  }
  send(data: string): void {
    if (this.readyState !== 1) return;
    const message = JSON.parse(data) as ClientMessage;
    setTimeout(() => this.room.receive(this, message), 2);
  }
  deliver(message: ServerMessage): void {
    if (this.readyState === 1) setTimeout(() => this.emit('message', JSON.stringify(message)), 2);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.room.sockets.delete(this);
    if (this.presence) this.room.tellPresence(null);
    this.emit('close', undefined, code, reason);
  }
}

async function linked(room: Room, dir: string, membership: () => Promise<'member' | 'removed' | 'deleted' | 'unknown'> = async () => 'member', later = 300): Promise<Session> {
  const { files } = readProjectFiles(dir);
  const link: ProjectLink = {
    format: 'elabora-cloud-project/1', api: 'http://localhost:1', team: 'tm_test', project: 'prj_test', client: `c${path.basename(dir)}`,
    person: { id: 'acc_ada', name: 'Ada' }, head: room.head, confirmed: keepConfirmed(dir, files), waiting: [], journal: 0
  };
  writeLink(dir, link);
  const session = await openProject(dir, {
    cloud: { api: link.api, client: new CloudClient(link.api, 't'), token: 't', link, connect: room.connect, backoff: [20], later, membership },
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

const until = async (test: () => boolean, what: string): Promise<void> => {
  for (let wait = 0; wait < 200 && !test(); wait++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(test(), what);
};

test('a person who writes over a value written here unseen: told here, not to them; an agent\'s value left out names who changed it (D90)', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  const b = await linked(room, B);
  await settled(room, a, b);
  const events = (session: Session, type: string) => {
    const seen: Record<string, unknown>[] = [];
    session.subscribe((message) => { if (message.kind === 'event' && message.event.type === type) seen.push(message.event as unknown as Record<string, unknown>); });
    return seen;
  };
  const replacedA = events(a, 'cloudReplaced');
  const replacedB = events(b, 'cloudReplaced');
  const outcomesA = events(a, 'cloudOutcome');
  // B offline writes the title A wrote meanwhile, without having seen it: B's value wins, A is told.
  const clientB = b.cloud!.client;
  room.out(clientB);
  await a.run('update_screen', { id: 'chemin', title: 'Titre d\'Ada' }, { kind: 'human' });
  await settled(room, a);
  await b.run('update_screen', { id: 'chemin', title: 'Titre de Béa' }, { kind: 'human' });
  room.back(clientB);
  await settled(room, a, b);
  assert.equal(screen(A, 'chemin').title, 'Titre de Béa');
  // Told once the change is placed here, which may be a moment after the folders agree.
  await until(() => replacedA.length > 0, 'A is told its value was replaced');
  assert.equal(replacedA.length, 1, JSON.stringify(replacedA));
  const told = replacedA[0] as { overwrote: { file: string; path: string; was: unknown; now: unknown }[]; change: { author: { kind: string } } };
  assert.deepEqual([told.overwrote[0]?.file, told.overwrote[0]?.path, told.overwrote[0]?.was, told.overwrote[0]?.now, told.change.author.kind], ['screens/chemin.json', 'title', 'Titre d\'Ada', 'Titre de Béa', 'human']);
  assert.equal(replacedB.length, 0, 'the one who replaced is not told');
  // A's agent, offline, writes the title B writes meanwhile: the agent's value gives way, and says to whom.
  const clientA = a.cloud!.client;
  room.out(clientA);
  await b.run('update_screen', { id: 'chemin', title: 'Titre de Béa, encore' }, { kind: 'human' });
  await settled(room, b);
  await a.run('update_screen', { id: 'chemin', title: 'Titre de l\'agent' }, { kind: 'agent', name: 'claude-code' });
  room.back(clientA);
  await settled(room, a, b);
  assert.equal(screen(B, 'chemin').title, 'Titre de Béa, encore');
  await until(() => outcomesA.some((each) => ((each as { outcome?: { skipped?: unknown[] } }).outcome?.skipped ?? []).length > 0), 'A\'s agent is told what was left out');
  const skipped = (outcomesA.at(-1) as { outcome?: { skipped: { by?: { kind: string } }[] } } | undefined)?.outcome?.skipped ?? [];
  assert.equal(skipped[0]?.by?.kind, 'human', JSON.stringify(outcomesA).slice(0, 1000));
});

const eventsOf = (session: Session, type: string): Record<string, unknown>[] => {
  const seen: Record<string, unknown>[] = [];
  session.subscribe((message) => { if (message.kind === 'event' && message.event.type === type) seen.push(message.event as unknown as Record<string, unknown>); });
  return seen;
};

test('where a person is goes to the others, and again after a reconnection (D91)', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  const b = await linked(room, B);
  await settled(room, a, b);
  const clientA = a.cloud!.client;
  const seenByB = () => b.cloud?.peers.find((peer) => peer.client === clientA);
  a.cloudWhere({ view: 'plan' });
  a.cloudWhere({ view: 'diapositive', screen: 'chemin', selection: ['chemin-title'] });
  await until(() => seenByB()?.screen === 'chemin', `B sees where A is: ${JSON.stringify(seenByB())}`);
  assert.deepEqual([seenByB()?.view, seenByB()?.selection], ['diapositive', ['chemin-title']]);
  // The connection drops: the new presence says it again, without A moving.
  room.drop();
  await settled(room, a, b);
  await until(() => seenByB()?.screen === 'chemin', 'said again after the reconnection');
});

test('a copy sent away by the room (4003) ends: the folder unlinked, its change not sent kept, no reconnection (D91)', async () => {
  const A = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  await settled(room, a);
  const ended = eventsOf(a, 'cloudEnded');
  room.hold = true;
  await a.run('update_screen', { id: 'chemin', title: 'Pas encore envoyé' }, { kind: 'human' });
  await until(() => a.cloud?.pending === 1, 'the change waits');
  room.end(a.cloud!.client, 4003);
  await until(() => ended.length === 1, 'the end is told');
  assert.deepEqual([ended[0]?.reason, ended[0]?.team, ended[0]?.project], ['removed', 'tm_test', 'prj_test']);
  assert.equal(a.cloud, null);
  assert.equal(fs.existsSync(linkFile(A)), false, 'the folder is no longer linked');
  assert.equal(screen(A, 'chemin').title, 'Pas encore envoyé', 'what was not sent stays in the folder');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(room.sockets.size, 0, 'no reconnection');
});

test('a copy the room keeps out asks whether its person is still in the team: removed, it ends (D91)', async () => {
  const A = copyExample();
  const room = new Room(readProjectFiles(A).files);
  let answer: 'member' | 'removed' = 'member';
  const a = await linked(room, A, async () => answer);
  await settled(room, a);
  const ended = eventsOf(a, 'cloudEnded');
  // Kept out while away (the room no longer takes its connection), not removed yet: it keeps trying.
  answer = 'member';
  room.out(a.cloud!.client);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(ended.length, 0);
  assert.ok(a.cloud, 'still a copy');
  // Asked again later (the copy asks at most every 30 s): a session opened on it asks at once.
  await a.close({ media: 'cancel' });
  sessions.splice(sessions.indexOf(a), 1);
  answer = 'removed';
  const again = await linked(room, A, async () => answer);
  const endedAgain = eventsOf(again, 'cloudEnded');
  await until(() => endedAgain.length === 1 || !fs.existsSync(linkFile(A)), 'the end is found at the next opening');
  assert.equal(fs.existsSync(linkFile(A)), false);
  assert.equal(again.cloud, null);
});

test('made a viewer, a copy keeps its changes until it writes again; a message it does not know changes nothing (D93)', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  const b = await linked(room, B);
  await settled(room, a, b);
  const roles = eventsOf(a, 'cloudRole');
  const clientA = a.cloud!.client;
  room.role(clientA, 'viewer');
  await until(() => a.cloud?.role === 'viewer', 'the copy takes the role');
  assert.deepEqual(roles.map((event) => event.role), ['viewer']);
  const head = room.head;
  const statuses = eventsOf(a, 'cloudStatus');
  await a.run('update_screen', { id: 'chemin', title: 'Écrit en lecteur' }, { kind: 'agent', name: 'claude-code' });
  await until(() => a.cloud?.pending === 1, 'the change waits');
  // The window is told, without any other message from the room.
  await until(() => statuses.at(-1)?.pending === 1, 'its status says the change waits');
  await a.cloud!.settled();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(room.head, head, 'nothing sent while a viewer');
  // An editor again: what waited goes.
  room.role(clientA, 'editor');
  await settled(room, a, b);
  assert.equal(screen(B, 'chemin').title, 'Écrit en lecteur');
  // A copy older than a message ignores it: the client's default, and the session goes on.
  for (const socket of room.sockets) if (socket.presence?.client === clientA) socket.deliver({ type: 'novelty' } as unknown as ServerMessage);
  await b.run('update_screen', { id: 'chemin', title: 'Après le message inconnu' }, { kind: 'human' });
  await settled(room, a, b);
  assert.equal(screen(A, 'chemin').title, 'Après le message inconnu');
});

// The role in welcome (D94): known before anything waiting is sent.
test('opened as a viewer, a copy knows it from welcome and keeps its changes (D94)', async () => {
  const A = copyExample();
  const room = new Room(readProjectFiles(A).files);
  room.roles.set(`c${path.basename(A)}`, 'viewer');
  const a = await linked(room, A);
  await until(() => a.cloud?.online === true && a.cloud.role === 'viewer', 'the role from welcome');
  const head = room.head;
  await a.run('update_screen', { id: 'chemin', title: 'Écrit en lecteur' }, { kind: 'agent', name: 'claude-code' });
  await until(() => a.cloud?.pending === 1, 'the change waits');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(room.head, head, 'nothing sent');
  assert.equal(room.refused, 0);
  assert.equal(screen(A, 'chemin').title, 'Écrit en lecteur', 'kept in the folder');
});

test('demoted while offline, a copy keeps what it did meanwhile (D94)', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  const b = await linked(room, B);
  await settled(room, a, b);
  const clientA = a.cloud!.client;
  const roles = eventsOf(a, 'cloudRole');
  room.out(clientA);
  await until(() => a.cloud?.online === false, 'offline');
  await a.run('update_screen', { id: 'chemin', title: 'Écrit hors ligne' }, { kind: 'human' });
  room.roles.set(clientA, 'viewer');
  const head = room.head;
  room.back(clientA);
  await until(() => a.cloud?.online === true && a.cloud.role === 'viewer', 'back, a viewer');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(room.head, head, 'nothing sent');
  assert.equal(a.cloud?.pending, 1, 'kept');
  assert.equal(screen(A, 'chemin').title, 'Écrit hors ligne');
  assert.deepEqual(roles.map((event) => event.role), ['viewer'], 'the app told');
});

test('promoted while offline, a copy sends what it kept (D94)', async () => {
  const A = copyExample();
  const B = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  const b = await linked(room, B);
  await settled(room, a, b);
  const clientA = a.cloud!.client;
  room.role(clientA, 'viewer');
  await until(() => a.cloud?.role === 'viewer', 'a viewer');
  await a.run('update_screen', { id: 'chemin', title: 'Gardé' }, { kind: 'agent', name: 'claude-code' });
  await until(() => a.cloud?.pending === 1, 'kept');
  room.out(clientA);
  await until(() => a.cloud?.online === false, 'offline');
  room.roles.set(clientA, 'editor');
  room.back(clientA);
  await settled(room, a, b);
  assert.equal(a.cloud?.role, 'editor');
  assert.equal(screen(B, 'chemin').title, 'Gardé', 'sent once an editor again');
});

test('a room that does not say the role in welcome: the copy writes as before, a viewer\'s change refused (D94)', async () => {
  const A = copyExample();
  const room = new Room(readProjectFiles(A).files);
  room.sayRole = false;
  room.roles.set(`c${path.basename(A)}`, 'viewer');
  const a = await linked(room, A);
  const outcomes = eventsOf(a, 'cloudOutcome');
  await until(() => a.cloud?.online === true, 'online');
  assert.equal(a.cloud?.role, null);
  const before = screen(A, 'chemin').title;
  await a.run('update_screen', { id: 'chemin', title: 'Refusé' }, { kind: 'agent', name: 'claude-code' });
  await until(() => outcomes.some((event) => (event.outcome as { refused?: { code: string } }).refused?.code === 'E_SYNC_READ_ONLY'), 'refused, as before D94');
  await until(() => screen(A, 'chemin').title === before, 'the refused change left the module');
});

test('an app older than the room (4005): the copy keeps its changes and does not try again, even when asked; the room\'s protocol is said (C80)', async () => {
  const A = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A);
  await settled(room, a);
  const statuses = eventsOf(a, 'cloudStatus');
  room.refuseHello = { code: 4005, reason: 'elabora-sync/2' };
  room.drop();
  await until(() => a.cloud?.held === 'outdated', 'kept out');
  await a.run('update_screen', { id: 'chemin', title: 'Pas encore envoyé' }, { kind: 'human' });
  await until(() => a.cloud?.pending === 1, 'the change waits');
  const hellos = room.hellos;
  a.cloudRetry();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(room.hellos, hellos, 'not tried again, even when asked');
  assert.equal(a.cloud?.online, false);
  assert.ok(statuses.some((status) => status.held === 'outdated' && status.protocol === 'elabora-sync/2'), 'the room\'s protocol said');
  assert.ok(fs.existsSync(linkFile(A)), 'still linked');
  assert.equal(screen(A, 'chemin').title, 'Pas encore envoyé');
});

test('a project whose connections are all taken (4007): the copy keeps its changes and tries again later, not in a loop; then they go (C83)', async () => {
  const A = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A, async () => 'member', 1500);
  await settled(room, a);
  room.refuseHello = { code: 4007 };
  room.drop();
  await until(() => a.cloud?.held === 'full', 'kept out');
  const hellos = room.hellos;
  await a.run('update_screen', { id: 'chemin', title: 'Écrit pendant que c\'est plein' }, { kind: 'human' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(room.hellos, hellos, 'not in a loop: tried again later');
  room.refuseHello = null;
  await settled(room, a);
  assert.equal(a.cloud?.held, null);
  const placed = room.files.get('screens/chemin.json');
  assert.equal(placed?.kind === 'text' && JSON.parse(placed.text).title, 'Écrit pendant que c\'est plein');
});

test('a room whose storage is newer than its server (4006): the copy keeps its changes; asked, it tries again at once (C80)', async () => {
  const A = copyExample();
  const room = new Room(readProjectFiles(A).files);
  const a = await linked(room, A, async () => 'member', 60_000);
  await settled(room, a);
  room.refuseHello = { code: 4006 };
  room.drop();
  await until(() => a.cloud?.held === 'storage-newer', 'kept out');
  await a.run('update_screen', { id: 'chemin', title: 'Écrit pendant la mise à niveau' }, { kind: 'human' });
  room.refuseHello = null;
  a.cloudRetry();
  await settled(room, a);
  const placed = room.files.get('screens/chemin.json');
  assert.equal(placed?.kind === 'text' && JSON.parse(placed.text).title, 'Écrit pendant la mise à niveau');
});
