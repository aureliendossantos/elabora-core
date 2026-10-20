// The shapes of Elabora's hosting protocol (version 3) that the
// core's client reads and returns, and what it makes of review comments for authors and their AI
// (docs/decisions.md D43). No import, as build-types.ts: the app window's typecheck may name them
// without bringing Node modules.

export type Visibility = 'public' | 'private';

// What the space's index and the sharing previews say of a publication.
export interface PublicationMeta {
  title: string;
  description: string;
  languages: string[];
  image: string | null; // a file of the version, or null
  course: { id: string; version: string } | null;
}

export interface AnnouncedManifest {
  files: Record<string, { sha256: string; size: number }>;
  noindex: boolean;
  meta: PublicationMeta;
}

// A publication as GET /v1/spaces/<space>/publications lists it.
export interface CloudPublication {
  name: string;
  url: string | null; // null for a private publication: only a review serves it
  visibility: Visibility;
  version: string;
  committedAt: string;
  noindex: boolean;
  meta: PublicationMeta;
  files: number;
  bytes: number;
}

export interface CloudAccount {
  id: string;
  email: string;
  handle: string | null;
  displayName: string | null;
  language: string;
  state: string;
  space: { name: string; url: string } | null;
  createdAt?: string;
  updatedAt?: string;
  lastLoginAt?: string;
}

export interface AccountLimits {
  storageBytes: number;
  publicPublications: number;
  openReviews: number;
  indexing: boolean;
}

export interface AccountUsage {
  storageBytes: number;
  publicPublications: number;
  openReviews: number;
}

export type ReviewState = 'open' | 'read-only' | 'closed';

export interface ReviewVersion {
  number: number;
  version: string;
  title: string;
  languages: string[];
  addedAt: string;
  comments: number;
  open: number;
  content?: string | null; // the address of this version, only in the answers that hold the link; null once withdrawn
  withdrawn?: boolean; // the author took this version down: its comments stay, the module is not shown
  course?: { id: string; version: string } | null; // the course it was built from (protocol 6; null before)
}

export interface CloudReview {
  id: string;
  space: string;
  publication: string;
  title: string;
  state: ReviewState;
  languages: string[];
  latest: number;
  versions: ReviewVersion[];
  comments: { open: number; resolved: number };
  reviewers: number;
  rev: number;
  createdAt: string;
  updatedAt: string;
  linkCreatedAt?: string;
  note?: string | null; // the author's note to reviewers, plain text (protocol 6)
  invitedBy?: string | null; // the inviter's name the review page shows (protocol 6)
}

// A read-only key for the author's AI (protocol 6, D45): never the key itself.
export interface CloudAiKey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// What a comment points at (the anchor shared with the player's review bridge, D42, and the comments
// API). version is the publication's version (16 hex digits). Unknown fields come back as sent.
export interface CommentAnchor {
  version: string;
  language: string;
  screen: string; // the screen's permanent key (D4)
  block?: string;
  step?: number;
  layer?: string;
  time?: number;
  line?: string;
  word?: number | string; // the API counts words (an index), the bridge names them (D28)
  occurrence?: number;
  point?: { x: number; y: number };
  frame: { width: number; height: number };
  courseVersion?: string; // the course version the review page adds (protocol 4)
  said?: string; // the narration line's text and speaker, from the bridge (D42)
  speaker?: string;
  [field: string]: unknown;
}

export interface CloudComment {
  id: string;
  number: number | null; // a thread's pin; null for a reply
  parent: string | null;
  version: string;
  versionNumber: number;
  screen: string | null;
  anchor: CommentAnchor | null;
  text: string;
  by: { kind: 'reviewer' | 'author' | string; name: string; reviewer?: string };
  mine: boolean;
  state: 'open' | 'resolved' | null;
  resolvedAt: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  rev: number;
}

