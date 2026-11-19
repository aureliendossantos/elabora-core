// SHA-256 (FIPS 180-4) without node:crypto, so the core runs in browsers and workers as well: in one
// call for what is small (canonical JSON, component files, text assets), or fed by pieces (Sha256),
// what WebCrypto's digest does not do, so that a browser hashes a file of hundreds of megabytes (a
// model, a video) as it reads it, never holding it whole. The same digests as node:crypto's and
// WebCrypto's (test/unit/sha256.test.ts).

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const encoder = new TextEncoder();

// Digest of a string (UTF-8) or of bytes, as 64 lowercase hex digits.
export function sha256(data: string | Uint8Array): string {
  return new Sha256().update(typeof data === 'string' ? encoder.encode(data) : data).hex();
}

export class Sha256 {
  readonly #state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  readonly #block = new Uint8Array(64);
  readonly #words = new Uint32Array(64);
  #filled = 0;
  #length = 0; // bytes, below 2^53

  update(bytes: Uint8Array): this {
    let at = 0;
    this.#length += bytes.length;
    if (this.#filled) {
      const take = Math.min(64 - this.#filled, bytes.length);
      this.#block.set(bytes.subarray(0, take), this.#filled);
      this.#filled += take;
      at = take;
      if (this.#filled < 64) return this;
      this.#compress(this.#block, 0);
      this.#filled = 0;
    }
    for (; at + 64 <= bytes.length; at += 64) this.#compress(bytes, at);
    if (at < bytes.length) { this.#block.set(bytes.subarray(at)); this.#filled = bytes.length - at; }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.#length * 8;
    const pad = new Uint8Array((this.#filled < 56 ? 56 : 120) - this.#filled + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(pad.length - 4, bits >>> 0);
    this.#length -= pad.length; // the padding is not the message
    this.update(pad);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.#state[i]);
    return out;
  }

  // 64 lowercase hex digits.
  hex(): string {
    return [...this.digest()].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  #compress(data: Uint8Array, offset: number): void {
    const w = this.#words;
    for (let i = 0; i < 16; i++) w[i] = (data[offset + i * 4] << 24) | (data[offset + i * 4 + 1] << 16) | (data[offset + i * 4 + 2] << 8) | data[offset + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const s = this.#state;
    let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    s[0] += a; s[1] += b; s[2] += c; s[3] += d; s[4] += e; s[5] += f; s[6] += g; s[7] += h;
  }
}

// A Blob hashed slice by slice, never read whole (onSlice sees each slice as it goes): 64 hex digits.
// A file's bytes as a browser's Blob gives them (the core has no DOM types).
export interface Sliced { readonly size: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } }

export async function sha256OfBlob(blob: Sliced, sliceBytes = 4 * 1024 * 1024, onSlice?: (bytes: Uint8Array) => void | Promise<void>): Promise<string> {
  const hash = new Sha256();
  for (let at = 0; at < blob.size; at += sliceBytes) {
    const bytes = new Uint8Array(await blob.slice(at, at + sliceBytes).arrayBuffer());
    hash.update(bytes);
    await onSlice?.(bytes);
  }
  return hash.hex();
}
