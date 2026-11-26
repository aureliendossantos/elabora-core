import { VoiceError } from '../provider.ts';

// ElevenLabs' answers as every host reads them (docs/decisions.md D29): a line's audio and its
// characters timed, why a request failed, and the key as it is shown.

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

// Why a request failed, as codes the app words (scrub: a message without the key, whatever it carried;
// newKey: where this host takes another key): the key refused or missing a permission, credits
// spent, too many requests, the voice unknown or not for this plan, the text refused.
export function failure(status: number, body: string, what: string, { scrub = scrubKeys, newKey = 'elabora voice key set' }: { scrub?: (message: string) => string; newKey?: string } = {}): VoiceError {
  let detail: { status?: string; message?: string } = {};
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    detail = typeof parsed.detail === 'object' && parsed.detail ? parsed.detail as typeof detail : { message: typeof parsed.detail === 'string' ? parsed.detail : body.slice(0, 300) };
  } catch { detail = { message: body.slice(0, 300) }; }
  const said = scrub(detail.message ?? '');
  const kind = detail.status ?? '';
  if (status === 401 && /missing_permissions|permission/i.test(`${kind} ${said}`)) return new VoiceError('E_VOICE_KEY_PERMISSION', `The ElevenLabs key may not ${what}: ${said} (give the key this permission on https://elevenlabs.io/app/settings/api-keys).`);
  if (status === 401) return new VoiceError('E_VOICE_KEY_INVALID', `ElevenLabs refused the key (${said || 'invalid API key'}): check it, or create another (${newKey}).`);
  if (/quota_exceeded|credits|character_limit/i.test(kind) || (status === 401 && /quota/i.test(said))) return new VoiceError('E_VOICE_CREDITS', `Not enough ElevenLabs credits left to ${what}: ${said}`);
  if (status === 429) return new VoiceError('E_VOICE_BUSY', `ElevenLabs is busy or the plan's concurrent requests are used (${said}): try again in a moment.`);
  if (status === 404 || /voice_not_found/i.test(kind)) return new VoiceError('E_VOICE_UNKNOWN', `ElevenLabs does not know this voice (${said}).`);
  if (status === 400 || status === 422) return new VoiceError('E_VOICE_REQUEST', `ElevenLabs refused to ${what}: ${said}`);
  return new VoiceError('E_VOICE_SERVICE', `ElevenLabs could not ${what} (HTTP ${status}${said ? `: ${said}` : ''}).`);
}

// The samples of 16-bit little-endian PCM (the output format pcm_24000), -1 to 1.
export function pcmSamples(base64: string): Float32Array {
  const binary = atob(base64);
  const samples = new Float32Array(Math.floor(binary.length / 2));
  for (let i = 0; i < samples.length; i++) {
    const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
  }
  return samples;
}

// sk_…1a2b: enough to tell two keys apart, never enough to use one.
export const maskKey = (key: string): string => `${key.slice(0, 3)}…${key.slice(-4)}`;

// A message without these keys, nor anything shaped like a key.
export const scrubKeys = (message: string, keys: readonly string[] = []): string =>
  keys.reduce((text, key) => text.split(key).join(maskKey(key)), message).replace(/sk_[A-Za-z0-9]{20,}/g, (found) => maskKey(found));
