import { narrationWords } from '@elabora/core/narration/words';
import { playsDirections, withoutDirections } from '@elabora/core/narration/directions';
import { VoiceError } from '../provider.ts';
import type { SynthesisRequest, SynthesisResult, VoiceProvider, DialogueRequest, DialogueResult } from '../provider.ts';
import type { VoiceAccount, VoiceInfo, VoiceQuery, VoiceSearchResult, VoiceGender } from '../types.ts';
import { quotaPercent, shareOf } from '@elabora/core/ai/quota';
import type { Quota } from '@elabora/core/ai/quota';
import { generation, pcmSamples, request } from './api.ts';
import type { Alignment, SpeechAnswer } from './api.ts';
import { maskKey, requireKey, resolveKey } from './key.ts';
import { chargedShare, keyId, noteSpent, quotaOf, readQuota, readSubscription, recordCharge, remember, rememberVoiceRate, voiceRate } from './costs.ts';

// ElevenLabs voices (docs/decisions.md D29), with the author's own key and credits. A line is said by
// the model the speaker's voice settings name (Eleven v4 by default: the most expressive, which plays
// stage directions), its characters timed; lines of several speakers that follow each other can be
// said as one exchange (synthesizeDialogue) and cut back into lines by those times. The audio is
// written into the course as any voice's: the course plays without the key.
//   settings: { model?: 'eleven_v4' | 'eleven_v4_turbo' | 'eleven_v3' | …, stability?: 0–1, similarity?: 0–1 }
// Eleven v4 has no speed nor style: pace and emotion come from the text, its punctuation and its
// directions.

export const PROVIDER = 'elevenlabs';
export const DEFAULT_MODEL = 'eleven_v4';
export const SAMPLE_RATE = 24000;
const OUTPUT = `pcm_${SAMPLE_RATE}`;

// A model's price per character, over the plan's (GET /v1/models model_rates); these when it cannot be read.
const MODEL_RATES: Record<string, number> = { eleven_v4: 1, eleven_v4_turbo: 0.5, eleven_v3: 1, eleven_multilingual_v2: 1, eleven_flash_v2_5: 0.5, eleven_turbo_v2_5: 0.5 };
let modelRates: Promise<Record<string, number>> | null = null;

const primary = (language: string) => language.toLowerCase().split('-')[0];
const clamp01 = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;

export interface ElevenSettings { model: string; stability?: number; similarity?: number }

export function settingsOf(settings: Readonly<Record<string, unknown>>): ElevenSettings {
  const model = typeof settings.model === 'string' && /^[a-z0-9_]{3,60}$/.test(settings.model) ? settings.model : DEFAULT_MODEL;
  const stability = clamp01(settings.stability);
  const similarity = clamp01(settings.similarity);
  return { model, ...(stability === undefined ? {} : { stability }), ...(similarity === undefined ? {} : { similarity }) };
}

// The text the model is given: with its stage directions for a model that plays them, else without.
export const textFor = (text: string, model: string): string => playsDirections({ provider: PROVIDER, settings: { model } }) ? text.trim() : withoutDirections(text);

// ── Voices ───────────────────────────────────────────────────────────

const known = new Map<string, VoiceInfo>();

interface AccountVoice {
  voice_id: string; name: string; category?: string; description?: string | null; preview_url?: string | null;
  labels?: Record<string, string>; sharing?: { rate?: number | null; notice_period?: number | null } | null;
  fine_tuning?: { state?: Record<string, string> } | null;
}

interface LibraryVoice {
  voice_id: string; public_owner_id: string; name: string; accent?: string; gender?: string; age?: string; descriptive?: string; use_case?: string;
  language?: string; locale?: string; description?: string | null; preview_url?: string | null; rate?: number | null; notice_period?: number | null; category?: string;
  verified_languages?: { language: string; preview_url?: string | null }[] | null;
}

const genderOf = (value: string | undefined): VoiceGender | null => value === 'female' || value === 'male' ? value : null;

