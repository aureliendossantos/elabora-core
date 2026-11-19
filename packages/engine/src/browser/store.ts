import type { Files, JournalEntry } from '@elabora/core/ops/types';
import type { CopyLink, CopyStore, MediumRef } from '@elabora/core/sync/copy';
import type { MediaFacts, MediaMap } from '@elabora/core/sync/media';
import { sha256 as coreSha256 } from '@elabora/core/util/sha256';

// What a browser's copy of a project keeps (D103, D104): the store of the base's copy (its link, what
// the room confirmed, the team's media) and the copy's own journal. What it holds is read before the
// session opens; an entry of the journal is kept for good before anything shows it.
export interface BrowserStore extends CopyStore {
  readonly link: CopyLink;
  journal(): readonly JournalEntry[];
  append(entries: readonly JournalEntry[]): Promise<void>;
  // A medium's bytes, kept, or taken from the team's media and kept (null: not kept, and the project
  // cannot be reached).
  medium(hash: string): Promise<Blob | null>;
  // A medium this copy made (an import, a line's audio): its bytes kept by hash, its facts with them
  // for the room (mediaFacts, D126). Gives its hash.
  keep(data: Blob | Uint8Array, facts?: MediaFacts): Promise<string>;
  // Bytes start to end (included) of a medium of `size`, without taking it whole: from what is kept,
  // else read by range from the team's media (C103); null when neither can give them.
  mediumPart?(hash: string, start: number, end: number): Promise<Blob | null>;
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
    medium: async (hash) => { const bytes = media.get(hash); return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null; },
    mediumPart: async (hash, start, end) => { const bytes = media.get(hash); return bytes ? new Blob([bytes.slice(start, end + 1) as Uint8Array<ArrayBuffer>]) : null; },
    async keep(data, made) {
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
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

// sha256:<hex> of bytes held (the core's Sha256, which also hashes what is read by slices).
export async function sha256(bytes: Uint8Array): Promise<string> {
  return `sha256:${coreSha256(bytes)}`;
}
