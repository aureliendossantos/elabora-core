import type { Files, JournalEntry } from '@elabora/core/ops/types';
import type { CopyLink, CopyStore, MediumRef } from '@elabora/core/sync/copy';
import type { MediaFacts, MediaMap } from '@elabora/core/sync/media';

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
  // A medium this copy made (an import, a line's audio): its bytes kept by hash, its facts with them
  // for the room (mediaFacts, D126). Gives its hash.
  keep(bytes: Uint8Array, facts?: MediaFacts): Promise<string>;
}

// The facts of the media a copy made, by hash, for its room (CopyStore.mediaFacts): only those of the
// very bytes, at their size.
export function madeFacts(): { set(hash: string, facts: MediaFacts): void; get(refs: readonly MediumRef[], size: (hash: string) => number | null): MediaMap<MediaFacts> } {
  const known = new Map<string, MediaFacts>();
  return {
    set: (hash, facts) => { known.set(hash, facts); },
    get: (refs, size) => Object.fromEntries(refs.flatMap((ref) => { const facts = known.get(ref.hash); return facts && (ref.size === undefined || size(ref.hash) === ref.size) ? [[ref.hash, facts]] : []; }))
  };
}

// A copy kept in memory (tests, the conformance suite under Node, a module tried without an account):
// what a browser's storage holds, gone with the page.
export function memoryCopy({ link, confirmed, journal = [], media: given = new Map() }: { link: CopyLink; confirmed: Files; journal?: readonly JournalEntry[]; media?: ReadonlyMap<string, Uint8Array> }): BrowserStore & { readonly kept: { link: CopyLink; confirmed: Files; journal: JournalEntry[]; unlinked: boolean } } {
  const kept = { link: structuredClone(link), confirmed, journal: [...journal], unlinked: false };
  const media = new Map(given);
  const facts = madeFacts();
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
    async keep(bytes, made) {
      const hash = await sha256(bytes);
      media.set(hash, bytes);
      if (made) facts.set(hash, made);
      return hash;
    },
    mediaFacts: async (refs) => facts.get(refs, (hash) => media.get(hash)?.byteLength ?? null),
    // No room to send media to, nor to read them from: what the copy has is all there is.
    sendMedia: async () => null,
    commitMedia: async () => {},
    fetchMedium: async () => {},
    membership: async () => 'unknown'
  };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
