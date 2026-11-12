import type { Author, ChangeLike, Files, Json } from '@elabora/core/ops/types';
import { lookup, parsePath } from '@elabora/core/ops/path';
import { sameContent } from '@elabora/core/ops/json';
import { diffFiles } from '@elabora/core/ops/diff';
import { SyncClient, type LocalChange, type Outcome } from '@elabora/core/sync/client';
import { SYNC_PROTOCOL, type ClientMessage, type Committed, type Presence, type RoomRole, type ServerMessage } from '@elabora/core/sync/protocol';
import type { CloudClient } from '@elabora/node/cloud/client';
import {
  blobsOf, commitMedia, confirmedFiles, fetchMedium, keepConfirmed, projectMembership, roomUrl, sendMedia, unlinkFolder, writeLink, type ProjectLink
} from '@elabora/node/cloud/projects';
import type { EngineEvent, ExternalNotes } from './protocol.ts';

// A session's copy of a project in the cloud (D73, D83): the changes of the folder (the session's,
// other processes', files edited by programs that are not Elabora tools) go to the project's room
// through the core's SyncClient, one in flight; the room's changes come back and are written in the
// folder and its journal. One invariant, kept in one place: the folder holds the client's view
// (confirmed, then the waiting changes rebased on top). Every step that moves the view runs in the
// session's write queue, under the project lock, after the journal's new entries are taken in.

export interface CloudHost {
  readonly root: string;
  files(): Files;
  // Runs work in the session's queue, under the lock, after the folder's changes are taken in.
  step<T>(work: () => Promise<T>): Promise<T>;
  // Writes the view's difference in the folder and its journal, as one change of author (inside a step).
  write(before: Files, after: Files, author: Author, batch: string | undefined, seq: number): Promise<void>;
  emit(event: EngineEvent): void;
  notes(change: string): ExternalNotes | undefined;
  // The copy ended (D91): the session no longer syncs the folder.
  ended(): void;
  // Elabora's version of the folder as it is, named (its local backups): what a restored room replaces.
  version(name: string): Promise<string | null>;
}

// Where this copy's person is (D91): the screen, the blocks chosen, the view; the room shows it to the
// others while the connection lasts.
export type Where = Pick<Presence, 'screen' | 'selection' | 'view'>;
// Why a copy ended: its person is no longer in the team, or the project was deleted.
export type CloudEnd = 'removed' | 'deleted';
// Why the room keeps a copy out for now (elabora-cloud C80, C83), its changes kept here: an app older
// than the room (4005: not tried again, Elabora is to be updated), the room's storage newer than the
// server's code (4006), or the project's connections all taken (4007): tried again later, or when asked.
export type CloudHeld = 'outdated' | 'storage-newer' | 'full';

export interface CloudOptions {
  api: string;
  client: CloudClient;  // the API with the person's session
  token: string;
  link: ProjectLink;
  // Waits between reconnections, in milliseconds (the last repeats).
  backoff?: number[];
  // The wait before trying again a room that kept the copy out for its storage or its connections.
  later?: number;
  // The name of the version kept before a restored room's project replaces the copy's (the app's words).
  restoredVersion?: string;
  // Opens the room's connection (tests give a room in memory); by default a WebSocket with the
  // session in Authorization, never in the address.
  connect?: (url: string, token: string) => RoomSocket;
  // Whether the person still reaches the project, asked when the room would not take the connection;
  // by default the team's list of projects (tests answer it).
  membership?: () => Promise<'member' | CloudEnd | 'unknown'>;
}

