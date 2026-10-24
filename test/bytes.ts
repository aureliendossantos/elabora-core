import { seededRandom } from './mutations.ts';

// Reproducible high-entropy media/archive fixtures: unlike repeated bytes, compression cannot
// turn a large-file or streaming regression into a tiny-input test. Use another seed to edit it.
export function bytes(length: number, seed = 1): Buffer {
  const random = seededRandom(seed), value = Buffer.alloc(length);
  for (let i = 0; i < length; i++) value[i] = Math.floor(random() * 256);
  return value;
}