function creditOf(name: string): Record<string, string> {
  const short = name.split(' - ')[0].trim() || name;
  return { fr: `Voix de synthèse : ${short} (ElevenLabs)`, en: `Synthetic voice: ${short} (ElevenLabs)` };
}

function fromAccount(voice: AccountVoice): VoiceInfo {
  const labels = voice.labels ?? {};
  const owner = voice.category === 'premade' ? 'premade' : 'account';
  const info: VoiceInfo = {
    provider: PROVIDER, id: voice.voice_id, name: voice.name, language: labels.language || 'en', gender: genderOf(labels.gender),
    description: { en: (voice.description || [labels.descriptive, labels.use_case].filter(Boolean).join(', ')).slice(0, 240) },
    licence: owner === 'premade' ? 'ElevenLabs default voice' : voice.category === 'professional' ? 'ElevenLabs voice (Voice Library or the author\'s clone)' : 'The author\'s ElevenLabs voice',
    source: 'ElevenLabs', credit: creditOf(voice.name), multilingual: true, owner,
    labels: { ...(labels.accent ? { accent: labels.accent } : {}), ...(labels.age ? { age: labels.age } : {}), ...(labels.use_case ? { useCase: labels.use_case } : {}), ...(labels.descriptive ? { descriptive: labels.descriptive } : {}) },
    ...(voice.preview_url ? { preview: voice.preview_url } : {}),
    ...(typeof voice.sharing?.rate === 'number' ? { rate: voice.sharing.rate } : {}),
    ...(voice.sharing && 'notice_period' in voice.sharing ? { noticeDays: voice.sharing.notice_period ?? null } : {})
  };
  known.set(info.id, info);
  rememberVoiceRate(info.id, info.rate);
  return info;
}

// language: the one searched, whose recording of the voice (when it has one) is heard first.
function fromLibrary(voice: LibraryVoice, language?: string): VoiceInfo {
  const preview = (language && voice.verified_languages?.find((verified) => primary(verified.language) === primary(language) && verified.preview_url)?.preview_url) || voice.preview_url;
  const info: VoiceInfo = {
    provider: PROVIDER, id: voice.voice_id, name: voice.name, language: voice.language || 'en', gender: genderOf(voice.gender),
    description: { en: (voice.description || [voice.descriptive, voice.use_case].filter(Boolean).join(', ')).slice(0, 240) },
    licence: 'ElevenLabs Voice Library (a paid plan may use it commercially)', source: `ElevenLabs Voice Library, shared by ${voice.public_owner_id}`,
    credit: creditOf(voice.name), multilingual: true, owner: 'library',
    labels: { ...(voice.accent ? { accent: voice.accent } : {}), ...(voice.age ? { age: voice.age } : {}), ...(voice.use_case ? { useCase: voice.use_case } : {}), ...(voice.descriptive ? { descriptive: voice.descriptive } : {}), ...(voice.locale ? { locale: voice.locale } : {}) },
    ...(preview ? { preview } : {}),
    ...(typeof voice.rate === 'number' ? { rate: voice.rate } : {}),
    noticeDays: voice.notice_period ?? null
  };
  known.set(info.id, info);
  rememberVoiceRate(info.id, info.rate);
  return info;
}

