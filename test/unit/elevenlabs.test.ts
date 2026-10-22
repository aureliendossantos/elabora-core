import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { copyExample, readJSON, writeJSON, codes, ROOT } from '../helpers.ts';
import { narrate, hasFfmpeg } from '../narration.ts';
import { lineDirections, maskDirections, withoutDirections, playsDirections } from '@elabora/core/narration/directions';
import { modelName, voiceFit, voiceModel } from '@elabora/core/narration/voice-fit';
import { narrationWords, lineWordTimes } from '@elabora/core/narration/words';
import { captionChunks, estimatedDuration } from '@elabora/core/narration/timing';
import { applyPronunciations, narrationLines } from '@elabora/core/narration/narration';
import { toXliff, readXliff } from '@elabora/core/i18n/xliff';
import { generateNarration, estimateNarration, setSpeakerVoice, voiceTakes, voiceProvider, VoiceError, setSessionKey } from '@elabora/node/voice/index';
import type { VoiceInfo } from '@elabora/node/voice/index';
import { splitDialogue, synthesize, wordsFromAlignment, speechBounds, SAMPLE_RATE } from '@elabora/node/voice/elevenlabs/index';
import { COST_BOOK } from '@elabora/core/ai/cost-ledger.generated';
import { chargedShare, expectedCharge, recordCharge, forgetQuota, noteSpent, remember, keyId } from '@elabora/node/voice/elevenlabs/costs';
import { APPROVAL_SHARE, covers, needsApproval, quotaPercent } from '@elabora/core/ai/quota';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { validateDir } from '@elabora/node/project-reader';

// What the ledger says a Starter plan is charged on Eleven v4 now (D36): 0.4005 on 13 October 2026.
const STARTER = COST_BOOK.averages.find((a) => a.key === 'elevenlabs/eleven_v4/starter/2026-10-13')!.undiscounted!;

// ElevenLabs voices (docs/decisions.md D29) against a local imitation of its API: tones as long as
// the words, every character timed, never a real voice nor a real key. A real call runs only with
// ELABORA_ELEVENLABS_LIVE=1 and a key (ELEVENLABS_API_KEY or elabora voice key set): it spends credits.

const run = promisify(execFile);
const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg and ffprobe not found';
const KEY = 'sk_test0123456789abcdefghijklmnop';
const RATE = SAMPLE_RATE;

interface Seen { method: string; url: string; key: string | undefined; body: any }
const seen: Seen[] = [];
let server: http.Server;
let forbid: string | null = null;
// The imitation's month: its quota, and what it charges a request over its list price (0.11 as Eleven v4).
let limit = 40000;
let charge = 0.11;
const LIBRARY_RATE: Record<string, number> = { library0voice0000002: 2 };
const cost = (texts: { text: string; voice: string }[]) => Math.ceil(texts.reduce((sum, input) => sum + input.text.length * (LIBRARY_RATE[input.voice] ?? 1), 0) * charge);
const live = process.env.ELABORA_ELEVENLABS_LIVE === '1';
const saved = { url: process.env.ELABORA_ELEVENLABS_URL, key: process.env.ELEVENLABS_API_KEY, cache: process.env.ELABORA_ELEVENLABS_CACHE, file: process.env.ELABORA_ELEVENLABS_KEY_FILE };

// What a voice would say: 0.2 s of silence, then 50 ms a character outside directions (a tone), then
// 0.2 s; each character timed, a direction's characters at the start of what follows.
function speech(text: string, frequency = 300): { pcm: Buffer; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }; seconds: number } {
  const masked = maskDirections(text);
  const starts: number[] = [];
  const ends: number[] = [];
  let t = 0.2;
  for (let i = 0; i < text.length; i++) {
    const spoken = masked[i] !== ' ' || text[i] === ' ';
    starts.push(Math.round(t * 1000) / 1000);
    if (spoken) t += 0.05;
    ends.push(Math.round(t * 1000) / 1000);
  }
  const seconds = t + 0.2;
  const samples = Math.round(seconds * RATE);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = Math.round(0.2 * RATE); i < Math.round((t) * RATE); i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * frequency * i) / RATE)), i * 2);
  return { pcm, alignment: { characters: [...text], character_start_times_seconds: starts, character_end_times_seconds: ends }, seconds };
}

