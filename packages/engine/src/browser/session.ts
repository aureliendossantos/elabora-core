import type { Author, ChangeLike, FileContent, JournalEntry, MarkEntry } from '@elabora/core/ops/types';
import { applyOps, invertOps } from '@elabora/core/ops/apply';
import { assignBatch, isAiAuthor } from '@elabora/core/ops/batch';
import { planUndo, undoOps, type UndoPlan } from '@elabora/core/ops/undo-plan';
import { binaryFile, type ProjectFiles, type SourceFile } from '@elabora/core/project/files';
import { executeCommand } from '@elabora/core/commands/execute';
import { namedCommand } from '@elabora/core/commands/table';
import { unmetExpectation, type Expectation } from '@elabora/core/commands/index';
import { sortDiagnostics, type Diagnostic } from '@elabora/core/diagnostics/index';
import { stampAuthor } from '@elabora/core/sync/copy';
import type { ValidationOptions } from '@elabora/core/validate/index';
import { isRecord } from '@elabora/core/util/values';
import { ProjectState } from '../base/project-state.ts';
import { SessionReads } from '../base/reads.ts';
import { Renderer } from '../base/render.ts';
import { WriteQueue } from '../base/queue.ts';
import { Batches } from '../base/batches.ts';
import { changeView, diagnosticsEvent } from '../base/events.ts';
import { EngineError, protocolError } from '../base/errors.ts';
import { NEED_SERVICES, isRequestType, notHere, serviceOf } from '../base/services.ts';
import { SessionCloud, type RoomSocket } from '../base/session-cloud.ts';
import { CopyChanges, newId, touched } from './copy-changes.ts';
import type { BrowserStore } from './store.ts';
import { relaySource, type ObjectCompiler } from './relay.ts';
import { serveRelayPort } from '@elabora/player/relay-protocol';
import type {
  ChangeSource, EndTurnParams, EndTurnResult, EngineEvent, EventMessage, FormatMigrationView, MarkResult, RequestMessage, RequestResult, RequestType, ResponseMessage, RunResult, Service, UndoView
} from '../protocol.ts';

// A browser engine's session (D103): the engine's protocol answered from a Worker, on a copy of a
// project of the cloud. The base's reads, batches and copy of the project; the copy's journal as the
// source of its changes (D104): a command runs on the view, is kept in the journal, then recorded in
// the copy's SyncClient by the base's SessionCloud. It has the services its host gives (D102), none
// by default.

export interface CopyOptions {
  // The module's id, as the summary names it (root).
  id: string;
  store: BrowserStore;
  // The hosting's API (its origin) and the room's connection (a WebSocket with the session's cookie, by
  // default; a room in memory in tests; one that never opens offline).
  api: string;
  token?: string;
  connect?: (url: string, token: string) => RoomSocket;
  backoff?: number[];
  author?: Author;
  // The services its host provides (D102): a service named here that this engine has no provider for is
  // not had (none yet: media, voices, word times and packages come later).
  services?: readonly Service[];
  validation?: ValidationOptions;
  // How free objects are compiled for the relay's frames (esbuild-wasm, D117): without it, an object's
  // code is not served.
  objects?: () => Promise<ObjectCompiler>;
}

// The services this engine has a provider for: none yet.
const PROVIDED: ReadonlySet<Service> = new Set();

// How far back a chat's turn is looked for: no turn lasts a day.
const TURN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Opens a copy: what the store holds, the journal's entries the copy had not taken in yet applied on
// top (kept before a stop), validated; then the copy's machine starts.
export async function openCopy(options: CopyOptions): Promise<BrowserSession> {
  const session = new BrowserSession(options);
  await session.start();
  return session;
}

export class BrowserSession {
  readonly id: string;
  readonly author: Author;
  readonly #store: BrowserStore;
  readonly #state: ProjectState;
  readonly #queue = new WriteQueue();
  readonly #listeners = new Set<(message: EventMessage) => void>();
  readonly #entries: JournalEntry[];
  readonly #renderer = new Renderer();
  readonly #reads: SessionReads;
  readonly #batches: Batches;
  readonly #changes: CopyChanges;
  readonly #services: ReadonlySet<Service>;
  readonly #pending: ChangeLike[];
  #cloud: SessionCloud | null;
  #closing: Promise<{ version: string | null }> | null = null;
  readonly #objects: (() => Promise<ObjectCompiler>) | undefined;
  // The relay's ports served (relayPort), each ended with relay/bye as the session closes.
  readonly #relays = new Set<() => void>();

