// The page of the ElevenLabs key, keys.elabora.studio, framed by the app's « Clé ElevenLabs » dialogue
// (D136; the host serves it with its own policy, connect-src ElevenLabs only, frame-ancestors the app
// only). It holds only the key's field: the dialogue around it is the app's. The app's origins it
// takes ports from are written by the host in <meta name="elabora-app-origins">. Each port asks the operations of keeper.ts; the window's also
// keyState, forgetKey, commit, setKeep, focus and clear. Nothing it posts carries the key.

import { KeyKeeper } from './keeper.ts';
import type { KeyAnswer, KeyState, KeyStore } from './keeper.ts';

const VERSION = 1;
const DB = 'elabora-key';

const origins = (document.querySelector('meta[name="elabora-app-origins"]')?.getAttribute('content') ?? '')
  .split(/\s+/).filter((origin) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin));
const query = new URLSearchParams(location.search);
const french = query.get('lang') !== 'en';
document.documentElement.lang = french ? 'fr' : 'en';
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';

// The key kept in IndexedDB, encrypted by a key of its own that cannot be read out (it guards the copy
// on the disk, not the page: the page can use it).
const request = <T>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
async function database(): Promise<IDBDatabase> {
  const open = indexedDB.open(DB, 1);
  open.onupgradeneeded = () => { open.result.createObjectStore('key'); };
  return request(open);
}
const store: KeyStore = {
  async load() {
    const db = await database();
    const kept = await request(db.transaction('key').objectStore('key').get('key')) as { secret: CryptoKey; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined;
    db.close();
    if (!kept) return null;
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: kept.iv }, kept.secret, kept.data));
  },
  async save(key) {
    const secret = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, secret, new TextEncoder().encode(key));
    const db = await database();
    const tx = db.transaction('key', 'readwrite');
    tx.objectStore('key').put({ secret, iv, data }, 'key');
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  },
  async clear() {
    await request(indexedDB.deleteDatabase(DB)).catch(() => {});
  }
};

const keeper = new KeyKeeper({ store, fetch: (url, init) => fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }) });
const ports = new Set<MessagePort>();
const field = document.createElement('input');
let keep = false;

const post = (message: Record<string, unknown>, to?: MessagePort) => { for (const port of to ? [to] : ports) port.postMessage({ v: VERSION, ...message }); };
const keyEvent = (state: KeyState) => post({ kind: 'key', key: state });
const fieldEvent = (submitted = false) => post({ kind: 'field', empty: !field.value.trim(), submitted });

async function answer(port: MessagePort, data: unknown): Promise<void> {
  if (typeof data !== 'object' || data === null) return;
  const { v, id, op, params } = data as { v?: unknown; id?: unknown; op?: unknown; params?: unknown };
  if (v !== VERSION) { port.postMessage({ v: VERSION, id, ok: false, code: 'E_KEY_PROTOCOL', message: `This page speaks version ${VERSION}.` }); return; }
  if (typeof op !== 'string') return;
  let reply: Record<string, unknown>;
  switch (op) {
    case 'keyState': reply = { ok: true, key: keeper.state() }; break;
    case 'forgetKey': field.value = ''; reply = { ok: true, key: await keeper.forget() }; keyEvent(keeper.state()); break;
    case 'setKeep': keep = !!(params as { keep?: unknown } | undefined)?.keep; reply = { ok: true, key: await keeper.setKeep(keep) }; keyEvent(keeper.state()); break;
    case 'commit': {
      const done = await keeper.commit(field.value, keep);
      if (done.ok) { field.value = ''; fieldEvent(); keyEvent(keeper.state()); reply = { ok: true, key: keeper.state() }; }
      else reply = done;
      break;
    }
    case 'focus': field.focus(); reply = { ok: true }; break;
    case 'clear': field.value = ''; fieldEvent(); reply = { ok: true }; break;
    default: {
      const asked: KeyAnswer = await keeper.ask(op, params);
      if (asked.ok && asked.bytes) { port.postMessage({ v: VERSION, id, ...asked }, [asked.bytes]); return; }
      reply = asked;
    }
  }
  port.postMessage({ v: VERSION, id, ...reply });
}

function serve(port: MessagePort): void {
  ports.add(port);
  port.onmessage = ({ data }) => { void answer(port, data); };
  keyEvent(keeper.state());
}

if (window.parent === window) {
  // Opened by itself, out of Elabora: nothing to do here.
  document.body.textContent = french ? 'Cette page s’ouvre depuis Elabora, dans « Clé ElevenLabs ».' : 'This page opens from Elabora, in « ElevenLabs key ».';
} else {
  field.type = 'password';
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.name = 'elevenlabs-key';
  field.setAttribute('aria-label', query.get('label') || (french ? 'Clé ElevenLabs' : 'ElevenLabs key'));
  field.addEventListener('input', () => fieldEvent());
  field.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); fieldEvent(true); } });
  document.body.append(field);
  new ResizeObserver(() => post({ kind: 'size', height: Math.ceil(document.documentElement.getBoundingClientRect().height) })).observe(document.body);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !origins.includes(event.origin)) return;
    const { v, kind } = (event.data ?? {}) as { v?: unknown; kind?: unknown };
    if (v === VERSION && kind === 'connect' && event.ports[0]) serve(event.ports[0]);
  });
  void keeper.open().then(() => {
    keep = keeper.state().kept;
    keyEvent(keeper.state());
    window.parent.postMessage({ v: VERSION, kind: 'ready' }, '*');
  });
}
