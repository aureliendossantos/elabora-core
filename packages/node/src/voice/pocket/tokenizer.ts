import fs from 'node:fs';
import { UnigramTokenizer as Tokenizer } from '@elabora/core/voice/pocket/tokenizer';
import type { UnigramJson } from '@elabora/core/voice/pocket/tokenizer';

// The core's tokenizer of a Pocket TTS bundle (@elabora/core/voice/pocket/tokenizer), read from a file.
export class UnigramTokenizer extends Tokenizer {
  static fromFile(file: string): UnigramTokenizer {
    return new UnigramTokenizer(JSON.parse(fs.readFileSync(file, 'utf8')) as UnigramJson);
  }
}
