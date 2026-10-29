// How a sound of the story is mixed (D67, schemas 0.1.7): the part of its file played, its gain
// under a ceiling, its fades, and how far it lowers the voice, the music and the ambiences under it.
// Pure: the player plays with it (sounds.ts), and the desktop app's editor hears a cue with it, so
// that the author judges by ear what learners will hear.

// A volume goes up to 200 % (+6 dB) for a sound recorded too quietly. Above 100 %, a sound is never
// raised past the point where its loudest sample reaches −1 dBFS (the true-peak ceiling of EBU R128):
// louder would clip, which is a distortion, not a louder sound.
export const VOLUME_MAX = 2;
export const PEAK_CEILING = 10 ** (-1 / 20);
// Seconds of fade in or out at most.
export const FADE_MAX = 10;
// A sound that lowers what plays under it: by up to 30 dB, down in 0.1 s as it starts (quick, so its
// first moment is heard over the voice; slower would let the voice cover its attack), back up in
// 0.5 s once it is done (slower than down, so the voice does not jump back).
export const DUCK_MAX = 30;
export const DUCK_ATTACK = 0.1;
export const DUCK_RELEASE = 0.5;

// The part of a file played, in seconds: from start to end, kept inside the file; the whole file when
// they leave nothing to play.
export interface SoundPart {
  offset: number;
  length: number;
}
export function partOf(start: number | undefined, end: number | undefined, duration: number): SoundPart {
  const from = Math.max(0, Math.min(start ?? 0, duration));
  const to = Math.max(0, Math.min(end ?? duration, duration));
  return to - from > 0.01 ? { offset: from, length: to - from } : { offset: 0, length: duration };
}

// The samples of a decoded sound, channel by channel (an AudioBuffer).
export function channelsOf(buffer: { numberOfChannels: number; getChannelData(channel: number): Float32Array }): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) channels.push(buffer.getChannelData(channel));
  return channels;
}

// The loudest sample of a decoded sound over a part, 0 to 1 (and above, for a file that clips).
export function peakOf(channels: readonly Float32Array[], sampleRate: number, part?: SoundPart): number {
  let peak = 0;
  for (const samples of channels) {
    const from = part ? Math.max(0, Math.floor(part.offset * sampleRate)) : 0;
    const to = part ? Math.min(samples.length, Math.ceil((part.offset + part.length) * sampleRate)) : samples.length;
    for (let i = from; i < to; i++) {
      const value = samples[i] < 0 ? -samples[i] : samples[i];
      if (value > peak) peak = value;
    }
  }
  return peak;
}

// The gain a volume asks for: up to 100 % as asked; above, no higher than brings the peak to the
// ceiling (and never below 100 %: a file already that loud plays at its own level). A peak not
// known keeps 100 %.
export function gainOf(volume: number | undefined, peak: number | null): number {
  const asked = Math.max(0, Math.min(VOLUME_MAX, volume ?? 1));
  if (asked <= 1) return asked;
  if (peak === null || !(peak > 0)) return 1;
  return Math.max(1, Math.min(asked, PEAK_CEILING / peak));
}

// The fades of a part: shortened together when, end to end, they would be longer than it.
export function fadesOf(fadeIn: number | undefined, fadeOut: number | undefined, length: number): { in: number; out: number } {
  const inward = Math.max(0, Math.min(FADE_MAX, fadeIn ?? 0));
  const outward = Math.max(0, Math.min(FADE_MAX, fadeOut ?? 0));
  const total = inward + outward;
  if (total <= length || total === 0) return { in: inward, out: outward };
  const share = length / total;
  return { in: inward * share, out: outward * share };
}

// dB down to a gain (12 → 0.25).
export const gainOfDb = (db: number): number => 10 ** (-Math.max(0, db) / 20);

// A sound that lowers what plays under it, on a clock: from at (its start), for length seconds.
export interface Duck {
  at: number;
  length: number;
  depth: number; // dB, 0 to DUCK_MAX
}
// How far one duck lowers at a time, in dB (0 to depth): down over the attack, held while the sound
// plays, back over the release. Linear in dB, which the ear hears as even.
export function duckDbAt(duck: Duck, time: number): number {
  const depth = Math.max(0, Math.min(DUCK_MAX, duck.depth));
  const t = time - duck.at;
  if (depth === 0 || t <= 0 || t >= duck.length + DUCK_RELEASE) return 0;
  if (t < DUCK_ATTACK) return depth * (t / DUCK_ATTACK);
  if (t <= duck.length) return depth;
  return depth * (1 - (t - duck.length) / DUCK_RELEASE);
}
// The gain under every duck at a time: the deepest wins (two sounds together lower no further).
export function duckGainAt(ducks: readonly Duck[], time: number): number {
  let db = 0;
  for (const duck of ducks) db = Math.max(db, duckDbAt(duck, time));
  return gainOfDb(db);
}
// The moments where the gain under ducks changes course, in order: a Web Audio gain follows it with
// ramps between them (linear in dB, exponential in gain, between two of them).
export function duckTimes(ducks: readonly Duck[]): number[] {
  const times = new Set<number>();
  for (const duck of ducks) for (const t of [duck.at, duck.at + Math.min(DUCK_ATTACK, duck.length), duck.at + duck.length, duck.at + duck.length + DUCK_RELEASE]) times.add(t);
  return [...times].sort((a, b) => a - b);
}
// Schedules the gain under ducks on an AudioParam from a time on (what was scheduled after it is
// replaced): the player's music bus, the editor's voice.
export function scheduleDucks(param: AudioParam, ducks: readonly Duck[], from: number): void {
  param.cancelScheduledValues(from);
  param.setValueAtTime(duckGainAt(ducks, from), from);
  for (const time of duckTimes(ducks)) {
    if (time <= from) continue;
    // A ramp in dB: exponential in gain (a gain is never 0 here, DUCK_MAX keeps it above).
    param.exponentialRampToValueAtTime(duckGainAt(ducks, time), time);
  }
}
