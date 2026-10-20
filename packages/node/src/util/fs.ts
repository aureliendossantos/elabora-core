import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJSON, stringifyJSON } from '@elabora/core/util/json';

// File helpers of the Node services. The core parses and formats; these read and write.

// Reads JSON and reports parse errors with line and column, which agents can act on.
export function readJSONFile(file: string): { value: unknown; text: string; error?: undefined } | { value?: undefined; text: string; error: string } {
  const text = fs.readFileSync(file, 'utf8');
  const r = parseJSON(text);
  return r.error === undefined ? { value: r.value, text } : { error: r.error, text };
}

// Written to a temporary file then renamed, so readers never see half a file.
export function writeFileAtomic(file: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function writeJSONFile(file: string, value: unknown): void {
  writeFileAtomic(file, stringifyJSON(value));
}

// SHA-256 with node:crypto: same digest as the core's, much faster on packages and media.
export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
