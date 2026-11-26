// The web app's page in the miniatures' tests: a list of rows that shows each in view as a miniature (as the window's list of screens will:
// an element mounted while seen, released when it leaves), through createThumbs, with the engine's four requests faked from the renders the
// test's hosts hold and the module's files served by the same stand-in as the relay's tests. window.thumbsApp is what the test drives.
import { createThumbs } from '@elabora/player/canvas-thumbs';
import { serveRelayPort } from '@elabora/player/relay-protocol';
import type { RelayAnswer, RelayRequest, RelaySource } from '@elabora/player/relay-protocol';
import type { ThumbRequestName, ThumbRequests, ThumbShown, ThumbSource } from '@elabora/player/thumbs-protocol';

const params = new URLSearchParams(location.search);
const number = (name: string, fallback: number, least: number, most: number): number => { const value = Number(params.get(name)); return Number.isFinite(value) && params.has(name) ? Math.max(least, Math.min(most, Math.round(value))) : fallback; };
const CANVAS = 'https://canvas.elabora.page';
const ROWS = number('rows', 8, 1, 60);
const LIMIT = number('limit', 16, 1, 60);
const REFRESH = number('refresh', 400, 0, 5000);
const HEIGHT = number('height', 360, 90, 8000);
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
    if (!renders.has(screen)) renders.set(screen, await (await fetch(`/render/a/${encodeURIComponent(screen)}.json`)).json());
    return { id: `${name}:${screen}`, render: renders.get(screen), width: 1280, height: 720, version: `${screen}:${versions.get(screen) ?? 0}` } as unknown as ThumbRequests[Name]['result'];
  }
};

const thumbs = createThumbs({
  canvasOrigin: CANVAS,
  relayPort: async (host, port) => { ports++; ends.push(serveRelayPort(port, files, host)); },
  source, limit: LIMIT, refreshMs: REFRESH, current: () => current, drawTimeoutMs: 30000
});

document.body.style.cssText = 'margin:0;font:12px sans-serif';
const list = document.createElement('div');
list.id = 'list';
list.style.cssText = `width:420px;height:${HEIGHT}px;overflow:auto;position:relative`;
document.body.append(list);
let loads = 0;
list.addEventListener('load', () => { loads++; }, true);
const rows: HTMLElement[] = [];
const shown = new Map<number, ThumbShown>();
const drawn = new Map<number, boolean>();
const observer = new IntersectionObserver((changes) => {
  for (const change of changes) {
    const index = rows.indexOf(change.target as HTMLElement);
    if (change.isIntersecting && !shown.has(index)) {
      const one = thumbs.show(rows[index]!, { kind: 'screen', screen: SCREENS[index % SCREENS.length]! });
      shown.set(index, one);
      void one.drawn.then((ok) => { drawn.set(index, ok); });
    } else if (!change.isIntersecting && shown.has(index)) { shown.get(index)!.release(); shown.delete(index); drawn.delete(index); }
  }
});
for (let index = 0; index < ROWS; index++) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.index = String(index);
  row.style.cssText = 'width:160px;height:90px;margin:4px;background:#ddd;display:inline-block;overflow:hidden';
  list.append(row);
  rows.push(row);
  observer.observe(row);
}

const api = {
  calls, versions, drawn, rows,
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
  close() { thumbs.close(); for (const end of ends.splice(0)) end(); }
};
(window as unknown as { thumbsApp: typeof api }).thumbsApp = api;
