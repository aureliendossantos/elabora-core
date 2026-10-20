import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Quota } from '@elabora/core/ai/quota';
import { expectedShare } from '@elabora/core/ai/costs';
import type { CostBook, OwnCharge, ShareAnswer } from '@elabora/core/ai/costs';
import { COST_BOOK } from '@elabora/core/ai/cost-ledger.generated';
import { cacheDir, request } from './api.ts';

// What ElevenLabs charges and what the author has left (docs/decisions.md D29, D30, D36).
//
// The list price, a credit per character times the model's multiplier (GET /v1/models) and the
// voice's rate, is only a ceiling: an account is charged a share of it, which the ledger of what the
// service charged says (ai-costs/ in elabora-core, shipped as @elabora/core cost-ledger.generated.ts) by
// model, plan and price period. On a Starter plan, 13 October 2026, a request is charged
// round(0.4 × characters × the model's multiplier), a line or a dialogue, with or without timestamps
// or context text, whatever the language, output format or voice; the first two weeks of Eleven v4
// were a launch discount (0.11) that ended without notice, so its figures are never used for today's
// price, and a discount running is never counted on (D30).
//
// The estimate is the current period's average for the model and plan; where the ledger has too few
// requests of them, the list price until the author's own requests, whose charges the service gives
// in the character-cost header (kept in <cache>/charges.json with their date, plan and list price),
// say what the account is charged: then those, and a quarter more. The author's recent requests
// charged more than the ledger says are followed at once (a price that rises), never past the list
// price. A model whose list price is no longer the period's (GET /v1/models says another) is told the
// list price again, as a new model is.
//
// The account's credit count follows about a minute after a request: what this process spent since
// it last read the count is added to it until the count catches up.

const PROVIDER = 'elevenlabs';
const DEFAULT_MODEL = 'eleven_v4';
// The author's own requests kept on this computer (the estimate reads the last twelve of a key).
const KEPT = 200;

const chargesFile = (): string => path.join(cacheDir(), 'charges.json');

function readCharges(): OwnCharge[] {
  try {
    const value = JSON.parse(fs.readFileSync(chargesFile(), 'utf8')) as { charges?: OwnCharge[] };
    return Array.isArray(value?.charges) ? value.charges : [];
  } catch {
    return [];
  }
}

// Voices priced above their model (library voices that cost two or three times as much), kept on
// this computer once a search or a lookup saw them: priced the same after a restart, and their
// charges teach the model's share right.
const voiceRatesFile = (): string => path.join(cacheDir(), 'voice-rates.json');
let voiceRates: Record<string, number> | null = null;

function readVoiceRates(): Record<string, number> {
  if (voiceRates) return voiceRates;
  try {
    const value = JSON.parse(fs.readFileSync(voiceRatesFile(), 'utf8')) as Record<string, number>;
    voiceRates = value && typeof value === 'object' ? value : {};
  } catch {
    voiceRates = {};
  }
  return voiceRates;
}

export const voiceRate = (voice: string): number | null => readVoiceRates()[voice] ?? null;

export function rememberVoiceRate(voice: string, rate: number | null | undefined): void {
  const rates = readVoiceRates();
  const known = rates[voice];
  if (!(typeof rate === 'number' && rate > 0) || known === rate || (rate === 1 && known === undefined)) return;
  rates[voice] = rate;
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(voiceRatesFile(), JSON.stringify(rates));
  } catch { /* priced from a search again */ }
}

// Forgets the rates read (tests, another cache).
export function forgetVoiceRates(): void {
  voiceRates = null;
}

// The share of its list price a request of this model is expected to be charged on this plan (null:
// not known), the model's list price per character as the service says it now when it was read
// (rate), and where the figure comes from (D36).
export function expectedCharge(plan: string | null, model = DEFAULT_MODEL, rate?: number, kind: 'speech' | 'dialogue' = 'speech', book: CostBook = COST_BOOK): ShareAnswer {
  return expectedShare(book, { provider: PROVIDER, model, plan: plan?.toLowerCase() ?? null, kind, ...(rate === undefined ? {} : { rates: { characters: rate } }), own: readCharges() });
}

export const chargedShare = (plan: string | null, model = DEFAULT_MODEL, rate?: number, kind: 'speech' | 'dialogue' = 'speech'): number => expectedCharge(plan, model, rate, kind).share;

