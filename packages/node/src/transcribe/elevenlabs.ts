import fs from 'node:fs';
import path from 'node:path';
import { APPROVAL_SHARE, covers, needsApproval, quotaPercent, shareOf } from '@elabora/core/ai/quota';
import { expectedShare } from '@elabora/core/ai/costs';
import { COST_BOOK } from '@elabora/core/ai/cost-ledger.generated';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { probeMedia } from '../media/probe.ts';
import { baseUrl } from '../voice/elevenlabs/api.ts';
import { requireKey, scrub } from '../voice/elevenlabs/key.ts';
import { noteSpent, readQuota } from '../voice/elevenlabs/costs.ts';
import { VoiceError } from '../voice/provider.ts';
import { TranscriptionError } from './process.ts';
import type { TranscribeProgress, Transcript, TranscriptionEstimate } from './types.ts';

// ElevenLabs' speech to text (docs/decisions.md D46), with the author's key, when they ask for it:
//   POST /v1/speech-to-text   multipart: model_id, file, language_code, timestamps_granularity=word,
//                             tag_audio_events=false; the text, its language, and its words timed.
//   DELETE /v1/speech-to-text/transcripts/{id}   the transcript ElevenLabs keeps (only an enterprise
//                             plan may ask it to keep nothing): removed as soon as it is read.
// It needs the key's « Speech to Text » permission (not among the three D29 asks for: the error says
// to add it). What it costs is told as a share of the author's monthly quota before anything is
// spent (D30): from APPROVAL_SHARE the author approves it first (approvedPercent).

export const STT_MODEL = 'scribe_v2';
// The list price: credits a second of audio (330 a minute, ElevenLabs' pricing page, 15 October 2026;
// ai-costs/periods.json). What a plan is charged of it comes from the ledger (D36) once measured: the
// list price until then, so the share told is « at most ».
export const LIST_CREDITS_PER_SECOND = 5.5;

// The credits a transcription of so many seconds is expected to cost on a plan.
export const transcriptionCredits = (seconds: number, plan: string | null): number =>
  Math.ceil(seconds * LIST_CREDITS_PER_SECOND * expectedShare(COST_BOOK, { provider: 'elevenlabs', model: STT_MODEL, plan: plan?.toLowerCase() ?? null, kind: 'transcription', rates: { seconds: LIST_CREDITS_PER_SECOND } }).share);

interface SpeechToTextAnswer {
  transcription_id?: string;
  language_code?: string;
  text: string;
  words?: { text: string; start?: number; end?: number; type?: 'word' | 'spacing' | 'audio_event'; logprob?: number }[];
}

// What transcribing a file with ElevenLabs takes of the author's quota (the quota read with the key's
// User: read; null when it cannot be read).
export async function estimateTranscription(file: string, { signal, tools }: { signal?: AbortSignal; tools?: MediaTools } = {}): Promise<TranscriptionEstimate> {
  const seconds = (await probeMedia(path.resolve(file), { tools: tools ?? await findMediaTools() })).duration ?? 0;
  const quota = await readQuota({ signal, key: requireKey() }).catch(() => null);
  const credits = transcriptionCredits(seconds, quota?.plan ?? null);
  const share = quota ? shareOf(credits, quota.limit) : null;
  return { seconds: Math.round(seconds * 10) / 10, credits, percent: share === null ? null : quotaPercent(share), needsApproval: needsApproval(credits, quota) };
}

