import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { localDataRoot } from '../../data-dir.ts';
import { VoiceError } from '../provider.ts';
import { requireKey, scrub } from './key.ts';

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

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface SpeechAnswer {
  audio_base64: string;
  alignment?: Alignment | null;
  normalized_alignment?: Alignment | null;
  voice_segments?: { voice_id: string; start_time_seconds: number; end_time_seconds: number; character_start_index: number; character_end_index: number; dialogue_input_index: number }[];
}

// Why a request failed, as codes the app words: the key refused or missing a permission, credits
// spent, too many requests, the voice unknown or not for this plan, the text refused.
export function failure(status: number, body: string, what: string): VoiceError {
  let detail: { status?: string; message?: string } = {};
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    detail = typeof parsed.detail === 'object' && parsed.detail ? parsed.detail as typeof detail : { message: typeof parsed.detail === 'string' ? parsed.detail : body.slice(0, 300) };
  } catch { detail = { message: body.slice(0, 300) }; }
  const said = scrub(detail.message ?? '');
  const kind = detail.status ?? '';
  if (status === 401 && /missing_permissions|permission/i.test(`${kind} ${said}`)) return new VoiceError('E_VOICE_KEY_PERMISSION', `The ElevenLabs key may not ${what}: ${said} (give the key this permission on https://elevenlabs.io/app/settings/api-keys).`);
  if (status === 401) return new VoiceError('E_VOICE_KEY_INVALID', `ElevenLabs refused the key (${said || 'invalid API key'}): check it, or create another (elabora voice key set).`);
  if (/quota_exceeded|credits|character_limit/i.test(kind) || (status === 401 && /quota/i.test(said))) return new VoiceError('E_VOICE_CREDITS', `Not enough ElevenLabs credits left to ${what}: ${said}`);
  if (status === 429) return new VoiceError('E_VOICE_BUSY', `ElevenLabs is busy or the plan's concurrent requests are used (${said}): try again in a moment.`);
  if (status === 404 || /voice_not_found/i.test(kind)) return new VoiceError('E_VOICE_UNKNOWN', `ElevenLabs does not know this voice (${said}).`);
  if (status === 400 || status === 422) return new VoiceError('E_VOICE_REQUEST', `ElevenLabs refused to ${what}: ${said}`);
  return new VoiceError('E_VOICE_SERVICE', `ElevenLabs could not ${what} (HTTP ${status}${said ? `: ${said}` : ''}).`);
}

export async function request<T>(method: 'GET' | 'POST', route: string, options: { body?: unknown; signal?: AbortSignal; what: string; key?: string }): Promise<T> {
  return (await answered<T>(method, route, options)).body;
}

// The answer and what the service charged for it: ElevenLabs says each request's credits in its
// character-cost header (the account's count follows about a minute later).
async function answered<T>(method: 'GET' | 'POST', route: string, { body, signal, what, key }: { body?: unknown; signal?: AbortSignal; what: string; key?: string }): Promise<{ body: T; cost: number | null }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${route}`, {
      method, signal,
      headers: { 'xi-api-key': key ?? requireKey(), ...(body === undefined ? {} : { 'content-type': 'application/json' }), accept: 'application/json' },
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

// A generation, from this computer's cache when the same thing was asked before (cost 0), else what
// the service charged for it (null when it did not say). Another address than ElevenLabs' own (a
// test's imitation, a data residency) has answers of its own.
export async function generation(route: string, body: Record<string, unknown>, { signal, what }: { signal?: AbortSignal; what: string }): Promise<{ answer: SpeechAnswer; cached: boolean; cost: number | null }> {
  const where = baseUrl() === DEFAULT_URL ? '' : `${baseUrl()}\0`;
  const id = crypto.createHash('sha256').update(`${where}${route}\0${JSON.stringify(body)}`).digest('hex');
  const file = path.join(cacheDir(), id.slice(0, 2), `${id}.json`);
  try { return { answer: JSON.parse(fs.readFileSync(file, 'utf8')) as SpeechAnswer, cached: true, cost: 0 }; } catch { /* not asked yet */ }
  const { body: answer, cost } = await answered<SpeechAnswer>('POST', route, { body, signal, what });
  if (typeof answer.audio_base64 !== 'string' || !answer.audio_base64) throw new VoiceError('E_VOICE_SERVICE', `ElevenLabs gave no audio to ${what}.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.part`, JSON.stringify(answer));
  fs.renameSync(`${file}.part`, file);
  return { answer, cached: false, cost };
}

// The samples of 16-bit little-endian PCM (the output format pcm_24000), -1 to 1.
export function pcmSamples(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  const samples = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
  return samples;
}
