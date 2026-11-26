// The web app's page in the miniatures' tests: a list of rows that shows each in view as a miniature (as the window's list of screens will:
// an element mounted while seen, released when it leaves), through createThumbs. The renders come from a stand-in that holds the test's
// hosts' renders (its versions under the test's hand), or, with `engine=1`, from the engine's own Worker opened on a project's files
// (thumbsApp.startEngine), which also answers each frame's port of the relay, as the web app has it. window.thumbsApp is what the test drives.
import { createThumbs } from '@elabora/player/canvas-thumbs';
import { serveRelayPort } from '@elabora/player/relay-protocol';
import type { RelayAnswer, RelayHost, RelayRequest, RelaySource } from '@elabora/player/relay-protocol';
import type { ThumbRequestName, ThumbRequests, ThumbShown, ThumbSource } from '@elabora/player/thumbs-protocol';

const params = new URLSearchParams(location.search);
const number = (name: string, fallback: number, least: number, most: number): number => { const value = Number(params.get(name)); return Number.isFinite(value) && params.has(name) ? Math.max(least, Math.min(most, Math.round(value))) : fallback; };
const CANVAS = 'https://canvas.elabora.page';
const ENGINE = params.get('engine') === '1';
const ROWS = number('rows', 8, 1, 60);
const LIMIT = number('limit', 16, 1, 60);
const REFRESH = number('refresh', 400, 0, 5000);
const HEIGHT = number('height', 360, 90, 8000);
// A row's size and the list's width: a column of the window's list of screens, or a grid (a Storyboard, a Planche).
const WIDTH = number('width', 420, 100, 4000);
const ROW = number('row', 160, 40, 1000);
const SCREENS = ['simulation', 'accueil'];

const files: RelaySource = {
  async get(request: RelayRequest): Promise<RelayAnswer> {
    if (request.kind !== 'file') return { status: 'refused' };
    const response = await fetch(`/module/a/${request.path.split('/').map(encodeURIComponent).join('/')}`);
    if (response.status === 404) return { status: 'not-found' };
    const body = await response.blob();
    return { status: 'ok', type: response.headers.get('content-type') ?? 'application/octet-stream', size: body.size, body };
  }
};

// ── The engine's Worker (engine=1) ──────────────────────────────────────────────────────────────
let worker: Worker | null = null;
let requests = 0;
const engine = <T>(type: string, request: unknown, transfer: Transferable[] = []): Promise<T> => {
  const id = `thumbs-${type}-${++requests}`;
  return new Promise<T>((resolve, reject) => {
    worker!.addEventListener('message', function listen({ data }: MessageEvent<{ kind?: string; id?: string; ok?: boolean; result?: T; error?: { code?: string; message?: string } }>) {
      if (data.kind !== 'response' || data.id !== id) return;
      worker!.removeEventListener('message', listen);
      if (data.ok) resolve(data.result as T); else reject(new Error(`${data.error?.code ?? 'error'}: ${data.error?.message ?? type}`));
    });
    worker!.postMessage({ kind: 'request', id, type, params: request }, transfer);
  });
};

const calls: Array<{ name: string; screen?: string; at: number }> = [];
const versions = new Map<string, number>();
const renders = new Map<string, unknown>();
const ends: Array<() => void> = [];
let ports = 0;
let current: string | null = params.get('current') === 'accueil' ? 'accueil' : null;
const source: ThumbSource = {
  async render<Name extends ThumbRequestName>(name: Name, request: ThumbRequests[Name]['params']): Promise<ThumbRequests[Name]['result']> {
    const screen = (request as { screen?: string }).screen ?? SCREENS[0]!;
    calls.push({ name, screen, at: performance.now() });
    if (ENGINE) return engine(name, request);
    if (!renders.has(screen)) renders.set(screen, await (await fetch(`/render/a/${encodeURIComponent(screen)}.json`)).json());
    return { id: `${name}:${screen}`, render: renders.get(screen), width: 1280, height: 720, version: `${screen}:${versions.get(screen) ?? 0}` } as unknown as ThumbRequests[Name]['result'];
  }
};
const relayPort = async (host: RelayHost, port: MessagePort): Promise<void> => {
  ports++;
  if (ENGINE) { await engine('relayPort', { host }, [port]); return; }
  ends.push(serveRelayPort(port, files, host));
};

