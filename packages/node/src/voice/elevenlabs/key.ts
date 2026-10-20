import fs from 'node:fs';
import path from 'node:path';
import { localDataRoot } from '../../data-dir.ts';
import { VoiceError } from '../provider.ts';

// The author's ElevenLabs API key (docs/decisions.md D29, D40). Never in a course, its journal, a log
// or a message: Elabora shows it masked (sk_…1a2b). Where it comes from, first found:
//   1. the app, when the author keeps it in the system's secure storage (Keychain, DPAPI, libsecret):
//      read there the first time the author calls the service in a launch, and given to its engine
//      in memory (setSessionKey), never to its window;
//   2. ELEVENLABS_API_KEY in the environment (a script, a CI, a developer);
//   3. the file elabora voice key set writes for the command line and agents, readable by the author
//      only (0600): <local data>/credentials/elevenlabs-api-key. The app keeps the key there, and
//      only there, when the author lets agents and the command line use it.

export const KEY_ENV = 'ELEVENLABS_API_KEY';

let sessionKey: string | null = null;

// ELABORA_ELEVENLABS_KEY_FILE puts it elsewhere (tests).
export const keyFile = (): string => process.env.ELABORA_ELEVENLABS_KEY_FILE || path.join(localDataRoot(), 'credentials', 'elevenlabs-api-key');

export function setSessionKey(key: string | null): void {
  sessionKey = key ? checkedKey(key) : null;
}

function checkedKey(key: string): string {
  const trimmed = key.trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(trimmed)) throw new VoiceError('E_VOICE_KEY_FORMAT', 'This is not an ElevenLabs API key (it starts with sk_ and has no spaces).');
  return trimmed;
}

export function resolveKey(): { key: string; source: 'app' | 'environment' | 'file' } | null {
  if (sessionKey) return { key: sessionKey, source: 'app' };
  const fromEnv = process.env[KEY_ENV]?.trim();
  if (fromEnv) return { key: fromEnv, source: 'environment' };
  try {
    const fromFile = fs.readFileSync(keyFile(), 'utf8').trim();
    if (fromFile) return { key: fromFile, source: 'file' };
  } catch { /* none */ }
  return null;
}

export function requireKey(): string {
  const found = resolveKey();
  if (!found) throw new VoiceError('E_VOICE_KEY_MISSING', `No ElevenLabs API key on this computer: create one at https://elevenlabs.io/app/settings/api-keys (Text to Speech, Voices: read, User: read), then elabora voice key set (it reads the key from its input), or set ${KEY_ENV}.`);
  return found.key;
}

// sk_…1a2b: enough to tell two keys apart, never enough to use one.
export const maskKey = (key: string): string => `${key.slice(0, 3)}…${key.slice(-4)}`;

// Writes the key for the command line and agents, readable by the author only.
export function writeKeyFile(key: string): string {
  const file = keyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${checkedKey(key)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function removeKeyFile(): boolean {
  try { fs.rmSync(keyFile()); return true; } catch { return false; }
}

// A message without the key, whatever an error carried.
export function scrub(message: string): string {
  const keys = [sessionKey, process.env[KEY_ENV]?.trim()].filter((key): key is string => !!key);
  try { const fromFile = fs.readFileSync(keyFile(), 'utf8').trim(); if (fromFile) keys.push(fromFile); } catch { /* none */ }
  return keys.reduce((text, key) => text.split(key).join(maskKey(key)), message).replace(/sk_[A-Za-z0-9]{20,}/g, (found) => maskKey(found));
}
