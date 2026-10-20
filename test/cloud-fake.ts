import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

// A fake of Elabora's hosting API (its protocol, version 6) for the core's client
// tests and the app's: sign-in by code (no e-mail: the code is fixed), the account (its devices, its
// display name, its deletion by a fresh code), publishing by hashes with
// whole and multipart blobs, private publications, reviews, comments with since, and the refusals the
// client must carry (quota, rights, a session over), and read-only AI keys (D45). In memory, on 127.0.0.1; it records every
// request so that tests can say what was sent.

export const FAKE_CODE = '12345678';

const sha256 = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');
const token = (prefix: string) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
const hexId = (prefix: string) => `${prefix}${crypto.randomBytes(10).toString('hex')}`;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

interface Principal { kind: 'session' | 'invitation' | 'ai'; space: string | null; account?: Account; label: string; session?: string; id?: string }
interface FakeSession { id: string; device: string; createdAt: string; lastUsedAt: string; expiresAt: string; account: Account; token: string }
interface AiKey { id: string; name: string; createdAt: string; lastUsedAt: string | null; key: string; account: Account }
interface Account { id: string; email: string; handle: string | null; displayName: string | null; language: string }
interface Publication { name: string; visibility: 'public' | 'private'; version: string; manifest: { files: Record<string, { sha256: string; size: number }>; noindex: boolean; meta: Record<string, unknown> }; committedAt: string; versions: string[] }
interface Upload { id: string; space: string; name: string; visibility: 'public' | 'private'; version: string; manifest: Publication['manifest']; previous: string | null }
interface Review { id: string; space: string; publication: string; title: string; state: 'open' | 'read-only' | 'closed'; versions: { number: number; version: string; addedAt: string; withdrawn?: boolean; course: unknown }[]; rev: number; link: string; createdAt: string; note: string | null; invitedBy: string | null }
export interface FakeComment { id: string; review: string; number: number | null; parent: string | null; version: string; versionNumber: number; screen: string | null; anchor: Record<string, unknown> | null; text: string; by: { kind: string; name: string }; state: 'open' | 'resolved' | null; resolvedAt: string | null; createdAt: string; editedAt: string | null; deleted: boolean; rev: number }

export interface FakeRequest { method: string; path: string; bytes: number; authorization: boolean }

