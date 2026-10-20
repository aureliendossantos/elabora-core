import path from 'node:path';
import { readLock } from '@elabora/core/compile/state-model';
import { screenBlocks } from '@elabora/core/project/load';
import { narrationWords, normalizeWord, findPhrase } from '@elabora/core/narration/words';
import type { Project, ScreenEntry } from '@elabora/core/project/model';
import { loadProjectFromDir } from '../project-reader.ts';
import { CloudError, cloudUrl, isRecord } from './client.ts';
import { connect } from './account.ts';
import { courseReviews, fetchComments, fetchReview, isReviewId } from './reviews.ts';
import type { CommentsQuery } from './reviews.ts';
import { findPublishedVersion, screenHashes } from './records.ts';
import type { CloudComment, CloudReview, CommentAnchor, CommentsAnswer, ResolvedComment, ResolvedComments, ResolvedPlace, ResolvedReply } from './types.ts';

// Review comments placed in the course's sources (docs/decisions.md D43): a reviewer's anchor names a
// screen by its permanent key (D4), a block by its id, a step, a layer, a narration line and a word
// (D28); the author's AI needs the file to open, the block's pointer in it, the line's text, and
// whether the screen changed since the version commented. Nothing is guessed: what the sources no
// longer have is said (an id null, a type null).

interface CourseView {
  dir: string;
  project: Project;
  byKey: Map<string, string>; // permanent key → screen id
  hashes: Record<string, string>;
}

function courseView(dir: string): CourseView {
  const project = loadProjectFromDir(dir);
  const byKey = new Map<string, string>();
  for (const [name, key] of Object.entries(readLock(project).keys)) if (name.startsWith('screen:')) byKey.set(key, name.slice('screen:'.length));
  return { dir: path.resolve(dir), project, byKey, hashes: screenHashes(project) };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length ? value : null);

