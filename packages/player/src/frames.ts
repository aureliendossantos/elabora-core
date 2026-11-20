// Where the frame of a free object loads from, and its sandbox.
//   In a package: next to the course page, sandboxed without allow-same-origin, so the object has an
//     opaque origin, apart from the page, the LMS API, cookies and storage.
//   In a local preview (elabora preview, elabora look): from another port of the same server, with
//     allow-same-origin. That is another origin, so the object stays apart from the page; and browser
//     panes that refuse frames of an opaque origin (the in-app browsers of agent apps answer
//     ERR_BLOCKED_BY_CLIENT) show it. The same host keeps the frame on the page's site: in its
//     process, drawn with it, and allowed with it where a pane asks before opening a site.
//   In a page served on the web: from an origin of its own (another site than the page's, which a
//     service worker there answers for), with allow-same-origin: a service worker serves no frame of
//     an opaque origin, and the object stays apart from the page all the same, by its origin.
// FramesSource: that port (only pages of this computer use it) or that origin; null: as in a package.
// Whatever the source, an object never gets the origin of the page that shows it: a source that
// would give it that (the page's own port or origin) leaves the frame sandboxed, as in a package.

// route: the relay's route of the view (relay-protocol.ts), which the frame's address carries so that the
// relay answers it by the port of the tab that holds it (D119).
export type FramesSource = { port: number } | { origin: string; route?: string };

import { isRoute } from './relay-protocol.ts';

// The sandbox words an object's manifest may ask for, whatever validation said of it (a manifest from a team's project, or a
// package, is not always validated): `pointer-lock` and nothing else. Any other word, one with a space in it too, is dropped:
// `top-navigation`, `popups`, `downloads`, `modals`... are the author's code moving the tab or opening windows.
export const SANDBOX_PERMISSIONS: readonly string[] = ['pointer-lock'];

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// dir: the object's folder in the package (objects/<id>); base: the URL the page resolves it against.
export function objectFrame(dir: string, permissions: readonly string[], frames: FramesSource | null, base: string): { src: string; sandbox: string } {
  const sandbox = ['allow-scripts', ...permissions.filter((permission) => SANDBOX_PERMISSIONS.includes(permission)).map((permission) => `allow-${permission}`)];
  const src = `${dir}/frame.html`;
  const packaged = { src, sandbox: sandbox.join(' ') };
  if (!frames) return packaged;
  // The frame's address next to the page.
  const url = new URL(src, base);
  if ('port' in frames) {
    if (!LOOPBACK.has(url.hostname) || url.port === String(frames.port)) return packaged;
    url.port = String(frames.port);
  } else {
    const origin = framesOrigin(frames.origin);
    if (!origin || origin === url.origin) return packaged;
    const framed = new URL(url.pathname + url.search, origin);
    if (frames.route !== undefined && isRoute(frames.route)) framed.searchParams.set('route', frames.route);
    return { src: framed.href, sandbox: [...sandbox, 'allow-same-origin'].join(' ') };
  }
  return { src: url.href, sandbox: [...sandbox, 'allow-same-origin'].join(' ') };
}

// An origin a page may load frames from: https, or http on this computer; nothing after the host.
export function framesOrigin(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin === 'null' || url.origin !== value.replace(/\/$/, '')) return null;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return url.origin;
  return null;
}

// Where a page's free objects load from: <meta name="elabora-object-frames" content="<port>"> (a
// preview server adds it to the course page it serves), or ?frames=<port or origin> in the URL of the
// canvas page (the app's page of the web gives the origin of its frames host).
export function pageFrames(source: 'meta' | 'url'): FramesSource | null {
  const value = source === 'meta' ? document.querySelector<HTMLMetaElement>('meta[name="elabora-object-frames"]')?.content : new URLSearchParams(location.search).get('frames');
  if (!value) return null;
  if (/^\d{1,5}$/.test(value)) return { port: Number(value) };
  const origin = framesOrigin(value);
  if (!origin) return null;
  // The frames' own route, not the canvas page's (`route`): the canvas's is not given to code of the author.
  const route = source === 'url' ? new URLSearchParams(location.search).get('framesRoute') : null;
  return isRoute(route) ? { origin, route } : { origin };
}