const thumbs = createThumbs({ canvasOrigin: CANVAS, relayPort, source, limit: LIMIT, refreshMs: REFRESH, current: () => current, drawTimeoutMs: 30000 });

document.body.style.cssText = 'margin:0;font:12px sans-serif';
const list = document.createElement('div');
list.id = 'list';
list.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;overflow:auto;position:relative`;
document.body.append(list);
let loads = 0;
list.addEventListener('load', () => { loads++; }, true);
const rows: HTMLElement[] = [];
const screensOf: string[] = [];
const shown = new Map<number, ThumbShown>();
const drawn = new Map<number, boolean>();
// When each row was seen and when its miniature was drawn (ms of the page's clock): what the measures read.
const seen = new Map<number, number>();
const drawnAt = new Map<number, number>();
const observer = new IntersectionObserver((changes) => {
  for (const change of changes) {
    const index = rows.indexOf(change.target as HTMLElement);
    if (change.isIntersecting && !shown.has(index)) {
      const one = thumbs.show(rows[index]!, { kind: 'screen', screen: screensOf[index]! });
      shown.set(index, one);
      seen.set(index, performance.now());
      void one.drawn.then((ok) => { if (shown.get(index) !== one) return; drawn.set(index, ok); if (ok) drawnAt.set(index, performance.now()); });
    } else if (!change.isIntersecting && shown.has(index)) { shown.get(index)!.release(); shown.delete(index); drawn.delete(index); }
  }
});
function build(screens: string[]): void {
  for (const [index, screen] of screens.entries()) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.index = String(index);
    row.style.cssText = `width:${ROW}px;aspect-ratio:16/9;margin:4px;background:#ddd;display:inline-block;overflow:hidden;vertical-align:top`;
    list.append(row);
    rows.push(row);
    screensOf.push(screen);
    observer.observe(row);
  }
}
if (!ENGINE) build(Array.from({ length: ROWS }, (_, index) => SCREENS[index % SCREENS.length]!));

const api = {
  calls, versions, drawn, rows, seen, drawnAt,
  get ports() { return ports; },
  get loads() { return loads; },
  get live() { return thumbs.live; },
  frames: () => [...list.querySelectorAll('iframe')].map((frame) => ({ src: frame.src, sandbox: frame.getAttribute('sandbox'), inert: frame.hasAttribute('inert'), ariaHidden: frame.getAttribute('aria-hidden'), parent: (frame.parentElement?.parentElement as HTMLElement | null)?.dataset.index ?? null })),
  setCurrent(screen: string | null) { current = screen; },
  bump(screen: string) { versions.set(screen, (versions.get(screen) ?? 0) + 1); },
  refresh(index: number) { shown.get(index)?.refresh(); },
  release(index: number) { shown.get(index)?.release(); shown.delete(index); drawn.delete(index); },
  scrollTo(top: number) { list.scrollTop = top; },
  measure: (screen: string, language: string | null) => thumbs.measure(screen, language),
  // The engine's Worker opened on a project's files (the seed), offline, with the canvas service; then a row for each screen given.
  async startEngine(seed: unknown, screens: string[]): Promise<number> {
    const started = performance.now();
    worker = new Worker('/engine-worker.js', { type: 'module' });
    await new Promise((resolve) => { worker!.onmessage = ({ data }) => resolve(data); worker!.postMessage({ kind: 'open', team: 'tm_test', project: 'thumbs-engine', seed, api: 'http://localhost:1', offline: true, services: ['canvas'] }); });
    worker.onmessage = null;
    const opened = performance.now() - started;
    build(screens);
    return opened;
  },
  close() { thumbs.close(); for (const end of ends.splice(0)) end(); worker?.terminate(); }
};
(window as unknown as { thumbsApp: typeof api }).thumbsApp = api;
