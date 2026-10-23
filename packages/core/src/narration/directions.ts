// Stage directions in a narration line (docs/decisions.md D29): how to say it, written in square
// brackets where the delivery changes, in the line's language, as a play's didascalies are:
//   « [chuchote] Personne ne l'avait vu venir… [un temps] et pourtant, tout était là. »
// A voice that plays them (ElevenLabs' expressive models) is given them as they are; a voice that
// cannot (Pocket TTS) is given the line without them. They are never words: captions, the
// transcript, word anchors and the word aligner skip them, and translators keep or adapt them
// (XLIFF <mrk type="elabora:direction">). A bracket that does not close on the same line, or that
// holds more than 80 characters, is text.

export interface Direction {
  // What is between the brackets, trimmed (« chuchote »).
  text: string;
  // Offsets of the whole direction, brackets included, in the line's text (end excluded).
  start: number;
  end: number;
}

export const DIRECTION_MAX = 80;
const DIRECTION = /\[([^[\]\n]{1,80})\]/g;

export function lineDirections(text: string): Direction[] {
  const out: Direction[] = [];
  for (const match of text.matchAll(DIRECTION)) {
    const inner = match[1].trim();
    if (inner) out.push({ text: inner, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return out;
}

export const hasDirections = (text: string): boolean => lineDirections(text).length > 0;

// The text with each direction replaced by as many spaces: what words are read from, so that their
// offsets stay those of the line's text (the editor underlines them in place).
export function maskDirections(text: string): string {
  const directions = lineDirections(text);
  if (!directions.length) return text;
  let out = '';
  let at = 0;
  for (const direction of directions) {
    out += text.slice(at, direction.start) + ' '.repeat(direction.end - direction.start);
    at = direction.end;
  }
  return out + text.slice(at);
}

// The text without its directions, as learners read it (captions, transcript): a direction and
// the space before it go (« mot [un temps], suite » reads « mot, suite »). The rest of the text keeps
// its own typography: the space a French line puts before : ; ! ? stays (« étage : ni »).
export function withoutDirections(text: string): string {
  if (!hasDirections(text)) return text;
  return text.replace(/[ \t]*\[([^[\]\n]{1,80})\]([ \t]*)/g, (whole: string, inner: string, after: string, offset: number, all: string) => {
    if (!inner.trim()) return whole;
    const next = all[offset + whole.length] ?? '';
    // Nothing at either end of the line or before a comma, a full stop or a closing bracket; one
    // space where the direction stood between words, and only if one followed it (« mot [rit]: »).
    if (!all.slice(0, offset).trim() || next === '' || /[,.…)\]]/.test(next)) return '';
    return after ? ' ' : '';
  }).replace(/[ \t]{2,}/g, ' ').replace(/^\s+/, '').replace(/\s+$/, '');
}

// Applies fn to the parts of the text outside directions (pronunciations never touch a direction).
export function outsideDirections(text: string, fn: (part: string) => string): string {
  const directions = lineDirections(text);
  if (!directions.length) return fn(text);
  let out = '';
  let at = 0;
  for (const direction of directions) {
    out += fn(text.slice(at, direction.start)) + text.slice(direction.start, direction.end);
    at = direction.end;
  }
  return out + fn(text.slice(at));
}

// Whether a speaker's voice plays stage directions: ElevenLabs' expressive models (Eleven v3, v4
// and their variants; v4 when the settings name none). Others are given the line without them.
export function playsDirections(voice: { provider?: unknown; settings?: unknown } | null | undefined): boolean {
  if (voice?.provider !== 'elevenlabs') return false;
  const model = voice.settings && typeof voice.settings === 'object' ? (voice.settings as Record<string, unknown>).model : undefined;
  return model === undefined || (typeof model === 'string' && /^eleven_v[34](?:_|$)/.test(model));
}
