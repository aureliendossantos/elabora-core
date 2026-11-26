// What the relay's service worker and a relay page say to each other (D119). Types only: the app and
// the engine never see these; they speak relay-protocol.ts.
//
// The service worker keeps nothing that outlives it. A page that holds routes says so (`relay/hold`), the
// worker remembers it in memory, and asks, for a request, the one page that holds its route, never
// several: a message to every page would tell a route to a page of an object that is not the tab's. A
// worker that wakes up says `relay/awake` (to the relay pages, which hold nothing of anyone's), and the
// pages say again what they hold.

// A page → the service worker (controller.postMessage).
export type PageToWorker =
  // Asks the version and the app's origin; the answer comes on the port that goes with it.
  | { type: 'relay/hello' }
  // The routes this page holds, all of them (a page that holds none says []).
  | { type: 'relay/hold'; routes: string[] }
  // Said to a newer script that waits to take over: it asks to skip waiting again (see relay-page.ts, update).
  | { type: 'relay/skip' };

export interface WorkerHello {
  version: string;
  // The one origin the relay's pages take the app's messages from: null when the host's policy does not name it.
  appOrigin: string | null;
}

// The service worker → a page (client.postMessage).
export type WorkerToPage =
  | { type: 'relay/awake' }
  // A request for the route's file, on the port that goes with it: the page answers a RelayAnswer there, and
  // may be told `cancel` there when the browser no longer waits.
  | { type: 'relay/fetch'; route: string; request: import('./relay-protocol.ts').RelayRequest }
  // A request the worker answered 503: sent to the relay page that holds the route (or, with none, the canvas page that asked),
  // which tells its app; never to a module's frame.
  | { type: 'relay/fault'; path: string; stage: import('./relay-protocol.ts').RelayFaultStage; message: string };

// What the worker's host (its Worker) writes before the script: the policy it puts on every answer.
export interface RelayHostPolicy {
  // The host's whole Content-Security-Policy, frame-ancestors included.
  policy: string;
  // Its frame-ancestors directive alone.
  frameAncestors: string;
  // The app's origin, when the host names it (the frames host's ancestors are the canvas and the app).
  appOrigin?: string;
  // The policy the host serves the relay's script under, when it is not `policy` (D131): one that lets the relay fetch its own
  // origin's files (`connect-src 'self'`) where the host's pages may not (the frames host's `connect-src 'none'`).
  workerPolicy?: string;
}

// Whether a policy lets its holder fetch its own origin: `connect-src`, else `default-src`, names 'self' (D131).
export function mayConnectToSelf(policy: string): boolean {
  const directives = new Map(policy.split(';').map((part) => part.trim().split(/\s+/)).filter((words) => words[0]).map((words) => [words[0]!.toLowerCase(), words.slice(1)]));
  return (directives.get('connect-src') ?? directives.get('default-src') ?? []).includes("'self'");
}

// The pages that may hold a route: the relay page of the frames host and the canvas page.
export const RELAY_PAGES: readonly string[] = ['/relay.html', '/canvas/index.html'];
