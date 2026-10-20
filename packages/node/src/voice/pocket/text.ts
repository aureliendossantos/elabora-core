import type { UnigramTokenizer } from './tokenizer.ts';

// Text as Pocket TTS expects it, ported from Kyutai's pocket_tts/models/text_chunking.py: characters
// absent from the training data replaced, a capital first letter and a final period, then the text
// cut into chunks of at most maxTokens tokens at sentence ends (and at commas inside a sentence too
// long), each chunk spoken from the voice's state on its own.

export interface TextRules {
  replaceCharacters: Readonly<Record<string, string>>;
  removeSemicolons: boolean;
  padWithSpacesForShortInputs: boolean;
}

const TERMINAL = '.!?…';
const WEAK = ',;:-–—';
const CLOSERS = '"\'”’)]»';

const stripEnd = (text: string, chars: string): string => {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
};

export function ensureTerminalPunctuation(text: string): string {
  const core = stripEnd(text, `${CLOSERS} `);
  const closers = text.slice(core.length).trim();
  if (!core || TERMINAL.includes(core[core.length - 1])) return text;
  if (WEAK.includes(core[core.length - 1])) return `${stripEnd(core, `${WEAK} `)}.${closers}`;
  return `${text}.`;
}

// The prompt of one chunk, and how many frames to let the model speak after it says it is done.
export function prepareText(input: string, rules: TextRules): { text: string; framesAfterEos: number } {
  let text = input.trim();
  const replace = Object.entries(rules.replaceCharacters);
  if (replace.length) {
    text = Array.from(text, (char) => rules.replaceCharacters[char] ?? char).join('').split(/\s+/u).filter(Boolean).join(' ');
    // A deleted quote leaves « "Hi?", she said » as « Hi?, she said »: keep the sentence mark only.
    text = text.replace(/([.!?…])\s*[,;:]/gu, '$1');
  }
  if (!text) throw new Error('Nothing to say: the text is empty.');
  text = text.replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('  ', ' ');
  if (rules.removeSemicolons) text = text.replaceAll(';', ',');
  const framesAfterEos = text.split(/\s+/u).filter(Boolean).length <= 4 ? 3 : 1;
  text = text[0].toUpperCase() + text.slice(1);
  text = ensureTerminalPunctuation(text);
  if (rules.padWithSpacesForShortInputs && text.split(/\s+/u).filter(Boolean).length < 5) text = ' '.repeat(8) + text;
  return { text, framesAfterEos };
}

function boundaries(tokens: readonly number[], boundary: ReadonlySet<number>, decimal?: UnigramTokenizer): number[] {
  const indices = [0];
  let previousWasBoundary = false;
  tokens.forEach((token, index) => {
    if (boundary.has(token)) { previousWasBoundary = true; return; }
    if (previousWasBoundary) {
      // "3.5": the period of a decimal number ends no sentence.
      const prefix = decimal?.decode(tokens.slice(0, index)) ?? '';
      const suffix = decimal?.decode(tokens.slice(index)) ?? '';
      const isDecimal = !!decimal && prefix.length >= 2 && prefix.endsWith('.') && /\d/u.test(prefix[prefix.length - 2]) && /^\d/u.test(suffix);
      if (!isDecimal) indices.push(index);
    }
    previousWasBoundary = false;
  });
  indices.push(tokens.length);
  return indices;
}

function segments(tokenizer: UnigramTokenizer, tokens: readonly number[], indices: readonly number[]): { count: number; text: string }[] {
  const out: { count: number; text: string }[] = [];
  for (let i = 0; i < indices.length - 1; i++) out.push({ count: indices[i + 1] - indices[i], text: tokenizer.decode(tokens.slice(indices[i], indices[i + 1])) });
  return out;
}

export function splitIntoChunks(tokenizer: UnigramTokenizer, input: string, rules: TextRules, maxTokens: number): string[] {
  const text = prepareText(input, rules).text.trim();
  const tokens = tokenizer.encode(text);
  const sentenceEnds = new Set(tokenizer.encode('.!...?').slice(1));
  const sentences = segments(tokenizer, tokens, boundaries(tokens, sentenceEnds, tokenizer));
  // A sentence too long is cut at its commas, semicolons and colons, else the model skips words.
  const fallback = new Set(tokenizer.encode(',;:').slice(1));
  const refined: { count: number; text: string }[] = [];
  for (const sentence of sentences) {
    if (sentence.count <= maxTokens) { refined.push(sentence); continue; }
    const sub = tokenizer.encode(sentence.text.trim());
    const parts = segments(tokenizer, sub, boundaries(sub, fallback));
    if (parts.length > 1) refined.push(...parts);
    else refined.push(sentence);
  }
  const chunks: string[] = [];
  let current = '';
  let count = 0;
  for (const part of refined) {
    if (!current) { current = part.text; count = part.count; continue; }
    if (count + part.count > maxTokens) { chunks.push(current.trim()); current = part.text; count = part.count; }
    else { current += ` ${part.text}`; count += part.count; }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}
