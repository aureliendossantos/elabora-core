import os from 'node:os';
import { CloudClient, CloudError, cloudUrl, segment } from './client.ts';
import { readAiKey, removeAiKey, removeInvitation, removeSession, removeSessionFile, requireCredential, statusOf, updateSessionHandle, writeAiKey, writeInvitation, writeSession, isInvitationKey, isSessionToken, isSpaceName } from './credentials.ts';
import type { Credential, CredentialStatus } from './credentials.ts';
import type { AccountErased, AccountLimits, AccountSession, AccountUsage, CloudAccount, CloudAiKey, CloudPublication, CloudReview } from './types.ts';

// Signing in by e-mail code and the author's account (protocol « Accounts », version 3): the code
// is asked for by the caller (the command line reads it from its input, never an argument), the
// session token goes to its file and nowhere else.

export interface ServiceInfo {
  protocol: number;
  accounts: { signup: 'open' | 'closed'; codeLength: number; codeSeconds: number; attempts: number; sessionDays: number };
}

export const serviceInfo = (api: string = cloudUrl()): Promise<ServiceInfo> => new CloudClient(api).request<ServiceInfo>('GET', '/v1');

// The name this device goes by in the account's devices list: « Elabora CLI · macOS ». Never the
// computer's name, which is often a first name and would reach the hosting (and its sessions list)
// without the author having typed it, and never a user agent; the author names the device with
// --device when two computers must be told apart.
const SYSTEMS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
export const systemName = (platform: string = os.platform()): string => SYSTEMS[platform] ?? platform;
export function defaultDevice(platform: string = os.platform()): string {
  return `Elabora CLI · ${systemName(platform)}`;
}

export const signInLanguage = (language: string | undefined): 'fr' | 'en' => (language && !language.toLowerCase().startsWith('fr') ? 'en' : 'fr');

// Asks for a code: the API answers the same for every well-formed address (no e-mail goes to one that
// may not sign in), so this says nothing about the address.
export async function startSignIn(email: string, { language, api = cloudUrl() }: { language?: string; api?: string } = {}): Promise<{ expiresIn: number; codeLength: number }> {
  const answer = await new CloudClient(api).request<{ expiresIn: number; codeLength: number }>('POST', '/v1/auth/start', { json: { email: email.trim(), language: signInLanguage(language) } });
  return { expiresIn: answer.expiresIn, codeLength: answer.codeLength };
}

export interface SignedIn {
  account: CloudAccount;
  session: string | null;
  next: 'choose-handle' | null;
  file: string | null; // where the token went: the file, or null for the app's store (setSessionStore)
}

// Checks the code and keeps the session token in its file (0600). The token is in no return value.
export async function verifySignIn(email: string, code: string, { device = defaultDevice(), language, api = cloudUrl() }: { device?: string; language?: string; api?: string } = {}): Promise<SignedIn> {
  const answer = await new CloudClient(api).request<{ token: string; session: { id?: string } | string | null; account: CloudAccount; next: 'choose-handle' | null }>('POST', '/v1/auth/verify', {
    json: { email: email.trim(), code: code.replace(/[\s-]/g, ''), device: device.slice(0, 60), language: signInLanguage(language) }
  });
  const session = typeof answer.session === 'string' ? answer.session : answer.session?.id ?? null;
  const file = writeSession({ api, token: answer.token, session, email: answer.account.email, handle: answer.account.handle, device, createdAt: new Date().toISOString() });
  return { account: answer.account, session, next: answer.next, file };
}

// Keeps a tester's invitation key, after checking it opens its space.
export async function keepInvitation(key: string, space: string, { api = cloudUrl() }: { api?: string } = {}): Promise<{ file: string; publications: number }> {
  if (!isInvitationKey(key)) throw new CloudError(0, 'E_CLOUD_KEY_FORMAT', 'This is not an invitation key (eik_ followed by 43 characters).');
  if (!isSpaceName(space)) throw new CloudError(0, 'E_CLOUD_SPACE', `${JSON.stringify(space)} is not a space name.`);
  const { publications } = await new CloudClient(api, key).request<{ publications: CloudPublication[] }>('GET', `/v1/spaces/${segment(space)}/publications`);
  return { file: writeInvitation({ api, key, space, addedAt: new Date().toISOString() }), publications: publications.length };
}

// The session kept here (the file, or the app's store): updated and forgotten by the client. A
// session given by ELABORA_CLOUD_KEY_FILE is the script's, never touched.
const keptSession = (credential: Credential): boolean => credential.kind === 'session' && (credential.source === 'session-file' || credential.source === 'session-store');

