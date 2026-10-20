// Which versions to keep (docs/architecture/storage.md, Backups): everything for 24 hours, one per hour for
// 7 days, one per day for 30 days, then one per week; named versions until the user deletes them.
//
// The version kept in a period is the newest of it, and periods nest (UTC hours in days, days in
// ISO weeks starting on Monday), so the newest of a week was also the newest of its day and of its
// hour: pruning again later never leaves a gap. Pure: `now` is a parameter.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
const MONDAY = 4 * DAY; // 1970-01-01 was a Thursday

export interface RetentionInput {
  id: string;
  time: number;
  name: string | null;
}

export interface RetentionPlan {
  keep: Set<string>;
  // Kept versions older than 30 days (one per week), whose binary files the retention trims.
  weekly: Set<string>;
}

export function retentionPlan(versions: readonly RetentionInput[], now: number): RetentionPlan {
  const newestFirst = [...versions].sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const keep = new Set<string>();
  const weekly = new Set<string>();
  const taken = new Set<string>();
  newestFirst.forEach((v, index) => {
    const age = now - v.time;
    const hour = `h${Math.floor(v.time / HOUR)}`;
    const day = `d${Math.floor(v.time / DAY)}`;
    const week = `w${Math.floor((v.time - MONDAY) / WEEK)}`;
    const period = age <= DAY ? null : age <= 7 * DAY ? hour : age <= 30 * DAY ? day : week;
    const kept = index === 0 || v.name !== null || period === null || !taken.has(period);
    if (!kept) return;
    keep.add(v.id);
    taken.add(hour).add(day).add(week);
    if (age > 30 * DAY && v.name === null) weekly.add(v.id);
  });
  return { keep, weekly };
}