// What the copy needs of a WebSocket.
export interface RoomSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
  addEventListener(type: 'close', listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

const OPEN = 1;
// The room's close codes (elabora-cloud C37): the person's membership ended, the project was deleted.
// 4008, the room just restored to an earlier time (elabora-cloud C84), is any other drop: connect again.
const CLOSED: Record<number, CloudEnd> = { 4003: 'removed', 4004: 'deleted' };
const HELD: Record<number, CloudHeld> = { 4005: 'outdated', 4006: 'storage-newer', 4007: 'full' };
// About a minute, as the room's Retry-After says for its storage (60 s).
const LATER = 60_000;
// How often a copy the room keeps out asks whether its person still reaches the project.
const MEMBERSHIP_EVERY = 30_000;
// Where the person is, sent at most so often (the last place always goes).
const WHERE_EVERY = 150;

const webSocket = (url: string, token: string): RoomSocket =>
  new (WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => RoomSocket)(url, { headers: { Authorization: `Bearer ${token}` } });

const SYNC_COMMAND = 'sync';
// A journal entry the copy wrote from the room: never sent back.
export const isFromRoom = (entry: ChangeLike): boolean => entry.command?.name === SYNC_COMMAND;

export class SessionCloud {
  readonly #host: CloudHost;
  readonly #options: CloudOptions;
  readonly #link: ProjectLink;
  readonly #client: SyncClient;
  #saved: Files;
  #ws: RoomSocket | null = null;
  #online = false;
  #stopped = false;
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;
  readonly #uploads = new Map<string, string | null>(); // submission id → its media upload
  // Who is in the room: each copy connected, this one included (by the room's word).
  #peers: Presence[] = [];
  #idle: (() => void)[] = [];
  #where: Where = {};
  #whereSent: string | null = null;
  #whereTimer: NodeJS.Timeout | null = null;
  #ended: CloudEnd | null = null;
  // Kept out for now by the room (its protocol, for an app older than it).
  #held: { reason: CloudHeld; protocol: string | null } | null = null;
  // The room was restored to an earlier time since this copy's head (elabora-cloud C84): its epoch, taken
  // once its whole project (snapshot) replaced the copy's.
  #restored: string | null = null;
  #askedAt = -Infinity;
  // The person's role as the room last said it (D93): null until it says one.
  #role: RoomRole | null = null;

  constructor(host: CloudHost, options: CloudOptions) {
    this.#host = host;
    this.#options = options;
    this.#link = options.link;
    const confirmed = confirmedFiles(host.root, options.link.confirmed);
    this.#saved = confirmed;
    this.#client = new SyncClient(confirmed, options.link.head);
    for (const change of options.link.waiting) this.#client.record(change);
  }

  get online(): boolean { return this.#online; }
  get head(): number { return this.#client.head; }
  get pending(): number { return this.#client.pending; }
  get view(): Files { return this.#client.view; }
  get peers(): readonly Presence[] { return this.#peers; }
  get link(): Readonly<ProjectLink> { return this.#link; }
  get role(): RoomRole | null { return this.#role; }
  get held(): CloudHeld | null { return this.#held?.reason ?? null; }

  // Journal entries the copy has not taken in yet (made while no session synced), then a check that
  // the folder is the view: what differs goes as a file edit no Elabora tool made.
  async start(entries: readonly ChangeLike[]): Promise<void> {
    await this.#host.step(async () => {
      for (const entry of entries) this.take(entry);
      const files = this.#host.files();
      const paths = [...new Set([...files.keys(), ...this.#client.view.keys()])].filter((rel) => !sameContent(files.get(rel), this.#client.view.get(rel)) && files.get(rel)?.kind !== 'binary');
      if (paths.length) {
        const after = new Map(this.#client.view);
        for (const rel of paths) { const file = files.get(rel); if (file) after.set(rel, file); else after.delete(rel); }
        const ops = diffFiles(this.#client.view, after);
        if (ops.length) this.#client.record({ id: `${this.#link.client}.open-${Date.now().toString(36)}`, at: new Date().toISOString(), author: { kind: 'external' }, ops });
      }
      this.#save();
    });
    this.#connect();
  }

  // A journal entry, in the journal's order (the session calls it as it takes entries in).
  take(entry: ChangeLike): void {
    if (entry.seq <= this.#link.journal) return;
    this.#link.journal = entry.seq;
    if (isFromRoom(entry) || !entry.ops.length) return;
    const notes = this.#host.notes(entry.id);
    const unsure = notes?.overwrote.filter((overwrite) => overwrite.unsure) ?? [];
    const change: LocalChange = {
      id: this.#submissionId(entry.id), at: entry.at, author: entry.author, batch: entry.batch,
      ...(entry.command ? { command: entry.command } : {}), ops: entry.ops, inverse: entry.inverse,
      // An undo, with what it left out (D87): ids as the project's server knows them.
      ...(entry.type === 'undo' ? { undoes: { ...entry.undoes, changes: entry.undoes.changes.map((id) => this.#submissionId(id)), ...(entry.skipped.length ? { skipped: entry.skipped.map((skipped) => ({ ...skipped, change: this.#submissionId(skipped.change) })) } : {}) } } : {}),
      ...(unsure.length ? { overwrote: unsure } : {})
    };
    this.#client.record(change);
    // The window knows at once that a change waits (its cloud says it), before the room's answer.
    this.#status();
    this.#later(() => this.#pump());
  }

  // Resolves once nothing waits and nothing is in flight, the copy online; for a viewer, once online
  // (its changes wait until it writes again, D93).
  settled(): Promise<void> {
    if (this.#online && (!this.#client.pending || this.#role === 'viewer')) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#whereTimer) clearTimeout(this.#whereTimer);
    this.#ws?.close(1000, 'closing');
    this.#ws = null;
    this.#online = false;
  }

  // Where the person is now: told to the room at once, then at most every WHERE_EVERY ms, and again
  // after each reconnection (a presence lasts as long as its connection).
  where(where: Where): void {
    this.#where = where;
    if (this.#whereTimer) return;
    this.#tellWhere();
    this.#whereTimer = setTimeout(() => { this.#whereTimer = null; this.#tellWhere(); }, WHERE_EVERY);
    this.#whereTimer.unref?.();
  }

  #tellWhere(): void {
    if (!this.#online) return;
    const said = JSON.stringify(this.#where);
    if (said === this.#whereSent) return;
    this.#whereSent = said;
    this.#send({ type: 'presence', presence: this.#where });
  }

  // ── the connection ──

  #connect(): void {
    if (this.#stopped) return;
    const url = roomUrl(this.#options.api, this.#link.team, this.#link.project);
    const ws = (this.#options.connect ?? webSocket)(url, this.#options.token);
    this.#ws = ws;
    let welcomed = false;
    ws.addEventListener('open', () => {
      this.#attempt = 0;
      this.#send({ type: 'hello', protocol: SYNC_PROTOCOL, client: this.#link.client, actor: { id: this.#link.person.id, name: this.#link.person.name ?? 'Elabora', kind: 'human' }, since: this.#client.head, ...(this.#link.epoch ? { epoch: this.#link.epoch } : {}) });
    });
    ws.addEventListener('message', (event) => {
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)) as ServerMessage; } catch { return; }
      if (message.type === 'welcome') {
        // What came while away first (an acknowledgement lost with the connection is in it), then
        // the waiting changes: the pump follows every message received.
        welcomed = true;
        this.#online = true;
        this.#held = null;
        this.#peers = message.peers;
        // The person's role as the room says it at the connection (D94), before anything waiting goes:
        // opened as a viewer, or demoted while away, the copy keeps; an editor again, it sends.
        if (message.role) this.#takeRole(message.role);
        // Another history than this copy's head belongs to (elabora-cloud C84): the room was restored to an
        // earlier time, its numbers name other changes now, a copy ahead of it included. The whole project
        // comes instead of a catch-up, whatever its head; this copy is never up to date on a number.
        const epoch = message.epoch ?? '0';
        this.#restored = this.#client.head > 0 && epoch !== (this.#link.epoch ?? '0') ? epoch : null;
        if (!this.#restored && message.epoch) this.#link.epoch = message.epoch;
        this.#status();
        if (!this.#restored) this.#send({ type: 'catchup', since: this.#client.head });
        this.#whereSent = null;
        this.#tellWhere();
        return;
      }
      // Who is there changed: nothing of the view moves.
      if (message.type === 'presence') {
        this.#peers = message.peers;
        this.#status();
        return;
      }
      // The person's role changed (D93): a viewer's changes wait here (the room would refuse them),
      // and go once the person writes again.
      if (message.type === 'role') {
        this.#takeRole(message.role);
        return;
      }
      void this.#later(() => this.#receive(message));
    });
    const lost = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#online = false;
      this.#peers = [];
      this.#client.disconnected();
      this.#status();
      // An app older than the room is not tried again: Elabora is to be updated first.
      if (this.#stopped || this.#held?.reason === 'outdated') return;
      const waits = this.#options.backoff ?? [500, 1000, 2000, 5000, 10000];
      this.#timer = setTimeout(() => this.#connect(), this.#held ? this.#options.later ?? LATER : waits[Math.min(this.#attempt++, waits.length - 1)]);
      this.#timer.unref?.();
      // Kept out before a welcome: the person may have left the team while the module was closed.
      if (!welcomed) void this.#askMembership();
    };
    ws.addEventListener('close', (event) => {
      const end = event?.code ? CLOSED[event.code] : undefined;
      // Closed for good by the room: offline at once, no reconnection, then the end in the queue.
      if (end && this.#ws === ws) {
        this.#stopped = true;
        lost();
        void this.#later(async () => this.#end(end));
        return;
      }
      const held = event?.code ? HELD[event.code] : undefined;
      if (held && this.#ws === ws) this.#held = { reason: held, protocol: held === 'outdated' ? event.reason || null : null };
      lost();
    });
    ws.addEventListener('error', lost);
  }

  async #askMembership(): Promise<void> {
    if (performance.now() - this.#askedAt < MEMBERSHIP_EVERY) return;
    this.#askedAt = performance.now();
    const said = await (this.#options.membership ?? (() => projectMembership(this.#options.client, this.#link.team, this.#link.project)))().catch(() => 'unknown' as const);
    if (said === 'removed' || said === 'deleted') await this.#later(async () => this.#end(said));
  }

  // The copy ends (D91): no reconnection; the folder is no longer linked and keeps what the copy held,
  // its changes not sent included; the session is told, then whoever listens.
  #end(reason: CloudEnd): void {
    if (this.#ended) return;
    this.#ended = reason;
    this.stop();
    this.#peers = [];
    unlinkFolder(this.#host.root);
    this.#host.ended();
    this.#host.emit({ type: 'cloudEnded', reason, team: this.#link.team, project: this.#link.project });
  }

  // Tried again now, at the author's word: a copy the room kept out for its storage or its connections.
  retry(): void {
    if (this.#stopped || this.#ws || !this.#held || this.#held.reason === 'outdated') return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#connect();
  }

  #send(message: ClientMessage): void {
    if (this.#ws?.readyState === OPEN) this.#ws.send(JSON.stringify(message));
  }

  // Runs in the session's queue; a failure is said, the copy goes on.
  #later(work: () => Promise<void>): Promise<void> {
    return this.#host.step(work).catch((error: unknown) => this.#host.emit({ type: 'error', context: 'syncing with the project in the cloud', message: error instanceof Error ? error.message : String(error) }));
  }

  // ── steps (in the queue) ──

  async #pump(): Promise<void> {
    // Nothing goes between a restored room's welcome and its project (C84): its base would be a number of
    // the old history.
    if (!this.#online || this.#role === 'viewer' || this.#restored !== null) return;
    const before = this.#client.view;
    const submission = this.#client.next();
    await this.#settle(before, null);
    if (!submission) {
      this.#save();
      if (!this.#client.pending) this.#wake();
      return;
    }
    if (!this.#uploads.has(submission.id)) {
      try {
        this.#uploads.set(submission.id, await sendMedia(this.#options.client, this.#host.root, this.#link.team, blobsOf(submission.ops)));
      } catch (error) {
        // Not sent: tried again shortly, as after a lost connection.
        this.#client.disconnected();
        const timer = setTimeout(() => void this.#later(() => this.#pump()), 2000);
        timer.unref?.();
        throw error;
      }
    }
    this.#send({ type: 'submit', change: submission });
  }

  async #receive(message: ServerMessage): Promise<void> {
    // A catchup's changes one by one: each is journaled as its own author's.
    if (message.type === 'catchup' && message.changes.length > 1) {
      for (const change of message.changes) await this.#receive({ ...message, changes: [change] });
      return;
    }
    const before = this.#client.view;
    if (message.type === 'snapshot') for (const file of message.files) if ('blob' in file) await fetchMedium(this.#options.client, this.#host.root, this.#link.team, file.blob);
    // A restored room's project replaces this copy's: what the copy had is kept first, in Elabora's
    // versions of the module; what it had not sent goes again on top, as after any snapshot.
    const restored = message.type === 'snapshot' ? this.#restored : null;
    const version = restored !== null ? await this.#host.version(this.#options.restoredVersion ?? 'Before the project was restored') : null;
    if ((message.type === 'change' || message.type === 'ack') && blobsOf(message.change.ops).length) {
      for (const hash of blobsOf(message.change.ops)) await fetchMedium(this.#options.client, this.#host.root, this.#link.team, hash);
    }
    if (message.type === 'catchup') for (const change of message.changes) for (const hash of blobsOf(change.ops)) await fetchMedium(this.#options.client, this.#host.root, this.#link.team, hash);
    const said = this.#client.receive(message);
    if (said === 'gap') this.#send({ type: 'catchup', since: this.#client.head });
    // The room could not find a medium of the change: its media are sent again before it (D85).
    if (said === 'media' && message.type === 'refused') this.#uploads.delete(message.refusal.id);
    const placed = message.type === 'change' || message.type === 'ack' ? message.change : message.type === 'catchup' ? message.changes.at(-1) ?? null : null;
    await this.#settle(before, placed);
    if (placed && message.type !== 'ack' && !placed.id.startsWith(`${this.#link.client}.`)) this.#replaced(placed);
    if (message.type === 'ack' && this.#uploads.has(message.change.id)) {
      await commitMedia(this.#options.client, this.#link.team, this.#uploads.get(message.change.id) ?? null);
      this.#uploads.delete(message.change.id);
    }
    if (restored !== null) {
      this.#link.epoch = restored;
      this.#restored = null;
    }
    this.#save();
    if (restored !== null) this.#host.emit({ type: 'cloudRestored', version });
    await this.#pump();
  }

  // The view moved: the folder follows, and the outcomes of changes made here are told.
  async #settle(before: Files, placed: Committed | null): Promise<void> {
    const after = this.#client.view;
    if (after !== before) {
      const author: Author = placed?.author ?? { kind: 'system' };
      await this.#host.write(before, after, author, placed && placed.author.kind !== 'human' ? placed.batch : undefined, placed?.seq ?? this.#client.head);
    }
    for (const outcome of this.#client.takeOutcomes()) this.#tell(outcome);
  }

  #tell(outcome: Outcome): void {
    if (outcome.skipped.length || outcome.overwrote.length || 'refused' in outcome) this.#host.emit({ type: 'cloudOutcome', outcome });
  }

  // Another's change that replaced values written here, unseen (D90): the values of this copy's changes,
  // with what holds the place now (the view's, for « Comparer »).
  #replaced(change: Committed): void {
    const mine = change.overwrote.filter((overwrite) => overwrite.by?.startsWith(`${this.#link.client}.`));
    if (!mine.length) return;
    const now = (file: string, path: string): Json | string | null => {
      const content = this.#client.view.get(file);
      if (!content || content.kind !== 'text') return null;
      const segments = path ? parsePath(path) : [];
      if (!segments) return null;
      if (!segments.length) return content.json ?? content.text;
      const found = lookup(content.json, segments);
      return found.found ? found.value : null;
    };
    this.#host.emit({ type: 'cloudReplaced', change: { id: change.id, seq: change.seq, at: change.at, author: change.author }, overwrote: mine.map((overwrite) => ({ ...overwrite, now: now(overwrite.file, overwrite.path) })) });
  }

  // A role the room said (D93, D94): told to the app when it changes; what waits now stays here, or
  // goes, said with it.
  #takeRole(role: RoomRole): void {
    const was = this.#role;
    this.#role = role;
    if (was !== role) this.#host.emit({ type: 'cloudRole', role });
    this.#status();
    if (role === 'viewer') this.#wake();
    else if (was === 'viewer') void this.#later(() => this.#pump());
  }

  #status(): void {
    if (this.#ended) return;
    this.#host.emit({ type: 'cloudStatus', online: this.#online, head: this.#client.head, pending: this.#client.pending, client: this.#link.client, peers: this.#peers, ...(this.#held ? { held: this.#held.reason, ...(this.#held.protocol ? { protocol: this.#held.protocol } : {}) } : {}) });
  }

  #wake(): void {
    for (const resolve of this.#idle.splice(0)) resolve();
  }

  // What the copy keeps to go on after a restart: confirmed (only what changed is stored again),
  // the waiting changes, the head and the journal's last entry taken in.
  #save(): void {
    if (this.#ended) return;
    const confirmed = this.#client.confirmed;
    const changed = new Map([...confirmed].filter(([rel, file]) => this.#saved.get(rel) !== file));
    const kept = { ...this.#link.confirmed, ...keepConfirmed(this.#host.root, changed) };
    for (const rel of Object.keys(kept)) if (!confirmed.has(rel)) delete kept[rel];
    this.#link.confirmed = kept;
    this.#link.head = this.#client.head;
    this.#link.waiting = this.#client.waitingChanges();
    this.#saved = confirmed;
    writeLink(this.#host.root, this.#link);
    this.#status();
  }

  #submissionId(entry: string): string {
    return `${this.#link.client}.${entry}`;
  }
}