// A client with the author's credential and the space it publishes to.
export interface Connection {
  client: CloudClient;
  credential: Credential;
  space: string;
}

// readOnly: the call only reads reviews and their comments, which an AI key may do (and is taken
// first for). Anything else with only an AI key on this computer is refused here, before a request.
export async function connect(api: string = cloudUrl(), { readOnly = false }: { readOnly?: boolean } = {}): Promise<Connection> {
  const credential = requireCredential(api, { readOnly });
  if (credential.kind === 'ai' && !readOnly) throw sessionRequired(credential);
  const client = new CloudClient(api, credential.token);
  let space = credential.space;
  if (!space && credential.kind === 'session') {
    // A handle chosen elsewhere (the app, another computer) since this session was kept.
    const { account } = await guard(credential, () => client.request<{ account: CloudAccount }>('GET', '/v1/account'));
    space = account.handle;
    if (space && keptSession(credential)) updateSessionHandle(space);
  }
  if (!space) throw new CloudError(0, 'E_CLOUD_HANDLE_REQUIRED', 'Your account has no address yet: choose it once with elabora account handle <name> (it becomes https://<name>.elabora.page/ and never changes).');
  return { client, credential, space };
}

// A 401 on any call means the session is over (revoked, expired, the account suspended or deleted):
// its file is forgotten and the author signs in again. A refused invitation key is kept (the key may
// come back after a deploy) and said.
export async function guard<T>(credential: Credential, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CloudError && error.status === 403 && error.code === 'read-only-key') throw sessionRequired(credential);
    if (error instanceof CloudError && error.status === 401 && error.code === 'unauthorized') {
      if (keptSession(credential)) {
        removeSession();
        throw new CloudError(401, 'session-ended', 'Your session with Elabora\'s hosting has ended (signed out elsewhere, expired or the account closed): elabora account login.');
      }
      if (credential.kind === 'ai') {
        if (credential.source === 'ai-key-file') removeAiKey();
        throw new CloudError(401, 'ai-key-ended', 'The hosting refused the read-only AI key (revoked, or the account closed): the author creates a new one in Elabora\'s settings, or with elabora account ai-key create.');
      }
      throw new CloudError(401, 'unauthorized', `The hosting refused your ${credential.kind === 'invitation' ? 'invitation key (revoked?)' : 'token'}: elabora account logout forgets it.`);
    }
    throw error;
  }
}

// An AI key reads reviews and nothing else (D45): what it may not do is said plainly, with what to do.
export function sessionRequired(credential: Pick<Credential, 'kind' | 'device'>): CloudError {
  const what = credential.kind === 'ai' ? `This computer gives Elabora's hosting a read-only AI key${credential.device ? ` (« ${credential.device} »)` : ''}: it lists reviews and reads their comments, nothing else.` : 'This needs the author\'s session.';
  return new CloudError(403, 'E_CLOUD_SESSION_REQUIRED', `${what} Publishing, sharing a review link, answering, resolving, closing and the account need the author's session: the author signs in with elabora account login --email <address> (or does it in the app).`);
}

export interface AccountView {
  credential: CredentialStatus;
  space: string | null;
  account: CloudAccount | null; // a session's account
  limits: AccountLimits | null;
  usage: AccountUsage | null;
  next: 'choose-handle' | null;
  publications: number | null; // an invitation key's space
  reviews: number | null; // an AI key's space: the reviews it reads
}

export async function accountStatus(api: string = cloudUrl()): Promise<AccountView> {
  const credential = requireCredential(api);
  const client = new CloudClient(api, credential.token);
  if (credential.kind === 'session') {
    const view = await guard(credential, () => client.request<{ account: CloudAccount; limits: AccountLimits; usage: AccountUsage; next: 'choose-handle' | null }>('GET', '/v1/account'));
    if (view.account.handle && view.account.handle !== credential.space && keptSession(credential)) updateSessionHandle(view.account.handle);
    return { credential: statusOf({ ...credential, space: view.account.handle }), space: view.account.handle, account: view.account, limits: view.limits, usage: view.usage, next: view.next, publications: null, reviews: null };
  }
  if (credential.kind === 'ai') {
    const { reviews } = await guard(credential, () => client.request<{ reviews: CloudReview[] }>('GET', `/v1/spaces/${segment(credential.space ?? '')}/reviews`));
    return { credential: statusOf(credential), space: credential.space, account: null, limits: null, usage: null, next: null, publications: null, reviews: reviews.length };
  }
  const { publications } = await guard(credential, () => client.request<{ publications: CloudPublication[] }>('GET', `/v1/spaces/${segment(credential.space ?? '')}/publications`));
  return { credential: statusOf(credential), space: credential.space, account: null, limits: null, usage: null, next: null, publications: publications.length, reviews: null };
}

