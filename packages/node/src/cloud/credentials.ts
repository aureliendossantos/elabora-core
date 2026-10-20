import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { localDataRoot } from '../data-dir.ts';
import { CloudError, cloudUrl, isRecord, maskSecret } from './client.ts';
import type { SessionRecord, SessionStore } from './types.ts';

export type { SessionRecord, SessionStore } from './types.ts';

// The author's credential for Elabora's hosting (docs/decisions.md D43), on the model of the
// ElevenLabs key's file (D40): a file of the local data readable by the author only (0600, in a 0700
// folder), which the command line, agents' read tools and, later, the app read. Never in a course,
// a journal, a log or an output: what Elabora shows is masked (eas_…1a2b).
//   1. ELABORA_CLOUD_KEY_FILE: a file holding a key as it was handed over (a tester's invitation key,
//      with ELABORA_CLOUD_SPACE naming its space), for scripts and trials;
//   2. the session of an author signed in by e-mail code: <local data>/credentials/elabora-session,
//      or the store the app gives (setSessionStore: its safeStorage, when the author's AI may not use
//      the session); every read, write and removal of the session goes through the store;
//   3. a tester's invitation key kept by elabora account login --invitation:
//      <local data>/credentials/elabora-invitation;
//   4. a read-only AI key (D45): <local data>/credentials/elabora-ai-key, which the app writes in
//      place of the session so that agents read reviews and can do nothing else. Read tools (the
//      MCP server's) take it first; every other command needs a session and says so.
// Each file names the API it belongs to: a credential is only ever sent to that API, so a test
// server (ELABORA_CLOUD_URL) never receives the author's real token.

export type CredentialKind = 'session' | 'invitation' | 'ai';
// session-store: the session of a store the app gave (setSessionStore), not the file.
export type CredentialSource = 'session-file' | 'session-store' | 'invitation-file' | 'ai-key-file' | 'environment';

const SESSION_FORMAT = 'elabora-session/1';
const INVITATION_FORMAT = 'elabora-invitation/1';
const AI_KEY_FORMAT = 'elabora-ai-key/1';
const SESSION_TOKEN = /^eas_[A-Za-z0-9_-]{43}$/;
const INVITATION_KEY = /^eik_[A-Za-z0-9_-]{43}$/;
const AI_KEY = /^ear_[A-Za-z0-9_-]{43}$/;
const SPACE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// ELABORA_CLOUD_SESSION_FILE and ELABORA_CLOUD_INVITATION_FILE put them elsewhere (tests).
export const sessionFile = (): string => process.env.ELABORA_CLOUD_SESSION_FILE || path.join(localDataRoot(), 'credentials', 'elabora-session');
export const invitationFile = (): string => process.env.ELABORA_CLOUD_INVITATION_FILE || path.join(localDataRoot(), 'credentials', 'elabora-invitation');
export const aiKeyFile = (): string => process.env.ELABORA_CLOUD_AI_KEY_FILE || path.join(localDataRoot(), 'credentials', 'elabora-ai-key');

export interface InvitationRecord {
  format: typeof INVITATION_FORMAT;
  api: string;
  key: string;
  space: string;
  addedAt: string;
}

// A read-only key for the author's AI (D45): it lists the account's reviews and reads their comments.
export interface AiKeyRecord {
  format: typeof AI_KEY_FORMAT;
  api: string;
  key: string;
  id: string; // aik_…, to tell it apart in the account's devices and revoke it
  name: string;
  space: string; // the account's handle: the space whose reviews it reads
  createdAt: string;
}

export interface Credential {
  kind: CredentialKind;
  source: CredentialSource;
  file: string;
  api: string;
  token: string;
  space: string | null; // where publications and reviews go: the account's handle, the key's space
  email: string | null;
  device: string | null; // a session's device, an AI key's name
}

// What may be shown of a credential: never the token.
export interface CredentialStatus {
  kind: CredentialKind;
  source: CredentialSource;
  file: string;
  api: string;
  masked: string;
  space: string | null;
  email: string | null;
  device: string | null;
}