function answer(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

before(async () => {
  server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const url = request.url ?? '';
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: request.method ?? '', url, key: request.headers['xi-api-key'] as string | undefined, body });
      if (request.headers['xi-api-key'] !== KEY) return answer(response, 401, { detail: { status: 'invalid_api_key', message: `Invalid API key ${request.headers['xi-api-key']}` } });
      if (forbid && url.startsWith(forbid)) return answer(response, 401, { detail: { status: 'missing_permissions', message: `The API key you used is missing the permission ${forbid.includes('voices') ? 'voices_read' : 'text_to_speech'} to execute this operation.` } });
      if (url === '/v1/user') return answer(response, 200, { subscription: { tier: 'starter', character_count: 1200, character_limit: limit, next_character_count_reset_unix: 1794431996 } });
      if (url === '/v1/models') return answer(response, 200, [{ model_id: 'eleven_v4', model_rates: { character_cost_multiplier: 1 } }, { model_id: 'eleven_v4_turbo', model_rates: { character_cost_multiplier: 0.5 } }]);
      if (url.startsWith('/v2/voices')) return answer(response, 200, { voices: [
        { voice_id: 'acc0unt0voice0000001', name: 'Nadia - Calm narrator', category: 'cloned', labels: { gender: 'female', language: 'fr', accent: 'parisian', age: 'middle_aged', use_case: 'narrative_story' } },
        // A library voice the account added, whose training failed for Eleven v4 (as ElevenLabs says it).
        { voice_id: 'acc0unt0clara0000003', name: 'Clara - Modulated', category: 'professional', labels: { gender: 'female', language: 'fr' }, sharing: { category: 'high_quality' },
          high_quality_base_model_ids: ['eleven_multilingual_v2', 'eleven_turbo_v2_5'], fine_tuning: { state: { eleven_multilingual_v2: 'fine_tuned', eleven_turbo_v2_5: 'failed', eleven_v4: 'failed', eleven_v4_exp: 'failed', eleven_v2_5_flash: 'fine_tuned' } },
          verified_languages: [{ language: 'fr', model_id: 'eleven_multilingual_v2' }, { language: 'fr', model_id: 'eleven_multilingual_sts_v2' }] },
        { voice_id: 'prem0bella000000004', name: 'Bella - Bright', category: 'premade', labels: { gender: 'female', language: 'en' }, high_quality_base_model_ids: ['eleven_multilingual_v2'], fine_tuning: { state: {} }, verified_languages: [] }
      ] });
      if (url.startsWith('/v1/shared-voices')) return answer(response, 200, { voices: [{ voice_id: 'library0voice0000002', public_owner_id: 'owner1', name: 'Marc - Support agent', gender: 'male', age: 'young', accent: 'standard', use_case: 'conversational', language: 'fr', descriptive: 'casual', rate: 2, notice_period: 730, preview_url: 'https://example.invalid/marc.mp3',
        category: 'high_quality', cloned_by_count: 793595,
        verified_languages: [{ language: 'fr', model_id: 'eleven_v4' }, { language: 'fr', model_id: 'eleven_v4_eval' }, { language: 'en', model_id: 'eleven_multilingual_v2' }, { language: 'fr', model_id: 'eleven_multilingual_v2' }, { language: 'fr', model_id: 'test_m2' }] }], has_more: true, total_count: 1441 });
      const voice = /^\/v1\/voices\/([^/?]+)$/.exec(url);
      if (voice) return voice[1] === 'acc0unt0voice0000001' ? answer(response, 200, { voice_id: voice[1], name: 'Nadia - Calm narrator', category: 'cloned', labels: { gender: 'female', language: 'fr' } }) : answer(response, 404, { detail: { status: 'voice_not_found', message: 'A voice with this ID was not found.' } });
      const tts = /^\/v1\/text-to-speech\/([^/]+)\/with-timestamps\?output_format=pcm_24000$/.exec(url);
      if (tts) {
        if (!body.text) return answer(response, 400, { detail: { status: 'input_text_empty', message: 'Input at position 0 has empty text.' } });
        const said = speech(body.text);
        return answer(response, 200, { audio_base64: said.pcm.toString('base64'), alignment: said.alignment, normalized_alignment: said.alignment }, { 'character-cost': String(cost([{ text: body.text, voice: tts[1] }])) });
      }
      if (url === '/v1/text-to-dialogue/with-timestamps?output_format=pcm_24000') {
        // Turns one after the other, 0.25 s apart; a turn ending with « — » is cut in by the next 0.3 s before its end.
        const parts = body.inputs.map((input: { text: string }, index: number) => speech(input.text, 250 + 100 * index));
        const segments: object[] = [];
        const chars: string[] = [];
        const starts: number[] = [];
        const ends: number[] = [];
        let at = 0;
        const pieces: { offset: number; pcm: Buffer }[] = [];
        parts.forEach((part: ReturnType<typeof speech>, index: number) => {
          const from = chars.length;
          const t0 = at;
          part.alignment.characters.forEach((c, i) => { chars.push(c); starts.push(t0 + part.alignment.character_start_times_seconds[i]); ends.push(t0 + part.alignment.character_end_times_seconds[i]); });
          segments.push({ voice_id: body.inputs[index].voice_id, start_time_seconds: t0 + 0.2, end_time_seconds: t0 + part.seconds - 0.2, character_start_index: from, character_end_index: chars.length, dialogue_input_index: index });
          pieces.push({ offset: Math.round(t0 * RATE), pcm: part.pcm });
          at = t0 + part.seconds - (/—\s*$/.test(body.inputs[index].text) ? 0.5 : 0.15);
        });
        const total = Math.max(...pieces.map((piece) => piece.offset + piece.pcm.length / 2));
        const pcm = Buffer.alloc(total * 2);
        for (const piece of pieces) for (let i = 0; i < piece.pcm.length / 2; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, pcm.readInt16LE((piece.offset + i) * 2) + piece.pcm.readInt16LE(i * 2))), (piece.offset + i) * 2);
        return answer(response, 200, { audio_base64: pcm.toString('base64'), alignment: { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends }, voice_segments: segments }, { 'character-cost': String(cost(body.inputs.map((input: { text: string; voice_id: string }) => ({ text: input.text, voice: input.voice_id })))) });
      }
      answer(response, 404, { detail: { status: 'not_found', message: url } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  if (!live) {
    process.env.ELABORA_ELEVENLABS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.ELEVENLABS_API_KEY = KEY;
  }
  process.env.ELABORA_ELEVENLABS_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-elevenlabs-cache-'));
  process.env.ELABORA_ELEVENLABS_KEY_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-elevenlabs-key-')), 'key');
});

