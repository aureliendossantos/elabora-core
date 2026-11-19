import type { FileContent } from '@elabora/core/ops/types';
import type { CopyLink } from '@elabora/core/sync/copy';
import type { RoomSocket } from '../base/session-cloud.ts';
import type { EventMessage, RequestMessage, ResponseMessage, Service } from '../protocol.ts';
import { openCopy, type BrowserSession } from './session.ts';
import { openIdbCopy } from './idb-store.ts';
import { roomMedia, roomMembership, roomSeed, roomSocket, type RoomAccess } from './room.ts';

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
  // No connection to the room: nothing is sent nor taken (a module tried offline, a test).
  offline?: boolean;
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
const waiting: { message: RequestMessage; ports: readonly MessagePort[] }[] = [];

scope.onmessage = ({ data, ports }: MessageEvent<WorkerOpen | RequestMessage>) => {
  if (data.kind === 'open') {
    open(data).catch((error: unknown) => scope.postMessage({ kind: 'failed', message: error instanceof Error ? error.message : String(error), ...(typeof (error as { code?: unknown }).code === 'string' ? { code: (error as { code: string }).code } : {}) }));
    return;
  }
  if (session) void session.handle(data, ports).then((response) => scope.postMessage(response));
  else waiting.push({ message: data, ports });
};

// The copy's key in the browser's storage: its team and project.
const keyOf = ({ team, project }: RoomAccess): string => `${team}.${project}`;

async function open(request: WorkerOpen): Promise<void> {
  const key = keyOf(request);
  await navigator.locks.request(`elabora-copy:${key}`, { ifAvailable: true }, async (lock) => {
    if (!lock) { scope.postMessage({ kind: 'held' }); return; }
    // What only this browser holds (the changes waiting) is kept for good where the browser allows it.
    await navigator.storage.persist?.().catch(() => false);
    const online = !request.offline;
    const options = {
      ...(online ? { remote: roomMedia(request), membership: roomMembership(request) } : {}),
      onError: (error: unknown) => scope.postMessage({ kind: 'event', event: { type: 'error', context: 'keeping the copy in the browser', message: error instanceof Error ? error.message : String(error) } })
    };
    let store = await openIdbCopy(key, { ...options, ...(request.seed ? { seed: { link: request.seed.link, confirmed: new Map(request.seed.confirmed) } } : {}) });
    let taken = false;
    if (!store && online) {
      store = await openIdbCopy(key, { ...options, seed: await roomSeed(request) });
      taken = true;
    }
    if (!store) { scope.postMessage({ kind: 'missing' }); return; }
    const opened = await openCopy({ id: `cloud:${key}`, store, api: request.api, connect: online ? roomSocket : never, ...(request.services ? { services: request.services } : {}) });
    session = opened;
    opened.subscribe((message) => scope.postMessage(message));
    scope.postMessage({ kind: 'opened', taken });
    for (const { message, ports } of waiting.splice(0)) void opened.handle(message, ports).then((response) => scope.postMessage(response));
    // Held until the session closes.
    await new Promise<void>((resolve) => opened.subscribe(({ event }) => { if (event.type === 'closed') resolve(); }));
    store.close();
  });
}