export class FakeCloud {
  readonly requests: FakeRequest[] = [];
  readonly tokens = new Map<string, Principal>();
  readonly blobs = new Map<string, Map<string, Buffer>>(); // space → sha256 → bytes
  readonly publications = new Map<string, Map<string, Publication>>();
  readonly uploads = new Map<string, Upload>();
  readonly multiparts = new Map<string, { sha256: string; parts: Map<number, Buffer> }>();
  readonly reviews = new Map<string, Review>();
  readonly comments: FakeComment[] = [];
  readonly sentCodes: { email: string; language: string }[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly deletionCodes = new Set<string>(); // the accounts a deletion code was sent for (the code is FAKE_CODE)
  readonly erased: string[] = []; // the ids of the accounts erased
  readonly aiKeys = new Map<string, AiKey>();
  limits = { singlePutMaxBytes: 64 * 1024 * 1024, partBytes: 32 * 1024 * 1024 };
  quota: { storageBytes: number } | null = null; // an account's storage limit, checked at the announce
  attempts = new Map<string, number>();
  #server: http.Server | null = null;
  url = '';

  async start(): Promise<string> {
    this.#server = http.createServer((request, response) => { this.#handle(request, response).catch((error: unknown) => this.#send(response, 500, { error: { code: 'fake', message: String(error) } })); });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  // A tester's invitation key for a space, as the administrator issues it.
  invite(space: string, label = 'Testeur'): string {
    const key = token('eik_');
    this.tokens.set(key, { kind: 'invitation', space, label });
    return key;
  }

  blobRequests(): FakeRequest[] { return this.requests.filter((r) => r.method === 'PUT' && /\/blobs\//.test(r.path)); }

  // A reviewer's comment, as the review page posts it (POST /v1/review/comments).
  reviewerComment(review: string, anchor: Record<string, unknown>, text: string, name = 'Léa Morel'): FakeComment {
    const target = this.reviews.get(review)!;
    const version = target.versions.find((v) => v.version === anchor.version) ?? target.versions.at(-1)!;
    target.rev++;
    const thread: FakeComment = {
      id: hexId('cm_'), review, number: this.comments.filter((c) => c.review === review && c.parent === null).length + 1, parent: null,
      version: version.version, versionNumber: version.number, screen: String(anchor.screen), anchor, text, by: { kind: 'reviewer', name },
      state: 'open', resolvedAt: null, createdAt: new Date().toISOString(), editedAt: null, deleted: false, rev: target.rev
    };
    this.comments.push(thread);
    return thread;
  }

  reviewerReply(review: string, parent: string, text: string, name = 'Léa Morel'): FakeComment {
    const target = this.reviews.get(review)!;
    const thread = this.comments.find((c) => c.id === parent)!;
    target.rev++;
    const reply: FakeComment = { ...thread, id: hexId('cm_'), number: null, parent, anchor: null, screen: null, text, by: { kind: 'reviewer', name }, state: null, rev: target.rev };
    this.comments.push(reply);
    return reply;
  }

  #send(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  }

  async #handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(request.url ?? '/', this.url);
    const method = request.method ?? 'GET';
    const authorization = request.headers.authorization;
    this.requests.push({ method, path: url.pathname, bytes: raw.byteLength, authorization: !!authorization });
    const json = (): Record<string, unknown> => (raw.byteLength ? JSON.parse(raw.toString('utf8')) : {});
    const fail = (status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) => this.#send(response, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } }, headers);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'v1') return fail(404, 'no-route', 'No such route.');

    if (parts.length === 1 && method === 'GET') return this.#send(response, 200, { service: 'elabora-cloud', protocol: 6, accounts: { signup: 'closed', codeLength: 8, codeSeconds: 600, attempts: 5, sessionDays: 90 } });
    if (parts[1] === 'auth' && parts[2] === 'start') {
      const body = json();
      if (typeof body.email !== 'string' || !body.email.includes('@')) return fail(422, 'invalid-email', 'This is not an e-mail address.');
      this.sentCodes.push({ email: body.email, language: String(body.language) });
      return this.#send(response, 202, { accepted: true, expiresIn: 600, codeLength: 8 });
    }
    if (parts[1] === 'auth' && parts[2] === 'verify') {
      const body = json();
      const email = String(body.email);
      if (body.code !== FAKE_CODE) {
        const left = 4 - (this.attempts.get(email) ?? 0);
        this.attempts.set(email, (this.attempts.get(email) ?? 0) + 1);
        return left > 0 ? fail(401, 'invalid-code', 'This code is not the one sent.', { attemptsLeft: left }) : fail(401, 'code-expired', 'Ask a new code.');
      }
      const known = [...this.tokens.values()].find((p) => p.account?.email === email)?.account;
      const account: Account = known ?? { id: hexId('acc_'), email, handle: null, displayName: null, language: 'fr' };
      const session = token('eas_');
      const now = new Date().toISOString();
      const row: FakeSession = { id: hexId('ses_'), device: String(body.device), createdAt: now, lastUsedAt: now, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), account, token: session };
      this.sessions.set(row.id, row);
      this.tokens.set(session, { kind: 'session', space: account.handle, account, label: email, session: row.id });
      return this.#send(response, 200, { token: session, session: { id: row.id, device: row.device }, account: this.#account(account), next: account.handle ? null : 'choose-handle' });
    }

    const principal = authorization?.startsWith('Bearer ') ? this.tokens.get(authorization.slice(7)) : undefined;
    if (!principal) return fail(401, 'unauthorized', 'A valid key is required.');
    // An AI key reads the reviews and their comments, nothing else (elabora-cloud C31).
    if (principal.kind === 'ai') {
      const reads = method === 'GET' && parts[1] === 'spaces' && parts[3] === 'reviews' && (parts.length === 4 || parts.length === 5 || (parts.length === 6 && parts[5] === 'comments'));
      if (!reads) return fail(403, 'read-only-key', 'This key is an AI’s: it only lists reviews and reads their comments.');
      this.aiKeys.get(principal.id!)!.lastUsedAt = new Date().toISOString();
    }

    if (parts[1] === 'auth' && parts[2] === 'logout' && method === 'POST') {
      if (principal.session) this.sessions.delete(principal.session);
      this.tokens.delete(authorization!.slice(7));
      return this.#send(response, 200, { loggedOut: true });
    }
    if (parts[1] === 'account') {
      if (principal.kind !== 'session') return fail(403, 'session-required', 'These routes are an author’s, signed in by e-mail code.');
      const account = principal.account!;
      if (parts[2] === 'ai-keys') {
        const mine = () => [...this.aiKeys.values()].filter((key) => key.account === account).map(({ key: _key, account: _account, ...shown }) => shown);
        if (method === 'GET' && parts.length === 3) return this.#send(response, 200, { aiKeys: mine(), limit: 5 });
        if (method === 'POST' && parts.length === 3) {
          if (!account.handle) return fail(403, 'handle-required', 'Choose a handle first.');
          if (mine().length >= 5) return fail(409, 'too-many-ai-keys', 'An account has at most 5 AI keys: revoke one first.', { limit: 5 });
          const name = String(json().name ?? '').trim();
          if (!name || name.length > 60) return fail(422, 'invalid-name', 'name is 1 to 60 characters.');
          const made: AiKey = { id: hexId('aik_'), name, createdAt: new Date().toISOString(), lastUsedAt: null, key: token('ear_'), account };
          this.aiKeys.set(made.id, made);
          this.tokens.set(made.key, { kind: 'ai', space: account.handle, account, label: name, id: made.id });
          return this.#send(response, 201, { aiKey: { id: made.id, name, createdAt: made.createdAt, lastUsedAt: null }, key: made.key, space: account.handle });
        }
        if (method === 'DELETE' && parts.length === 4) {
          const found = this.aiKeys.get(parts[3]);
          if (!found || found.account !== account) return fail(404, 'no-ai-key', 'No such AI key.');
          this.aiKeys.delete(found.id);
          this.tokens.delete(found.key);
          return this.#send(response, 200, { revoked: true, aiKey: found.id });
        }
      }
      if (method === 'GET' && parts.length === 2) return this.#send(response, 200, { account: this.#account(account), limits: { storageBytes: 500 * 1024 * 1024, publicPublications: 3, openReviews: 3, indexing: false }, usage: { storageBytes: this.#stored(account.handle), publicPublications: 0, openReviews: 0 }, next: account.handle ? null : 'choose-handle' });
      if (method === 'PATCH' && parts.length === 2) {
        const body = json();
        if (typeof body.handle === 'string') {
          if (account.handle) return fail(409, 'handle-fixed', 'The handle never changes.');
          if (body.handle === 'essai') return fail(409, 'handle-unavailable', 'This address is reserved.', { reason: 'reserved' });
          account.handle = body.handle;
          for (const p of this.tokens.values()) if (p.account === account) p.space = body.handle;
        }
        if (body.displayName !== undefined) {
          if (body.displayName !== null && (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 60)) return fail(422, 'invalid-name', 'displayName is 1 to 60 characters.');
          account.displayName = body.displayName === null ? null : String(body.displayName).trim();
        }
        if (body.language !== undefined) {
          if (body.language !== 'fr' && body.language !== 'en') return fail(422, 'invalid-language', 'language is "fr" or "en".');
          account.language = body.language;
        }
        return this.#send(response, 200, { account: this.#account(account), next: account.handle ? null : 'choose-handle' });
      }
      // The devices: list, and sign one out.
      if (parts[2] === 'sessions' && parts.length === 3 && method === 'GET') {
        const sessions = [...this.sessions.values()].filter((row) => row.account === account).map(({ account: _a, token: _t, ...row }) => ({ ...row, current: row.id === principal.session }));
        const aiKeys = [...this.aiKeys.values()].filter((key) => key.account === account).map(({ key: _k, account: _a, ...shown }) => shown);
        return this.#send(response, 200, { sessions, aiKeys });
      }
      if (parts[2] === 'sessions' && parts.length === 4 && method === 'DELETE') {
        const row = this.sessions.get(parts[3]!);
        if (!row || row.account !== account) return fail(404, 'no-session', 'No such session.');
        this.sessions.delete(row.id);
        this.tokens.delete(row.token);
        return this.#send(response, 200, { revoked: true, session: row.id, current: row.id === principal.session });
      }
      // Erasure: a fresh code first, then the handle (or the address) and that code.
      if (parts[2] === 'deletion-code' && parts.length === 3 && method === 'POST') {
        this.deletionCodes.add(account.id);
        return this.#send(response, 202, { sent: true, expiresIn: 600, codeLength: 8 });
      }
      if (parts.length === 2 && method === 'DELETE') {
        const body = json();
        if (body.confirm !== (account.handle ?? account.email)) return fail(422, 'confirmation-required', 'Confirm with the account\'s handle (or its address before a handle).');
        if (!this.deletionCodes.has(account.id)) return fail(401, 'code-expired', 'Ask a new code.');
        if (body.code !== FAKE_CODE) return fail(401, 'invalid-code', 'This code is not the one sent.', { attemptsLeft: 4 });
        this.deletionCodes.delete(account.id);
        for (const [key, p] of this.tokens) if (p.account === account) this.tokens.delete(key);
        for (const [id, row] of this.sessions) if (row.account === account) this.sessions.delete(id);
        for (const [id, key] of this.aiKeys) if (key.account === account) this.aiKeys.delete(id);
        const space = account.handle;
        let reviewsDeleted = 0;
        let commentsDeleted = 0;
        let objectsDeleted = 0;
        if (space) {
          for (const [id, review] of this.reviews) {
            if (review.space !== space) continue;
            reviewsDeleted++;
            commentsDeleted += this.comments.filter((c) => c.review === id).length;
            this.reviews.delete(id);
          }
          objectsDeleted = (this.blobs.get(space)?.size ?? 0) + (this.publications.get(space)?.size ?? 0);
          this.blobs.delete(space);
          this.publications.delete(space);
        }
        this.erased.push(account.id);
        return this.#send(response, 200, { deleted: true, account: account.id, space, objectsDeleted, reviewsDeleted, commentsDeleted });
      }
    }

    if (parts[1] !== 'spaces' || !parts[2]) return fail(404, 'no-route', 'No such route.');
    const space = parts[2];
    if (principal.space !== space) return fail(403, 'forbidden', 'This key may not act on this space.');
    const publications = this.publications.get(space) ?? new Map<string, Publication>();
    this.publications.set(space, publications);
    const blobs = this.blobs.get(space) ?? new Map<string, Buffer>();
    this.blobs.set(space, blobs);

    // Publications.
    if (parts[3] === 'publications' && parts.length === 4 && method === 'GET') {
      return this.#send(response, 200, { publications: [...publications.values()].map((p) => this.#publication(space, p)) });
    }
    // One publication with the versions kept, and one version withdrawn (the current one refused, the reviews that showed it listing it as withdrawn).
    // Unpublishing: refused while a review shows it.
    if (parts[3] === 'publications' && parts.length === 5 && method === 'DELETE') {
      const found = publications.get(parts[4]!);
      if (!found) return fail(404, 'not-published', 'This publication is not published.');
      const shown = [...this.reviews.values()].filter((review) => review.space === space && review.publication === found.name).length;
      if (shown) return fail(409, 'in-review', `${shown} review(s) show this publication: delete them first (that removes it too).`);
      publications.delete(found.name);
      return this.#send(response, 200, { unpublished: true, versionsDeleted: found.versions.length, blobsDeleted: 0, uploadsExpired: 0 });
    }
    if (parts[3] === 'publications' && parts.length === 5 && method === 'GET') {
      const found = publications.get(parts[4]);
      if (!found) return fail(404, 'not-published', 'This publication is not published.');
      return this.#send(response, 200, { ...this.#publication(space, found), manifest: found.manifest, versions: found.versions });
    }
    if (parts[3] === 'publications' && parts[5] === 'versions' && parts.length === 7 && method === 'DELETE') {
      const found = publications.get(parts[4]);
      if (!/^[0-9a-f]{16}$/.test(parts[6])) return fail(400, 'bad-version', 'Not a version.');
      if (!found || !found.versions.includes(parts[6])) return fail(404, 'no-version', 'This publication has no such version.');
      if (found.version === parts[6]) return fail(409, 'current-version', 'This is the current version: publish a newer one first, or unpublish.');
      found.versions = found.versions.filter((v) => v !== parts[6]);
      const shown = [...this.reviews.values()].flatMap((review) => review.space === space && review.publication === found.name ? review.versions.filter((v) => v.version === parts[6]) : []);
      for (const v of shown) v.withdrawn = true;
      return this.#send(response, 200, { name: found.name, version: parts[6], withdrawn: true, visibility: found.visibility, reviews: shown.length, blobsDeleted: 0, uploadsExpired: 0 });
    }
    if (parts[3] === 'publications' && parts[5] === 'uploads' && method === 'POST') {
      const name = parts[4];
      const body = json() as { visibility?: 'public' | 'private'; manifest: Publication['manifest'] };
      const visibility = body.visibility ?? 'public';
      if (!body.manifest.noindex) return fail(403, 'noindex-required', 'Publish with noindex: an invitation key or an account without indexing.');
      const current = publications.get(name);
      if (current && current.visibility !== visibility) return fail(409, 'visibility-fixed', `${name} is ${current.visibility}.`);
      const version = sha256(canonical({ files: body.manifest.files, noindex: body.manifest.noindex, meta: body.manifest.meta })).slice(0, 16);
      const urlOf = visibility === 'public' ? `https://${space}.elabora.page/${name}/` : null;
      if (current?.version === version) return this.#send(response, 200, { unchanged: true, version, url: urlOf, missing: [] });
      const missing = new Map<string, number>();
      for (const file of Object.values(body.manifest.files)) if (!blobs.has(file.sha256)) missing.set(file.sha256, file.size);
      const adding = [...missing.values()].reduce((sum, size) => sum + size, 0);
      if (this.quota && this.#stored(space) + adding > this.quota.storageBytes) {
        return fail(403, 'quota-storage', 'Your space is full: unpublish an old publication, or delete a review that shows one.', { quota: 'storageBytes', limit: this.quota.storageBytes, used: this.#stored(space), adding });
      }
      const upload: Upload = { id: hexId('up_'), space, name, visibility, version, manifest: body.manifest, previous: current?.version ?? null };
      this.uploads.set(upload.id, upload);
      return this.#send(response, 201, { unchanged: false, upload: upload.id, version, previous: upload.previous, url: urlOf, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), missing: [...missing].map(([sha, size]) => ({ sha256: sha, size })), missingBytes: adding, limits: this.limits });
    }
    if (parts[3] === 'uploads') {
      const upload = this.uploads.get(parts[4]);
      if (!upload || upload.space !== space) return fail(404, 'no-upload', 'No such upload.');
      const sizes = new Map(Object.values(upload.manifest.files).map((f) => [f.sha256, f.size]));
      if (parts[5] === 'blobs') {
        const sha = parts[6];
        if (!sizes.has(sha)) return fail(404, 'not-in-manifest', 'The version does not have this blob.');
        if (parts.length === 7 && method === 'PUT') {
          if (raw.byteLength > this.limits.singlePutMaxBytes) return fail(413, 'use-multipart', 'Send it in parts.');
          if (raw.byteLength !== sizes.get(sha)) return fail(400, 'bad-length', 'Not the announced size.');
          if (sha256(raw) !== sha) return fail(422, 'digest-mismatch', 'The bytes do not hash to the name.');
          const stored = !blobs.has(sha);
          blobs.set(sha, raw);
          return this.#send(response, 200, { sha256: sha, stored, present: true });
        }
        if (parts[7] === 'multipart' && parts.length === 8 && method === 'POST') {
          if (blobs.has(sha)) return this.#send(response, 200, { present: true });
          const id = `mp-${crypto.randomBytes(6).toString('hex')}/x`; // URL-encoded by the client
          this.multiparts.set(id, { sha256: sha, parts: new Map() });
          return this.#send(response, 200, { present: false, multipart: id, partBytes: this.limits.partBytes, parts: Math.ceil(sizes.get(sha)! / this.limits.partBytes) });
        }
        if (parts[7] === 'multipart') {
          const multipart = this.multiparts.get(decodeURIComponent(parts[8]));
          if (!multipart) return fail(404, 'no-multipart', 'No such multipart upload.');
          if (parts[9] === 'complete' && method === 'POST') {
            const body = json() as { parts: { partNumber: number; etag: string }[] };
            const bytes = Buffer.concat(body.parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => multipart.parts.get(p.partNumber) ?? Buffer.alloc(0)));
            if (sha256(bytes) !== multipart.sha256) return fail(422, 'digest-mismatch', 'The parts do not hash to the name.');
            blobs.set(multipart.sha256, bytes);
            return this.#send(response, 200, { stored: true });
          }
          const n = Number(parts[9]);
          multipart.parts.set(n, raw);
          return this.#send(response, 200, { partNumber: n, etag: sha256(raw).slice(0, 32) });
        }
      }
      if (parts[5] === 'commit' && method === 'POST') {
        const missing = [...sizes.keys()].filter((sha) => !blobs.has(sha));
        if (missing.length) return fail(409, 'blobs-missing', 'Send them first.', { missing });
        const committedAt = new Date().toISOString();
        const kept = publications.get(upload.name)?.versions ?? [];
        publications.set(upload.name, { name: upload.name, visibility: upload.visibility, version: upload.version, manifest: upload.manifest, committedAt, versions: kept.includes(upload.version) ? kept : [...kept, upload.version] });
        this.uploads.delete(upload.id);
        const urlOf = upload.visibility === 'public' ? `https://${space}.elabora.page/${upload.name}/` : null;
        return this.#send(response, 200, { version: upload.version, visibility: upload.visibility, url: urlOf, pinnedUrl: urlOf ? `${urlOf}@${upload.version}/` : null, committedAt });
      }
    }

    // Reviews.
    if (parts[3] === 'reviews') {
      const id = parts[4];
      if (!id && method === 'POST') {
        const body = json();
        const publication = publications.get(String(body.publication));
        if (!publication) return fail(404, 'not-published', `${String(body.publication)} is not published.`);
        if (publication.visibility !== 'private') return fail(409, 'not-private', 'Only a private publication is reviewed.');
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
        if (note && note.length > 500) return fail(422, 'invalid-text', 'note is at most 500 characters.');
        const invitedBy = principal.kind === 'session' ? principal.account!.displayName : principal.label;
        const review: Review = { id: hexId('rv_'), space, publication: publication.name, title: typeof body.title === 'string' ? body.title : String(publication.manifest.meta.title), state: 'open', versions: [{ number: 1, version: publication.version, addedAt: new Date().toISOString(), course: publication.manifest.meta.course ?? null }], rev: 0, link: '', createdAt: new Date().toISOString(), note, invitedBy };
        review.link = `https://revue.elabora.studio/#${token('erl_')}`;
        this.reviews.set(review.id, review);
        return this.#send(response, 201, { review: this.#review(review, true), link: review.link });
      }
      if (!id && method === 'GET') {
        const only = url.searchParams.get('publication');
        return this.#send(response, 200, { space, reviews: [...this.reviews.values()].filter((r) => r.space === space && (!only || r.publication === only)).map((r) => this.#review(r)) });
      }
      const review = this.reviews.get(id);
      if (!review || review.space !== space) return fail(404, 'no-review', 'No such review.');
      if (parts.length === 5 && method === 'GET') return this.#send(response, 200, { review: this.#review(review), reviewers: [] });
      if (parts.length === 5 && method === 'PATCH') {
        const body = json();
        if (typeof body.state === 'string') review.state = body.state as Review['state'];
        if (body.title !== undefined) {
          if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 300) return fail(422, 'invalid-name', 'title is 1 to 300 characters.');
          review.title = body.title.trim();
        }
        if (body.note !== undefined) review.note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
        return this.#send(response, 200, { review: this.#review(review) });
      }
      if (parts.length === 5 && method === 'DELETE') {
        this.reviews.delete(id);
        const count = this.comments.filter((c) => c.review === id && !c.deleted).length;
        const others = [...this.reviews.values()].some((r) => r.publication === review.publication && r.space === space);
        if (!others) publications.delete(review.publication);
        return this.#send(response, 200, { deleted: true, review: review.id, commentsDeleted: count, content: others ? null : { unpublished: true } });
      }
      if (parts[5] === 'link' && method === 'POST') { review.link = `https://revue.elabora.studio/#${token('erl_')}`; return this.#send(response, 200, { review: this.#review(review, true), link: review.link }); }
      if (parts[5] === 'versions' && method === 'POST') {
        const current = publications.get(review.publication)!;
        const added = !review.versions.some((v) => v.version === current.version);
        if (added) review.versions.push({ number: review.versions.length + 1, version: current.version, addedAt: new Date().toISOString(), course: current.manifest.meta.course ?? null });
        return this.#send(response, 200, { added, review: this.#review(review) });
      }
      if (parts[5] === 'comments') {
        if (parts.length === 6 && method === 'GET') {
          const since = Number(url.searchParams.get('since') ?? -1);
          const screen = url.searchParams.get('screen');
          const state = url.searchParams.get('state');
          const threadOf = (c: FakeComment) => (c.parent ? this.comments.find((t) => t.id === c.parent)! : c);
          const list = this.comments.filter((c) => c.review === id && c.rev > since && (!screen || threadOf(c).screen === screen) && (!state || threadOf(c).state === state));
          return this.#send(response, 200, { review: review.id, rev: review.rev, comments: list.map((c) => ({ ...c, mine: c.by.kind === 'author', review: undefined })) });
        }
        if (parts.length === 6 && method === 'POST') {
          const body = json();
          const thread = this.comments.find((c) => c.id === body.parent && c.review === id);
          if (!thread) return fail(404, 'no-comment', 'No such comment.');
          review.rev++;
          const reply: FakeComment = { ...thread, id: hexId('cm_'), number: null, parent: thread.id, anchor: null, screen: null, text: String(body.text), by: { kind: 'author', name: typeof body.name === 'string' ? body.name : principal.label }, state: null, resolvedAt: null, createdAt: new Date().toISOString(), rev: review.rev };
          this.comments.push(reply);
          return this.#send(response, 201, { comment: { ...reply, mine: true, review: undefined } });
        }
        if (parts.length === 7 && method === 'PATCH') {
          const comment = this.comments.find((c) => c.id === parts[6] && c.review === id);
          if (!comment) return fail(404, 'no-comment', 'No such comment.');
          const body = json();
          if (body.state && comment.parent) return fail(422, 'not-a-thread', 'Only a thread is resolved.');
          if (body.state === 'resolved' || body.state === 'open') { comment.state = body.state; comment.resolvedAt = body.state === 'resolved' ? new Date().toISOString() : null; }
          comment.rev = ++review.rev;
          return this.#send(response, 200, { comment: { ...comment, mine: false, review: undefined } });
        }
      }
    }
    return fail(404, 'no-route', `No such route: ${method} ${url.pathname}`);
  }

  #stored(space: string | null): number {
    return space ? [...(this.blobs.get(space)?.values() ?? [])].reduce((sum, bytes) => sum + bytes.byteLength, 0) : 0;
  }

  #account(account: Account) {
    return { ...account, state: 'active', space: account.handle ? { name: account.handle, url: `https://${account.handle}.elabora.page/` } : null };
  }

  #publication(space: string, p: Publication) {
    return { name: p.name, url: p.visibility === 'public' ? `https://${space}.elabora.page/${p.name}/` : null, visibility: p.visibility, version: p.version, committedAt: p.committedAt, noindex: p.manifest.noindex, meta: p.manifest.meta, files: Object.keys(p.manifest.files).length, bytes: Object.values(p.manifest.files).reduce((s, f) => s + f.size, 0) };
  }

  #review(review: Review, withContent = false) {
    const threads = this.comments.filter((c) => c.review === review.id && c.parent === null && !c.deleted);
    return {
      id: review.id, space: review.space, publication: review.publication, title: review.title, state: review.state, note: review.note, invitedBy: review.invitedBy, languages: ['fr'], latest: review.versions.length,
      versions: review.versions.map((v) => ({ ...v, title: review.title, languages: ['fr'], comments: threads.filter((t) => t.version === v.version).length, open: threads.filter((t) => t.version === v.version && t.state === 'open').length, ...(withContent ? { content: v.withdrawn ? null : `https://${review.space}.elabora.page/~cap/@${v.version}/` } : {}), withdrawn: v.withdrawn === true })),
      comments: { open: threads.filter((t) => t.state === 'open').length, resolved: threads.filter((t) => t.state === 'resolved').length },
      reviewers: new Set(threads.map((t) => t.by.name)).size, rev: review.rev, createdAt: review.createdAt, updatedAt: review.createdAt
    };
  }
}