export async function elevenLabsTranscript(file: string, language: string, { approvedPercent, signal, onProgress, tools }: { approvedPercent?: number; signal?: AbortSignal; onProgress?: (progress: TranscribeProgress) => void; tools?: MediaTools }): Promise<Transcript> {
  const key = requireKey();
  const estimate = await estimateTranscription(file, { signal, ...(tools ? { tools } : {}) });
  const quota = await readQuota({ signal, key }).catch(() => null);
  const share = quota ? shareOf(estimate.credits, quota.limit) : Number.POSITIVE_INFINITY;
  if (estimate.needsApproval && !(typeof approvedPercent === 'number' && covers(approvedPercent, share))) {
    throw Object.assign(new TranscriptionError('E_TRANSCRIBE_SPEND', `Transcribing ${path.basename(file)} with ElevenLabs takes ${estimate.percent === null ? 'a share of your quota that could not be read' : `~${estimate.percent} % of your monthly quota`}: approve it first (from ${APPROVAL_SHARE * 100} %; --spend <percent>, approvedPercent).`), { estimate });
  }
  onProgress?.({ phase: 'transcribe', fraction: 0 });
  const form = new FormData();
  form.set('model_id', STT_MODEL);
  form.set('language_code', language.toLowerCase().split('-')[0]);
  form.set('timestamps_granularity', 'word');
  form.set('tag_audio_events', 'false');
  form.set('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/v1/speech-to-text`, { method: 'POST', signal, headers: { 'xi-api-key': key, accept: 'application/json' }, body: form });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new VoiceError('E_VOICE_OFFLINE', `ElevenLabs could not be reached to transcribe the recording (${scrub(error instanceof Error ? error.message : String(error))}): check the connection.`);
  }
  const body = await response.text();
  if (!response.ok) throw failure(response.status, body);
  let answer: SpeechToTextAnswer;
  try { answer = JSON.parse(body) as SpeechToTextAnswer; } catch { throw new VoiceError('E_VOICE_SERVICE', 'ElevenLabs answered something unreadable to the transcription.'); }
  const charged = Number(response.headers.get('character-cost'));
  const credits = response.headers.has('character-cost') && Number.isFinite(charged) && charged >= 0 ? charged : estimate.credits;
  noteSpent(credits);
  if (answer.transcription_id) await forget(answer.transcription_id, key);
  onProgress?.({ phase: 'transcribe', fraction: 1 });
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const words = (answer.words ?? []).filter((word) => (word.type ?? 'word') === 'word' && typeof word.start === 'number')
    .map((word) => ({ text: word.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''), start: round(word.start!), end: round(word.end ?? word.start!), ...(typeof word.logprob === 'number' ? { score: round(Math.exp(word.logprob)) } : {}) }))
    .filter((word) => word.text);
  return {
    text: (answer.text ?? '').replace(/\s+/g, ' ').trim(), words, transcriber: `elevenlabs/${STT_MODEL}`, duration: estimate.seconds, service: 'elevenlabs',
    ...(quota ? { percent: quotaPercent(shareOf(credits, quota.limit)) } : {})
  };
}

// The transcript ElevenLabs stored, removed: what the author's recording said stays on this computer
// only. A removal that fails changes nothing for the author (the service keeps it as it keeps every
// account's history).
async function forget(id: string, key: string): Promise<void> {
  try {
    await fetch(`${baseUrl()}/v1/speech-to-text/transcripts/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'xi-api-key': key } });
  } catch { /* kept by the service */ }
}

// Why a transcription failed, as the voices' codes say it (the app words them once).
function failure(status: number, body: string): Error {
  let message = body.slice(0, 300);
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail;
    message = typeof detail === 'string' ? detail : typeof detail === 'object' && detail && 'message' in detail ? String((detail as { message: unknown }).message) : message;
  } catch { /* the body as it is */ }
  const said = scrub(message);
  if (status === 401 && /permission/i.test(body)) return new VoiceError('E_VOICE_KEY_PERMISSION', `The ElevenLabs key may not transcribe: ${said} (give the key the « Speech to Text » permission on https://elevenlabs.io/app/settings/api-keys).`);
  if (status === 401) return new VoiceError('E_VOICE_KEY_INVALID', `ElevenLabs refused the key (${said || 'invalid API key'}): check it, or create another (elabora voice key set).`);
  if (/quota|credits/i.test(body)) return new VoiceError('E_VOICE_CREDITS', `Not enough ElevenLabs credits left to transcribe the recording: ${said}`);
  if (status === 429) return new VoiceError('E_VOICE_BUSY', `ElevenLabs is busy (${said}): try again in a moment.`);
  return new VoiceError(status === 400 || status === 422 ? 'E_VOICE_REQUEST' : 'E_VOICE_SERVICE', `ElevenLabs could not transcribe the recording (HTTP ${status}${said ? `: ${said}` : ''}).`);
}