export async function searchVoices(query: VoiceQuery, signal?: AbortSignal): Promise<VoiceSearchResult> {
  const scope = query.scope ?? 'all';
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 30));
  const voices: VoiceInfo[] = [];
  let total = 0;
  let more = false;
  const matches = (voice: VoiceInfo) => (!query.language || primary(voice.language) === primary(query.language) || voice.labels?.locale?.toLowerCase().startsWith(primary(query.language)))
    && (!query.gender || voice.gender === query.gender) && (!query.age || voice.labels?.age === query.age)
    && (!query.accent || voice.labels?.accent === query.accent) && (!query.useCase || voice.labels?.useCase === query.useCase);
  if (scope !== 'library' && !query.page) {
    const params = new URLSearchParams({ page_size: '100', ...(query.text ? { search: query.text } : {}) });
    const answer = await request<{ voices: AccountVoice[] }>('GET', `/v2/voices?${params}`, { signal, what: 'list the account\'s voices' });
    const mine = answer.voices.map(fromAccount).filter(matches);
    voices.push(...mine);
    total += mine.length;
  }
  if (scope !== 'account') {
    const sort = query.sort === 'trending' ? 'trending' : query.sort === 'recent' ? 'created_date' : 'usage_character_count_1y';
    const params = new URLSearchParams({ page_size: String(pageSize), page: String(query.page ?? 0), sort });
    if (query.text) params.set('search', query.text);
    if (query.language) params.set('language', primary(query.language));
    if (query.gender) params.set('gender', query.gender);
    if (query.age) params.set('age', query.age);
    if (query.accent) params.set('accent', query.accent);
    if (query.useCase) params.append('use_cases', query.useCase);
    const answer = await request<{ voices: LibraryVoice[]; has_more: boolean; total_count?: number }>('GET', `/v1/shared-voices?${params}`, { signal, what: 'search the voice library' });
    const seen = new Set(voices.map((voice) => voice.id));
    voices.push(...answer.voices.map((voice) => fromLibrary(voice, query.language)).filter((voice) => !seen.has(voice.id)));
    total += answer.total_count ?? answer.voices.length;
    more = answer.has_more;
  }
  return { voices, total, more };
}

// A voice by its id: the account's (and library voices it already used); else one a search found.
export async function lookupVoice(id: string, signal?: AbortSignal): Promise<VoiceInfo | null> {
  try {
    return fromAccount(await request<AccountVoice>('GET', `/v1/voices/${encodeURIComponent(id)}`, { signal, what: 'read the voice' }));
  } catch (error) {
    if (error instanceof VoiceError && error.code === 'E_VOICE_UNKNOWN') return known.get(id) ?? null;
    throw error;
  }
}

// ── Account and costs ────────────────────────────────────────────────

// The month's quota of the key in use, what this process spent included (D30).
export async function quota(signal?: AbortSignal): Promise<Quota> {
  return readQuota({ signal, key: requireKey() });
}

// What a typical line costs: 70 characters said by the default model, as a share of a quota.
const LINE_CHARACTERS = 70;
export const lineShare = (limit: number, plan: string | null): number => shareOf(Math.ceil(LINE_CHARACTERS * chargedShare(plan)), limit);

// The plan, its quota this month, and what the key may do: each permission Elabora needs tried
// without spending (an empty text is refused as such only when the key may make speech). key: a key
// to check before it is kept (the app's « Vérifier »), else the one in use.
export async function account({ signal, check = false, key: given }: { signal?: AbortSignal; check?: boolean; key?: string } = {}): Promise<VoiceAccount> {
  const found = given ? { key: given.trim(), source: 'given' as const } : resolveKey();
  if (!found) requireKey();
  const key = found!.key;
  const permissions: Record<string, boolean | null> = { user_read: null, voices_read: null, text_to_speech: null };
  let read: Quota | null = null;
  try {
    const sub = await readSubscription({ signal, key });
    read = given ? quotaOf(sub) : remember(keyId(key), quotaOf(sub));
    permissions.user_read = true;
  } catch (error) {
    if (!(error instanceof VoiceError && error.code === 'E_VOICE_KEY_PERMISSION')) throw error;
    permissions.user_read = false;
  }
  if (check) {
    permissions.voices_read = await allowed(() => request('GET', '/v2/voices?page_size=1', { signal, what: 'list voices', key }));
    permissions.text_to_speech = await allowed(() => request('POST', `/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=${OUTPUT}`, { body: { text: '', model_id: DEFAULT_MODEL }, signal, what: 'make speech', key }), true);
  }
  return {
    provider: PROVIDER, key: maskKey(key), keySource: found!.source,
    plan: read?.plan ?? 'unknown', used: read?.used ?? 0, limit: read?.limit ?? 0, remaining: read ? Math.max(0, read.limit - read.used) : 0,
    usedPercent: read && read.limit > 0 ? quotaPercent(shareOf(read.used, read.limit)) : 0,
    resetsAt: read?.resetsAt ?? null,
    commercial: !!read && read.plan !== 'free', library: !!read && read.plan !== 'free',
    linePercent: read && read.limit > 0 ? quotaPercent(lineShare(read.limit, read.plan)) : null,
    permissions
  };
}

