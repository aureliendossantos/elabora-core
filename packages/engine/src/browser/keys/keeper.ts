// What the page of the ElevenLabs key (keys.elabora.studio, framed by the app) does with the key: it
// holds it, in memory, or kept in this browser when the author ticks it; it sends the operations Elabora
// asks ElevenLabs (@elabora/core voice/elevenlabs/requests.ts, nothing else) with it; it answers with
// ElevenLabs' answer, never with the key. The page (page.ts) gives it the field's value and its storage.

import { elevenLabsRequest } from '@elabora/core/voice/elevenlabs/requests';
import { failure, maskKey, scrubKeys } from '@elabora/core/voice/elevenlabs/answers';

export const API = 'https://api.elevenlabs.io';

// Where a kept key is: the page's IndexedDB (page.ts), or a test's memory.
export interface KeyStore {
  load(): Promise<string | null>;
  save(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface KeyState { present: boolean; masked: string | null; kept: boolean }

// An operation's answer: ElevenLabs' (its status and its JSON or its bytes, and what it charged when the
// page can read it), or why the page did not ask (code).
export type KeyAnswer =
  | { ok: true; status: number; body?: unknown; bytes?: ArrayBuffer; cost: number | null }
  | { ok: false; code: string; message: string };

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

const KEY_FORMAT = /^[A-Za-z0-9_-]{20,200}$/;
const refusal = (code: string, message: string): KeyAnswer => ({ ok: false, code, message });

export class KeyKeeper {
  readonly #store: KeyStore;
  readonly #fetch: Fetch;
  #key: string | null = null;
  #keep = false;

  constructor({ store, fetch }: { store: KeyStore; fetch: Fetch }) {
    this.#store = store;
    this.#fetch = fetch;
  }

  // The key kept in this browser, if there is one.
  async open(): Promise<void> {
    const kept = await this.#store.load().catch(() => null);
    if (kept) { this.#key = kept; this.#keep = true; }
  }

  state(): KeyState {
    return { present: !!this.#key, masked: this.#key ? maskKey(this.#key) : null, kept: !!this.#key && this.#keep };
  }

  // The field's value checked by ElevenLabs (/v1/user), then held, and kept when keep says so.
  async commit(value: string, keep: boolean): Promise<KeyAnswer & { state?: KeyState }> {
    const key = value.trim();
    if (!key) return refusal('E_VOICE_KEY_MISSING', 'The field is empty: paste an ElevenLabs API key.');
    if (!KEY_FORMAT.test(key)) return refusal('E_VOICE_KEY_FORMAT', 'This is not an ElevenLabs API key (it starts with sk_ and has no spaces).');
    const checked = await this.#send('account', {}, key);
    if (!checked.ok) return checked;
    if (checked.status >= 400) {
      const error = failure(checked.status, JSON.stringify(checked.body ?? ''), 'read your account', { scrub: (message) => scrubKeys(message, [key]), newKey: 'the ElevenLabs key\'s dialogue' });
      return refusal(error.code, error.message);
    }
    this.#key = key;
    this.#keep = keep;
    if (keep) await this.#store.save(key);
    else await this.#store.clear();
    return { ...checked, body: undefined, state: this.state() };
  }

  // Whether the key is kept in this browser: kept or erased from its storage at once.
  async setKeep(keep: boolean): Promise<KeyState> {
    this.#keep = keep;
    if (this.#key && keep) await this.#store.save(this.#key);
    else await this.#store.clear();
    return this.state();
  }

  async forget(): Promise<KeyState> {
    this.#key = null;
    await this.#store.clear();
    return this.state();
  }

  // An operation of the list, with the key held.
  ask(op: string, params: unknown): Promise<KeyAnswer> {
    return this.#send(op, params, this.#key);
  }

  async #send(op: string, params: unknown, key: string | null): Promise<KeyAnswer> {
    let request;
    try { request = elevenLabsRequest(op, params); } catch (error) { return refusal('E_KEY_REQUEST', (error as Error).message); }
    if (request.keyed && !key) return refusal('E_VOICE_KEY_MISSING', 'No ElevenLabs key in this browser: add it in « Clé ElevenLabs ».');
    const headers: Record<string, string> = { accept: request.answer === 'json' ? 'application/json' : 'audio/mpeg', ...(request.keyed ? { 'xi-api-key': key! } : {}), ...(request.body ? { 'content-type': 'application/json' } : {}) };
    let response: Response;
    try {
      response = await this.#fetch(request.keyed ? `${API}${request.path}` : request.path, { method: request.method, headers, ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
    } catch (error) {
      return refusal('E_VOICE_OFFLINE', `ElevenLabs could not be reached (${scrubKeys(error instanceof Error ? error.message : String(error), key ? [key] : [])}): check the connection.`);
    }
    // ElevenLabs does not expose character-cost to pages: null, unless a browser one day reads it.
    const charged = Number(response.headers.get('character-cost'));
    const cost = response.headers.has('character-cost') && Number.isFinite(charged) && charged >= 0 ? charged : null;
    if (response.ok && request.answer === 'bytes') return { ok: true, status: response.status, bytes: await response.arrayBuffer(), cost };
    // An answer never carries the key, even an error that would quote it.
    const text = scrubKeys(await response.text(), key ? [key] : []);
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* the text as it came */ }
    return { ok: true, status: response.status, body, cost };
  }
}
