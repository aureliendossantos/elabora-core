import type { FileContent } from '@elabora/core/ops/types';
import type { CopyLink } from '@elabora/core/sync/copy';
import type { RoomSocket } from '../base/session-cloud.ts';
import type { EventMessage, RequestMessage, ResponseMessage, Service } from '../protocol.ts';
import { openCopy, type BrowserSession } from './session.ts';
import { openIdbCopy, type MediaSource } from './idb-store.ts';
import { roomMedia, roomMembership, roomSeed, roomSocket, type RoomAccess } from './room.ts';
import type { ObjectCompiler } from './relay.ts';
import { mediaWorker, workerClient } from './worker-client.ts';
import type { ModelsWorker } from './models/align.ts';
import type { ModelsAnswer, ModelsAsk, ModelsInit } from './models/worker.ts';
import type { NewCourseOptions } from '@elabora/core/commands/new-course';

// The browser engine in a Worker (D103): one module a Worker. The page opens it, then speaks the
// engine's protocol to it by messages. One tab holds a module at a time (Web Locks): a second one is
// told the module is open elsewhere, and writes nothing. A copy the browser does not hold (a first
// opening, or what the browser erased) is taken from the room.

export type WorkerOpen = RoomAccess & {
  kind: 'open';
  // The copy as the room would give it, kept when the browser holds none (tests, a module tried
  // without an account); without it, the room gives it.
  seed?: { link: CopyLink; confirmed: [string, FileContent][] };
  services?: Service[];
  // The media Worker's script, which the app serves beside this one (D106): with it, the media service
  // may be had; the AAC encoder's address, for a browser without its own (D107, D135).
  mediaWorker?: string;
  aacEncoder?: string;
  // The models Worker's script, onnxruntime-web's ESM build and the folder of its wasm, all served by
  // the app, and the models' origin (C110: the page's meta elabora-models): with the media Worker, the
  // align service may be had (D114).
  modelsWorker?: string;
  ort?: string;
  ortWasm?: string | { mjs: string; wasm: string };
  models?: string;
  // The folder where the app serves the local voices' catalogue (voices.json and the voices'
  // embeddings, @elabora/node's voices/pocket-tts/): with the models Worker, the voices service may be
  // had. voiceStandIn: tones in Pocket TTS's place, for routine checks, never a course's voice.
  voices?: string;
  voiceStandIn?: boolean;
  // No connection to the room: nothing is sent nor taken (a module tried offline, a test).
  offline?: boolean;
  // A project just made in the window (« Nouveau module »): its first files, written as its first
  // change when it has no course yet (create_course, D112).
  newCourse?: NewCourseOptions;
};

export type WorkerAnswer =
  | { kind: 'opened'; taken: boolean } // taken: the copy came from the room now
  // Another tab holds the module: this one shows it is open there.
  | { kind: 'held' }
  // Nothing kept for this copy, offline, and no seed.
  | { kind: 'missing' }
  | { kind: 'failed'; message: string; code?: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(message: WorkerAnswer | ResponseMessage | EventMessage): void };
const never = (): RoomSocket => ({ readyState: 0, send() {}, close() {}, addEventListener() {} });

let session: BrowserSession | null = null;
let objects: (() => Promise<ObjectCompiler>) | undefined;
let source: MediaSource | undefined;

// Media the app holds by hash (the examples it ships, which a copy opened offline does not carry):
// given by the app's Worker as it loads, like provideObjects. A medium is taken from what the copy
// kept, else from this source, else from the team's, and checked against its hash before it is kept.
export function provideMedia(get: MediaSource): void {
  source = get;
}

// How free objects are compiled for the relay's frames (D117): the app's Worker, which imports this
// one, gives it as it loads, before the page's open message. It is called at the first object a page
// asks for, once (again only if it failed): a module without a free object loads nothing.
export function provideObjects(load: () => Promise<ObjectCompiler>): void {
  let loading: Promise<ObjectCompiler> | null = null;
  objects = () => (loading ??= load().catch((error: unknown) => { loading = null; throw error; }));
}
// A request and the files it names (D108): `attachments`, by token, beside the message.
type Envelope = RequestMessage & { attachments?: Record<string, Blob> };
const waiting: { message: RequestMessage; ports: readonly MessagePort[]; attachments: Map<string, Blob> }[] = [];