after(() => {
  server.close();
  for (const [name, value] of [['ELABORA_ELEVENLABS_URL', saved.url], ['ELEVENLABS_API_KEY', saved.key], ['ELABORA_ELEVENLABS_CACHE', saved.cache], ['ELABORA_ELEVENLABS_KEY_FILE', saved.file]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const ttsCalls = () => seen.filter((s) => s.method === 'POST' && s.url.startsWith('/v1/text-to-speech'));

// The example's first screen: Leïla and Marc on the phone, with directions.
function narrated(): string {
  const dir = copyExample();
  narrate(dir, 'accueil', [
    { id: 'l1', speaker: 'leila', text: '[chaleureuse] Support informatique, Leïla, bonjour.' },
    { id: 'l2', speaker: 'marc', text: '[agacé] Plus rien ne marche au 2e étage !' },
    { id: 'l3', speaker: 'leila', text: 'Le poste P-12 [un temps] ne répond plus ?' }
  ], { speakers: [{ id: 'leila', name: 'Leïla' }, { id: 'marc', name: 'Marc' }] });
  return dir;
}

test('directions: read in brackets, never words, captions nor pronunciations; a voice that cannot play them is told', () => {
  const text = '[chuchote] Personne ne l’avait vu venir… [un temps] et pourtant, tout était là [rit].';
  assert.deepEqual(lineDirections(text).map((d) => d.text), ['chuchote', 'un temps', 'rit']);
  assert.equal(maskDirections(text).length, text.length, 'offsets kept');
  assert.equal(withoutDirections(text), 'Personne ne l’avait vu venir… et pourtant, tout était là.');
  assert.deepEqual(narrationWords(text, 'fr').map((w) => w.text), ['Personne', 'ne', 'l’', 'avait', 'vu', 'venir', 'et', 'pourtant', 'tout', 'était', 'là']);
  const venir = narrationWords(text, 'fr').find((w) => w.text === 'venir')!;
  assert.equal(text.slice(venir.start, venir.end), 'venir', 'a word\'s offsets are in the line\'s text');
  assert.deepEqual(captionChunks(text), ['Personne ne l’avait vu venir… et pourtant, tout était là.']);
  assert.equal(estimatedDuration('[chuchote] Bonjour.'), estimatedDuration('Bonjour.'));
  assert.equal(applyPronunciations('[rit] Le P-12 [rit]', [{ text: 'rit', say: 'ri' }, { text: 'P-12', say: 'pé douze' }]), '[rit] Le pé douze [rit]');
  assert.equal(withoutDirections('Un [crochet ouvert et un texte'), 'Un [crochet ouvert et un texte', 'an unclosed bracket is text');
  assert.equal(lineDirections(`[${'x'.repeat(81)}] trop long`).length, 0);
  assert.ok(playsDirections({ provider: 'elevenlabs' }) && playsDirections({ provider: 'elevenlabs', settings: { model: 'eleven_v4_turbo' } }));
  assert.ok(!playsDirections({ provider: 'elevenlabs', settings: { model: 'eleven_multilingual_v2' } }) && !playsDirections({ provider: 'pocket-tts' }));

  const dir = narrated();
  const found = validateDir(dir).diagnostics.filter((d) => d.code === 'I_NARRATION_DIRECTIONS_IGNORED');
  assert.equal(found.length, 3, 'no voice that plays them yet');
  const course = readJSON(dir, 'course.json');
  course.speakers = course.speakers.map((s: object) => ({ ...s, voices: { fr: { provider: 'elevenlabs', voice: 'acc0unt0voice0000001', name: 'Nadia' } } }));
  writeJSON(dir, 'course.json', course);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('I_NARRATION_DIRECTIONS_IGNORED'));
});

test('directions take no time and are never read: the captions\' speed, words placed by estimate and on-screen text repeating a line count the line without them', { skip: NO_FFMPEG }, () => {
  const dir = copyExample();
  // l1 says 19 characters in 1.5 s (13 a second), its directions doubling it; l2 is really too fast.
  narrate(dir, 'accueil', [
    { id: 'l1', speaker: 'leila', text: '[agacée, au bord de l’explosion, la voix qui monte] Ça fait trois fois !', seconds: 1.5 },
    { id: 'l2', speaker: 'leila', text: '[pressée] Plus rien ne marche au deuxième étage, ni l’imprimante ni le partage.', seconds: 2 },
    { id: 'l3', speaker: 'leila', text: '[calme] Je comprends [un temps] monsieur Dubois, [soupire] trois appels c’est trois de trop.' }
  ], { speakers: [{ id: 'leila', name: 'Leïla' }] });
  const fast = () => validateDir(dir).diagnostics.filter((d) => d.code === 'W_TEXT_TOO_FAST' && d.path?.startsWith('/narration/lines/'));
  assert.deepEqual(fast().map((d) => [d.path, d.measured]), [['/narration/lines/1', Math.round(withoutDirections('Plus rien ne marche au deuxième étage, ni l’imprimante ni le partage.').length / 2)]], 'l1 is not too fast once its directions are left out; l2 is, at the speed of its words');
  // Placed by estimate, a line's words start where its directions end.
  assert.deepEqual(lineWordTimes('[agacé, au bord de l’explosion] Ça fait [un temps] trois fois.', 2, null, 'fr'), lineWordTimes('Ça fait trois fois.', 2, null, 'fr'));
  // On-screen text that repeats l3 word for word is found, its directions between the words.
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push({ id: 'accueil-repete', type: 'text', props: { markdown: 'Je comprends monsieur Dubois, trois appels c’est trois de trop.' } });
  writeJSON(dir, 'screens/accueil.json', screen);
  assert.ok(validateDir(dir).diagnostics.some((d) => d.code === 'W_NARRATION_DUPLICATED' && d.target === 'accueil-repete'));
});

test('directions in XLIFF: a narration line\'s are markers translators keep or adapt, read back as text; elsewhere brackets stay Markdown', () => {
  const xml = toXliff({ srcLang: 'fr', trgLang: 'en', original: 'course', units: [
    { id: 'screen.accueil.narration.l1.text', source: '[chuchote] Le poste P-12 ne répond plus.', sourceMarks: [{ id: 'w-poste', start: 14, end: 19 }], target: '[whispers] Workstation P-12 is down.' },
    { id: 'screen.accueil.block.b1.markdown', source: 'Voir [la procédure](https://example.org).' }
  ] });
  assert.match(xml, /<source><mrk id="d1" type="elabora:direction">\[chuchote\]<\/mrk> Le <mrk id="w-poste" type="elabora:anchor">poste<\/mrk> P-12/);
  assert.match(xml, /<target><mrk id="d1" type="elabora:direction">\[whispers\]<\/mrk> Workstation/);
  assert.match(xml, /<source>Voir \[la procédure\]\(https:\/\/example.org\)\.<\/source>/);
  const read = readXliff(xml.replace('[whispers]', '[in a whisper]')).units.get('screen.accueil.narration.l1.text')!;
  assert.equal(read.source, '[chuchote] Le poste P-12 ne répond plus.');
  assert.equal(read.target, '[in a whisper] Workstation P-12 is down.', 'adapted by the translator');
  assert.deepEqual(read.sourceMarks, [{ id: 'w-poste', start: 14, end: 19 }], 'only anchors are marks');
});

test('elevenlabs: voices searched and looked up, the account read with its key masked, permissions tried without spending', async () => {
  const provider = voiceProvider('elevenlabs');
  assert.ok(provider.paid);
  const found = await provider.search!({ provider: 'elevenlabs', language: 'fr' });
  assert.deepEqual(found.voices.map((v) => [v.id, v.owner, v.multilingual]), [['acc0unt0voice0000001', 'account', true], ['acc0unt0clara0000003', 'account', true], ['library0voice0000002', 'library', true]]);
  const [nadia, clara, marc] = found.voices as [VoiceInfo, VoiceInfo, VoiceInfo];
  assert.equal(marc.rate, 2);
  assert.equal(marc.preview, 'https://example.invalid/marc.mp3');
  // What each voice is ready for, by model; the service's own variants left out.
  assert.deepEqual([nadia.quality, clara.quality, marc.quality], ['instant', 'high', 'high'], 'a library voice the account added keeps its rating');
  assert.equal(nadia.models, undefined, 'nothing said: nothing known');
  assert.deepEqual(clara.models, { eleven_multilingual_v2: ['fr'], eleven_turbo_v2_5: [], eleven_v4: 'failed' }, 'a model it was trained for wins over a failed training');
  assert.deepEqual(marc.models, { eleven_v4: ['fr'], eleven_multilingual_v2: ['en', 'fr'] });
  assert.equal(marc.users, 793595);
  assert.deepEqual([voiceFit(marc, 'eleven_v4', 'fr-FR'), voiceFit(marc, 'eleven_v4', 'en'), voiceFit(clara, 'eleven_v4', 'fr'), voiceFit(clara, 'eleven_turbo_v2_5', 'fr'), voiceFit(clara, 'eleven_v3', 'fr'), voiceFit(nadia, 'eleven_v4', 'fr')],
    ['ready', 'other-languages', 'failed', 'trained', 'untrained', null]);
  const bella = (await provider.search!({ provider: 'elevenlabs', scope: 'account' })).voices.find((voice) => voice.id === 'prem0bella000000004')!;
  assert.equal(bella.quality, 'premade');
  assert.equal(voiceFit(bella, voiceModel({ provider: 'elevenlabs', settings: {} })!, 'en'), 'untrained', 'a default voice not trained for Eleven v4 says so');
  assert.deepEqual([modelName('eleven_v4'), modelName('eleven_v4_turbo'), modelName('eleven_v3_conversational'), modelName('eleven_turbo_v2_5'), voiceModel({ provider: 'local', settings: {} })], ['Eleven v4', 'Eleven v4 Turbo', 'Eleven v3 Conversational', 'Eleven Turbo v2.5', null]);
  assert.ok(found.more && found.total > 1000);
  const shared = seen.find((s) => s.url.startsWith('/v1/shared-voices'))!;
  assert.match(shared.url, /language=fr/);
  assert.equal((await provider.lookup!('acc0unt0voice0000001'))?.name, 'Nadia - Calm narrator');
  assert.equal((await provider.lookup!('library0voice0000002'))?.name, 'Marc - Support agent', 'a library voice the search met');
  const account = await provider.account!({ check: true });
  assert.deepEqual({ plan: account.plan, remaining: account.remaining, key: account.key, commercial: account.commercial }, { plan: 'starter', remaining: 38800, key: 'sk_…mnop', commercial: true });
  assert.deepEqual(account.permissions, { user_read: true, voices_read: true, text_to_speech: true });
  // The quota comes from /v1/user (0.25 s), not from /v1/user/subscription (1.3 to 1.9 s, with the invoices).
  assert.ok(seen.some((call) => call.url === '/v1/user') && !seen.some((call) => call.url === '/v1/user/subscription'));
  assert.equal(ttsCalls().at(-1)!.body.text, '', 'speech tried with an empty text: refused for it, nothing spent');
  forbid = '/v2/voices';
  try { assert.equal((await provider.account!({ check: true })).permissions.voices_read, false); } finally { forbid = null; }
  forbid = '/v1/text-to-speech';
  try {
    await assert.rejects(synthesize({ text: 'Bonjour.', voice: 'acc0unt0voice0000001', language: 'fr', settings: {}, seed: 99 }), (error: VoiceError) => error.code === 'E_VOICE_KEY_PERMISSION' && !error.message.includes(KEY));
  } finally { forbid = null; }
  process.env.ELEVENLABS_API_KEY = 'sk_wrongwrongwrongwrongwrong';
  try {
    await assert.rejects(provider.account!(), (error: VoiceError) => error.code === 'E_VOICE_KEY_INVALID' && !error.message.includes('sk_wrongwrongwrongwrongwrong') && /sk_…rong/.test(error.message), 'the key the service echoes is masked');
  } finally { process.env.ELEVENLABS_API_KEY = KEY; }
});

test('elevenlabs: under 1 % of the quota a line is said at once; from 1 % it waits for the share approved', { skip: NO_FFMPEG }, async () => {
  const dir = narrated();
  await setSpeakerVoice(dir, { speaker: 'leila', voice: 'acc0unt0voice0000001', provider: 'elevenlabs' });
  await setSpeakerVoice(dir, { speaker: 'marc', voice: 'library0voice0000002', provider: 'elevenlabs', name: 'Marc - Support agent', settings: { model: 'eleven_v4', stability: 0.3 } });
  assert.deepEqual(readJSON(dir, 'course.json').speakers.map((s: { voices: object }) => s.voices), [
    { fr: { provider: 'elevenlabs', voice: 'acc0unt0voice0000001', name: 'Nadia - Calm narrator' } },
    { fr: { provider: 'elevenlabs', voice: 'library0voice0000002', name: 'Marc - Support agent', settings: { model: 'eleven_v4', stability: 0.3 } } }
  ]);

  // Characters sent, directions included; Marc's voice costs twice. The list price is the ceiling,
  // the cost the plan's share of it (a Starter plan is charged 0.4 of it, as the ledger measured, D36;
  // the discount of the first days, 0.11, is not counted on); the quota says what share that is.
  forgetQuota();
  const estimate = await estimateNarration(dir, { screen: 'accueil' });
  assert.deepEqual(estimate.lines.map((l) => [l.line, l.characters, l.ceiling]), [['l1', 51, 51], ['l2', 41, 82], ['l3', 41, 41]]);
  assert.equal(estimate.ceiling, 174);
  const share = chargedShare('starter');
  assert.equal(share, STARTER, 'a Starter plan: 0.4 of the list price, as the ledger averages it');
  assert.deepEqual(estimate.lines.map((l) => l.credits), [51, 82, 41].map((ceiling) => Math.ceil(ceiling * share)));
  assert.deepEqual([estimate.quota?.plan, estimate.quota?.limit, estimate.needsApproval], ['starter', 40000, false]);
  assert.equal(estimate.percent, quotaPercent(estimate.credits / 40000));

  // A small quota: the same lines are 2 % of it, and wait for the author.
  limit = 1000;
  forgetQuota();
  try {
    const small = await estimateNarration(dir, { screen: 'accueil' });
    assert.deepEqual([small.percent, small.needsApproval], [quotaPercent(small.credits / 1000), true]);
    const before = ttsCalls().length;
    await assert.rejects(generateNarration(dir, { screen: 'accueil' }), (error: VoiceError & { estimate?: { percent: number } }) => error.code === 'E_VOICE_SPEND' && error.estimate?.percent === small.percent && /% of the author's monthly quota/.test(error.message));
    await assert.rejects(generateNarration(dir, { screen: 'accueil', approvedPercent: 1 }), (error: VoiceError) => error.code === 'E_VOICE_SPEND');
    assert.equal(ttsCalls().length, before, 'nothing asked of the service');
    assert.ok(!fs.existsSync(path.join(dir, 'assets/narration/fr/accueil/l1.m4a')));
  } finally {
    limit = 40000;
    forgetQuota();
  }

  const before = ttsCalls().length;
  const result = await generateNarration(dir, { screen: 'accueil' });
  assert.deepEqual(result.lines.map((l) => [l.line, l.status]), [['l1', 'generated'], ['l2', 'generated'], ['l3', 'generated']]);
  const charged = cost([{ text: '[chaleureuse] Support informatique, Leïla, bonjour.', voice: 'acc0unt0voice0000001' }]) + cost([{ text: '[agacé] Plus rien ne marche au 2e étage !', voice: 'library0voice0000002' }]) + cost([{ text: 'Le poste P-12 [un temps] ne répond plus ?', voice: 'acc0unt0voice0000001' }]);
  assert.deepEqual(result.spent, [{ provider: 'elevenlabs', characters: 133, estimate: estimate.credits, credits: charged, percent: quotaPercent(charged / 40000) }], 'what the service charged, from its character-cost header');
  assert.equal(result.overBudget, undefined);
  const calls = ttsCalls().slice(before);
  assert.equal(calls[0].url, '/v1/text-to-speech/acc0unt0voice0000001/with-timestamps?output_format=pcm_24000');
  assert.equal(calls[0].body.text, '[chaleureuse] Support informatique, Leïla, bonjour.', 'directions sent as written');
  assert.equal(calls[0].body.model_id, 'eleven_v4');
  assert.equal(calls[0].body.language_code, 'fr');
  assert.ok(Number.isInteger(calls[0].body.seed));
  assert.equal(calls[0].body.next_text, '[agacé] Plus rien ne marche au 2e étage !', 'the next line, for the tone');
  assert.deepEqual(calls[1].body.voice_settings, { stability: 0.3 });
  assert.equal(calls[2].body.text, 'Le poste P-12 [un temps] ne répond plus ?');

  const sidecar = readJSON(dir, 'assets/narration/fr/accueil/l3.json');
  assert.deepEqual([sidecar.provider, sidecar.voice, sidecar.model, sidecar.generated, sidecar.aligner], ['elevenlabs', 'acc0unt0voice0000001', 'elevenlabs/eleven_v4', true, 'elevenlabs']);
  assert.equal(sidecar.credit, 'Voix de synthèse : Nadia (ElevenLabs)');
  assert.deepEqual(sidecar.words.map((w: { text: string }) => w.text), ['Le', 'poste', 'P-12', 'ne', 'répond', 'plus'], 'its words, not its directions');
  // Trimmed to 50 ms before the voice: the first word starts there.
  assert.ok(Math.abs(sidecar.words[0].start - 0.05) < 0.02, `first word at ${sidecar.words[0].start}`);
  assert.ok(sidecar.words[3].start - sidecar.words[2].end < 0.17, `a direction takes no time in this imitation (its spaces do): ${JSON.stringify(sidecar.words)}`);
  assert.deepEqual(narrationLines(loadProjectFromDir(dir), 'accueil')!.map((l) => l.status), ['ok', 'ok', 'ok']);

  // The same request again (the same take's seed): from this computer's cache.
  const again = await synthesize({ text: calls[2].body.text, voice: 'acc0unt0voice0000001', language: 'fr', settings: {}, seed: calls[2].body.seed, context: { before: calls[2].body.previous_text } });
  assert.ok(again.cached);
  assert.equal(ttsCalls().length, before + 3);

  // A text changed and changed back: the line gets its take back, nothing spent.
  const screen = readJSON(dir, 'screens/accueil.json');
  const original = screen.narration.lines[0].text;
  screen.narration.lines[0].text = '[froide] Support informatique.';
  writeJSON(dir, 'screens/accueil.json', screen);
  await generateNarration(dir, { screen: 'accueil' });
  screen.narration.lines[0].text = original;
  writeJSON(dir, 'screens/accueil.json', screen);
  const calls2 = ttsCalls().length;
  const back = await generateNarration(dir, { screen: 'accueil' });
  assert.deepEqual(back.lines.map((l) => [l.line, l.status, l.take]), [['l1', 'selected', 1]]);
  assert.equal(ttsCalls().length, calls2, 'given back, not asked again');
  assert.deepEqual(voiceTakes(dir, { screen: 'accueil', line: 'l1' }).takes.map((t) => [t.take, t.current]), [[1, true], [2, false]]);

  // A sample of a paid voice is its preview, unless the author asks to hear their own words (spend).
  const { voiceSample } = await import('@elabora/node/voice/index');
  await assert.rejects(voiceSample({ voice: 'library0voice0000002', provider: 'elevenlabs', text: 'Bonjour' }), (error: VoiceError) => error.code === 'E_VOICE_PAID');
  const sample = await voiceSample({ voice: 'library0voice0000002', provider: 'elevenlabs', text: 'Le poste P-12 ne répond plus.', spend: true, language: 'fr' });
  assert.ok(sample.duration > 1 && sample.audio.length > 44, 'said, as WAV');
  assert.equal(ttsCalls().at(-1)!.body.text, 'Le poste P-12 ne répond plus.');
});

test('elevenlabs: a dialogue said as one exchange, cut into lines at its turns, an interruption without pause', { skip: NO_FFMPEG }, async () => {
  const dir = narrated();
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.narration.lines[1].text = '[agacé] Plus rien ne marche au 2e étage, et je —';
  writeJSON(dir, 'screens/accueil.json', screen);
  await setSpeakerVoice(dir, { speaker: 'leila', voice: 'acc0unt0voice0000001', provider: 'elevenlabs' });
  await setSpeakerVoice(dir, { speaker: 'marc', voice: 'library0voice0000002', provider: 'elevenlabs', name: 'Marc' });
  const estimate = await estimateNarration(dir, { screen: 'accueil', dialogue: true });
  assert.deepEqual(estimate.lines.map((l) => l.dialogue), ['accueil-1', 'accueil-1', 'accueil-1']);
  assert.equal(estimate.needsApproval, false, 'an exchange of three lines is far under 1 % of the quota');
  const result = await generateNarration(dir, { screen: 'accueil', dialogue: true });
  const dialogue = seen.filter((s) => s.url.startsWith('/v1/text-to-dialogue'));
  assert.equal(dialogue.length, 1, 'one request for the exchange');
  assert.equal(result.spent?.[0].credits, cost(dialogue[0].body.inputs.map((input: { text: string; voice_id: string }) => ({ text: input.text, voice: input.voice_id }))), 'the exchange charged once, as its lines would be');
  assert.deepEqual(dialogue[0].body.inputs.map((i: { voice_id: string }) => i.voice_id), ['acc0unt0voice0000001', 'library0voice0000002', 'acc0unt0voice0000001']);
  // The exchange is named for this generation (another one of the screen is another exchange).
  const exchange = result.lines[0]?.dialogue ?? '';
  assert.match(exchange, /^accueil-[a-z0-9]+-1$/);
  assert.deepEqual(result.lines.map((l) => [l.line, l.status, l.dialogue]), [['l1', 'generated', exchange], ['l2', 'generated', exchange], ['l3', 'generated', exchange]]);
  const lines = readJSON(dir, 'screens/accueil.json').narration.lines;
  // The exchange's silence before Marc (0.25 s), less the 50 ms of silence each line keeps at its ends.
  assert.ok(lines[1].pauseBefore >= 0.12 && lines[1].pauseBefore <= 0.2, `pause before Marc: ${lines[1].pauseBefore}`);
  assert.equal(lines[2].pauseBefore, 0, 'Leïla cuts in: no pause');
  // Each line has its own audio and words, cut at the turns.
  const durations = ['l1', 'l2', 'l3'].map((id) => readJSON(dir, `assets/narration/fr/accueil/${id}.json`).duration);
  const expected = [37, 43, 31].map((chars) => chars * 0.05 + 0.1);
  durations.forEach((d, i) => assert.ok(Math.abs(d - expected[i]) < 0.35, `line ${i + 1}: ${d} s, about ${expected[i]} s`));
  assert.deepEqual(readJSON(dir, 'assets/narration/fr/accueil/l2.json').words.map((w: { text: string }) => w.text).slice(0, 3), ['Plus', 'rien', 'ne']);
  assert.equal(voiceTakes(dir, { screen: 'accueil', line: 'l2' }).takes[0].dialogue, exchange);
  // The engine says which lines were said together (the editor's rule between them).
  const { openProject } = await import('@elabora/engine/session');
  const session = await openProject(dir, { backups: { onOpen: false, prune: false }, rescanIntervalMs: 0, media: { enabled: false } });
  try {
    assert.deepEqual(session.narration('accueil')!.lines.map((line) => line.dialogue), [exchange, exchange, exchange]);
  } finally { await session.close(); }
});

test('elevenlabs: a dialogue asks where each turn is heard, once, in the whole exchange, and falls back to the service\'s times', async () => {
  const provider = voiceProvider('elevenlabs');
  const request = { turns: [{ text: 'Bonjour, je vous appelle.', voice: 'acc0unt0voice0000001' }, { text: 'Oui, je vous écoute.', voice: 'library0voice0000002' }], language: 'fr', settings: {}, seed: 41 };
  const plain = await provider.synthesizeDialogue!(request);
  let asked: { samples: Float32Array; sampleRate: number } | null = null;
  let calls = 0;
  const heard = await provider.synthesizeDialogue!({ ...request, hear: async (exchange) => { calls++; asked = exchange; return [{ start: 0.2, end: 1.45 }, { start: 2.2, end: 3.1 }]; } });
  assert.equal(calls, 1);
  assert.equal(asked!.sampleRate, SAMPLE_RATE);
  assert.ok(Math.abs(asked!.samples.length / SAMPLE_RATE - (plain.lines[1].start + plain.lines[1].samples.length / SAMPLE_RATE)) < 0.3, 'the aligner is given the whole exchange, not a line');
  // The second turn is heard 0.5 s after the service's time for it: its words move with it.
  assert.ok(Math.abs(heard.lines[1].words[0].start - plain.lines[1].words[0].start - 0.5) < 0.02, `${heard.lines[1].words[0].start} against ${plain.lines[1].words[0].start}`);
  assert.deepEqual(heard.lines.map((l) => l.start), plain.lines.map((l) => l.start), 'cut in the same silence');
  // An aligner that finds nothing (or fails to) leaves the service's times.
  const none = await provider.synthesizeDialogue!({ ...request, hear: async () => null });
  assert.deepEqual(none.lines.map((l) => l.words), plain.lines.map((l) => l.words));
});

test('elevenlabs: helpers cut the voice from its silences and time words from characters, directions left out', () => {
  const samples = new Float32Array(RATE);
  for (let i = 6000; i < 18000; i++) samples[i] = 0.3 * Math.sin(i / 3);
  const bounds = speechBounds(samples);
  assert.ok(Math.abs(bounds.start - (6000 - 1200)) <= 240 && Math.abs(bounds.end - (18000 + 1200)) <= 240, JSON.stringify(bounds));
  const said = speech('[soupire] Bon. [rit] Alors !');
  assert.deepEqual(wordsFromAlignment(said.alignment).map((w) => w.text), ['Bon', 'Alors']);
  assert.throws(() => splitDialogue({ audio_base64: said.pcm.toString('base64'), voice_segments: [] }, 2), (error: VoiceError) => error.code === 'E_VOICE_DIALOGUE');
});

// The exchange of 13 October's « client mécontent »: ElevenLabs' times of the turns after the first
// were 0.38 s ahead of the audio, so a cut at the end of a turn sat before the last word of the
// interrupted client, « et », which his line lost (and its alignment flagged as swallowed). Where the
// aligner heard each turn, the cut is in the silence after its last word, and the service's words move
// onto the audio.
test('elevenlabs: a dialogue heard by the aligner is cut in the silence after each turn, whatever the service\'s times say', () => {
  const turns = [
    { shift: 0, words: [['Bonjour', 0.1, 0.5], ['monsieur', 0.6, 1.1]] },
    { shift: 0.38, words: [['Trois', 1.6, 2.0], ['fois', 2.1, 2.5], ['et', 2.67, 2.79]] },
    { shift: 0.38, words: [['et', 3.15, 3.27], ['cette', 3.3, 3.7]] }
  ] as const;
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const segments: { end_time_seconds: number }[] = [];
  const pcm = Buffer.alloc(Math.round(4 * RATE) * 2);
  turns.forEach((turn, index) => {
    const from = characters.length;
    turn.words.forEach(([word, start, end], at) => {
      for (let i = Math.round(start * RATE); i < Math.round(end * RATE); i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / RATE)), i * 2);
      if (at) { characters.push(' '); starts.push(start - turn.shift); ends.push(start - turn.shift); }
      [...word].forEach((char, i) => { characters.push(char); starts.push(start - turn.shift + ((end - start) * i) / word.length); ends.push(start - turn.shift + ((end - start) * (i + 1)) / word.length); });
    });
    // Segments follow each other as the service's do: each from the end of the one before.
    segments.push({ voice_id: `v${index % 2}`, start_time_seconds: index ? segments[index - 1].end_time_seconds : 0, end_time_seconds: turn.words.at(-1)![2] - turn.shift, character_start_index: from, character_end_index: characters.length, dialogue_input_index: index } as never);
  });
  const said = { audio_base64: pcm.toString('base64'), alignment: { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }, voice_segments: segments as never };
  const heard = turns.map((turn) => ({ start: turn.words[0][1], end: turn.words.at(-1)![2] }));
  const rms = (line: { samples: Float32Array; start: number }, from: number, to: number) => {
    let sum = 0;
    const a = Math.round((from - line.start) * RATE);
    const b = Math.round((to - line.start) * RATE);
    for (let i = a; i < b; i++) sum += line.samples[i] * line.samples[i];
    return Math.sqrt(sum / (b - a));
  };
  const lines = splitDialogue(said, 3, heard).lines;
  assert.ok(rms(lines[1], 2.68, 2.78) > 0.1, 'the client\'s « et » is in his line');
  assert.ok(lines[1].start + lines[1].samples.length / RATE > 2.79, 'his line runs to the end of that word');
  assert.ok(lines[2].start >= 2.79, `the next line starts after it: ${lines[2].start}`);
  assert.ok(rms(lines[2], 3.16, 3.26) > 0.1, 'the advisor\'s « et » is in hers');
  assert.ok(lines[0].start + lines[0].samples.length / RATE < 1.6, 'the first cut is in the silence after « monsieur »');
  // The service's words of a turn are moved onto the audio: « Trois » at 1.6 s in the exchange, 0.05 s into the line.
  assert.ok(Math.abs(lines[1].words[0].start - (1.6 - lines[1].start)) < 0.02, `« Trois » at ${lines[1].words[0].start}`);
  // Without what the aligner heard, the service's times are all there is: the same cut as before.
  const unheard = splitDialogue(said, 3).lines;
  assert.ok(unheard[1].start + unheard[1].samples.length / RATE < 2.79, 'the exchange cut by the service\'s times loses the word');
  assert.deepEqual(splitDialogue(said, 3, [heard[0]]).lines.map((line) => line.start), unheard.map((line) => line.start), 'a heard list that does not fit the turns is ignored');
});

test('quota: costs said as a share of the month, one threshold, an approval that covers its rounded figure', () => {
  assert.equal(APPROVAL_SHARE, 0.01);
  assert.deepEqual([0.000213, 0.0018, 0.0095, 0.0149, 0.026, 0.126, 0].map(quotaPercent), [0.02, 0.2, 1, 1, 3, 13, 0]);
  assert.equal(needsApproval(399, { limit: 40000 }), false);
  assert.equal(needsApproval(400, { limit: 40000 }), true);
  assert.equal(needsApproval(1, null), true, 'a quota not known asks');
  assert.equal(needsApproval(0, null), false);
  assert.ok(covers(2, 0.024) && covers(2, 0.025) && !covers(2, 0.026), 'a quarter more than the figure told');
  assert.ok(covers(1, 0.013) && covers(1, 0.0149) && !covers(1, 0.0151), 'whatever is told « 1 % » is covered by 1 %');

  // The account's count follows a minute later: what was spent meanwhile is added, once.
  const id = keyId('sk_quotatestquotatestquotatest');
  forgetQuota();
  assert.equal(remember(id, { plan: 'starter', limit: 40000, used: 1000, resetsAt: '2026-11-11T00:00:00Z' }).used, 1000);
  noteSpent(30);
  assert.equal(remember(id, { plan: 'starter', limit: 40000, used: 1000, resetsAt: '2026-11-11T00:00:00Z' }).used, 1030, 'not counted yet');
  assert.equal(remember(id, { plan: 'starter', limit: 40000, used: 1030, resetsAt: '2026-11-11T00:00:00Z' }).used, 1030, 'counted: not twice');
  noteSpent(10);
  assert.equal(remember(id, { plan: 'starter', limit: 40000, used: 0, resetsAt: '2026-12-11T00:00:00Z' }).used, 0, 'a new month');
  forgetQuota();
});

test('elevenlabs: what the service charges teaches the estimates, and a generation charged far more than allowed stops', { skip: NO_FFMPEG }, async () => {
  const cache = process.env.ELABORA_ELEVENLABS_CACHE;
  process.env.ELABORA_ELEVENLABS_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-elevenlabs-cache-'));
  charge = 7;
  forgetQuota();
  try {
    const dir = narrated();
    await setSpeakerVoice(dir, { speaker: 'leila', voice: 'acc0unt0voice0000001', provider: 'elevenlabs' });
    await setSpeakerVoice(dir, { speaker: 'marc', voice: 'acc0unt0voice0000001', provider: 'elevenlabs' });
    assert.equal(chargedShare('starter'), STARTER, 'the Starter plan\'s rate, before this computer saw a charge');
    // Under 1 % of 40 000 credits as estimated (16), but charged 7 credits a character: 357, then
    // 287, more than half as much again as 1 % (600) before the third line.
    const result = await generateNarration(dir, { screen: 'accueil' });
    assert.deepEqual(result.lines.map((l) => l.line), ['l1', 'l2']);
    assert.deepEqual(result.overBudget, { allowedPercent: 2, spentPercent: 2 });
    assert.equal(chargedShare('starter'), 1, 'followed from the charges, never past the list price');
    const again = await estimateNarration(dir, { screen: 'accueil' });
    assert.deepEqual([again.lines.length, again.credits, again.needsApproval], [1, 41, false], 'the next estimate follows');
  } finally {
    charge = 0.11;
    process.env.ELABORA_ELEVENLABS_CACHE = cache;
    forgetQuota();
  }
});

// The « Nietzsche » course, 13 October 2026: two narrated screens (8 lines, 1,163 characters) were
// estimated at 203 credits (0.5 % of a Starter quota, so said without asking) and charged 465 (1.2 %).
// The estimate came from the 0.11 of the first two days (v4's launch discount, over by the morning of the
// 13th); a Starter plan is charged 0.4 of the list price, for every model, as the ledger measured (D36).
test('elevenlabs: a Starter plan is estimated at the ledger\'s undiscounted 0.4 of the list price, a rise is followed, a discount is not counted on, a plan not measured is told the list price, then its own requests', () => {
  const cache = process.env.ELABORA_ELEVENLABS_CACHE;
  process.env.ELABORA_ELEVENLABS_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-elevenlabs-rates-'));
  try {
    const credits = (characters: number, plan: string | null = 'starter', model = 'eleven_v4') => Math.ceil(characters * (model === 'eleven_v4_turbo' ? 0.5 : 1) * chargedShare(plan, model));
    assert.ok(credits(1163) >= 465 && credits(1163) < 470, 'the course: 465 charged');
    assert.ok([12, 13].includes(credits(30)), 'the experiment: 30 characters, 12 credits charged (13 told: the average is a little over 0.4)');
    assert.equal(credits(25, 'starter', 'eleven_v4_turbo'), 5, 'on Turbo: 25 characters, 5 credits');
    assert.equal(expectedCharge('starter').from, 'ledger');
    const charge = (billed: number, plan = 'starter', list = 100) => recordCharge({ model: 'eleven_v4', plan, list, billed, rate: 1, kind: 'speech' });
    // A discount the ledger does not know: 0.11 recorded, and not believed to go on.
    for (let i = 0; i < 12; i++) charge(11);
    assert.equal(chargedShare('starter'), STARTER);
    // A rise is followed at once, by the last requests; never past the list price.
    for (let i = 0; i < 12; i++) charge(80);
    assert.deepEqual([chargedShare('starter'), expectedCharge('starter').from], [0.8, 'own']);
    for (let i = 0; i < 12; i++) charge(100);
    assert.equal(chargedShare('starter'), 1);
    // The model's list price is no longer the period's: the ledger and the requests made at the old price are not used.
    assert.deepEqual([chargedShare('starter', 'eleven_v4', 2), expectedCharge('starter', 'eleven_v4', 2).from], [1, 'list']);
    // A request too small to say a share (8 credits for 74 characters) is not counted.
    fs.rmSync(path.join(process.env.ELABORA_ELEVENLABS_CACHE, 'charges.json'));
    charge(30, 'starter', 30);
    assert.equal(chargedShare('starter'), STARTER);
    // A plan the ledger has not measured: the list price, then what its own requests say, and a quarter more.
    assert.equal(chargedShare('creator'), 1);
    assert.equal(chargedShare(null), 1);
    for (let i = 0; i < 3; i++) charge(40, 'creator');
    assert.deepEqual([chargedShare('creator'), expectedCharge('creator').from], [0.5, 'own']);
    assert.equal(chargedShare('starter'), STARTER);
    // A model the ledger has not measured: the list price.
    assert.equal(chargedShare('starter', 'eleven_v5'), 1);
    // rates.json, kept before the ledger without dates, is dropped once a charge is kept.
    fs.writeFileSync(path.join(process.env.ELABORA_ELEVENLABS_CACHE, 'rates.json'), '{}');
    charge(40);
    assert.equal(fs.existsSync(path.join(process.env.ELABORA_ELEVENLABS_CACHE, 'rates.json')), false);
  } finally {
    process.env.ELABORA_ELEVENLABS_CACHE = cache;
  }
});

test('elevenlabs: a voice priced above its model keeps its price after a restart (its rate kept on the computer)', async () => {
  const { estimateCredits } = await import('@elabora/node/voice/elevenlabs/index');
  const { rememberVoiceRate, forgetVoiceRates, voiceRate } = await import('@elabora/node/voice/elevenlabs/costs');
  const plain = await estimateCredits('Bonjour, voici une réplique.', 'n0t0seen0voice000001', {});
  rememberVoiceRate('n0t0seen0voice000002', 2);
  forgetVoiceRates();
  assert.equal(voiceRate('n0t0seen0voice000002'), 2, 'read back from the cache folder');
  const double = await estimateCredits('Bonjour, voici une réplique.', 'n0t0seen0voice000002', {});
  assert.equal(double.ceiling, plain.ceiling * 2);
});

test('elevenlabs: an imitation of the service has answers of its own in the cache', async () => {
  const cache = process.env.ELABORA_ELEVENLABS_CACHE!;
  const before = fs.readdirSync(cache, { recursive: true }).length;
  const request = { text: 'Bonjour.', voice: 'acc0unt0voice0000001', language: 'fr', settings: {}, seed: 4242 };
  assert.equal((await synthesize(request)).cached, false);
  assert.equal((await synthesize(request)).cached, true);
  const url = process.env.ELABORA_ELEVENLABS_URL!;
  process.env.ELABORA_ELEVENLABS_URL = url.replace('127.0.0.1', 'localhost');
  try {
    const other = await synthesize(request);
    assert.deepEqual([other.cached, other.cost], [false, cost([{ text: 'Bonjour.', voice: 'acc0unt0voice0000001' }])], 'another address asks again');
  } finally { process.env.ELABORA_ELEVENLABS_URL = url; }
  assert.ok(fs.readdirSync(cache, { recursive: true }).length > before);
});

test('elevenlabs: the cache lives beside the key, out of Chromium\'s Cache folder; what was kept before is moved once', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-el-home-'));
  const script = `
    import fs from 'node:fs'; import path from 'node:path';
    import { localDataRoot } from '@elabora/node/data-dir';
    const before = path.join(localDataRoot(), 'cache', 'elevenlabs', 'ab');
    fs.mkdirSync(before, { recursive: true });
    fs.writeFileSync(path.join(before, 'ab12.json'), '{}');
    const { cacheDir } = await import('@elabora/node/voice/elevenlabs/api');
    const dir = cacheDir();
    console.log(JSON.stringify({ dir: path.relative(localDataRoot(), dir), kept: fs.existsSync(path.join(dir, 'ab', 'ab12.json')), left: fs.existsSync(before) }));`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'local'), XDG_DATA_HOME: path.join(home, 'share') };
  delete env.ELABORA_ELEVENLABS_CACHE;
  delete env.ELABORA_LOCAL_DATA_DIR;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env });
  assert.deepEqual(JSON.parse(stdout), { dir: path.join('elevenlabs', 'cache'), kept: true, left: false });
});

