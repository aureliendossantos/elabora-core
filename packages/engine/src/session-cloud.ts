import type { Author, ChangeLike, Files } from '@elabora/core/ops/types';
import { sameContent } from '@elabora/core/ops/json';
import { diffFiles } from '@elabora/core/ops/diff';
import { SyncClient, type LocalChange, type Outcome } from '@elabora/core/sync/client';
import { SYNC_PROTOCOL, type ClientMessage, type Committed, type ServerMessage } from '@elabora/core/sync/protocol';
import type { CloudClient } from '@elabora/node/cloud/client';
import {
  blobsOf, commitMedia, confirmedFiles, fetchMedium, keepConfirmed, roomUrl, sendMedia, writeLink, type ProjectLink
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
}

export interface CloudOptions {
  api: string;
  client: CloudClient;  // the API with the person's session
  token: string;
  link: ProjectLink;
  // Waits between reconnections, in milliseconds (the last repeats).
  backoff?: number[];
  // Opens the room's connection (tests give a room in memory); by default a WebSocket with the
  // session in Authorization, never in the address.
  connect?: (url: string, token: string) => RoomSocket;
}

// What the copy needs of a WebSocket.
export interface RoomSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

const OPEN = 1;

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
  #idle: (() => void)[] = [];

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
      ...(entry.type === 'undo' ? { undoes: { ...entry.undoes, changes: entry.undoes.changes.map((id) => this.#submissionId(id)) } } : {}),
      ...(unsure.length ? { overwrote: unsure } : {})
    };
    this.#client.record(change);
    this.#later(() => this.#pump());
  }

  // Resolves once nothing waits and nothing is in flight, the copy online.
  settled(): Promise<void> {
    if (this.#online && !this.#client.pending) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#ws?.close(1000, 'closing');
    this.#ws = null;
    this.#online = false;
  }

  // ── the connection ──

  #connect(): void {
    if (this.#stopped) return;
    const url = roomUrl(this.#options.api, this.#link.team, this.#link.project);
    const ws = (this.#options.connect ?? webSocket)(url, this.#options.token);
    this.#ws = ws;
    ws.addEventListener('open', () => {
      this.#attempt = 0;
      this.#send({ type: 'hello', protocol: SYNC_PROTOCOL, client: this.#link.client, actor: { id: this.#link.person.id, name: this.#link.person.name ?? 'Elabora', kind: 'human' }, since: this.#client.head });
    });
    ws.addEventListener('message', (event) => {
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)) as ServerMessage; } catch { return; }
      if (message.type === 'welcome') {
        // What came while away first (an acknowledgement lost with the connection is in it), then
        // the waiting changes: the pump follows every message received.
        this.#online = true;
        this.#status();
        this.#send({ type: 'catchup', since: this.#client.head });
        return;
      }
      void this.#later(() => this.#receive(message));
    });
    const lost = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#online = false;
      this.#client.disconnected();
      this.#status();
      if (this.#stopped) return;
      const waits = this.#options.backoff ?? [500, 1000, 2000, 5000, 10000];
      this.#timer = setTimeout(() => this.#connect(), waits[Math.min(this.#attempt++, waits.length - 1)]);
      this.#timer.unref?.();
    };
    ws.addEventListener('close', lost);
    ws.addEventListener('error', lost);
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
    if (!this.#online) return;
    const before = this.#client.view;
    const submission = this.#client.next();
    await this.#settle(before, null);
    if (!submission) {
      this.#save();
      if (!this.#client.pending) this.#wake();
      return;
    }
    if (!this.#uploads.has(submission.id)) this.#uploads.set(submission.id, await sendMedia(this.#options.client, this.#host.root, this.#link.team, blobsOf(submission.ops)));
    this.#send({ type: 'submit', change: submission });
  }

  async #receive(message: ServerMessage): Promise<void> {
    const before = this.#client.view;
    if (message.type === 'snapshot') for (const file of message.files) if ('blob' in file) await fetchMedium(this.#options.client, this.#host.root, this.#link.team, file.blob);
    if ((message.type === 'change' || message.type === 'ack') && blobsOf(message.change.ops).length) {
      for (const hash of blobsOf(message.change.ops)) await fetchMedium(this.#options.client, this.#host.root, this.#link.team, hash);
    }
    if (message.type === 'catchup') for (const change of message.changes) for (const hash of blobsOf(change.ops)) await fetchMedium(this.#options.client, this.#host.root, this.#link.team, hash);
    if (this.#client.receive(message) === 'gap') this.#send({ type: 'catchup', since: this.#client.head });
    const placed = message.type === 'change' || message.type === 'ack' ? message.change : message.type === 'catchup' ? message.changes.at(-1) ?? null : null;
    await this.#settle(before, placed);
    if (message.type === 'ack' && this.#uploads.has(message.change.id)) {
      await commitMedia(this.#options.client, this.#link.team, this.#uploads.get(message.change.id) ?? null);
      this.#uploads.delete(message.change.id);
    }
    this.#save();
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
    if ('refused' in outcome) this.#host.emit({ type: 'error', context: 'syncing with the project in the cloud', message: `A change made here was refused by the project: ${outcome.refused.message}` });
    if (outcome.skipped.length || outcome.overwrote.length || 'refused' in outcome) this.#host.emit({ type: 'cloudOutcome', outcome });
  }

  #status(): void {
    this.#host.emit({ type: 'cloudStatus', online: this.#online, head: this.#client.head, pending: this.#client.pending });
  }

  #wake(): void {
    for (const resolve of this.#idle.splice(0)) resolve();
  }

  // What the copy keeps to go on after a restart: confirmed (only what changed is stored again),
  // the waiting changes, the head and the journal's last entry taken in.
  #save(): void {
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

