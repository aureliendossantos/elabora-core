import type { Quota } from '../../ai/quota.ts';

// The month's credits of an ElevenLabs account (docs/decisions.md D30). The account's count follows
// about a minute after a request: what a host spent since it last read the count is added to it until
// the count catches up. Each host keeps one count for all it asks (lines, sounds, transcriptions).

export interface Subscription { tier: string; character_count: number; character_limit: number; next_character_count_reset_unix?: number | null }
// What Elabora reads of a subscription: all a page that holds the key gives back of the account (D136).
export const SUBSCRIPTION_FIELDS = ['tier', 'character_count', 'character_limit', 'next_character_count_reset_unix'] as const satisfies readonly (keyof Subscription)[];

const resetOf = (sub: Subscription): string | null => (sub.next_character_count_reset_unix ? new Date(sub.next_character_count_reset_unix * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null);

export function quotaOf(sub: Subscription): Quota {
  return { plan: sub.tier, limit: sub.character_limit, used: sub.character_count, resetsAt: resetOf(sub) };
}

const FRESH_MS = 30_000;
const LAG_MS = 5 * 60_000;

export class QuotaCount {
  // The last count read, by key; what was spent since; a read kept 30 s.
  #known: { key: string; quota: Quota; base: number; at: number } | null = null;
  #pending: { credits: number; at: number }[] = [];

  // The count of this key read less than 30 s ago, or null.
  fresh(id: string): Quota | null {
    return this.#known?.key === id && Date.now() - this.#known.at < FRESH_MS ? { ...this.#known.quota } : null;
  }

  // A count just read, with what this host spent since the last one.
  remember(id: string, read: Quota): Quota {
    const now = Date.now();
    const known = this.#known;
    if (!known || known.key !== id || known.quota.resetsAt !== read.resetsAt) {
      this.#pending = [];
      this.#known = { key: id, quota: { ...read }, base: read.used, at: now };
      return { ...read };
    }
    const spent = this.#pending.reduce((sum, entry) => sum + entry.credits, 0);
    // The count caught up, or what is pending is old enough to be in it: the count is right.
    if (read.used >= known.base + spent || this.#pending.every((entry) => now - entry.at > LAG_MS)) {
      this.#pending = [];
      this.#known = { key: id, quota: { ...read }, base: read.used, at: now };
      return { ...read };
    }
    this.#known = { key: id, quota: { ...read, used: Math.max(read.used, known.base + spent) }, base: known.base, at: now };
    return { ...this.#known.quota };
  }

  // Credits a request was charged: counted until the account's count shows them.
  spent(credits: number): void {
    if (!(credits > 0)) return;
    this.#pending.push({ credits, at: Date.now() });
    if (this.#known) this.#known.quota = { ...this.#known.quota, used: this.#known.quota.used + credits };
  }

  // Forgets the count read and what was spent since (tests, or another account).
  forget(): void {
    this.#known = null;
    this.#pending = [];
  }
}