// true when the call passes or is refused for what was asked (the key may), false when the key may not.
async function allowed(call: () => Promise<unknown>, refusalMeansAllowed = false): Promise<boolean> {
  try { await call(); return true; } catch (error) {
    if (error instanceof VoiceError && error.code === 'E_VOICE_KEY_PERMISSION') return false;
    if (refusalMeansAllowed && error instanceof VoiceError && error.code === 'E_VOICE_REQUEST') return true;
    throw error;
  }
}

async function listRates(): Promise<Record<string, number>> {
  modelRates ??= request<{ model_id: string; model_rates?: { character_cost_multiplier?: number } }[]>('GET', '/v1/models', { what: 'read the models\' prices' })
    .then((models) => ({ ...MODEL_RATES, ...Object.fromEntries(models.filter((m) => typeof m.model_rates?.character_cost_multiplier === 'number').map((m) => [m.model_id, m.model_rates!.character_cost_multiplier!])) }))
    .catch(() => MODEL_RATES);
  return modelRates;
}

// The list price of a text, a ceiling: its characters (directions included: they are sent) times the
// model's and the voice's rates.
async function ceilingOf(characters: number, model: string, voice: string): Promise<number> {
  return characters * (await modelRate(model)) * (known.get(voice)?.rate ?? voiceRate(voice) ?? 1);
}

// A model's list price per character, in credits, as the service says it (1 when it does not know the model).
const modelRate = async (model: string): Promise<number> => (await listRates())[model] ?? 1;

// The plan of the key in use (its quota, read or counted lately), null when it cannot be read.
async function planOf(): Promise<string | null> {
  try { return (await quota()).plan; } catch { return null; }
}

// What a text costs: about (credits: the list price times the share the plan is charged, D29, D30, D36:
// the current price period's, undiscounted) and at most (ceiling: the list price).
export async function estimateCredits(text: string, voice: string, settings: Readonly<Record<string, unknown>>): Promise<{ characters: number; credits: number; ceiling: number }> {
  const { model } = settingsOf(settings);
  const said = textFor(text, model);
  const ceiling = await ceilingOf(said.length, model, voice);
  return { characters: said.length, credits: Math.ceil(ceiling * chargedShare(await planOf(), model, await modelRate(model))), ceiling: Math.ceil(ceiling) };
}

// What a request was charged, learnt for the next estimates and counted until the account shows it.
async function charged(cost: number | null, cached: boolean, characters: number[], voices: string[], model: string, kind: 'speech' | 'dialogue'): Promise<number | null> {
  if (cached) return 0;
  const ceiling = (await Promise.all(characters.map((count, at) => ceilingOf(count, model, voices[at] ?? '')))).reduce((sum, value) => sum + value, 0);
  const [plan, rate] = [await planOf(), await modelRate(model)];
  if (cost !== null) recordCharge({ model, plan, list: ceiling, billed: cost, rate, kind });
  noteSpent(cost ?? Math.ceil(ceiling * chargedShare(plan, model, rate, kind)));
  return cost;
}

// ── Speech ───────────────────────────────────────────────────────────

