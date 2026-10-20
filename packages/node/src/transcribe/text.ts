// A transcriber's tokens as a line's text and its words (docs/decisions.md D46). Parakeet's pieces
// start a word with a space and carry its punctuation and capitals; the text is them run together,
// without a space before a comma or a full stop (onnx-asr's rule), and in French with the space
// French puts before « ? », « ! », « : » and « ; ». Words are what lies between spaces, their
// punctuation left out, from the time of their first piece to the start of the next word.

export interface TimedPiece {
  piece: string;         // a leading space where a word starts
  time: number;          // seconds
  probability: number;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

export function textOfPieces(pieces: readonly TimedPiece[], language: string): string {
  let text = pieces.map((piece) => piece.piece).join('').replace(/\s+/g, ' ').trim();
  text = text.replace(/\s+([.,…)\]])/g, '$1');
  if (language.toLowerCase().split('-')[0] === 'fr') text = text.replace(/(\S)\s*([?!:;])(?=\s|$)/gu, (match, before: string, mark: string) => (/\d/.test(before) && mark === ':' ? match : `${before} ${mark}`));
  else text = text.replace(/\s+([?!:;])/g, '$1');
  return text;
}

export function wordsOfPieces(pieces: readonly TimedPiece[], duration: number): { text: string; start: number; end: number; score?: number }[] {
  const words: { text: string; start: number; probabilities: number[] }[] = [];
  for (const piece of pieces) {
    const starts = /^\s/.test(piece.piece) || !words.length;
    const letters = piece.piece.trim();
    if (!letters) continue;
    if (starts) words.push({ text: letters, start: piece.time, probabilities: [piece.probability] });
    else { words.at(-1)!.text += letters; words.at(-1)!.probabilities.push(piece.probability); }
  }
  const kept = words.map((word) => ({ ...word, text: word.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') })).filter((word) => word.text);
  return kept.map((word, i) => ({
    text: word.text, start: round(word.start),
    end: round(Math.max(word.start, i + 1 < kept.length ? kept[i + 1].start : duration)),
    score: round(word.probabilities.reduce((sum, p) => sum + p, 0) / word.probabilities.length)
  }));
}

// A transcription written with the apostrophes of the text it replaces: a line typed with « ’ »
// keeps them where the transcriber writes « ' » (Parakeet does), and the other way round; a text
// with both, or neither, leaves the transcription as it is.
export function withApostrophesOf(text: string, model: string): string {
  const curly = model.includes('\u2019');
  const straight = /[\p{L}]'[\p{L}]/u.test(model);
  if (curly && !straight) return text.replace(/(?<=\p{L})'(?=\p{L})/gu, '\u2019');
  if (straight && !curly) return text.replace(/(?<=\p{L})\u2019(?=\p{L})/gu, "'");
  return text;
}
