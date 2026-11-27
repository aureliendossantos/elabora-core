// The relay page: the script of a page of the web app's canvas host (the canvas page) and of its frames
// host (the hidden page the app puts in a frame, /relay.html), D118, D119. It registers the relay, then
// holds one port per route that the app gives it, and answers the relay's requests for a route by asking
// the engine on that route's port. It takes messages from its parent only, at the app's exact origin
// (named by the host's policy through the service worker), and checks them as data.
//
// The role is on the script's tag: <script src="/relay-page.js" data-relay-role="canvas|frames">.

import { RELAY_ANSWER_MS, RELAY_FAULT_STAGES, RELAY_PROTOCOL, parseAppToRelay, parseRelayAnswer, parseRelayRequest } from './relay-protocol.ts';
import type { EnginePortMessage, RelayAnswer, RelayFaultStage, RelayHost, RelayPortMessage, RelayToApp } from './relay-protocol.ts';
import type { PageToWorker, WorkerHello, WorkerToPage } from './relay-link.ts';
import { isRecord } from './json.ts';

const role: RelayHost = document.querySelector('script[data-relay-role]')?.getAttribute('data-relay-role') === 'frames' ? 'frames' : 'canvas';
// A route's port, and the requests waiting on it.
interface Route { port: MessagePort; waiting: Map<number, (answer: RelayAnswer) => void> }
const routes = new Map<string, Route>();
let counter = 0;
let hello: WorkerHello | null = null;
// How long an update waits for the newer script to take over, in ms.
const UPDATE_WAIT_MS = 20000;
// How often a newer script that waits is asked again to skip waiting, in ms.
const NUDGE_MS = 1500;

const parentWindow = window.parent !== window ? window.parent : null;
const tell = (message: RelayToApp) => { if (parentWindow && hello?.appOrigin) parentWindow.postMessage(message, hello.appOrigin); };

function worker(): ServiceWorker | null {
  return navigator.serviceWorker.controller;
}

// What the worker is, and the app it takes messages from.
function askWorker(): Promise<WorkerHello | null> {
  const controller = worker();
  if (!controller) return Promise.resolve(null);
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 3000);
    port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      const data = event.data;
      // The app's origin is the target of what this page says and the one it takes messages from: an origin and nothing more.
      resolve(isRecord(data) && typeof data.version === 'string' ? { version: data.version, appOrigin: typeof data.appOrigin === 'string' && /^https?:\/\/[^/?#\s]+$/.test(data.appOrigin) ? data.appOrigin : null } : null);
    };
    controller.postMessage({ type: 'relay/hello' } satisfies PageToWorker, [port2]);
  });
}

// Says to the worker which routes this page holds.
function declare(): void {
  worker()?.postMessage({ type: 'relay/hold', routes: [...routes.keys()] } satisfies PageToWorker);
}

// The route closed here (relay/close, or another port for it) says relay/done to the engine, which forgets its
// port; one the engine ended (relay/bye) says nothing back.
function close(route: string, said = true): void {
  const held = routes.get(route);
  if (!held) return;
  routes.delete(route);
  held.port.onmessage = null;
  if (said) held.port.postMessage({ type: 'relay/done' } satisfies RelayPortMessage);
  held.port.close();
  for (const resolve of held.waiting.values()) resolve({ status: 'unavailable', message: 'the route was closed' });
}

function open(route: string, port: MessagePort): void {
  close(route);
  const held: Route = { port, waiting: new Map() };
  routes.set(route, held);
  port.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<EnginePortMessage> | null;
    if (!isRecord(message)) return;
    if (message.type === 'relay/bye') { if (routes.get(route) === held) close(route, false); return; }
    if (message.type !== 'relay/answer' || typeof message.id !== 'number') return;
    const answer = parseRelayAnswer(message.answer);
    held.waiting.get(message.id)?.(answer ?? { status: 'failed', message: 'the engine\'s answer is not one' });
  };
  declare();
}

// The engine's answer to the relay's request, on the route's port.
function forward(route: string, request: Extract<WorkerToPage, { type: 'relay/fetch' }>['request'], reply: MessagePort): void {
  const held = routes.get(route);
  if (!held) { reply.postMessage({ status: 'unavailable', message: 'the route is not open on this page' } satisfies RelayAnswer); reply.close(); return; }
  const id = ++counter;
  const finish = (answer: RelayAnswer) => {
    if (!held.waiting.delete(id)) return;
    clearTimeout(timer);
    reply.postMessage(answer);
    reply.close();
  };
  const timer = setTimeout(() => finish({ status: 'unavailable', message: 'the engine gave no answer in time' }), RELAY_ANSWER_MS);
  held.waiting.set(id, finish);
  // The relay gave the request up (a medium seeked away from): the engine may stop.
  reply.onmessage = () => { if (held.waiting.delete(id)) { clearTimeout(timer); held.port.postMessage({ type: 'relay/cancel', id } satisfies RelayPortMessage); reply.close(); } };
  held.port.postMessage({ type: 'relay/request', id, request } satisfies RelayPortMessage);
}

navigator.serviceWorker.addEventListener('message', (event) => {
  // Only the worker that controls this page speaks to it.
  if (event.source !== worker()) return;
  const data: unknown = event.data;
  if (!isRecord(data)) return;
  if (data.type === 'relay/awake') { declare(); return; }
  if (data.type === 'relay/fault' && typeof data.path === 'string' && typeof data.message === 'string' && RELAY_FAULT_STAGES.some((stage) => stage === data.stage)) {
    tell({ type: 'relay/fault', protocol: RELAY_PROTOCOL, path: data.path.slice(0, 300), stage: data.stage as RelayFaultStage, message: data.message.slice(0, 500) });
    return;
  }
  if (data.type === 'relay/fetch' && typeof data.route === 'string' && event.ports[0]) {
    const request = parseRelayRequest(data.request);
    if (request) forward(data.route, request, event.ports[0]);
    else { event.ports[0].postMessage({ status: 'refused' } satisfies RelayAnswer); event.ports[0].close(); }
  }
});

