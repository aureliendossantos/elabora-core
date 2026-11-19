// The relay page: the script of a page of the web app's canvas host (the canvas page) and of its frames
// host (the hidden page the app puts in a frame, /relay.html), D118, D119. It registers the relay, then
// holds one port per route that the app gives it, and answers the relay's requests for a route by asking
// the engine on that route's port. It takes messages from its parent only, at the app's exact origin
// (named by the host's policy through the service worker), and checks them as data.
//
// The role is on the script's tag: <script src="/relay-page.js" data-relay-role="canvas|frames">.

import { RELAY_ANSWER_MS, RELAY_PROTOCOL, parseAppToRelay, parseRelayAnswer, parseRelayRequest } from './relay-protocol.ts';
import type { EnginePortMessage, RelayAnswer, RelayHost, RelayPortMessage, RelayToApp } from './relay-protocol.ts';
import type { PageToWorker, WorkerHello, WorkerToPage } from './relay-link.ts';
import { isRecord } from './json.ts';

const role: RelayHost = document.querySelector('script[data-relay-role]')?.getAttribute('data-relay-role') === 'frames' ? 'frames' : 'canvas';
// A route's port, and the requests waiting on it.
interface Route { port: MessagePort; waiting: Map<number, (answer: RelayAnswer) => void> }
const routes = new Map<string, Route>();
let counter = 0;
let hello: WorkerHello | null = null;

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

function close(route: string): void {
  const held = routes.get(route);
  if (!held) return;
  routes.delete(route);
  held.port.onmessage = null;
  held.port.close();
  for (const resolve of held.waiting.values()) resolve({ status: 'unavailable' });
}

function open(route: string, port: MessagePort): void {
  close(route);
  const held: Route = { port, waiting: new Map() };
  routes.set(route, held);
  port.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<EnginePortMessage> | null;
    if (!isRecord(message)) return;
    if (message.type === 'relay/bye') { if (routes.get(route) === held) close(route); return; }
    if (message.type !== 'relay/answer' || typeof message.id !== 'number') return;
    const answer = parseRelayAnswer(message.answer);
    held.waiting.get(message.id)?.(answer ?? { status: 'failed' });
  };
  declare();
}

// The engine's answer to the relay's request, on the route's port.
function forward(route: string, request: Extract<WorkerToPage, { type: 'relay/fetch' }>['request'], reply: MessagePort): void {
  const held = routes.get(route);
  if (!held) { reply.postMessage({ status: 'unavailable' } satisfies RelayAnswer); reply.close(); return; }
  const id = ++counter;
  const finish = (answer: RelayAnswer) => {
    if (!held.waiting.delete(id)) return;
    clearTimeout(timer);
    reply.postMessage(answer);
    reply.close();
  };
  const timer = setTimeout(() => finish({ status: 'unavailable' }), RELAY_ANSWER_MS);
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
    close(message.route);
    declare();
    tell({ type: 'relay/closed', protocol: RELAY_PROTOCOL, route: message.route });
  } else {
    void update();
  }
});

// Looks for a newer script, and says which one runs.
async function update(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration('/');
  await registration?.update().catch(() => {});
  hello = (await askWorker()) ?? hello;
  if (hello) tell({ type: 'relay/updated', protocol: RELAY_PROTOCOL, version: hello.version });
}

async function start(): Promise<void> {
  try {
    await navigator.serviceWorker.register('/relay.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    // The first visit: the page is claimed once the worker is active.
    if (!worker()) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    hello = await askWorker();
    if (!hello?.appOrigin) return;
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
    if (hello?.appOrigin) tell({ type: 'relay/error', protocol: RELAY_PROTOCOL, message: error instanceof Error ? error.message : String(error) });
  }
}

void start();
