// The author's day, YYYY-MM-DD, in the time zone of the computer that runs Elabora (not UTC's:
// between midnight and 2 a.m. in France UTC is still yesterday). `TZ` moves it, as for any Node program.
export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
