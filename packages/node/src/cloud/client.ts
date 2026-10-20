// The HTTP side of Elabora's hosting (docs/decisions.md D43): one request at a time to the API, a
// bearer credential that never appears in a message, and the API's stable error codes kept as
// they are. Nothing here runs unless the author asks for it (a command, an agent's read tool):
// the core makes no network call of its own.

// The API's address. ELABORA_CLOUD_URL points elsewhere (the tests' fake server, a staging Worker).
export const DEFAULT_CLOUD_URL = 'https://api.elabora.studio';
// The page reviewers comment on: what a review build names as its origin (D42).
export const REVIEW_PAGE_ORIGIN = 'https://revue.elabora.studio';
// Where a space's publications are served: https://<space>.elabora.page/<publication>/.
export const CONTENT_DOMAIN = 'elabora.page';

export const publicationUrl = (space: string, name: string): string => `https://${space}.${CONTENT_DOMAIN}/${name}/`;

// The API checked: HTTPS, or HTTP on this computer only (a fake server); a credential is never sent
// in clear over a network.
export function cloudUrl(value: string | undefined = process.env.ELABORA_CLOUD_URL): string {
  const raw = value?.trim() || DEFAULT_CLOUD_URL;
  let url: URL;
  try { url = new URL(raw); } catch { throw new CloudError(0, 'E_CLOUD_URL', `ELABORA_CLOUD_URL is not an address: ${raw}`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new CloudError(0, 'E_CLOUD_URL', `The hosting API is reached over HTTPS (http only on this computer), not ${url.origin}.`);
  if (url.username || url.password || url.search || url.hash) throw new CloudError(0, 'E_CLOUD_URL', 'ELABORA_CLOUD_URL is an origin, without credentials, query or fragment.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

// An answer the API refused (its status, stable code, message and details), or a failure of this
// side (status 0, an E_CLOUD_* code: no credential, no network, a folder that is not a module).
export class CloudError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly retryAfter: number | null; // seconds, from Retry-After (429, 503)
  constructor(status: number, code: string, message: string, details?: unknown, retryAfter: number | null = null) {
    super(scrubSecrets(message));
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

// Session tokens (eas_), invitation keys (eik_), AI keys (ear_), review links (erl_) and reviewer tokens (ert_):
// masked wherever they would appear in a message.
const SECRET = /\b(eas|eik|erl|ert|ear)_[A-Za-z0-9_-]{16,}/g;
export const maskSecret = (secret: string): string => `${secret.slice(0, 4)}…${secret.slice(-4)}`;
export const scrubSecrets = (text: string): string => text.replace(SECRET, (found) => maskSecret(found));

export interface RequestOptions {
  json?: unknown; // a JSON body
  bytes?: Uint8Array; // raw bytes (a blob or a part)
  timeoutMs?: number;
}

export class CloudClient {
  readonly api: string;
  readonly #token: string | null;

  constructor(api: string, token: string | null = null) {
    this.api = api.replace(/\/+$/, '');
    this.#token = token;
  }

  get authenticated(): boolean { return this.#token !== null; }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    let body: BodyInit | undefined;
    if (options.bytes) {
      body = options.bytes as Uint8Array<ArrayBuffer>;
      headers['Content-Type'] = 'application/octet-stream'; // fetch sets Content-Length from the bytes
    } else if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['Content-Type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await fetch(`${this.api}${path}`, { method, headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 60_000), redirect: 'error' });
    } catch (error) {
      const reason = error instanceof Error ? (error.name === 'TimeoutError' ? 'no answer in time' : (error.cause as Error | undefined)?.message ?? error.message) : String(error);
      throw new CloudError(0, 'E_CLOUD_NETWORK', `Elabora's hosting could not be reached (${new URL(this.api).host}): ${reason}.`);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!response.ok) {
      const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
      const retry = Number(response.headers.get('retry-after'));
      throw new CloudError(response.status, typeof error?.code === 'string' ? error.code : `http-${response.status}`,
        typeof error?.message === 'string' ? error.message : `${response.status} ${response.statusText}`, error?.details, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    return parsed as T;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A path segment for the API (names are checked by the API; this keeps a caller's typo from making
// another route).
export const segment = (value: string): string => encodeURIComponent(value);
