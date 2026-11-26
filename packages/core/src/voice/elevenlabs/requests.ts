// What Elabora asks ElevenLabs (docs/decisions.md D29), by name: each operation, the parameters it
// takes, and the request it makes. Every host asks through this list. The desktop builds its requests
// with it before it sends them with the key; in a browser, the page that holds the key (keys.elabora.studio)
// builds them with it too, and refuses anything outside it. So a script in the app's origin can ask only
// these, never another of ElevenLabs' routes (deleting voices, making keys, reading the history).

import { VoiceError } from '../provider.ts';

export type ElevenOp = 'account' | 'subscription' | 'voices' | 'voice' | 'sharedVoices' | 'models' | 'speech' | 'dialogue' | 'sound' | 'preview';

export interface ElevenRequest {
  method: 'GET' | 'POST';
  // From the API's root, its query included; for preview, a whole address.
  path: string;
  body?: Record<string, unknown>;
  // What the answer is: JSON, or the bytes of a sound (sound, preview).
  answer: 'json' | 'bytes';
  // Whether it needs the key (a voice's sample does not).
  keyed: boolean;
}

// A voice's sample: a file of ElevenLabs' public bucket.
export const PREVIEWS = 'https://storage.googleapis.com/eleven-public-prod/';
const TEXT_MAX = 10_000;
const VALUE_MAX = 200;

const refuse = (why: string): never => { throw new VoiceError('E_KEY_REQUEST', `Not a request Elabora makes of ElevenLabs: ${why}.`); };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown, what: string): string => (typeof value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(value) ? value : refuse(`${what} is not an id`));
const word = (value: unknown, what: string): string => (typeof value === 'string' && /^[a-z0-9_]{1,60}$/.test(value) ? value : refuse(`${what} is not a name`));
const text = (value: unknown, what: string, max = TEXT_MAX): string => (typeof value === 'string' && value.length <= max ? value : refuse(`${what} is not a text of ${max} characters at most`));
const number = (value: unknown, what: string, min: number, max: number): number => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : refuse(`${what} is not a number from ${min} to ${max}`));
const OUTPUT = /^pcm_(16000|22050|24000|44100|48000)$/;

// The keys an object may have, each checked: what it gives back, in the order given.
function only(value: unknown, what: string, checks: Readonly<Record<string, (field: unknown, name: string) => unknown>>): Record<string, unknown> {
  if (!isObject(value)) return refuse(`${what} is not an object`);
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(checks, key)) refuse(`${what} has no ${key}`);
    out[key] = checks[key]!(field, `${what}.${key}`);
  }
  return out;
}

// A value as a form encodes it (application/x-www-form-urlencoded, as URLSearchParams writes it).
const form = (value: string): string => encodeURIComponent(value).replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');

// A query of these names, in the order given, each a short text or a number.
function query(params: Record<string, unknown>, names: readonly string[]): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (!names.includes(key)) refuse(`no ${key} in this query`);
    const said = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000 ? String(value) : text(value, key, VALUE_MAX);
    pairs.push(`${key}=${form(said)}`);
  }
  return pairs.length ? `?${pairs.join('&')}` : '';
}

const settings = (value: unknown, what: string) => only(value, what, { stability: (v, n) => number(v, n, 0, 1), similarity_boost: (v, n) => number(v, n, 0, 1), similarity: (v, n) => number(v, n, 0, 1) });
const seed = (value: unknown, what: string) => number(value, what, 0, 2 ** 32 - 1);

// The request of an operation, its parameters checked; anything else is refused (E_KEY_REQUEST).
export function elevenLabsRequest(op: string, params: unknown = {}): ElevenRequest {
  const p = isObject(params) ? params : refuse('its parameters are not an object');
  const none = (path: string): ElevenRequest => (Object.keys(p).length ? refuse(`${op} takes no parameter`) : { method: 'GET', path, answer: 'json', keyed: true });
  switch (op) {
    case 'account': return none('/v1/user');
    case 'subscription': return none('/v1/user/subscription');
    case 'models': return none('/v1/models');
    case 'voices': return { method: 'GET', path: `/v2/voices${query(p, ['page_size', 'search'])}`, answer: 'json', keyed: true };
    case 'voice': {
      const { id: voice, ...rest } = p;
      if (Object.keys(rest).length) refuse('voice takes its id only');
      return { method: 'GET', path: `/v1/voices/${id(voice, 'id')}`, answer: 'json', keyed: true };
    }
    case 'sharedVoices': return { method: 'GET', path: `/v1/shared-voices${query(p, ['page_size', 'page', 'sort', 'search', 'language', 'gender', 'age', 'accent', 'use_cases', 'category'])}`, answer: 'json', keyed: true };
    case 'speech': {
      const { voice, output_format: output, body, ...rest } = p;
      if (Object.keys(rest).length) refuse('speech takes voice, output_format and body');
      if (typeof output !== 'string' || !OUTPUT.test(output)) refuse('output_format is not a PCM format');
      const checked = only(body, 'body', {
        text: (v, n) => text(v, n), model_id: (v, n) => word(v, n), voice_settings: settings, seed, language_code: (v, n) => word(v, n),
        previous_text: (v, n) => text(v, n), next_text: (v, n) => text(v, n), apply_text_normalization: (v, n) => (v === 'auto' || v === 'on' || v === 'off' ? v : refuse(`${n} is not auto, on or off`))
      });
      return { method: 'POST', path: `/v1/text-to-speech/${id(voice, 'voice')}/with-timestamps?output_format=${output}`, body: checked, answer: 'json', keyed: true };
    }
    case 'dialogue': {
      const { output_format: output, body, ...rest } = p;
      if (Object.keys(rest).length) refuse('dialogue takes output_format and body');
      if (typeof output !== 'string' || !OUTPUT.test(output)) refuse('output_format is not a PCM format');
      const checked = only(body, 'body', {
        inputs: (v, n) => (Array.isArray(v) && v.length > 0 && v.length <= 50 ? v.map((input, i) => only(input, `${n}[${i}]`, { text: (t, m) => text(t, m), voice_id: (t, m) => id(t, m) })) : refuse(`${n} is not a list of 1 to 50 turns`)),
        model_id: (v, n) => word(v, n), settings, seed, language_code: (v, n) => word(v, n)
      });
      return { method: 'POST', path: `/v1/text-to-dialogue/with-timestamps?output_format=${output}`, body: checked, answer: 'json', keyed: true };
    }
    case 'sound': {
      const { body, ...rest } = p;
      if (Object.keys(rest).length) refuse('sound takes its body only');
      const checked = only(body, 'body', {
        text: (v, n) => text(v, n, 1000), model_id: (v, n) => word(v, n), duration_seconds: (v, n) => number(v, n, 0.5, 30),
        prompt_influence: (v, n) => number(v, n, 0, 1), loop: (v, n) => (typeof v === 'boolean' ? v : refuse(`${n} is not true or false`))
      });
      return { method: 'POST', path: '/v1/sound-generation?output_format=mp3_44100_128', body: checked, answer: 'bytes', keyed: true };
    }
    case 'preview': {
      const { url, ...rest } = p;
      if (Object.keys(rest).length) refuse('preview takes its url only');
      if (typeof url !== 'string' || !url.startsWith(PREVIEWS) || url.includes('..') || url.length > 600) refuse('url is not a sample of ElevenLabs\' public bucket');
      return { method: 'GET', path: url as string, answer: 'bytes', keyed: false };
    }
    default: return refuse(`no operation ${op}`);
  }
}