// A request's charge against its list price, kept for the next estimates with its date, plan and the
// model's list price per character then (the last 200; rates.json, kept without dates before D36, is
// dropped: its requests cannot be placed in a period).
export function recordCharge(charge: { model: string; plan: string | null; list: number; billed: number; rate?: number; kind?: string; date?: string }): void {
  if (!(charge.list > 0) || !(charge.billed >= 0)) return;
  try {
    const own: OwnCharge = {
      provider: PROVIDER, model: charge.model, plan: charge.plan?.toLowerCase() ?? null, date: charge.date ?? new Date().toISOString(),
      ...(charge.kind ? { kind: charge.kind } : {}), list: charge.list, billed: charge.billed, ...(charge.rate === undefined ? {} : { rates: { characters: charge.rate } })
    };
    const charges = [...readCharges(), own].slice(-KEPT);
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(`${chargesFile()}.part`, JSON.stringify({ charges }));
    fs.renameSync(`${chargesFile()}.part`, chargesFile());
    fs.rmSync(path.join(cacheDir(), 'rates.json'), { force: true });
  } catch { /* the next estimate uses what it knew */ }
}

// ── The quota ─────────────────────────────────────────────────────────

export interface Subscription { tier: string; character_count: number; character_limit: number; next_character_count_reset_unix?: number | null }

// The plan and its count. From /v1/user, which carries the same subscription in about a quarter of a
// second: /v1/user/subscription adds the invoices (next, open) and takes 1.3 to 1.9 s every time,
// which is what « Réglages d'Elabora » waited for to show the quota (measured 13 October 2026).
export async function readSubscription({ signal, key }: { signal?: AbortSignal; key: string }): Promise<Subscription> {
  const { subscription } = await request<{ subscription?: Subscription }>('GET', '/v1/user', { signal, what: 'read your quota', key });
  return subscription ?? request<Subscription>('GET', '/v1/user/subscription', { signal, what: 'read your quota', key });
}

const resetOf = (sub: Subscription): string | null => (sub.next_character_count_reset_unix ? new Date(sub.next_character_count_reset_unix * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null);

// The last count read, by key; what was spent since; a read kept 30 s.
let known: { key: string; quota: Quota; base: number; at: number } | null = null;
let pending: { credits: number; at: number }[] = [];
const FRESH_MS = 30_000;
const LAG_MS = 5 * 60_000;

export const keyId = (key: string): string => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

export function quotaOf(sub: Subscription): Quota {
  return { plan: sub.tier, limit: sub.character_limit, used: sub.character_count, resetsAt: resetOf(sub) };
}

// The month's quota of the key in use, the credits spent here since the count was read added.
export async function readQuota({ signal, key, fresh = false }: { signal?: AbortSignal; key: string; fresh?: boolean }): Promise<Quota> {
  const id = keyId(key);
  if (!fresh && known?.key === id && Date.now() - known.at < FRESH_MS) return { ...known.quota };
  const sub = await readSubscription({ signal, key });
  return remember(id, quotaOf(sub));
}

// A count just read (by readQuota or the account), with what this process spent since the last one.
export function remember(id: string, read: Quota): Quota {
  const now = Date.now();
  if (!known || known.key !== id || known.quota.resetsAt !== read.resetsAt) {
    pending = [];
    known = { key: id, quota: { ...read }, base: read.used, at: now };
    return { ...read };
  }
  const spent = pending.reduce((sum, entry) => sum + entry.credits, 0);
  // The count caught up, or what is pending is old enough to be in it: the count is right.
  if (read.used >= known.base + spent || pending.every((entry) => now - entry.at > LAG_MS)) {
    pending = [];
    known = { key: id, quota: { ...read }, base: read.used, at: now };
    return { ...read };
  }
  known = { key: id, quota: { ...read, used: Math.max(read.used, known.base + spent) }, base: known.base, at: now };
  return { ...known.quota };
}

// Credits a request of this process was charged: counted until the account's count shows them.
export function noteSpent(credits: number): void {
  if (!(credits > 0)) return;
  pending.push({ credits, at: Date.now() });
  if (known) known.quota = { ...known.quota, used: known.quota.used + credits };
}

// Forgets the count read and what was spent since (tests, or another account).
export function forgetQuota(): void {
  known = null;
  pending = [];
}
