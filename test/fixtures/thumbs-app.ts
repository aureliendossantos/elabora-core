// The web app's page in the miniatures' tests: a list of rows, each shown as a miniature through createThumbs as the window's list of
// screens will (shown when it is mounted, released when it goes; createThumbs draws those in the view), or, with `view=1`, as a window
// that mounts a row only while it is seen and releases those that leave. The renders come from a stand-in that holds the test's
// hosts' renders (its versions under the test's hand), or, with `engine=1`, from the engine's own Worker opened on a project's files
// (thumbsApp.startEngine), which also answers each frame's port of the relay, as the web app has it. window.thumbsApp is what the test drives.
import { createThumbs } from '@elabora/player/canvas-thumbs';
import { serveRelayPort } from '@elabora/player/relay-protocol';
import type { RelayAnswer, RelayHost, RelayRequest, RelaySource } from '@elabora/player/relay-protocol';
import { THUMB_LIMIT } from '@elabora/player/thumbs-protocol';
import type { ThumbRequestName, ThumbRequests, ThumbShown, ThumbSource } from '@elabora/player/thumbs-protocol';

const params = new URLSearchParams(location.search);
const number = (name: string, fallback: number, least: number, most: number): number => { const value = Number(params.get(name)); return Number.isFinite(value) && params.has(name) ? Math.max(least, Math.min(most, Math.round(value))) : fallback; };
const CANVAS = 'https://canvas.elabora.page';
const ENGINE = params.get('engine') === '1';
const ROWS = number('rows', 8, 1, 200);
const LIMIT = number('limit', THUMB_LIMIT, 1, 60);
const REFRESH = number('refresh', 400, 0, 5000);
const HEIGHT = number('height', 360, 90, 8000);
// A row's size and the list's width: a column of the window's list of screens, or a grid (a Storyboard, a Planche).
const WIDTH = number('width', 420, 100, 4000);
const ROW = number('row', 160, 40, 1000);
const SCREENS = ['simulation', 'accueil'];
// The window that shows only the rows in the view, and releases those that leave (no frame is kept out of the view).
const VIEW = params.get('view') === '1';
// A block's preview in the stand-in: the screen's render with one of its blocks as the block added, in a course of slides or not.
const PREVIEWED: Record<string, string> = { accueil: 'accueil-objectifs', simulation: 'simulation-bravo' };
const SLIDES = params.get('slides') === '1';
// The course's reference height in the stand-in's renders (720): a shorter one, and a screen runs past its window.
const PAGE_HEIGHT = number('page', 720, 200, 2000);

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
let engineOpen!: () => void;
const engineStarted = new Promise<void>((resolve) => { engineOpen = resolve; });
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
// Ports the pages let go (relay/done): their route closed.
let portsDone = 0;
let current: string | null = params.get('current') === 'accueil' ? 'accueil' : null;
const source: ThumbSource = {
  async render<Name extends ThumbRequestName>(name: Name, request: ThumbRequests[Name]['params']): Promise<ThumbRequests[Name]['result']> {
    const screen = (request as { screen?: string }).screen ?? (request as { args?: { screen?: string } }).args?.screen ?? SCREENS[0]!;
    calls.push({ name, screen, at: performance.now() });
    if (ENGINE) return engine(name, request);
    if (!renders.has(screen)) renders.set(screen, await (await fetch(`/render/a/${encodeURIComponent(screen)}.json`)).json());
    const made = { id: `${name}:${screen}`, render: renders.get(screen), width: 1280, height: PAGE_HEIGHT, version: `${name}:${screen}:${versions.get(screen) ?? 0}` };
    const preview = name === 'blockPreviewRender' ? { block: PREVIEWED[screen] ?? '', slides: SLIDES } : {};
    return { ...made, ...preview } as unknown as ThumbRequests[Name]['result'];
  }
};
// noport=1: the engine refuses every route's port.
const NO_PORT = params.get('noport') === '1';
const relayPort = async (host: RelayHost, port: MessagePort): Promise<void> => {
  ports++;
  if (NO_PORT) throw new Error('no route');
  // As in the app, whose engine is there before the miniatures: a port given sooner (the painter, made at once) waits for it.
  if (ENGINE) { await engineStarted; await engine('relayPort', { host }, [port]); return; }
  ends.push(serveRelayPort(port, files, host, () => { portsDone++; }));
};

