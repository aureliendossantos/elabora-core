import fs from 'node:fs';
import path from 'node:path';
import type { JournalEntry } from '@elabora/core/ops/types';

// Reads the journal (<data>/journal/<yyyy-mm>.jsonl) as it grows: only the bytes appended since the
// last read, whole lines only (a line being written is read next time). Entries are deduplicated
// by sequence number, so a month file rewritten by pruning (a new file under the same name) is
// read again from its start without repeating anything.

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

interface Position { offset: number; ino: number }

export class JournalTail {
  readonly dir: string;
  #positions = new Map<string, Position>();
  #lastSeq = 0;

  constructor(journalDir: string) {
    this.dir = journalDir;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  // The entries appended since the last read, in sequence order.
  async read(): Promise<JournalEntry[]> {
    const entries: JournalEntry[] = [];
    for (const name of await this.#months()) {
      const file = path.join(this.dir, name);
      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(file, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      try {
        const stat = await handle.stat();
        let position = this.#positions.get(name);
        if (!position || position.ino !== stat.ino || stat.size < position.offset) position = { offset: 0, ino: stat.ino };
        if (stat.size > position.offset) {
          const buffer = Buffer.alloc(stat.size - position.offset);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position.offset);
          const end = bytesRead > 0 ? buffer.lastIndexOf(0x0a, bytesRead - 1) : -1;
          if (end >= 0) {
            for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
              const entry = parseEntry(line);
              if (entry && entry.seq > this.#lastSeq) entries.push(entry);
            }
            position = { offset: position.offset + end + 1, ino: stat.ino };
          }
        }
        this.#positions.set(name, position);
      } finally {
        await handle.close();
      }
    }
    entries.sort((a, b) => a.seq - b.seq);
    const unique = entries.filter((entry, index) => index === 0 || entry.seq !== entries[index - 1].seq);
    if (unique.length) this.#lastSeq = unique[unique.length - 1].seq;
    return unique;
  }

  // Whether a month file grew or was replaced since the last read: cheap (file sizes only).
  async hasNew(): Promise<boolean> {
    for (const name of await this.#months()) {
      const position = this.#positions.get(name);
      const stat = await fs.promises.stat(path.join(this.dir, name)).catch(() => null);
      if (stat && (!position || position.ino !== stat.ino || stat.size !== position.offset)) return true;
    }
    return false;
  }

  // Forgets what was read: the next read returns the whole journal.
  reset(): void {
    this.#positions.clear();
    this.#lastSeq = 0;
  }

  async #months(): Promise<string[]> {
    try {
      return (await fs.promises.readdir(this.dir)).filter((name) => MONTH_FILE.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

// The same acceptance as the journal's own reader: a line cut short by a crash is skipped.
function parseEntry(line: string): JournalEntry | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as Partial<JournalEntry> | null;
    if (value && typeof value.seq === 'number' && typeof value.id === 'string' && typeof value.at === 'string' && (value.type === 'change' || value.type === 'undo' || value.type === 'mark')) {
      return value as JournalEntry;
    }
  } catch {
    // cut short
  }
  return undefined;
}