  constructor(options: CopyOptions) {
    this.id = options.id;
    this.#store = options.store;
    this.author = options.author ?? { kind: 'human' };
    this.#services = new Set((options.services ?? []).filter((service) => PROVIDED.has(service)));
    this.#objects = options.objects;
    const entries = [...options.store.journal()];
    this.#entries = entries;
    this.#cloud = new SessionCloud({
      files: () => this.#state.files,
      step: (work) => this.#queue.run(async () => {
        try {
          return await this.#changes.write(work);
        } finally {
          await this.#afterChange();
        }
      }),
      write: async (before, after, author, batch, seq) => {
        const updates = new Map<string, SourceFile | null>();
        for (const rel of new Set([...before.keys(), ...after.keys()])) if (before.get(rel) !== after.get(rel)) updates.set(rel, sourceOf(after.get(rel)));
        await this.#changes.journal({ updates, author, command: { name: 'sync', args: { seq } }, source: 'cloud', ...(batch ? { batch } : {}) });
      },
      emit: (event) => this.#emit(event),
      notes: () => undefined,
      ended: () => { this.#cloud = null; },
      version: async () => null
    }, { api: options.api, token: options.token ?? '', link: options.store.link, store: options.store, ...(options.connect ? { connect: options.connect } : {}), ...(options.backoff ? { backoff: options.backoff } : {}) });
    // What the journal kept that the copy had not taken in yet: shown at once, taken in as the copy starts.
    this.#pending = entries.filter((entry): entry is ChangeLike => entry.type !== 'mark' && entry.seq > options.store.link.journal);
    const view = this.#pending.reduce((files, entry) => applyOps(files, entry.ops), this.#cloud.view);
    this.#state = new ProjectState(this.id, new Map([...view].map(([rel, file]) => [rel, sourceOf(file) as SourceFile])), [], options.validation);
    this.#changes = new CopyChanges({ state: this.#state, store: this.#store, host: { taken: (taken, source) => this.#taken(taken, source), afterChange: () => this.#afterChange(), emit: (event) => this.#emit(event) } });
    this.#batches = new Batches({ idleMs: 5 * 60_000, run: (work) => this.#queue.run(work), version: async () => null, emit: (event) => this.#emit(event), reportError: (error, context) => this.#emitError(error, context) });
    this.#reads = new SessionReads({
      root: this.id, state: this.#state, renderer: this.#renderer, entries: () => this.#entries, journalSeq: () => this.#changes.lastSeq, openBatch: () => this.#batches.open,
      mediaJobs: () => [], migrate: undefined, services: [...this.#services], assertOpen: () => this.#assertOpen()
    });
  }

  async start(): Promise<void> {
    // A browser has no transcript of the chat to say a turn ended: no turn is opened again.
    this.#batches.resume(this.#entries, () => true);
    await this.#cloud?.start(this.#pending);
  }

  subscribe(listener: (message: EventMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get closed(): boolean { return this.#closing !== null; }

  // The copy of the project: connected, the room's number, changes waiting (the cloudStatus event says it as it changes).
  get cloud(): { online: boolean; head: number; pending: number } | null {
    const cloud = this.#cloud;
    return cloud && { online: cloud.online, head: cloud.head, pending: cloud.pending };
  }

  // ── protocol ───────────────────────────────────────────────────────

  // ports: what came transferred with the message (relayPort's).
  async handle(message: unknown, ports: readonly MessagePort[] = []): Promise<ResponseMessage> {
    const request = (message ?? {}) as Partial<RequestMessage>;
    const id = typeof request.id === 'string' ? request.id : '';
    const type = typeof request.type === 'string' ? request.type : '';
    try {
      if (!id || request.kind !== 'request' || !isRequestType(type)) throw new EngineError('bad-request', `Not a request of the engine protocol: ${JSON.stringify(message)?.slice(0, 200)}`);
      const result = await this.#dispatch(request as RequestMessage, ports);
      return { kind: 'response', id, type, ok: true, result } as ResponseMessage;
    } catch (error) {
      return { kind: 'response', id, type, ok: false, error: protocolError(error) };
    }
  }

  async #dispatch(request: RequestMessage, ports: readonly MessagePort[]): Promise<RequestResult<RequestType>> {
    const service = serviceOf(request.type);
    if (service && !this.#services.has(service)) {
      this.#assertOpen();
      throw notHere(request.type, service);
    }
    const reads = this.#reads;
    switch (request.type) {
      case 'summary': return reads.summary();
      case 'readFile': return reads.readFile(request.params.path);
      case 'listFiles': return reads.listFiles(request.params.dir);
      case 'readScreen': return reads.readScreen(request.params.screen);
      case 'screenParts': return reads.screenParts(request.params.screen);
      case 'narration': return reads.narration(request.params.screen, request.params.language, request.params.layer);
      case 'timeline': return reads.timeline(request.params.screen, request.params.language, request.params.layer);
      case 'timelineAt': return reads.timelineAt(request.params);
      case 'timelineMarks': return reads.timelineMarks(request.params.screen, request.params.language, request.params.layer);
      case 'effects': return reads.effects();
      case 'planVoiceover': return reads.planVoiceover(request.params.screen);
      case 'planVersions': return reads.planVersions();
      case 'planDiff': return reads.planDiff(request.params ?? {});
      case 'planDocument': return reads.planDocument(request.params?.date, request.params?.version);
      case 'dialogue': return reads.dialogue(request.params.block);
      case 'dialoguePlay': return reads.dialoguePlay(request.params);
      case 'findText': return reads.findText(request.params.query, request.params.caseSensitive);
      case 'conversions': return reads.conversions(request.params);
      case 'translationStatus': return reads.translationStatus(request.params.to);
      case 'translationTable': return reads.translationTable(request.params.language);
      case 'screenTranslation': return reads.screenTranslation(request.params.screen, request.params.language);
      case 'diagnostics': return reads.diagnostics(request.params.screen);
      case 'history': return reads.history(request.params.limit, { ops: request.params.ops });
      case 'renderScreen': return reads.renderScreen(request.params);
      case 'courseSounds': return reads.courseSounds();
      case 'run': {
        const name = request.params.command;
        const command = typeof name === 'string' ? namedCommand(name) : null;
        if (!command) throw new EngineError('bad-request', `Unknown command "${String(name)}"`);
        if (command.needs && !this.#services.has(NEED_SERVICES[command.needs])) { this.#assertOpen(); throw notHere('run', NEED_SERVICES[command.needs]); }
        return this.run(command.name, request.params.args, request.params.author, request.params.expect);
      }
      case 'undo': return this.undo(request.params.seq);
      case 'redo': return this.redo();
      case 'undoBatch': return this.undoBatch(request.params.batch);
      case 'mark': return this.mark(request.params.request, this.author, request.params.chat);
      case 'endTurn': return this.endTurn(request.params);
      case 'migrate': return this.migrate();
      case 'close': return this.close();
      case 'relayPort': return this.relayPort(request.params?.host, ports[0]);
      default: throw new EngineError('bad-request', `${request.type} is not a request of this session`);
    }
  }

  // ── changes ────────────────────────────────────────────────────────

  // A command on the view (D104): its operations and their inverse kept as an entry of the copy's journal.
  async run(name: string, args: unknown, author: Author = this.author, expect?: readonly Expectation[]): Promise<RunResult> {
    this.#assertOpen();
    const command = namedCommand(name);
    if (!command) throw new EngineError('bad-request', `Unknown command "${name}"`);
    if (expect !== undefined && !Array.isArray(expect)) throw new EngineError('bad-request', 'expect: a list of expected values');
    const by = this.#stamp(author);
    const { entry, result } = await this.#change(by, async () => {
      const unmet = expect?.length ? unmetExpectation(this.#state.project, expect) : null;
      if (unmet) throw new EngineError('refused', `${unmet}: nothing written.`, { code: 'E_EXPECTED' });
      const before = this.#state.files;
      const executed = executeCommand(before, name, (context) => command.run(context, args, undefined), { author: by, root: this.id });
      if (!executed.ops.length) return { entry: null, result: executed.result };
      const id = newId();
      const at = new Date().toISOString();
      const kept = await this.#changes.append({
        type: 'change', id, at, author: by, batch: this.#batchOf(id, at, by), command: command.journal(args, undefined),
        ops: executed.ops, inverse: executed.inverse, files: touched(executed.ops)
      });
      this.#adopt(before, executed.after as ProjectFiles);
      return { entry: kept as ChangeLike, result: executed.result };
    });
    return this.#runResult(name, entry, isRecord(result) ? result : {});
  }

  // ⌘Z without seq: the author's last step (D79).
  async undo(seq?: number, author: Author = this.author): Promise<UndoView> {
    this.#assertOpen();
    const by = this.#stamp(author);
    return this.#undoing(by, () => {
      if (seq !== undefined && !this.#entries.some((entry) => entry.type !== 'mark' && entry.seq === seq)) throw new EngineError('not-found', `No change ${seq} in the journal`);
      return planUndo(this.#entries, seq === undefined ? { undo: 'step', author: by } : { undo: 'change', seq });
    });
  }

  async redo(author: Author = this.author): Promise<UndoView> {
    this.#assertOpen();
    const by = this.#stamp(author);
    return this.#undoing(by, () => planUndo(this.#entries, { undo: 'redo', author: by }));
  }

  async undoBatch(batch?: string, author: Author = this.author): Promise<UndoView> {
    this.#assertOpen();
    return this.#undoing(this.#stamp(author), () => planUndo(this.#entries, { undo: 'batch', ...(batch ? { batch } : {}) }));
  }

  async mark(request: string, author: Author = this.author, chat?: string): Promise<MarkResult> {
    this.#assertOpen();
    if (chat !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(chat)) throw new EngineError('bad-request', `Not a chat id: ${JSON.stringify(chat)} (letters, digits, - and _, at most 64)`);
    return this.#queue.run(async () => {
      this.#batches.close('mark');
      await this.#batches.flush();
      const mark = await this.#changes.write(() => this.#changes.append({ type: 'mark', id: newId(), at: new Date().toISOString(), author: this.#stamp(author), request: String(request), ...(chat ? { chat } : {}) }));
      await this.#afterChange();
      return { mark: { id: mark.id, seq: mark.seq }, version: null };
    });
  }

  async endTurn(params: EndTurnParams): Promise<EndTurnResult> {
    this.#assertOpen();
    return this.#queue.run(async () => {
      const mark = this.#entries.find((entry): entry is MarkEntry => entry.type === 'mark' && entry.id === params.turn);
      const chat = mark?.chat;
      if (!chat) throw new EngineError('not-found', `No turn ${params.turn} of the chat in the journal`);
      this.#batches.endTurn(chat, params.turn);
      await this.#batches.flush();
      const changes = this.#entries.filter((entry) => entry.type !== 'mark' && entry.batch === params.turn).length;
      return { batch: changes ? params.turn : null, changes };
    });
  }

  // No format older than the one this Elabora writes has a migration yet: a copy in it is refused.
  async migrate(): Promise<FormatMigrationView | null> {
    this.#assertOpen();
    const migration = this.#state.project.migration;
    if (!migration) return null;
    throw new EngineError('refused', `This course is in format ${migration.from}, older than the one this Elabora writes (${migration.to}): a copy in the browser does not migrate it yet.`, { code: 'I_FORMAT_OUTDATED' });
  }

  // A relay host's port (D118, D105): the module's files served to it until the session closes.
  relayPort(host: unknown, port: MessagePort | undefined): Record<string, never> {
    this.#assertOpen();
    if (host !== 'canvas' && host !== 'frames') throw new EngineError('bad-request', 'relayPort takes host: canvas or frames');
    if (!port) throw new EngineError('bad-request', 'relayPort takes the port transferred with its message');
    const store = this.#store;
    const end = serveRelayPort(port, relaySource(host, { files: () => this.#state.files, project: () => this.#state.project, medium: (hash) => store.medium(hash), ...(this.#objects ? { objects: this.#objects } : {}) }));
    this.#relays.add(end);
    return {};
  }

  close(): Promise<{ version: string | null }> {
    this.#closing ??= (async () => {
      for (const end of this.#relays) end();
      this.#relays.clear();
      this.#cloud?.stop();
      await this.#queue.run(async () => {
        this.#batches.close('close');
        await this.#batches.flush();
      });
      this.#batches.stop();
      this.#emit({ type: 'closed' });
      this.#listeners.clear();
      return { version: null };
    })();
    return this.#closing;
  }

  // ── writing ────────────────────────────────────────────────────────

  // One write: in the queue, after closing the AI batch (a human or system change ends it); then what
  // changed is validated and told.
  #change<T>(author: Author, work: () => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      if (!isAiAuthor(author)) {
        this.#batches.close('human');
        await this.#batches.flush();
      }
      try {
        return await this.#changes.write(work);
      } finally {
        await this.#afterChange();
      }
    });
  }

  // An undo planned on the copy's journal (D104, @elabora/core ops/undo-plan), computed on the view.
  async #undoing(author: Author, plan: () => UndoPlan): Promise<UndoView> {
    const { entry, chosen, skipped } = await this.#change(author, async () => {
      const chosen = plan();
      const before = this.#state.files;
      const undone = undoOps(before, chosen);
      const id = newId();
      const at = new Date().toISOString();
      const kept = await this.#changes.append({
        type: 'undo', id, at, author, batch: this.#batchOf(id, at, author), command: { name: chosen.name, args: chosen.args },
        ops: undone.ops, inverse: invertOps(before, undone.ops), files: touched(undone.ops), undoes: chosen.undoes, skipped: undone.skipped
      });
      this.#adopt(before, undone.files as ProjectFiles);
      return { entry: kept as ChangeLike, chosen, skipped: undone.skipped };
    });
    return { ...this.#runResult(chosen.name, entry, {}), undone: chosen.undone, skipped, ...(chosen.batch ? { batch: chosen.batch } : {}) };
  }

  // The state takes the files the change wrote.
  #adopt(before: ProjectFiles, after: ProjectFiles): void {
    const updates = new Map<string, SourceFile | null>();
    for (const [rel, file] of after) if (before.get(rel) !== file) updates.set(rel, sourceOf(file));
    for (const rel of before.keys()) if (!after.has(rel)) updates.set(rel, null);
    if (updates.size) this.#state.update(updates);
  }

  // A change's batch (D79): an agent's run in one, a chat's turn its own.
  #batchOf(id: string, at: string, author: Author): string {
    const previous = this.#entries.at(-1);
    let turn: string | undefined;
    if (author.chat) {
      const since = Date.parse(at) - TURN_LOOKBACK_MS;
      for (const entry of [...this.#entries].reverse()) {
        if (entry.type === 'mark' && entry.chat === author.chat) { turn = entry.id; break; }
        if (Date.parse(entry.at) < since) break;
      }
    }
    return assignBatch(previous, { id, at, author }, turn);
  }

  // The author as the copy's journal writes it: its person (D78).
  #stamp(author: Author): Author {
    return stampAuthor(author ?? this.author, this.#store.link.person);
  }

  #runResult(command: string, entry: ChangeLike | null, result: Record<string, unknown>): RunResult {
    const files = entry?.files.map((file) => file.path) ?? [];
    const changed = new Set(files);
    const { screens, project, summary } = this.#state.diagnostics();
    const all: Diagnostic[] = [...project];
    for (const list of screens.values()) all.push(...list);
    return {
      command, change: entry ? changeView(entry) : null, files, result,
      diagnostics: sortDiagnostics(all.filter((d) => changed.has(d.file ?? '') || (d.severity === 'error' && !d.waived))), summary
    };
  }

  // Journal entries taken in, in order: recorded, given to the copy's machine, told.
  #taken(entries: readonly JournalEntry[], source: (entry: JournalEntry) => ChangeSource): void {
    for (const entry of entries) {
      this.#entries.push(entry);
      this.#batches.note(entry);
    }
    for (const entry of entries) if (entry.type !== 'mark') this.#cloud?.take(entry);
    for (const entry of entries) if (entry.type !== 'mark') this.#emit({ type: 'changed', source: source(entry), change: changeView(entry) });
  }

  async #afterChange(): Promise<void> {
    this.#renderer.invalidate(this.#state.takeChanged());
    const delta = this.#state.validate();
    if (delta) this.#emit(diagnosticsEvent(delta));
    await this.#batches.flush();
  }

  // ── events ─────────────────────────────────────────────────────────

  #emit(event: EngineEvent): void {
    const message: EventMessage = { kind: 'event', event };
    for (const listener of [...this.#listeners]) {
      try { listener(message); } catch { /* a listener's failure must not stop the session */ }
    }
  }

  #emitError(error: unknown, context: string): void {
    const { message, code } = protocolError(error);
    this.#emit({ type: 'error', message, context, ...(code ? { code } : {}) });
  }

  #assertOpen(): void {
    if (this.#closing) throw new EngineError('closed', 'The session is closed');
  }
}

// A file of the copy as the project's state holds it: a binary file keeps the facts it came with.
function sourceOf(file: FileContent | undefined): SourceFile | null {
  if (!file) return null;
  if (file.kind === 'text') return file;
  return typeof (file as { size?: unknown }).size === 'number' ? file as SourceFile : binaryFile(file.size ?? 0, file.hash ? { hash: file.hash as `sha256:${string}` } : {});
}

