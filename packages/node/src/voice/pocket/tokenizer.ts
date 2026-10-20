import fs from 'node:fs';

// The tokenizer of a Pocket TTS bundle: a SentencePiece Unigram model in the Hugging Face
// tokenizer.json format (Kyutai's pocket_tts config: tokenizer "tokenizers"), read without the
// tokenizers library. Same pieces as the library: "▁" prepended, spaces made "▁" and split before
// each "▁" (Metaspace, prepend_scheme always, split), the best segmentation of each word by the
// pieces' log probabilities (Viterbi), characters no piece covers as their UTF-8 bytes
// (<0x41>, byte_fallback). Decoding undoes it.

const SPACE = '▁';

interface UnigramJson {
  model: { type: string; vocab: [string, number][]; unk_id: number | null; byte_fallback?: boolean };
}

interface TrieNode {
  next: Map<string, TrieNode>;
  id: number;
}

export class UnigramTokenizer {
  readonly pieces: string[];
  private readonly scores: Float64Array;
  private readonly root: TrieNode = { next: new Map(), id: -1 };
  private readonly unkId: number;
  private readonly unkScore: number;
  private readonly bytes = new Int32Array(256).fill(-1);

  constructor(json: UnigramJson) {
    if (json.model.type !== 'Unigram') throw new Error(`Unsupported tokenizer model ${json.model.type} (Unigram expected).`);
    this.pieces = json.model.vocab.map(([piece]) => piece);
    this.scores = Float64Array.from(json.model.vocab, ([, score]) => score);
    this.unkId = json.model.unk_id ?? 0;
    let min = Infinity;
    for (const score of this.scores) min = Math.min(min, score);
    // tokenizers' Unigram gives an unknown character the lowest score minus 10.
    this.unkScore = min - 10;
    this.pieces.forEach((piece, id) => {
      const byte = /^<0x([0-9A-F]{2})>$/.exec(piece);
      if (byte && json.model.byte_fallback) this.bytes[parseInt(byte[1], 16)] = id;
      if (id === this.unkId || byte) return;
      let node = this.root;
      for (const char of piece) {
        let child = node.next.get(char);
        if (!child) { child = { next: new Map(), id: -1 }; node.next.set(char, child); }
        node = child;
      }
      node.id = id;
    });
  }

  static fromFile(file: string): UnigramTokenizer {
    return new UnigramTokenizer(JSON.parse(fs.readFileSync(file, 'utf8')) as UnigramJson);
  }

  encode(text: string): number[] {
    const ids: number[] = [];
    if (!text) return ids;
    const words =(SPACE + text.replaceAll(' ', SPACE)).split(new RegExp(`(?=${SPACE})`, 'u')).filter((word) => word.length);
    for (const word of words) this.encodeWord(word, ids);
    return ids;
  }

  // Viterbi over the characters of one word: best[i] is the best score of the first i characters.
  private encodeWord(word: string, ids: number[]): void {
    const chars = Array.from(word);
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    const piece = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let start = 0; start < n; start++) {
      if (best[start] === -Infinity) continue;
      let node: TrieNode | undefined = this.root;
      let matched = false;
      for (let end = start; end < n && node; end++) {
        node = node.next.get(chars[end]);
        if (node && node.id >= 0) {
          matched ||= end === start;
          const score = best[start] + this.scores[node.id];
          if (score > best[end + 1]) { best[end + 1] = score; from[end + 1] = start; piece[end + 1] = node.id; }
        }
      }
      if (!matched) {
        const score = best[start] + this.unkScore;
        if (score > best[start + 1]) { best[start + 1] = score; from[start + 1] = start; piece[start + 1] = this.unkId; }
      }
    }
    const reversed: { id: number; start: number; end: number }[] = [];
    for (let end = n; end > 0; end = from[end]) reversed.push({ id: piece[end], start: from[end], end });
    // Consecutive unknown characters are one unknown piece, then their bytes when the vocabulary has them.
    const tokens = reversed.reverse();
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.id !== this.unkId) { ids.push(token.id); continue; }
      let end = token.end;
      while (i + 1 < tokens.length && tokens[i + 1].id === this.unkId) end = tokens[++i].end;
      const bytes = new TextEncoder().encode(chars.slice(token.start, end).join(''));
      if (bytes.every((byte) => this.bytes[byte] >= 0)) for (const byte of bytes) ids.push(this.bytes[byte]);
      else ids.push(this.unkId);
    }
  }

  decode(ids: readonly number[]): string {
    const out: number[] = [];
    const encoder = new TextEncoder();
    for (const id of ids) {
      const piece = this.pieces[id] ?? '';
      const byte = /^<0x([0-9A-F]{2})>$/.exec(piece);
      if (byte) out.push(parseInt(byte[1], 16));
      else for (const b of encoder.encode(piece)) out.push(b);
    }
    const text = new TextDecoder().decode(Uint8Array.from(out)).replaceAll(SPACE, ' ');
    return text.startsWith(' ') ? text.slice(1) : text;
  }
}
