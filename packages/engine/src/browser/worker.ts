import type { FileContent } from '@elabora/core/ops/types';
import type { CopyLink } from '@elabora/core/sync/copy';
import type { RoomSocket } from '../base/session-cloud.ts';
import type { EventMessage, RequestMessage, ResponseMessage, Service } from '../protocol.ts';
import { openCopy, type BrowserSession } from './session.ts';
import { openIdbCopy } from './idb-store.ts';

// The browser engine in a Worker (D103): one module a Worker. The page opens it, then speaks the
// engine's protocol to it by messages. One tab holds a module at a time (Web Locks): a second one is
// told the module is open elsewhere, and writes nothing.

export type WorkerOpen = {
  kind: 'open';
  // The copy's key in the browser's storage (its team and project).
  copy: string;
  // The copy as the room gives it, kept when the browser holds none yet.
  seed?: { link: CopyLink; confirmed: [string, FileContent][] };
  api: string;
  services?: Service[];
  // No connection to the room (a module tried offline, a test).
  offline?: boolean;
};

export type WorkerAnswer =
  | { kind: 'opened' }
  // Another tab holds the module: this one shows it is open there.
  | { kind: 'held' }
  // Nothing kept for this copy, and no seed: the room must give it first.
  | { kind: 'missing' }
  | { kind: 'failed'; message: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(message: WorkerAnswer | ResponseMessage | EventMessage): void; close(): void };
const never = (): RoomSocket => ({ readyState: 0, send() {}, close() {}, addEventListener() {} });

let session: BrowserSession | null = null;
const waiting: RequestMessage[] = [];

scope.onmessage = ({ data }: MessageEvent<WorkerOpen | RequestMessage>) => {
  if (data.kind === 'open') {
    open(data).catch((error: unknown) => scope.postMessage({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (session) void session.handle(data).then((response) => scope.postMessage(response));
  else waiting.push(data);
};

async function open(request: WorkerOpen): Promise<void> {
  await navigator.locks.request(`elabora-copy:${request.copy}`, { ifAvailable: true }, async (lock) => {
    if (!lock) { scope.postMessage({ kind: 'held' }); return; }
    // What only this browser holds (the changes waiting) is kept for good where the browser allows it.
    await navigator.storage.persist?.().catch(() => false);
    try {
      const store = await openIdbCopy(request.copy, {
        ...(request.seed ? { seed: { link: request.seed.link, confirmed: new Map(request.seed.confirmed) } } : {}),
        onError: (error) => scope.postMessage({ kind: 'event', event: { type: 'error', context: 'keeping the copy in the browser', message: error instanceof Error ? error.message : String(error) } })
      });
      if (!store) { scope.postMessage({ kind: 'missing' }); return; }
      const opened = await openCopy({ id: `cloud:${request.copy}`, store, api: request.api, ...(request.offline ? { connect: never } : {}), ...(request.services ? { services: request.services } : {}) });
      session = opened;
      opened.subscribe((message) => scope.postMessage(message));
      scope.postMessage({ kind: 'opened' });
      for (const message of waiting.splice(0)) void opened.handle(message).then((response) => scope.postMessage(response));
      // Held until the session closes; then the Worker ends.
      await new Promise<void>((resolve) => opened.subscribe(({ event }) => { if (event.type === 'closed') resolve(); }));
      store.close();
    } catch (error) {
      scope.postMessage({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  });
}