export const isSpaceName = (value: string): boolean => SPACE.test(value);
export const isSessionToken = (value: string): boolean => SESSION_TOKEN.test(value);
export const isInvitationKey = (value: string): boolean => INVITATION_KEY.test(value);
export const isAiKey = (value: string): boolean => AI_KEY.test(value);

export function statusOf(credential: Credential): CredentialStatus {
  const { token, ...shown } = credential;
  return { ...shown, masked: maskSecret(token) };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(value) ? value : null;
  } catch { return null; }
}

// The session's store: the 0600 file by default; the app may give its own (its safeStorage).
const fileStore: SessionStore = {
  read: () => readJson(sessionFile()) as SessionRecord | null,
  write: (record) => { writeSecretFile(sessionFile(), record); },
  remove: () => remove(sessionFile())
};
let sessionStore: SessionStore = fileStore;

// null gives the file back.
export function setSessionStore(store: SessionStore | null): void {
  sessionStore = store ?? fileStore;
}

export const sessionInFile = (): boolean => sessionStore === fileStore;

export function readSession(): SessionRecord | null {
  let value: unknown;
  try { value = sessionStore.read(); } catch { return null; } // a store that cannot read: no session
  if (!isRecord(value) || value.format !== SESSION_FORMAT || typeof value.token !== 'string' || !isSessionToken(value.token) || typeof value.api !== 'string') return null;
  return value as unknown as SessionRecord;
}

export function readInvitation(): InvitationRecord | null {
  const value = readJson(invitationFile());
  if (!value || value.format !== INVITATION_FORMAT || typeof value.key !== 'string' || !isInvitationKey(value.key) || typeof value.space !== 'string' || typeof value.api !== 'string') return null;
  return value as unknown as InvitationRecord;
}

export function readAiKey(): AiKeyRecord | null {
  const value = readJson(aiKeyFile());
  if (!value || value.format !== AI_KEY_FORMAT || typeof value.key !== 'string' || !isAiKey(value.key) || typeof value.space !== 'string' || typeof value.api !== 'string') return null;
  return value as unknown as AiKeyRecord;
}

// Written whole, readable by the author only, then moved into place: a reader never sees half a file.
function writeSecretFile(file: string, value: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return file;
}

// Where the session went: the file's path, or null for a store the app gave.
export function writeSession(record: Omit<SessionRecord, 'format'>): string | null {
  if (!isSessionToken(record.token)) throw new CloudError(0, 'E_CLOUD_TOKEN', 'The API did not give a session token.');
  sessionStore.write({ format: SESSION_FORMAT, ...record });
  return sessionInFile() ? sessionFile() : null;
}

export function updateSessionHandle(handle: string): void {
  const session = readSession();
  if (session) sessionStore.write({ ...session, handle });
}

export function writeInvitation(record: Omit<InvitationRecord, 'format'>): string {
  if (!isInvitationKey(record.key)) throw new CloudError(0, 'E_CLOUD_KEY_FORMAT', 'This is not an invitation key (eik_ followed by 43 characters).');
  if (!isSpaceName(record.space)) throw new CloudError(0, 'E_CLOUD_SPACE', `${JSON.stringify(record.space)} is not a space name (lowercase letters, digits and hyphens).`);
  return writeSecretFile(invitationFile(), { format: INVITATION_FORMAT, ...record });
}

export function writeAiKey(record: Omit<AiKeyRecord, 'format'>): string {
  if (!isAiKey(record.key)) throw new CloudError(0, 'E_CLOUD_TOKEN', 'The API did not give an AI key.');
  if (!isSpaceName(record.space)) throw new CloudError(0, 'E_CLOUD_SPACE', `${JSON.stringify(record.space)} is not a space name.`);
  return writeSecretFile(aiKeyFile(), { format: AI_KEY_FORMAT, ...record });
}

