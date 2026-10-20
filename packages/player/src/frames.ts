// Where the frame of a free object loads from, and its sandbox.
//   In a package: next to the course page, sandboxed without allow-same-origin, so the object has an
//     opaque origin, apart from the page, the LMS API, cookies and storage.
//   In a local preview (elabora preview, elabora look): from another port of the same server, with
//     allow-same-origin. That is another origin, so the object stays apart from the page; and browser
//     panes that refuse frames of an opaque origin (the in-app browsers of agent apps answer
//     ERR_BLOCKED_BY_CLIENT) show it. The same host keeps the frame on the page's site: in its
//     process, drawn with it, and allowed with it where a pane asks before opening a site.
// framesPort: that port (null: as in a package). Only pages of this computer use it.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// dir: the object's folder in the package (objects/<id>); base: the URL the page resolves it against.
export function objectFrame(dir: string, permissions: readonly string[], framesPort: number | null, base: string): { src: string; sandbox: string } {
  const sandbox = ['allow-scripts', ...permissions.map((permission) => `allow-${permission}`)];
  const src = `${dir}/frame.html`;
  const url = framesPort ? new URL(src, base) : null;
  if (!url || !LOOPBACK.has(url.hostname) || url.port === String(framesPort)) return { src, sandbox: sandbox.join(' ') };
  url.port = String(framesPort);
  return { src: url.href, sandbox: [...sandbox, 'allow-same-origin'].join(' ') };
}

// The port a page's free objects load from: <meta name="elabora-object-frames" content="<port>"> (a
// preview server adds it to the course page it serves), or ?frames=<port> in the URL of the canvas page.
export function pageFramesPort(source: 'meta' | 'url'): number | null {
  const value = source === 'meta' ? document.querySelector<HTMLMetaElement>('meta[name="elabora-object-frames"]')?.content : new URLSearchParams(location.search).get('frames');
  return value && /^\d{1,5}$/.test(value) ? Number(value) : null;
}
