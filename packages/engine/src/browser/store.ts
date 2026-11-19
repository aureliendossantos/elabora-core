import type { Files, JournalEntry } from '@elabora/core/ops/types';
import type { CopyLink, CopyStore } from '@elabora/core/sync/copy';

// What a browser's copy of a project keeps (D103, D104): the store of the base's copy (its link, what
// the room confirmed, the team's media) and the copy's own journal. What it holds is read before the
// session opens; an entry of the journal is kept for good before anything shows it.
export interface BrowserStore extends CopyStore {
  readonly link: CopyLink;
  journal(): readonly JournalEntry[];
  append(entries: readonly JournalEntry[]): Promise<void>;
  // A medium's bytes, kept, or taken from the team's media and kept (null: not kept, and the project
  // cannot be reached).
  medium(hash: string): Promise<Uint8Array | null>;
}

// A copy kept in memory (tests, the conformance suite under Node, a module tried without an account):
// what a browser's storage holds, gone with the page.
export function memoryCopy({ link, confirmed, journal = [], media = new Map() }: { link: CopyLink; confirmed: Files; journal?: readonly JournalEntry[]; media?: ReadonlyMap<string, Uint8Array> }): BrowserStore & { readonly kept: { link: CopyLink; confirmed: Files; journal: JournalEntry[]; unlinked: boolean } } {
  const kept = { link: structuredClone(link), confirmed, journal: [...journal], unlinked: false };
  return {
    link: kept.link,
    kept,
    confirmed: () => kept.confirmed,
    save(copy, files) {
      kept.link = { ...kept.link, ...structuredClone(copy) };
      kept.confirmed = files;
    },
    unlink() { kept.unlinked = true; },
    journal: () => kept.journal,
    async append(entries) { kept.journal.push(...structuredClone(entries)); },
    medium: async (hash) => media.get(hash) ?? null,
    // No room to send media to, nor to read them from: what the copy has is all there is.
    sendMedia: async () => null,
    commitMedia: async () => {},
    fetchMedium: async () => {},
    membership: async () => 'unknown'
  };
}