export const removeSession = (): boolean => sessionStore.remove();
// The session file itself, whatever the store: what createAiKey's forgetSessionFile removes.
export const removeSessionFile = (): boolean => remove(sessionFile());
export const removeInvitation = (): boolean => remove(invitationFile());
export const removeAiKey = (): boolean => remove(aiKeyFile());
function remove(file: string): boolean {
  try { fs.rmSync(file); return true; } catch { return false; }
}

// A key handed over in a file (an invitation key, a session token a script was given, an AI key), trimmed.
export function readKeyFile(file: string): string {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new CloudError(0, 'E_CLOUD_KEY_FILE', `${file} cannot be read.`); }
  const key = text.trim();
  if (!isInvitationKey(key) && !isSessionToken(key) && !isAiKey(key)) throw new CloudError(0, 'E_CLOUD_KEY_FORMAT', `${file} does not hold an invitation key (eik_…), a session token (eas_…) or an AI key (ear_…).`);
  return key;
}

const kindOf = (token: string): CredentialKind => (isSessionToken(token) ? 'session' : isAiKey(token) ? 'ai' : 'invitation');

// The credential for an API (by default the configured one), first found as above; null without any.
// readOnly (the MCP server's read tools): the AI key first, so that an agent reads with the least
// it needs even when the author's session is kept too.
export function resolveCredential(api: string = cloudUrl(), { readOnly = false }: { readOnly?: boolean } = {}): Credential | null {
  const fromEnv = process.env.ELABORA_CLOUD_KEY_FILE?.trim();
  if (fromEnv) {
    const token = readKeyFile(fromEnv);
    const space = process.env.ELABORA_CLOUD_SPACE?.trim() || null;
    if (!isSessionToken(token) && !space) throw new CloudError(0, 'E_CLOUD_SPACE', `ELABORA_CLOUD_KEY_FILE holds ${isAiKey(token) ? 'an AI key' : 'an invitation key'}: ELABORA_CLOUD_SPACE names its space.`);
    if (space && !isSpaceName(space)) throw new CloudError(0, 'E_CLOUD_SPACE', `ELABORA_CLOUD_SPACE ${JSON.stringify(space)} is not a space name.`);
    return { kind: kindOf(token), source: 'environment', file: path.resolve(fromEnv), api, token, space, email: null, device: null };
  }
  const aiKey = readAiKey();
  const ai: Credential | null = aiKey && aiKey.api === api ? { kind: 'ai', source: 'ai-key-file', file: aiKeyFile(), api, token: aiKey.key, space: aiKey.space, email: null, device: aiKey.name } : null;
  if (readOnly && ai) return ai;
  const session = readSession();
  if (session && session.api === api) return { kind: 'session', source: sessionInFile() ? 'session-file' : 'session-store', file: sessionInFile() ? sessionFile() : '', api, token: session.token, space: session.handle, email: session.email, device: session.device };
  const invitation = readInvitation();
  if (invitation && invitation.api === api) return { kind: 'invitation', source: 'invitation-file', file: invitationFile(), api, token: invitation.key, space: invitation.space, email: null, device: null };
  return ai;
}

// Credentials kept for another API than the one configured (a session made against a test server):
// said by elabora account status, never used.
export function otherApiCredentials(api: string = cloudUrl()): { kind: CredentialKind; api: string }[] {
  const found: { kind: CredentialKind; api: string }[] = [];
  const session = readSession();
  if (session && session.api !== api) found.push({ kind: 'session', api: session.api });
  const invitation = readInvitation();
  if (invitation && invitation.api !== api) found.push({ kind: 'invitation', api: invitation.api });
  const aiKey = readAiKey();
  if (aiKey && aiKey.api !== api) found.push({ kind: 'ai', api: aiKey.api });
  return found;
}

export function requireCredential(api: string = cloudUrl(), options: { readOnly?: boolean } = {}): Credential {
  const credential = resolveCredential(api, options);
  if (!credential) throw new CloudError(0, 'E_CLOUD_NOT_SIGNED_IN', `Not signed in to Elabora's hosting (${new URL(api).host}): elabora account login --email <address> (a code is sent to it), or --invitation <file> --space <space> with a tester's key.`);
  return credential;
}