// Words timed from the characters ElevenLabs timed, directions left out; times from the start of
// the audio, shifted by offset (seconds cut before it).
export function wordsFromAlignment(alignment: Alignment | null | undefined, offset = 0, from = 0, to?: number): { text: string; start: number; end: number }[] {
  if (!alignment?.characters?.length) return [];
  const end = to ?? alignment.characters.length;
  const text = alignment.characters.slice(from, end).join('');
  const round = (seconds: number) => Math.max(0, Math.round((seconds - offset) * 1000) / 1000);
  return narrationWords(text).map((word) => ({
    text: word.text,
    start: round(alignment.character_start_times_seconds[from + word.start] ?? 0),
    end: round(alignment.character_end_times_seconds[from + word.end - 1] ?? alignment.character_start_times_seconds[from + word.start] ?? 0)
  }));
}

// Where the voice starts and stops in samples: past silence quieter than -45 dB on 10 ms, with 50 ms kept.
export function speechBounds(samples: Float32Array, rate = SAMPLE_RATE): { start: number; end: number } {
  const window = Math.round(rate * 0.01);
  const threshold = 10 ** (-45 / 20);
  const loud = (at: number) => { let sum = 0; for (let i = at; i < Math.min(samples.length, at + window); i++) sum += samples[i] * samples[i]; return Math.sqrt(sum / window) > threshold; };
  let start = 0;
  while (start < samples.length && !loud(start)) start += window;
  let end = samples.length;
  while (end > start && !loud(Math.max(0, end - window))) end -= window;
  const keep = Math.round(rate * 0.05);
  return { start: Math.max(0, start - keep), end: Math.min(samples.length, end + keep) };
}

function check(text: string): void {
  if (!withoutDirections(text).trim()) throw new VoiceError('E_VOICE_TEXT', 'A line needs words to say, not only directions.');
}

export async function synthesize(request: SynthesisRequest): Promise<SynthesisResult & { cached: boolean }> {
  const settings = settingsOf(request.settings);
  check(request.text);
  const body: Record<string, unknown> = {
    text: textFor(request.text, settings.model), model_id: settings.model, language_code: primary(request.language), seed: request.seed >>> 0,
    ...(settings.stability !== undefined || settings.similarity !== undefined ? { voice_settings: { ...(settings.stability !== undefined ? { stability: settings.stability } : {}), ...(settings.similarity !== undefined ? { similarity_boost: settings.similarity } : {}) } } : {}),
    ...(request.context?.before ? { previous_text: textFor(request.context.before, settings.model) } : {}),
    ...(request.context?.after ? { next_text: textFor(request.context.after, settings.model) } : {})
  };
  request.onProgress?.(0);
  const { answer, cached, cost } = await generation(`/v1/text-to-speech/${encodeURIComponent(request.voice)}/with-timestamps?output_format=${OUTPUT}`, body, { signal: request.signal, what: 'say a line' });
  const paid = await charged(cost, cached, [String(body.text).length], [request.voice], settings.model, 'speech');
  request.onProgress?.(1);
  const all = pcmSamples(answer.audio_base64);
  const { start, end } = speechBounds(all);
  const name = known.get(request.voice)?.name ?? request.voiceName ?? request.voice;
  return {
    samples: all.slice(start, end), sampleRate: SAMPLE_RATE, model: `elevenlabs/${settings.model}`, credit: creditOf(name)[primary(request.language)] ?? creditOf(name).en,
    words: wordsFromAlignment(answer.alignment, start / SAMPLE_RATE), retries: 0, settings: { ...settings }, cached, cost: paid
  };
}

