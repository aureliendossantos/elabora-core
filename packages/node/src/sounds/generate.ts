import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { covers, needsApproval, quotaPercent, shareOf } from '@elabora/core/ai/quota';
import { expectedShare } from '@elabora/core/ai/costs';
import { COST_BOOK } from '@elabora/core/ai/cost-ledger.generated';
import type { Quota } from '@elabora/core/ai/quota';
import { baseUrl, cacheDir, failure } from '../voice/elevenlabs/api.ts';
import { requireKey, scrub } from '../voice/elevenlabs/key.ts';
import { noteSpent, readQuota } from '../voice/elevenlabs/costs.ts';
import { VoiceError } from '../voice/provider.ts';
import type { EditOptions } from '../edit/executor.ts';
import { addSound } from './add.ts';

// « Créer avec ElevenLabs » (docs/decisions.md D67): a sound effect made from a description with the
// author's own key, kept as the MP3 the service gives (no second lossy encoding before the build),
// with its sidecar saying it was generated. Its cost is a share of the author's monthly quota (D30):
// under 1 % it runs, from 1 % the author approves it first. The same request is never paid twice
// (the answer is kept in the voices' cache).

export const SOUND_MODEL = 'eleven_text_to_sound_v2';
// The list price: credits a second of sound, whether its length is set or the service chooses it
// (ai-costs/periods.json: measured on 28 October 2026, 10 credits a second, where the documentation said
// 40). What a plan is charged of it comes from the ledger (D36). Without a length the service chooses
// one, up to 30 s (it chose 5 s in the trial): the estimate counts the longest, so that the share told
// is « at most » and the author's approval (D30) is never skipped by a longer sound than expected.
export const LIST_CREDITS_PER_SECOND = 10;
export const AUTO_SECONDS = 30;

export interface SoundEstimate {
  credits: number;
  quota: Quota | null;
  percent: number | null;
  needsApproval: boolean;
}

// The credits a sound of so many seconds (or of the length the service chooses) is expected to cost on a plan.
export const soundCredits = (duration: number | undefined, plan: string | null = null): number =>
  Math.ceil((duration ?? AUTO_SECONDS) * LIST_CREDITS_PER_SECOND * expectedShare(COST_BOOK, { provider: 'elevenlabs', model: SOUND_MODEL, plan: plan?.toLowerCase() ?? null, kind: 'sound', rates: { seconds: LIST_CREDITS_PER_SECOND } }).share);

export async function estimateSound({ duration, signal }: { duration?: number; signal?: AbortSignal } = {}): Promise<SoundEstimate> {
  const quota = await readQuota({ key: requireKey(), signal }).catch(() => null);
  const credits = soundCredits(duration, quota?.plan ?? null);
  return { credits, quota, percent: quota && quota.limit > 0 ? quotaPercent(shareOf(credits, quota.limit)) : null, needsApproval: needsApproval(credits, quota) };
}

export interface GenerateSoundRequest {
  prompt: string;
  duration?: number; // 0.5 to 30 s; without it, ElevenLabs chooses
  loop?: boolean;
  influence?: number; // 0 to 1: how closely it follows the description (default 0.3)
  id?: string;
  caption?: Record<string, string>;
  approvedPercent?: number;
  signal?: AbortSignal;
}

export async function generateSound(dir: string, request: GenerateSoundRequest, options?: EditOptions) {
  const prompt = request.prompt.trim();
  if (!prompt) throw new VoiceError('E_VOICE_REQUEST', 'Describe the sound to make (« a desk phone rings twice, close »).');
  if (request.duration !== undefined && !(request.duration >= 0.5 && request.duration <= 30)) throw new VoiceError('E_VOICE_REQUEST', 'A sound effect lasts from 0.5 to 30 seconds.');
  const estimate = await estimateSound({ duration: request.duration, signal: request.signal });
  const approved = request.approvedPercent;
  if (estimate.needsApproval && !(approved !== undefined && covers(approved, shareOf(estimate.credits, estimate.quota?.limit ?? 0)))) {
    const share = estimate.percent === null ? 'an unknown share of the author\'s monthly quota' : `~${estimate.percent} % of the author's monthly quota`;
    const error = new VoiceError('E_VOICE_SPEND', `Making this sound with ElevenLabs uses ${share}${approved !== undefined ? ` (more than the ${approved} % approved)` : ''}: ask the author, then approve it (--spend ${estimate.percent ?? '<percent>'}, MCP approvedPercent).`);
    Object.assign(error, { estimate });
    throw error;
  }
  const body = { text: prompt, model_id: SOUND_MODEL, ...(request.duration !== undefined ? { duration_seconds: request.duration } : {}), prompt_influence: request.influence ?? 0.3, ...(request.loop ? { loop: true } : {}) };
  const { file, cost, cached } = await requestSound(body, request.signal);
  if (cost) noteSpent(cost);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sound-gen-'));
  try {
    const mp3 = path.join(work, 'generated.mp3');
    fs.copyFileSync(file, mp3);
    const added = await addSound(dir, { from: mp3, id: request.id ?? slugOf(prompt), license: 'generated', title: prompt.slice(0, 200), ...(request.loop ? { loop: true } : {}), ...(request.caption ? { caption: request.caption } : {}), generated: { provider: 'elevenlabs', model: SOUND_MODEL, prompt: prompt.slice(0, 1000), createdAt: new Date().toISOString().slice(0, 10) } }, options);
    return { ...added, credits: cost, estimatedCredits: estimate.credits, percent: estimate.quota && cost !== null ? quotaPercent(shareOf(cost, estimate.quota.limit)) : estimate.percent, cached };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// The MP3 of a request, from this computer's cache when the same one was made before (cost 0).
async function requestSound(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ file: string; cost: number | null; cached: boolean }> {
  const id = crypto.createHash('sha256').update(`${baseUrl()}\0/v1/sound-generation\0${JSON.stringify(body)}`).digest('hex');
  const file = path.join(cacheDir(), id.slice(0, 2), `${id}.mp3`);
  if (fs.existsSync(file)) return { file, cost: 0, cached: true };
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/v1/sound-generation?output_format=mp3_44100_128`, { method: 'POST', signal, headers: { 'xi-api-key': requireKey(), 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new VoiceError('E_VOICE_OFFLINE', `ElevenLabs could not be reached to make a sound (${scrub(error instanceof Error ? error.message : String(error))}): check the connection.`);
  }
  if (!response.ok) throw failure(response.status, await response.text(), 'make a sound effect');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new VoiceError('E_VOICE_SERVICE', 'ElevenLabs gave no audio for the sound.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.part`, bytes);
  fs.renameSync(`${file}.part`, file);
  const charged = Number(response.headers.get('character-cost'));
  return { file, cost: response.headers.has('character-cost') && Number.isFinite(charged) ? charged : null, cached: false };
}

const slugOf = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 5).join('-').replace(/^(\d)/, 's-$1') || 'sound';
