// What Elabora's paid AI services cost the author, said one way everywhere (docs/decisions.md D30): a
// share of their monthly quota, never credits nor money. Counting credits tires people and leaves
// plans unused when a hundred credits are nothing; a share of the month is read at a glance and
// means the same for every service and every plan.

// The one threshold of every paid AI service of Elabora. Under this share of the author's monthly
// quota an action runs on a click, shows no cost, and the author's AI needs no approval; from it,
// the app confirms with the share and agents ask the author first.
export const APPROVAL_SHARE = 0.01;

// A service's quota this month, in its own units (ElevenLabs: credits).
export interface Quota {
  plan: string;
  limit: number;
  used: number;
  resetsAt: string | null;   // ISO date of the next renewal
}

// The share of a quota that some units are (Infinity when the quota is unknown or empty).
export const shareOf = (units: number, limit: number): number => (limit > 0 ? units / limit : Number.POSITIVE_INFINITY);

// Whether spending these units asks the author first: from the threshold, or whenever the quota is
// not known.
export const needsApproval = (units: number, quota: Pick<Quota, 'limit'> | null): boolean => units > 0 && (!quota || shareOf(units, quota.limit) >= APPROVAL_SHARE);

// A share as people say it, in percent: one significant digit under 1 % (0.02, 0.2), whole numbers
// from 1 % (2, 13); never 0 for a cost that is not.
export function quotaPercent(share: number): number {
  const percent = share * 100;
  if (!Number.isFinite(percent) || percent <= 0) return Math.max(0, percent);
  if (percent >= 1) return Math.round(percent);
  // One significant digit, rounded half up despite binary fractions (0.95 → 1, not 0.9).
  const step = 10 ** Math.floor(Math.log10(percent));
  return Number((Math.round(percent / step + 1e-9) * step).toPrecision(1));
}

// Whether the percent an author approved covers an estimate: whatever is told with that figure or
// less (quotaPercent rounds: « 1 % » is told up to 1.49 %), and, as an estimate moves a little
// between two calls, a quarter more than the figure.
export const covers = (approvedPercent: number, share: number): boolean =>
  Number.isFinite(share) && (quotaPercent(share) <= approvedPercent || share * 100 <= approvedPercent * 1.25 + 0.005);