// Lines of several speakers said as one exchange (text to dialogue), then cut into lines: each from
// where its speaker starts to where the next starts, in the silence between them (the quietest 20 ms
// near the service's boundary, or the middle of the gap the aligner heard: splitDialogue). When
// the next speaker starts before this one ends (an interruption), the cut is where the next starts:
// the interrupted words stop there, and the line after it has no pause before.
export async function synthesizeDialogue(request: DialogueRequest): Promise<DialogueResult> {
  const settings = settingsOf(request.settings);
  if (!playsDirections({ provider: PROVIDER, settings: { model: settings.model } })) throw new VoiceError('E_VOICE_DIALOGUE', `A dialogue needs Eleven v4 or v3 (the voices' model is ${settings.model}).`);
  for (const turn of request.turns) check(turn.text);
  const body: Record<string, unknown> = {
    inputs: request.turns.map((turn) => ({ text: textFor(turn.text, settings.model), voice_id: turn.voice })),
    model_id: settings.model, language_code: primary(request.language), seed: request.seed >>> 0,
    ...(settings.stability !== undefined || settings.similarity !== undefined ? { settings: { ...(settings.stability !== undefined ? { stability: settings.stability } : {}), ...(settings.similarity !== undefined ? { similarity: settings.similarity } : {}) } } : {})
  };
  request.onProgress?.(0);
  const { answer, cached, cost } = await generation(`/v1/text-to-dialogue/with-timestamps?output_format=${OUTPUT}`, body, { signal: request.signal, what: 'say a dialogue' });
  const paid = await charged(cost, cached, (body.inputs as { text: string }[]).map((input) => input.text.length), request.turns.map((turn) => turn.voice), settings.model, 'dialogue');
  request.onProgress?.(1);
  const heard = request.hear ? await request.hear({ samples: pcmSamples(answer.audio_base64), sampleRate: SAMPLE_RATE }) : null;
  return { ...splitDialogue(answer, request.turns.length, heard), model: `elevenlabs/${settings.model}`, cached, cost: paid, credits: request.turns.map((turn) => { const name = known.get(turn.voice)?.name ?? turn.voiceName ?? turn.voice; return creditOf(name)[primary(request.language)] ?? creditOf(name).en; }) };
}