test('cli: the key is read from the input and never shown; from 1 % of the quota a paid generation waits for --spend <percent> (exit 3)', { skip: NO_FFMPEG }, async () => {
  const dir = narrated();
  const env: NodeJS.ProcessEnv = { ...process.env, ELABORA_ELEVENLABS_CACHE: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-elevenlabs-cache-')) };
  delete env.ELEVENLABS_API_KEY;
  const elabora = (args: string[], input?: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: dir, env, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout, stderr }));
    child.stdin!.end(input ?? '');
  });
  assert.match((await elabora(['voice', 'key', 'status'])).stdout, /No ElevenLabs key/);
  const set = await elabora(['voice', 'key', 'set'], `${KEY}\n`);
  assert.equal(set.code, 0, set.stderr);
  assert.ok(!set.stdout.includes(KEY) && set.stdout.includes('sk_…mnop'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(process.env.ELABORA_ELEVENLABS_KEY_FILE!).mode & 0o777, 0o600, 'readable by the author only');
  const account = await elabora(['voice', 'account', '--check']);
  assert.equal(account.code, 0, account.stderr);
  assert.match(account.stdout, /Quota: 3 % used this month \(1200 of 40000 credits\)/);
  assert.match(account.stdout, /a line costs about 0\.07 % of it/);
  assert.match(account.stdout, /✔ Text to Speech/);
  assert.ok(!account.stdout.includes(KEY));
  assert.equal((await elabora(['voice', 'set', 'leila', 'acc0unt0voice0000001', '--provider', 'elevenlabs'])).code, 0);
  assert.equal((await elabora(['voice', 'set', 'marc', 'acc0unt0voice0000001', '--provider', 'elevenlabs', '--stability', '0.4'])).code, 0);
  const estimate = await elabora(['voice', 'estimate', 'accueil']);
  assert.match(estimate.stdout, /Total: ~0\.1 % of the monthly quota \(starter plan\), 133 characters, about 55 credits \(at most 133\)/);
  assert.match(estimate.stdout, /needs no approval/);
  // A small quota: 6 % of it as estimated, which waits for the author.
  limit = 1000;
  let refused, made;
  try {
    refused = await elabora(['voice', 'generate', 'accueil', '--json']);
    assert.equal(refused.code, 3);
    assert.deepEqual([JSON.parse(refused.stdout).needsApproval, JSON.parse(refused.stdout).estimate.percent], [true, 6]);
    assert.ok(!fs.existsSync(path.join(dir, 'assets/narration/fr/accueil/l1.m4a')));
    made = await elabora(['voice', 'generate', 'accueil', '--spend', '6%']);
  } finally { limit = 40000; }
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /elevenlabs: 133 characters sent, 16 credits \(~2 % of the monthly quota\)/);
  assert.match(made.stdout, /Credits: Voix de synthèse : Nadia \(ElevenLabs\)/, 'the name course.json keeps');
  for (const out of [set, account, estimate, refused, made]) assert.ok(!`${out.stdout}${out.stderr}`.includes(KEY), 'the key never printed');
  assert.equal((await elabora(['voice', 'key', 'remove'])).code, 0);
  assert.ok(!fs.existsSync(process.env.ELABORA_ELEVENLABS_KEY_FILE!));
});