window.addEventListener('message', (event) => {
  if (!parentWindow || event.source !== parentWindow || !hello?.appOrigin || event.origin !== hello.appOrigin) return;
  const message = parseAppToRelay(event.data);
  if (message === null) return;
  if (message === 'protocol' || message === 'route') { tell({ type: 'relay/refused', protocol: RELAY_PROTOCOL, reason: message }); return; }
  if (message.type === 'relay/open') {
    const port = event.ports[0];
    if (!port) { tell({ type: 'relay/refused', protocol: RELAY_PROTOCOL, reason: 'port', route: message.route }); return; }
    open(message.route, port);
    tell({ type: 'relay/opened', protocol: RELAY_PROTOCOL, route: message.route });
  } else if (message.type === 'relay/close') {
    // The canvas page gives back the route of its own files as it goes: what it still loads stops now, ended by the browser,
    // rather than answered by the relay's refusal (a 503 in its console while its frame is still there).
    if (role === 'canvas') window.stop();
    close(message.route);
    declare();
    tell({ type: 'relay/closed', protocol: RELAY_PROTOCOL, route: message.route });
  } else if (message.type === 'relay/forget') {
    tell({ type: 'relay/forgotten', protocol: RELAY_PROTOCOL, emptied: forget() });
  } else {
    void update();
  }
});

// What the player keeps on this origin, emptied (a sign-out): its local and session storage, which name modules (display settings,
// a preview's progress). The relay's own files (its cache) stay: they are the player's code, the same for everyone.
function forget(): boolean {
  let emptied = true;
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try { const kept = storage(); kept.clear(); emptied &&= kept.length === 0; } catch { emptied = false; }
  }
  return emptied;
}

// A newer script is on its way (found by the browser at a load of a page, or by `update`): waits until it has taken the
// pages over, and asks it again to skip waiting while it has not. The browser stops the running script to activate the
// newer one; when an event of a page (a script of an object's frame loading, a message) reaches the running one at that
// moment, it is started again and the newer one stays waiting until the running one has been idle for the browser's own
// time (about 30 s: seen with the browser's service worker states, in one pass in twenty of the relay's test). Asking the
// waiting script to skip waiting again makes the browser try again. This page says nothing to the running script meanwhile:
// a message to it is one more event that brings it back. `controllerchange` says ready again with the version that took over.
function takeOver(registration: ServiceWorkerRegistration, incoming: ServiceWorker): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); clearInterval(nudge); incoming.removeEventListener('statechange', changed); navigator.serviceWorker.removeEventListener('controllerchange', done); resolve(); };
    const changed = () => { if (incoming.state === 'activated' || incoming.state === 'redundant') done(); };
    const timer = setTimeout(done, UPDATE_WAIT_MS);
    const nudge = setInterval(() => { registration.waiting?.postMessage({ type: 'relay/skip' } satisfies PageToWorker); }, NUDGE_MS);
    incoming.addEventListener('statechange', changed);
    navigator.serviceWorker.addEventListener('controllerchange', done);
    changed();
  });
}

// Looks for a newer script, and says which one runs once it has taken over.
async function update(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration('/');
  await registration?.update().catch(() => {});
  const incoming = registration?.installing ?? registration?.waiting;
  if (registration && incoming) await takeOver(registration, incoming);
  hello = (await askWorker()) ?? hello;
  if (hello) tell({ type: 'relay/updated', protocol: RELAY_PROTOCOL, version: hello.version });
}

// How long a page that no service worker controls is waited for, in ms: the browser gives a page to its worker when the worker
// activates (the first visit), or at once when it loads; a page that has none after this has none to wait for (a private window
// where a browser has no service worker, a page the browser does not give to it).
const CONTROL_WAIT_MS = 5000;

// Says to the app that the relay cannot serve this page, and why. Without the worker's word this page does not know the app's
// origin: the sentence is sent to whoever frames it, which the host's `frame-ancestors` has said is the app, and carries nothing else.
function fail(message: string): void {
  if (!parentWindow) return;
  parentWindow.postMessage({ type: 'relay/error', protocol: RELAY_PROTOCOL, message } satisfies RelayToApp, hello?.appOrigin ?? '*');
}

async function start(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.register('/relay.js', { scope: '/' });
    // A newer script found by the browser (a deploy: this page was loaded, the browser checked) is taken over the same way.
    registration.addEventListener('updatefound', () => { const incoming = registration.installing; if (incoming) void takeOver(registration, incoming); });
    await navigator.serviceWorker.ready;
    // The first visit: the page is claimed once the worker is active.
    if (!worker()) {
      const controlled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), CONTROL_WAIT_MS);
        navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(true); }, { once: true });
      });
      if (!controlled && !worker()) {
        fail('The relay\'s service worker does not control this page: the module\'s files cannot be served to it.');
        // If the browser gives it the page later, it goes on as if it had at once.
        await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      }
    }
    hello = await askWorker();
    if (!hello?.appOrigin) { fail('The relay\'s service worker does not name the app that frames this page.'); return; }
    tell({ type: 'relay/ready', protocol: RELAY_PROTOCOL, version: hello.version, host: role });
    // A new script takes the page over: it is told what this page holds, and the app which version runs.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      void askWorker().then((next) => {
        if (!next) return;
        hello = next;
        declare();
        tell({ type: 'relay/ready', protocol: RELAY_PROTOCOL, version: next.version, host: role });
      });
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

void start();