// heard: where each turn's words are in the exchange's audio when a word aligner has found them. The
// service's times cannot always be trusted: on 13 October those of the turns after the first of a French
// exchange ran 0.38 s ahead of its audio, a cut at the end of a turn fell before its last word (« et — »)
// and the line lost it. With heard, the cut is in the middle of the silence between a turn's last word and
// the next one's first, and the words the service timed are moved onto the audio.
export function splitDialogue(answer: SpeechAnswer, count: number, heard?: { start: number; end: number }[] | null): Omit<DialogueResult, 'model' | 'cached' | 'credits'> {
  const all = pcmSamples(answer.audio_base64);
  const segments = answer.voice_segments ?? [];
  // Each turn's first and last segment (a turn may come in several).
  const spans = Array.from({ length: count }, (_, index) => {
    const own = segments.filter((segment) => segment.dialogue_input_index === index);
    if (!own.length) throw new VoiceError('E_VOICE_DIALOGUE', `ElevenLabs gave no times for turn ${index + 1} of the dialogue: generate its lines one by one.`);
    return {
      start: Math.min(...own.map((s) => s.start_time_seconds)), end: Math.max(...own.map((s) => s.end_time_seconds)),
      from: Math.min(...own.map((s) => s.character_start_index)), to: Math.max(...own.map((s) => s.character_end_index))
    };
  });
  const rate = SAMPLE_RATE;
  // How far the service's times of each turn run ahead of its audio, and where the turn is heard.
  const useHeard = heard && heard.length === count ? heard : null;
  const offsets = spans.map((span, index) => {
    const first = useHeard ? wordsFromAlignment(answer.alignment, 0, span.from, span.to)[0] : undefined;
    return useHeard && first ? Math.round((useHeard[index].start - first.start) * 1000) / 1000 : 0;
  });
  const timed = spans.map((span, index) => ({ ...span, start: useHeard ? useHeard[index].start : span.start, end: useHeard ? useHeard[index].end : span.end }));
  const quietest = (around: number, lo: number, hi: number): number => {
    const window = Math.round(rate * 0.02);
    let best = around;
    let bestEnergy = Infinity;
    for (let at = Math.max(lo, around - Math.round(rate * 0.25)); at <= Math.min(hi - window, around + Math.round(rate * 0.25)); at += Math.round(window / 2)) {
      let sum = 0;
      for (let i = at; i < at + window; i++) sum += all[i] * all[i];
      if (sum < bestEnergy) { bestEnergy = sum; best = at + Math.round(window / 2); }
    }
    return best;
  };
  // The middle of the first stretch without a voice (10 ms frames more than 14 dB under the exchange's loud
  // part, 60 ms at least; failing that the longest, 30 ms at least) between two times, in samples: what the
  // voice makes before the next turn's first word (a sigh, a breath) stays with that turn, and the room's
  // noise, which is no silence for speechBounds, does not hide the gap.
  const silenceBetween = (from: number, to: number): number => {
    const size = Math.round(rate * 0.01);
    const levels: number[] = [];
    for (let at = 0; at + size <= all.length; at += size) { let sum = 0; for (let i = at; i < at + size; i++) sum += all[i] * all[i]; levels.push(10 * Math.log10(sum / size + 1e-12)); }
    const loud = [...levels].sort((x, y) => x - y)[Math.floor(levels.length * 0.9)] ?? -100;
    const runs: { start: number; end: number }[] = [];
    let start = -1;
    const last = Math.ceil(to * 100);
    for (let k = Math.floor(from * 100); k <= last + 1; k++) {
      if (k <= last && levels[k] !== undefined && levels[k] <= loud - 14) { if (start < 0) start = k; continue; }
      if (start >= 0) runs.push({ start, end: k });
      start = -1;
    }
    const run = runs.find((candidate) => candidate.end - candidate.start >= 6) ?? runs.reduce<{ start: number; end: number } | null>((best, candidate) => (!best || candidate.end - candidate.start > best.end - best.start ? candidate : best), null);
    return run && run.end - run.start >= 3 ? Math.round(((run.start + run.end) / 200) * rate) : Math.round(((from + to) / 2) * rate);
  };
  const cuts: number[] = [0];
  const overlaps: boolean[] = [];
  for (let index = 1; index < count; index++) {
    const previous = timed[index - 1];
    const next = timed[index];
    const overlap = useHeard ? next.start < previous.end + 0.05 : next.start < previous.end - 0.05;
    overlaps.push(overlap);
    const cut = overlap ? Math.round(next.start * rate) : useHeard ? silenceBetween(previous.end, next.start) : quietest(Math.round(((previous.end + next.start) / 2) * rate), Math.round(previous.start * rate), Math.round(next.end * rate));
    cuts.push(Math.max(cuts[index - 1], cut));
  }
  cuts.push(all.length);
  const lines: DialogueResult['lines'] = [];
  let previousEnd = 0;
  spans.forEach((span, index) => {
    const piece = all.slice(cuts[index], cuts[index + 1]);
    const bounds = index > 0 && overlaps[index - 1] ? { start: 0, end: speechBounds(piece).end } : speechBounds(piece);
    const from = cuts[index] + bounds.start;
    // The silence the exchange left before this line (none after an interruption).
    const gap = index === 0 ? 0 : Math.max(0, Math.round(((from - previousEnd) / rate) * 100) / 100);
    previousEnd = cuts[index] + bounds.end;
    lines.push({ samples: piece.slice(bounds.start, bounds.end), words: wordsFromAlignment(answer.alignment, from / rate - offsets[index], span.from, span.to), start: Math.round((from / rate) * 1000) / 1000, gap, interrupted: overlaps[index] ?? false });
  });
  return { sampleRate: rate, lines };
}

export const elevenLabsProvider: VoiceProvider = {
  id: PROVIDER,
  name: 'ElevenLabs',
  paid: true,
  // Its voices are searched (searchVoices); those this process met are listed.
  voices(language) {
    return [...known.values()].filter((voice) => !language || voice.multilingual || primary(voice.language) === primary(language));
  },
  // Every language of Eleven v4; "installed" when a key is on this computer.
  status() {
    return { installed: !!resolveKey(), size: 0 };
  },
  async install() {
    requireKey();
  },
  synthesize,
  synthesizeDialogue,
  search: searchVoices,
  lookup: lookupVoice,
  account,
  estimate: estimateCredits,
  quota,
  async dispose() {}
};