scope.onmessage = ({ data, ports }: MessageEvent<WorkerOpen | Envelope>) => {
  if (data.kind === 'open') {
    open(data).catch((error: unknown) => scope.postMessage({ kind: 'failed', message: error instanceof Error ? error.message : String(error), ...(typeof (error as { code?: unknown }).code === 'string' ? { code: (error as { code: string }).code } : {}) }));
    return;
  }
  const { attachments: given, ...message } = data;
  const attachments = new Map(Object.entries(given ?? {}).filter((entry): entry is [string, Blob] => entry[1] instanceof Blob));
  if (session) void session.handle(message, ports, attachments).then((response) => scope.postMessage(response));
  else waiting.push({ message: message as RequestMessage, ports, attachments });
};

// The models Worker, when the page gives all it needs.
function modelsOf({ modelsWorker, ort, ortWasm, models }: WorkerOpen): { worker: ModelsWorker; base: string } | null {
  if (!modelsWorker || !ort || !ortWasm || !models) return null;
  const at = (url: string) => new URL(url, self.location.href).href;
  const wasm = typeof ortWasm === 'string' ? at(ortWasm) : { mjs: at(ortWasm.mjs), wasm: at(ortWasm.wasm) };
  return { worker: workerClient<ModelsInit, ModelsAsk, ModelsAnswer>(at(modelsWorker), { ort: at(ort), wasm }, (error) => ({ error })), base: models };
}

// The copy's key in the browser's storage: its team and project.
const keyOf = ({ team, project }: RoomAccess): string => `${team}.${project}`;

async function open(request: WorkerOpen): Promise<void> {
  const key = keyOf(request);
  await navigator.locks.request(`elabora-copy:${key}`, { ifAvailable: true }, async (lock) => {
    if (!lock) { scope.postMessage({ kind: 'held' }); return; }
    // What only this browser holds (the changes waiting) is kept for good where the browser allows it.
    // No browser's Worker has persist today: the window asks it (D137); asked here should one gain it.
    await navigator.storage.persist?.().catch(() => false);
    const online = !request.offline;
    const options = {
      ...(online ? { remote: roomMedia(request), membership: roomMembership(request) } : {}),
      ...(source ? { source } : {}),
      onError: (error: unknown) => scope.postMessage({ kind: 'event', event: { type: 'error', context: 'keeping the copy in the browser', message: error instanceof Error ? error.message : String(error) } })
    };
    let store = await openIdbCopy(key, { ...options, ...(request.seed ? { seed: { link: request.seed.link, confirmed: new Map(request.seed.confirmed) } } : {}) });
    let taken = false;
    if (!store && online) {
      store = await openIdbCopy(key, { ...options, seed: await roomSeed(request) });
      taken = true;
    }
    if (!store) { scope.postMessage({ kind: 'missing' }); return; }
    const opened = await openCopy({ id: `cloud:${key}`, store, api: request.api, connect: online ? roomSocket : never, ...(request.services ? { services: request.services } : {}), ...(objects ? { objects } : {}), ...(request.mediaWorker ? { media: mediaWorker(new URL(request.mediaWorker, self.location.href).href, request.aacEncoder ? { aacEncoder: new URL(request.aacEncoder, self.location.href).href } : {}) } : {}), ...(modelsOf(request) ? { models: modelsOf(request)! } : {}), ...(request.voices ? { voices: { catalogue: new URL(request.voices, self.location.href).href, ...(request.voiceStandIn ? { standIn: true } : {}) } } : {}) });
    session = opened;
    opened.subscribe((message) => scope.postMessage(message));
    if (request.newCourse) await opened.run('create_course', request.newCourse);
    scope.postMessage({ kind: 'opened', taken });
    for (const { message, ports, attachments } of waiting.splice(0)) void opened.handle(message, ports, attachments).then((response) => scope.postMessage(response));
    // Held until the session closes.
    await new Promise<void>((resolve) => opened.subscribe(({ event }) => { if (event.type === 'closed') resolve(); }));
    store.close();
  });
}