function placeOf(anchor: CommentAnchor, view: CourseView | null): ResolvedPlace {
  const courseLanguage = view?.project.course?.language;
  const onTranslation = !!courseLanguage && anchor.language !== courseLanguage && !anchor.language.startsWith(`${courseLanguage}-`);
  const translationFile = onTranslation ? `translations/${anchor.language}.xlf` : null;
  // The screen by its key, else by an id (a page that named it so).
  const id = view ? (view.byKey.get(anchor.screen) ?? (view.project.screens.has(anchor.screen) ? anchor.screen : null)) : null;
  const entry: ScreenEntry | undefined = id ? view?.project.screens.get(id) : undefined;
  const screen = entry?.data;
  const place: ResolvedPlace = {
    language: anchor.language,
    translation: translationFile,
    screen: { key: anchor.screen, id: entry ? id : null, title: text(screen?.title), file: entry?.file ?? null },
    block: null, step: null, layer: null, line: null,
    time: typeof anchor.time === 'number' ? anchor.time : null,
    point: isRecord(anchor.point) && typeof anchor.point.x === 'number' && typeof anchor.point.y === 'number' ? { x: anchor.point.x, y: anchor.point.y } : null,
    frame: isRecord(anchor.frame) && typeof anchor.frame.width === 'number' && typeof anchor.frame.height === 'number' ? { width: anchor.frame.width, height: anchor.frame.height } : null
  };
  if (typeof anchor.block === 'string') {
    const found = screen ? [...screenBlocks(screen, entry?.file)].find((location) => location.block.id === anchor.block) : undefined;
    place.block = { id: anchor.block, type: found ? text(found.block.type) : null, path: found?.path ?? null, layer: found?.layer ? text(found.layer.id) : null };
  }
  if (typeof anchor.step === 'number') {
    const steps = isRecord(screen) && isRecord((screen as Record<string, unknown>).steps) ? (screen as Record<string, unknown>).steps as Record<string, unknown> : {};
    const step = steps[String(anchor.step)];
    place.step = { number: anchor.step, label: isRecord(step) ? text(step.label) : null };
  }
  if (typeof anchor.layer === 'string') {
    const layer = (screen?.layers ?? []).find((candidate) => isRecord(candidate) && candidate.id === anchor.layer);
    place.layer = { id: anchor.layer, title: layer ? text(layer.title) : null, found: !!layer };
  }
  if (typeof anchor.line === 'string') {
    const narration = isRecord(screen) ? (screen as Record<string, unknown>).narration : undefined;
    const lines = isRecord(narration) && Array.isArray(narration.lines) ? narration.lines : [];
    const line = lines.find((candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.id === anchor.line);
    const lineText = line ? text(line.text) : null;
    place.line = { id: anchor.line, speaker: line ? text(line.speaker) : null, text: lineText, word: anchor.word === undefined ? null : wordOf(anchor, onTranslation ? null : lineText, courseLanguage) };
  }
  return place;
}

// The word commented: the API counts words from 0 (an index), the review bridge names them with
// their occurrence; both are given back when the line (in the course language) still says it.
function wordOf(anchor: CommentAnchor, lineText: string | null, language: string | undefined): NonNullable<ResolvedPlace['line']>['word'] {
  const words = lineText ? narrationWords(lineText, language) : [];
  if (typeof anchor.word === 'number') {
    const word = words[anchor.word];
    if (!word) return { index: anchor.word, text: null, occurrence: null };
    const same = normalizeWord(word.text);
    return { index: anchor.word, text: word.text, occurrence: words.slice(0, anchor.word + 1).filter((w) => normalizeWord(w.text) === same).length };
  }
  if (typeof anchor.word === 'string') {
    const occurrence = typeof anchor.occurrence === 'number' && anchor.occurrence > 1 ? anchor.occurrence : 1;
    const found = words.length ? findPhrase(words, anchor.word, { occurrence, language }) : null;
    return { index: found ? found.index : null, text: anchor.word, occurrence };
  }
  return null;
}

const byOf = (comment: CloudComment) => ({ kind: comment.by?.kind ?? 'reviewer', name: comment.by?.name ?? '' });

const replyOf = (comment: CloudComment): ResolvedReply => ({ id: comment.id, by: byOf(comment), text: comment.text, createdAt: comment.createdAt, editedAt: comment.editedAt, deleted: comment.deleted });

export interface ResolveOptions {
  courseDir?: string | null; // the course the review shows; null: comments without their sources
  api?: string;
  space?: string;
  since?: number | null;
  // Every thread of the review, when answer holds only what changed since a rev: replies whose thread
  // did not change are shown under it.
  threads?: readonly CloudComment[];
}

// answer: what GET …/comments gave; review: the review (GET …/reviews/<id>), for its publication,
// latest version and counts.
export function resolveComments(answer: CommentsAnswer, review: CloudReview, { courseDir = null, api = cloudUrl(), space, since = null, threads = [] }: ResolveOptions = {}): ResolvedComments {
  const view = courseDir ? courseView(courseDir) : null;
  const spaceName = space ?? review.space;
  const changed = new Set(answer.comments.map((comment) => comment.id));
  const all = new Map<string, CloudComment>();
  for (const thread of threads) if (thread.parent === null) all.set(thread.id, thread);
  for (const comment of answer.comments) all.set(comment.id, comment);
  const roots = [...all.values()].filter((comment) => comment.parent === null && (changed.has(comment.id) || answer.comments.some((c) => c.parent === comment.id)));
  const replies = answer.comments.filter((comment) => comment.parent !== null);
  const resolved: ResolvedComment[] = [];
  for (const thread of roots.sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
    const own = replies.filter((reply) => reply.parent === thread.id);
    // A deleted thread is shown only while it has replies (« Commentaire supprimé »).
    if (thread.deleted && !own.some((reply) => !reply.deleted) && !(since !== null && changed.has(thread.id))) continue;
    const anchor = isRecord(thread.anchor) ? thread.anchor as CommentAnchor : null;
    const place = anchor ? placeOf(anchor, view) : null;
    const published = view ? findPublishedVersion(view.dir, api, spaceName, review.publication, thread.version) : null;
    const key = anchor?.screen;
    const screenChanged = published && key !== undefined && published.screens[key] !== undefined
      ? (view?.hashes[key] ?? null) !== published.screens[key]
      : null;
    resolved.push({
      id: thread.id,
      number: thread.number ?? 0,
      state: thread.state === 'resolved' ? 'resolved' : 'open',
      // The course version from the record, else from the anchor (the review page adds courseVersion).
      version: { id: thread.version, number: thread.versionNumber, latest: review.latest, course: published?.course ?? (typeof anchor?.courseVersion === 'string' ? anchor.courseVersion : null), newerInReview: thread.versionNumber < review.latest, screenChanged },
      place,
      by: byOf(thread),
      text: thread.text,
      createdAt: thread.createdAt,
      editedAt: thread.editedAt,
      resolvedAt: thread.resolvedAt,
      deleted: thread.deleted,
      replies: own.map(replyOf)
    });
  }
  const course = view?.project.course;
  return {
    review: { id: review.id, title: review.title, publication: review.publication, state: review.state, latest: review.latest, comments: review.comments },
    course: { id: course?.id ?? null, dir: view?.dir ?? null, version: course?.version ?? null },
    rev: answer.rev,
    since,
    comments: resolved
  };
}

export interface ReviewCommentsOptions extends CommentsQuery {
  review?: string; // a review id; default: the course's reviews still open or read-only
  courseDir?: string | null;
  api?: string;
}

// The comments of a course's reviews (or of one), each placed in the course's sources.
export async function reviewComments({ review, courseDir = null, since, screen, state, api = cloudUrl() }: ReviewCommentsOptions): Promise<ResolvedComments[]> {
  const connection = await connect(api, { readOnly: true });
  let ids: string[];
  if (review) {
    if (!isReviewId(review)) throw new CloudError(0, 'E_CLOUD_REVIEW_ID', `${JSON.stringify(review)} is not a review id (rv_ and 20 hex digits, as elabora review list gives them).`);
    ids = [review];
  } else {
    const courseId = courseDir ? loadProjectFromDir(courseDir).course?.id : undefined;
    if (!courseId) throw new CloudError(0, 'E_CLOUD_NOT_A_COURSE', 'Name a review (rv_…), or give the course folder whose reviews to read.');
    const { reviews } = await courseReviews(connection, courseId);
    ids = reviews.filter((r: CloudReview) => r.state !== 'closed').map((r) => r.id);
  }
  // A screen filter by id: the API filters by permanent key.
  let screenKey = screen;
  if (screen && courseDir) {
    const key = readLock(loadProjectFromDir(courseDir)).keys[`screen:${screen}`];
    if (key !== undefined) screenKey = key;
  }
  const results: ResolvedComments[] = [];
  for (const id of ids) {
    const query = { ...(since !== undefined ? { since } : {}), ...(screenKey ? { screen: screenKey } : {}), ...(state ? { state } : {}) };
    const [target, answer] = await Promise.all([fetchReview(connection, id), fetchComments(connection, id, query)]);
    // Replies since a rev whose thread did not change: their threads, from the whole list.
    const orphans = since !== undefined && answer.comments.some((c) => c.parent !== null && !answer.comments.some((t) => t.id === c.parent));
    const threads = orphans ? (await fetchComments(connection, id, {})).comments.filter((c) => c.parent === null) : [];
    results.push(resolveComments(answer, target, { courseDir, api, space: connection.space, since: since ?? null, threads }));
  }
  return results;
}
