import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { localDataRoot } from '../../data-dir.ts';
import { VoiceError } from '../provider.ts';
import { requireKey, scrub } from './key.ts';
import { failure as coreFailure } from '@elabora/core/voice/elevenlabs/answers';
import { elevenLabsRequest } from '@elabora/core/voice/elevenlabs/requests';
import type { ElevenOp } from '@elabora/core/voice/elevenlabs/requests';
import type { SpeechAnswer } from '@elabora/core/voice/elevenlabs/answers';

// ElevenLabs' HTTP API (docs/decisions.md D29), as Elabora uses it:
//   POST /v1/text-to-speech/{voice}/with-timestamps   a line, its characters timed
//   POST /v1/text-to-dialogue/with-timestamps         lines of several speakers in one exchange
//   GET  /v2/voices, /v1/voices/{id}                  the account's voices
//   GET  /v1/shared-voices                            the library (thousands of voices)
//   GET  /v1/user/subscription                        credits used and left this month
//   GET  /v1/models                                   what a model costs
// ELABORA_ELEVENLABS_URL points it elsewhere (tests: a local server; data residency: api.eu…).
//
// What a generation costs is paid once: its answer is kept on this computer, keyed by what was asked
// (endpoint, model, voices, text, settings, seed), and the same request is answered from there
// (<local data>/elevenlabs/cache; ELABORA_ELEVENLABS_CACHE elsewhere). A new take asks with another seed.
// It was <local data>/cache/elevenlabs: on macOS, where the app's user data is the same folder and
// its file system ignores case, that is inside Chromium's own Cache folder, which Chromium may empty.
// What was kept there is moved once.

const DEFAULT_URL = 'https://api.elevenlabs.io';
export const baseUrl = (): string => (process.env.ELABORA_ELEVENLABS_URL || DEFAULT_URL).replace(/\/+$/, '');
let moved = false;
export function cacheDir(): string {
  if (process.env.ELABORA_ELEVENLABS_CACHE) return process.env.ELABORA_ELEVENLABS_CACHE;
  const dir = path.join(localDataRoot(), 'elevenlabs', 'cache');
  if (!moved) {
    moved = true;
    const before = path.join(localDataRoot(), 'cache', 'elevenlabs');
    try {
      if (!fs.existsSync(dir) && fs.existsSync(before)) {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.renameSync(before, dir);
      }
    } catch { /* left where it was: asked again, at worst */ }
  }
  return dir;
}

export type { Alignment, SpeechAnswer } from '@elabora/core/voice/elevenlabs/answers';
export { pcmSamples } from '@elabora/core/voice/elevenlabs/answers';

// Why a request failed (the core's failure), without the keys this computer knows.
export const failure = (status: number, body: string, what: string): VoiceError => coreFailure(status, body, what, { scrub });

export async function request<T>(method: 'GET' | 'POST', route: string, options: { body?: unknown; signal?: AbortSignal; what: string; key?: string }): Promise<T> {
  return (await answered<T>(method, route, options)).body;
}

// The answer and what the service charged for it: ElevenLabs says each request's credits in its
// character-cost header (the account's count follows about a minute later).
async function answered<T>(method: 'GET' | 'POST', route: string, { body, signal, what, key }: { body?: unknown; signal?: AbortSignal; what: string; key?: string }): Promise<{ body: T; cost: number | null }> {
  // No key is said as such (E_VOICE_KEY_MISSING), before anything is sent: not as the service unreachable.
  const headers = { 'xi-api-key': key ?? requireKey(), ...(body === undefined ? {} : { 'content-type': 'application/json' }), accept: 'application/json' };
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${route}`, {
      method, signal, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new VoiceError('E_VOICE_OFFLINE', `ElevenLabs could not be reached to ${what} (${scrub(error instanceof Error ? error.message : String(error))}): check the connection.`);
  }
  const text = await response.text();
  if (!response.ok) throw failure(response.status, text, what);
  const charged = Number(response.headers.get('character-cost'));
  const cost = response.headers.has('character-cost') && Number.isFinite(charged) && charged >= 0 ? charged : null;
  try { return { body: JSON.parse(text) as T, cost }; } catch { throw new VoiceError('E_VOICE_SERVICE', `ElevenLabs answered something unreadable to ${what}.`); }
}

// An operation of the core's list, sent with the key: its answer and what it charged.
export function call<T>(op: ElevenOp, params: Record<string, unknown>, { signal, what, key }: { signal?: AbortSignal; what: string; key?: string }): Promise<{ body: T; cost: number | null }> {
  const { method, path: route, body } = elevenLabsRequest(op, params);
  return answered<T>(method, route, { body, signal, what, key });
}

// The generations asked before, kept on this computer, keyed by what was asked (the address, then its
// body). Another address than ElevenLabs' own (a test's imitation, a data residency) has answers of its own.
const cacheFile = (op: ElevenOp, params: Record<string, unknown>): string => {
  const { path: route, body } = elevenLabsRequest(op, params);
  const where = baseUrl() === DEFAULT_URL ? '' : `${baseUrl()}\0`;
  const id = crypto.createHash('sha256').update(`${where}${route}\0${JSON.stringify(body)}`).digest('hex');
  return path.join(cacheDir(), id.slice(0, 2), `${id}.json`);
};

export const generations = {
  async get(op: ElevenOp, params: Record<string, unknown>): Promise<SpeechAnswer | null> {
    try { return JSON.parse(fs.readFileSync(cacheFile(op, params), 'utf8')) as SpeechAnswer; } catch { return null; }
  },
  async put(op: ElevenOp, params: Record<string, unknown>, answer: SpeechAnswer): Promise<void> {
    const file = cacheFile(op, params);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.part`, JSON.stringify(answer));
    fs.renameSync(`${file}.part`, file);
  }
};