// GET …/reviews/<id>/comments: the review by its id (its counts are in GET …/reviews/<id>).
export interface CommentsAnswer {
  review: string;
  rev: number;
  comments: CloudComment[];
}

// ── What the core makes of comments: each placed in the course's sources ──

export interface ResolvedScreen {
  key: string; // the permanent key the comment names
  id: string | null; // the screen's id now (null: no screen has this key in elabora.lock.json any more)
  title: string | null;
  file: string | null; // screens/<id>.json
}

export interface ResolvedBlock {
  id: string;
  type: string | null; // null: the block is not in the screen now (renamed, moved or removed)
  path: string | null; // the block's JSON pointer in the screen file
  layer: string | null; // the layer holding it
}

export interface ResolvedLine {
  id: string;
  speaker: string | null;
  text: string | null; // null: the line is not in the screen's narration now
  word: { index: number | null; text: string | null; occurrence: number | null } | null;
}

export interface ResolvedPlace {
  language: string;
  translation: string | null; // translations/<lang>.xlf when the comment was written on a translation
  screen: ResolvedScreen;
  block: ResolvedBlock | null;
  step: { number: number; label: string | null } | null;
  layer: { id: string; title: string | null; found: boolean } | null;
  line: ResolvedLine | null;
  time: number | null;
  point: { x: number; y: number } | null;
  frame: { width: number; height: number } | null;
}

export interface ResolvedVersion {
  id: string; // the publication's version commented
  number: number; // its number in the review (v1, v2…)
  latest: number; // the review's latest version number
  course: string | null; // the course version it was built from (this computer's record, else the anchor's courseVersion)
  // A newer version was sent to the review since the comment's: the remark may be fixed already.
  newerInReview: boolean;
  // The screen's source file changed since that version was published from this computer; null when
  // this computer did not publish it (no record to compare with).
  screenChanged: boolean | null;
}

export interface ResolvedReply {
  id: string;
  by: { kind: string; name: string };
  text: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface ResolvedComment {
  id: string;
  number: number;
  state: 'open' | 'resolved';
  version: ResolvedVersion;
  place: ResolvedPlace | null; // null: the thread has no anchor (not expected from the review page)
  by: { kind: string; name: string };
  text: string;
  createdAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  deleted: boolean;
  replies: ResolvedReply[];
}

export interface ResolvedComments {
  review: { id: string; title: string; publication: string; state: ReviewState; latest: number; comments: { open: number; resolved: number } };
  course: { id: string | null; dir: string | null; version: string | null };
  rev: number; // give it as since next time to get only what changed
  since: number | null;
  comments: ResolvedComment[];
}

// The author's session as it is kept (D43): in the 0600 file of the local data by default, or in a
// store the app gives (setSessionStore: its safeStorage). Node-free, so that the app's renderer may
// name it.
export interface SessionRecord {
  format: 'elabora-session/1';
  api: string;
  token: string;
  session: string | null; // the session's id (ses_…), to tell it apart in the account's devices
  email: string;
  handle: string | null; // the account's space; null until chosen
  device: string;
  createdAt: string;
}

// Where the session is kept. read gives what was written (or null); write replaces it; remove forgets
// it and says whether there was one. Synchronous: the app's main process decrypts with safeStorage.
export interface SessionStore {
  read(): SessionRecord | null;
  write(record: SessionRecord): void;
  remove(): boolean;
}

// A signed-in device of the account (GET /v1/account/sessions): current is the session asking.
export interface AccountSession {
  id: string;
  device: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

// What an account's erasure took (DELETE /v1/account): everything of it.
export interface AccountErased {
  deleted: true;
  account: string;
  space: string | null;
  objectsDeleted: number;
  reviewsDeleted: number;
  commentsDeleted: number;
}

// A check the build let through when publishing for review (a preview, D43): an error of
// the guardrails or of the delivery checklist, which stops the web and the package but not reviewers.
export interface PublishCheck {
  code: string;
  message: string;
  rule: string | null;
  target: string | null;
}