test('engine: the app gives the key in memory, reads the account, searches voices and estimates', async () => {
  const { openProject } = await import('@elabora/engine/session');
  const dir = narrated();
  delete process.env.ELEVENLABS_API_KEY;
  const session = await openProject(dir, { backups: { onOpen: false, prune: false }, rescanIntervalMs: 0, media: { enabled: false } });
  try {
    await assert.rejects(session.voiceAccount({}), (error: { code?: string }) => error.code === 'E_VOICE_KEY_MISSING');
    assert.deepEqual(session.setVoiceKey(KEY), { key: 'sk_…mnop' });
    assert.equal((await session.voiceAccount({})).keySource, 'app');
    assert.equal((await session.voiceSearch({ provider: 'elevenlabs', text: 'marc' })).voices.length, 4, 'the imitation answers every voice, whatever the words');
    await session.setSpeakerVoice({ speaker: 'leila', voice: 'acc0unt0voice0000001', provider: 'elevenlabs' });
    await session.setSpeakerVoice({ speaker: 'marc', voice: 'acc0unt0voice0000001', provider: 'elevenlabs' });
    const estimate = await session.voiceEstimate({ screen: 'accueil' });
    assert.deepEqual([estimate.ceiling, estimate.needsApproval, estimate.quota?.limit], [133, false, 40000]);
  } finally {
    setSessionKey(null);
    process.env.ELEVENLABS_API_KEY = KEY;
    await session.close();
  }
});

test('elevenlabs live: a real voice says a short line with a direction (ELABORA_ELEVENLABS_LIVE=1: spends about 40 credits)', { skip: !live && 'ELABORA_ELEVENLABS_LIVE=1 to call ElevenLabs' }, async () => {
  const said = await synthesize({ text: '[chaleureuse] Bienvenue dans l’équipe !', voice: process.env.ELABORA_ELEVENLABS_VOICE || 'YxrwjAKoUKULGd0g8K9Y', language: 'fr', settings: {}, seed: 7 });
  assert.ok(said.samples.length > RATE * 0.8, 'about a second or more');
  assert.deepEqual(said.words!.map((w) => w.text), ['Bienvenue', 'dans', 'l’', 'équipe']);
  assert.equal(said.model, 'elevenlabs/eleven_v4');
});