export async function handleAvailable(name: string, api: string = cloudUrl()): Promise<{ handle: string; available: boolean; reason: string | null }> {
  const credential = requireCredential(api);
  return guard(credential, () => new CloudClient(api, credential.token).request('GET', `/v1/account/handle?name=${encodeURIComponent(name)}`));
}

// The author's session, for the account's routes (an invitation key has no account).
function sessionCredential(api: string): Credential {
  const credential = requireCredential(api);
  if (credential.kind === 'ai') throw sessionRequired(credential);
  if (credential.kind !== 'session') throw new CloudError(0, 'E_CLOUD_SESSION_REQUIRED', 'This is an account\'s: sign in with elabora account login --email <address>.');
  return credential;
}

const accountCall = <T>(credential: Credential, method: string, path: string, json?: unknown): Promise<T> =>
  guard(credential, () => new CloudClient(credential.api, credential.token).request<T>(method, path, json === undefined ? {} : { json }));

// The account's address, once: it names the space and never changes. displayName: the name of the
// author's replies (and the review page's « … vous invite »), given at the same time.
export async function chooseHandle(handle: string, { displayName, api = cloudUrl() }: { displayName?: string; api?: string } = {}): Promise<CloudAccount> {
  const credential = sessionCredential(api);
  const { account } = await accountCall<{ account: CloudAccount }>(credential, 'PATCH', '/v1/account', { handle, ...(displayName !== undefined ? { displayName } : {}) });
  if (account.handle && keptSession(credential)) updateSessionHandle(account.handle);
  return account;
}

// The display name (null: none) and the language of the account's e-mails.
export async function updateAccount(changes: { displayName?: string | null; language?: 'fr' | 'en' }, api: string = cloudUrl()): Promise<CloudAccount> {
  const credential = sessionCredential(api);
  return (await accountCall<{ account: CloudAccount }>(credential, 'PATCH', '/v1/account', changes)).account;
}

// The account's signed-in devices (« Appareils connectés »), the one asking marked current.
// The read-only AI keys come with them (protocol 6, D45): what can reach the account, in one place.
export async function accountSessions(api: string = cloudUrl()): Promise<{ sessions: AccountSession[]; aiKeys: CloudAiKey[] }> {
  const credential = sessionCredential(api);
  const { sessions, aiKeys } = await accountCall<{ sessions: AccountSession[]; aiKeys?: CloudAiKey[] }>(credential, 'GET', '/v1/account/sessions');
  return { sessions, aiKeys: aiKeys ?? [] };
}

// Signs a device out at once. Revoking this device's own session forgets it here too.
export async function revokeSession(id: string, api: string = cloudUrl()): Promise<{ revoked: boolean; session: string; current: boolean; forgotten: boolean }> {
  if (!/^ses_[0-9a-f]{20}$/.test(id)) throw new CloudError(0, 'E_CLOUD_SESSION_ID', `${JSON.stringify(id)} is not a session's id (ses_ and 20 hex digits).`);
  const credential = sessionCredential(api);
  const answer = await accountCall<{ revoked: boolean; session: string; current: boolean }>(credential, 'DELETE', `/v1/account/sessions/${segment(id)}`);
  const forgotten = answer.current && keptSession(credential) ? removeSession() : false;
  return { ...answer, forgotten };
}

// A fresh code to the account's address, which only confirms its deletion (10 minutes, once).
export async function requestDeletionCode(api: string = cloudUrl()): Promise<{ sent: boolean; expiresIn: number; codeLength: number }> {
  const credential = sessionCredential(api);
  return accountCall(credential, 'POST', '/v1/account/deletion-code');
}

// Erases the account and everything of it (confirm: its handle, or its address before a handle; code:
// the deletion code), then forgets the session here. A wrong code is CloudError invalid-code with
// details.attemptsLeft; an old one code-expired.
export async function deleteAccount(confirm: string, code: string, api: string = cloudUrl()): Promise<AccountErased & { forgotten: boolean }> {
  const credential = sessionCredential(api);
  const erased = await accountCall<AccountErased>(credential, 'DELETE', '/v1/account', { confirm, code: code.replace(/[\s-]/g, '') });
  return { ...erased, forgotten: keptSession(credential) ? removeSession() : false };
}