// How long a frame's answer is waited for (a frame that never answers: a few ms).
const DRAW_TIMEOUT = number('timeout', 30000, 1, 60000);
// images=1: the painter's images (D139); otherwise the live frames of D130, which the tests before it cover.
const IMAGES = params.get('images') === '1';
const logs: string[] = [];
// Every frame's load in the page, the painter's included (the list's own count is `loads`).
let pageLoads = 0;
document.addEventListener('load', (event) => { if (event.target instanceof HTMLIFrameElement) pageLoads++; }, true);
// defer=1: the miniatures (and the painter) made when first asked for, as a module opens: a measure reads the browser without them first.
let made: ReturnType<typeof createThumbs> | null = null;
const thumbs = () => (made ??= createThumbs({ canvasOrigin: CANVAS, relayPort, source, limit: LIMIT, refreshMs: REFRESH, current: () => current, drawTimeoutMs: DRAW_TIMEOUT, images: IMAGES, log: (message) => { logs.push(message); } }));
if (params.get('defer') !== '1') thumbs();

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
function showRow(index: number): void {
  const one = thumbs().show(rows[index]!, { kind: 'screen', screen: screensOf[index]! });
  shown.set(index, one);
  void one.drawn.then((ok) => { if (shown.get(index) !== one) return; drawn.set(index, ok); if (ok) drawnAt.set(index, performance.now()); });
}
const observer = new IntersectionObserver((changes) => {
  for (const change of changes) {
    const index = rows.indexOf(change.target as HTMLElement);
    if (change.isIntersecting) seen.set(index, performance.now());
    if (!VIEW) continue;
    if (change.isIntersecting && !shown.has(index)) showRow(index);
    else if (!change.isIntersecting && shown.has(index)) { shown.get(index)!.release(); shown.delete(index); drawn.delete(index); }
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
    if (!VIEW) showRow(rows.length - 1);
  }
}
if (!ENGINE) build(Array.from({ length: ROWS }, (_, index) => SCREENS[index % SCREENS.length]!));

const blocks: Array<{ element: HTMLElement; one: ThumbShown }> = [];
const api = {
  calls, versions, drawn, rows, seen, drawnAt,
  get ports() { return ports; },
  logs,
  get pageLoads() { return pageLoads; },
  // Each row's image (its address and the type of what it shows), or null.
  pictures: () => rows.map((row) => { const image = row.querySelector('img'); return image ? image.src : null; }),
  // The frames outside the list: the painter's, the measurer's.
  frameCount: () => document.querySelectorAll('iframe').length,
  get portsDone() { return portsDone; },
  get loads() { return loads; },
  get live() { return made?.live ?? 0; },
  frames: () => [...list.querySelectorAll('iframe')].map((frame) => ({ src: frame.src, sandbox: frame.getAttribute('sandbox'), inert: frame.hasAttribute('inert'), ariaHidden: frame.getAttribute('aria-hidden'), parent: (frame.parentElement?.parentElement as HTMLElement | null)?.dataset.index ?? null })),
  setCurrent(screen: string | null) { current = screen; },
  bump(screen: string) { versions.set(screen, (versions.get(screen) ?? 0) + 1); },
  refresh(index: number) { shown.get(index)?.refresh(); },
  release(index: number) { shown.get(index)?.release(); shown.delete(index); drawn.delete(index); },
  scrollTo(top: number) { list.scrollTop = top; },
  measure: (screen: string, language: string | null) => thumbs().measure(screen, language),
  // A block's preview (« Ajouter un bloc ») in an element of its own above the list, of the size given: whether it was drawn, whether the
  // slide runs past the window, and the element's box (the frame's own box is the test's to read inside it).
  async showBlock(screen: string, mini: boolean, width: number, height: number, args?: Record<string, unknown>): Promise<{ drawn: boolean; overflow: boolean | null; transform: string | null; picture: { width: number; height: number } | null }> {
    const element = document.createElement('div');
    element.className = 'block-preview';
    element.style.cssText = `width:${width}px;height:${height}px;overflow:hidden;background:#ddd;position:relative`;
    document.body.prepend(element);
    const one = thumbs().show(element, { kind: 'block', args: { screen, ...args }, mini });
    blocks.push({ element, one });
    const ok = await one.drawn;
    const overflow = one.overflow ? await one.overflow : null;
    const image = element.querySelector('img');
    if (image) await image.decode().catch(() => {});
    return { drawn: ok, overflow, transform: element.querySelector('iframe')?.style.transform ?? null, picture: image ? { width: image.naturalWidth, height: image.naturalHeight } : null };
  },
  // The miniatures made now (defer=1), before any row.
  prepare() { thumbs(); },
  // More rows, one for each screen given.
  build,
  // The previews closed (the picker gone).
  releaseBlocks() { for (const { element, one } of blocks.splice(0)) { one.release(); element.remove(); } },
  // A render as createThumbs asks for it.
  render: (name: ThumbRequestName, request: unknown) => source.render(name, request as never),
  // The engine's Worker opened on a project's files (the seed), offline, with the canvas service; then a row for each screen given.
  async startEngine(seed: unknown, screens: string[]): Promise<number> {
    const started = performance.now();
    worker = new Worker('/engine-worker.js', { type: 'module' });
    await new Promise((resolve) => { worker!.onmessage = ({ data }) => resolve(data); worker!.postMessage({ kind: 'open', team: 'tm_test', project: 'thumbs-engine', seed, api: 'http://localhost:1', offline: true, services: ['canvas'] }); });
    worker.onmessage = null;
    engineOpen();
    const opened = performance.now() - started;
    build(screens);
    return opened;
  },
  close() { made?.close(); for (const end of ends.splice(0)) end(); worker?.terminate(); }
};
(window as unknown as { thumbsApp: typeof api }).thumbsApp = api;
