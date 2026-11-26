// CTC forced alignment (Viterbi; docs/decisions.md D27), the semantics of torchaudio's
// functional.forced_align: the targets are spoken in order, each on one or more consecutive frames,
// with blanks allowed before, between and after them; a blank is required between two equal
// consecutive targets. Emissions are log probabilities, frames × vocabulary, row-major.
//
// A target equal to STAR is a wildcard (torchaudio's multilingual tutorial, "<star>" token): its
// emission is starLogProb (default 0, probability 1) on every frame, so it absorbs whatever is said
// there (a word none of whose characters the vocabulary has).

export const STAR = -1;

export interface Emissions {
  logProbs: Float32Array;   // frames × vocab, log softmax
  frames: number;
  vocab: number;
}

export interface TokenSpan {
  token: number;            // vocabulary id, or STAR
  start: number;            // first frame
  end: number;              // frame after the last
  score: number;            // mean probability of the token over its frames
}

export interface AlignmentPath {
  spans: TokenSpan[];       // one per target, in order
  labels: Int32Array;       // per frame: the target index it emits, or -1 for a blank
  logLikelihood: number;
}

export class AlignmentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function forcedAlign(emissions: Emissions, targets: ArrayLike<number>, blank: number, starLogProb = 0): AlignmentPath {
  const { logProbs, frames: T, vocab: V } = emissions;
  const L = targets.length;
  if (L === 0) throw new AlignmentError('E_ALIGN_EMPTY', 'Nothing to align: the text has no alignable character.');
  let repeats = 0;
  for (let i = 1; i < L; i++) if (targets[i] === targets[i - 1]) repeats++;
  if (T < L + repeats) throw new AlignmentError('E_ALIGN_SHORT', `The audio is too short for the text (${T} frames for ${L + repeats} tokens).`);

  const S = 2 * L + 1;
  const emit = (t: number, s: number): number => {
    if ((s & 1) === 0) return logProbs[t * V + blank];
    const token = targets[(s - 1) >> 1];
    return token === STAR ? starLogProb : logProbs[t * V + token];
  };
  // Back pointers: how many states the path moved at frame t to reach s (0, 1 or 2).
  const moves = new Uint8Array(T * S);
  let prev = new Float64Array(S).fill(-Infinity);
  let next = new Float64Array(S);
  prev[0] = emit(0, 0);
  if (S > 1) prev[1] = emit(0, 1);
  for (let t = 1; t < T; t++) {
    // A state can only be reached if the rest of the targets still fit in the frames left.
    const sMin = Math.max(0, S - 2 * (T - t) - 1);
    const sMax = Math.min(S - 1, 2 * t + 1);
    next.fill(-Infinity);
    const row = t * S;
    for (let s = sMin; s <= sMax; s++) {
      let best = prev[s];
      let move = 0;
      if (s >= 1 && prev[s - 1] > best) { best = prev[s - 1]; move = 1; }
      if (s >= 2 && (s & 1) === 1 && targets[(s - 1) >> 1] !== targets[(s - 3) >> 1] && prev[s - 2] > best) { best = prev[s - 2]; move = 2; }
      if (best === -Infinity) continue;
      next[s] = best + emit(t, s);
      moves[row + s] = move;
    }
    const swap = prev; prev = next; next = swap;
  }
  let s = S - 1;
  if (S > 1 && prev[S - 2] > prev[S - 1]) s = S - 2;
  const logLikelihood = prev[s];
  if (logLikelihood === -Infinity) throw new AlignmentError('E_ALIGN_FAILED', 'No alignment of the text with the audio.');

  const states = new Int32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    states[t] = s;
    if (t > 0) s -= moves[t * S + s];
  }
  const labels = new Int32Array(T);
  const spans: TokenSpan[] = [];
  for (let t = 0; t < T; t++) {
    const st = states[t];
    if ((st & 1) === 0) { labels[t] = -1; continue; }
    const index = (st - 1) >> 1;
    labels[t] = index;
    const p = Math.exp(emit(t, st));
    const last = spans[index];
    if (last) { last.end = t + 1; last.score += p; } else spans[index] = { token: targets[index], start: t, end: t + 1, score: p };
  }
  for (const span of spans) span.score /= span.end - span.start;
  return { spans, labels, logLikelihood };
}

// Log softmax of logits in place, frames × vocab.
export function logSoftmax(logits: Float32Array, frames: number, vocab: number): Float32Array {
  for (let t = 0; t < frames; t++) {
    const o = t * vocab;
    let max = -Infinity;
    for (let v = 0; v < vocab; v++) if (logits[o + v] > max) max = logits[o + v];
    let sum = 0;
    for (let v = 0; v < vocab; v++) sum += Math.exp(logits[o + v] - max);
    const log = max + Math.log(sum);
    for (let v = 0; v < vocab; v++) logits[o + v] -= log;
  }
  return logits;
}