// Ends the session on the server, then forgets it here; an invitation key is only forgotten here
// (only the administrator revokes it). Forgotten even when the server cannot be reached.
export async function signOut(api: string = cloudUrl()): Promise<{ kind: Credential['kind']; source: Credential['source']; endedOnServer: boolean; forgotten: boolean }> {
  const credential = requireCredential(api);
  let endedOnServer = false;
  if (credential.kind === 'session') {
    try {
      await new CloudClient(api, credential.token).request('POST', '/v1/auth/logout');
      endedOnServer = true;
    } catch (error) {
      if (!(error instanceof CloudError) || error.status !== 401) {
        if (!keptSession(credential)) throw error;
      } else endedOnServer = true; // already over
    }
  }
  const forgotten = keptSession(credential) ? removeSession() : credential.source === 'invitation-file' ? removeInvitation() : credential.source === 'ai-key-file' ? removeAiKey() : false;
  return { kind: credential.kind, source: credential.source, endedOnServer, forgotten };
}

// ── Read-only AI keys (D45) ─────────────────────────────────────────────
// The author's session makes, lists and revokes them; the key goes to its file (0600) and nowhere
// else. The app calls createAiKey with the session it keeps (token), then the file holds the key in
// place of the session (forgetSessionFile), and agents read reviews without being able to act.

// The author's session: the token given (the app's), else the session file.
function sessionFor(api: string, token: string | undefined): Credential {
  if (token !== undefined) {
    if (!isSessionToken(token)) throw new CloudError(0, 'E_CLOUD_KEY_FORMAT', 'This is not a session token (eas_ followed by 43 characters).');
    return { kind: 'session', source: 'environment', file: '', api, token, space: null, email: null, device: null };
  }
  const credential = requireCredential(api);
  if (credential.kind !== 'session') throw sessionRequired(credential);
  return credential;
}

export interface CreatedAiKey {
  aiKey: CloudAiKey;
  space: string;
  file: string | null; // where the key went (null: keep false)
  forgotSession: boolean;
}

// Creates a read-only key named `name` (« Claude · macOS ») and keeps it in its file. The key itself
// is in no return value.
export async function createAiKey(name: string, { api = cloudUrl(), token, keep = true, forgetSessionFile = false }: { api?: string; token?: string; keep?: boolean; forgetSessionFile?: boolean } = {}): Promise<CreatedAiKey> {
  const credential = sessionFor(api, token);
  const answer = await guard(credential, () => new CloudClient(api, credential.token).request<{ aiKey: CloudAiKey; key: string; space: string }>('POST', '/v1/account/ai-keys', { json: { name: name.trim().slice(0, 60) } }));
  const file = keep ? writeAiKey({ api, key: answer.key, id: answer.aiKey.id, name: answer.aiKey.name, space: answer.space, createdAt: answer.aiKey.createdAt }) : null;
  const forgotSession = keep && forgetSessionFile ? removeSessionFile() : false;
  return { aiKey: answer.aiKey, space: answer.space, file, forgotSession };
}

// The account's AI keys (never a key), the one this computer keeps marked.
export async function listAiKeys({ api = cloudUrl(), token }: { api?: string; token?: string } = {}): Promise<{ aiKeys: (CloudAiKey & { here: boolean })[]; limit: number }> {
  const credential = sessionFor(api, token);
  const answer = await guard(credential, () => new CloudClient(api, credential.token).request<{ aiKeys: CloudAiKey[]; limit: number }>('GET', '/v1/account/ai-keys'));
  const kept = readAiKey();
  return { aiKeys: answer.aiKeys.map((key) => ({ ...key, here: kept?.api === api && kept.id === key.id })), limit: answer.limit };
}

// Revokes a key at once; the file goes too when it held that key.
export async function revokeAiKey(id: string, { api = cloudUrl(), token }: { api?: string; token?: string } = {}): Promise<{ revoked: boolean; aiKey: string; forgotten: boolean }> {
  if (!/^aik_[0-9a-f]{20}$/.test(id)) throw new CloudError(0, 'E_CLOUD_AI_KEY_ID', `${JSON.stringify(id)} is not an AI key's id (aik_ and 20 hex digits, as elabora account ai-key list gives them).`);
  const credential = sessionFor(api, token);
  await guard(credential, () => new CloudClient(api, credential.token).request('DELETE', `/v1/account/ai-keys/${segment(id)}`));
  const kept = readAiKey();
  const forgotten = kept?.api === api && kept.id === id ? removeAiKey() : false;
  return { revoked: true, aiKey: id, forgotten };
}
