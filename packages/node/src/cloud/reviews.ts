import { CloudError, cloudUrl, segment } from './client.ts';
import { connect, guard } from './account.ts';
import type { Connection } from './account.ts';
import type { CloudComment, CloudPublication, CloudReview, CommentsAnswer, ReviewState } from './types.ts';

// The author's side of the review (protocol « The review »): a review shows a private publication's
// versions to whoever holds its secret link; reviewers comment without an account; the author lists,
// answers, resolves and reopens their comments. The link is in the answer that creates or
// regenerates it, never again (the API keeps only its hash).

const REVIEW_ID = /^rv_[0-9a-f]{20}$/;
export const isReviewId = (id: string): boolean => REVIEW_ID.test(id);

function reviewPath(connection: Connection, id?: string): string {
  if (id !== undefined && !isReviewId(id)) throw new CloudError(0, 'E_CLOUD_REVIEW_ID', `${JSON.stringify(id)} is not a review id (rv_ and 20 hex digits, as elabora review list gives them).`);
  return `/v1/spaces/${segment(connection.space)}/reviews${id ? `/${id}` : ''}`;
}

const call = <T>(connection: Connection, method: string, path: string, json?: unknown): Promise<T> =>
  guard(connection.credential, () => connection.client.request<T>(method, path, json === undefined ? {} : { json }));

export interface ReviewWithLink { review: CloudReview; link: string }

// A review of a private publication (its current version unless one is named). note: what the
// review page's welcome says to reviewers, under « <the author> vous invite à relire ce module ».
export async function createReview(publication: string, { version, title, note, api = cloudUrl() }: { version?: string; title?: string; note?: string; api?: string } = {}): Promise<ReviewWithLink> {
  const connection = await connect(api);
  return call(connection, 'POST', reviewPath(connection), { publication, version: version ?? null, title: title ?? null, ...(note !== undefined ? { note } : {}) });
}

// The note of a review, changed or cleared (null).
export async function setReviewNote(id: string, note: string | null, api: string = cloudUrl()): Promise<CloudReview> {
  const connection = await connect(api);
  return (await call<{ review: CloudReview }>(connection, 'PATCH', reviewPath(connection, id), { note })).review;
}

export async function listReviews({ publication, api = cloudUrl() }: { publication?: string; api?: string } = {}): Promise<{ space: string; reviews: CloudReview[] }> {
  const connection = await connect(api, { readOnly: true });
  const { reviews } = await call<{ reviews: CloudReview[] }>(connection, 'GET', `${reviewPath(connection)}${publication ? `?publication=${encodeURIComponent(publication)}` : ''}`);
  return { space: connection.space, reviews };
}

export async function getReview(id: string, api: string = cloudUrl()): Promise<{ review: CloudReview; reviewers: { id: string; name: string; createdAt: string }[] }> {
  const connection = await connect(api, { readOnly: true });
  return call(connection, 'GET', reviewPath(connection, id));
}

// A new link and capability: the old link stops at once, reviewers keep their names.
export async function regenerateLink(id: string, api: string = cloudUrl()): Promise<ReviewWithLink> {
  const connection = await connect(api);
  return call(connection, 'POST', `${reviewPath(connection, id)}/link`);
}

// closed: nothing is shown any more; read-only: shown, no new comment; open: back under the same link.
export async function setReviewState(id: string, state: ReviewState, api: string = cloudUrl()): Promise<CloudReview> {
  const connection = await connect(api);
  return (await call<{ review: CloudReview }>(connection, 'PATCH', reviewPath(connection, id), { state })).review;
}

// A review's title, as reviewers see it in the review page's bar.
export async function renameReview(id: string, title: string, api: string = cloudUrl()): Promise<CloudReview> {
  const connection = await connect(api);
  return (await call<{ review: CloudReview }>(connection, 'PATCH', reviewPath(connection, id), { title })).review;
}

export async function addReviewVersion(id: string, { version, api = cloudUrl() }: { version?: string; api?: string } = {}): Promise<{ added: boolean; review: CloudReview }> {
  const connection = await connect(api);
  return call(connection, 'POST', `${reviewPath(connection, id)}/versions`, { version: version ?? null });
}

// The review, its reviewers and comments go; its private publication too when no other review shows it
// (content: the unpublish answer, else null). review: the review as it was, to say what went.
export async function deleteReview(id: string, api: string = cloudUrl()): Promise<{ deleted: boolean; review: CloudReview; commentsDeleted: number; content: unknown }> {
  const connection = await connect(api);
  const { review } = await call<{ review: CloudReview }>(connection, 'GET', reviewPath(connection, id));
  const answer = await call<{ deleted: boolean; commentsDeleted: number; content: unknown }>(connection, 'DELETE', reviewPath(connection, id));
  return { deleted: answer.deleted, review, commentsDeleted: answer.commentsDeleted, content: answer.content };
}

export interface CommentsQuery { since?: number; screen?: string; state?: 'open' | 'resolved' }

export async function listComments(id: string, query: CommentsQuery = {}, api: string = cloudUrl()): Promise<CommentsAnswer & { space: string }> {
  const connection = await connect(api, { readOnly: true });
  return { ...(await fetchComments(connection, id, query)), space: connection.space };
}

export function fetchReview(connection: Connection, id: string): Promise<CloudReview> {
  return call<{ review: CloudReview }>(connection, 'GET', reviewPath(connection, id)).then((answer) => answer.review);
}

export function fetchComments(connection: Connection, id: string, { since, screen, state }: CommentsQuery = {}): Promise<CommentsAnswer> {
  const search = new URLSearchParams();
  if (since !== undefined) search.set('since', String(since));
  if (screen !== undefined) search.set('screen', screen);
  if (state !== undefined) search.set('state', state);
  const query = search.size ? `?${search}` : '';
  return call(connection, 'GET', `${reviewPath(connection, id)}/comments${query}`);
}

// A comment by its id (cm_…) or its thread's number in the review (4, #4).
async function commentId(connection: Connection, review: string, comment: string): Promise<string> {
  if (/^cm_[0-9a-z]+$/i.test(comment)) return comment;
  const number = Number(comment.replace(/^#/, ''));
  if (!Number.isInteger(number) || number < 1) throw new CloudError(0, 'E_CLOUD_COMMENT_ID', `${JSON.stringify(comment)} is not a comment: its id (cm_…) or its number in the review (#4).`);
  const { comments } = await fetchComments(connection, review);
  const found = comments.find((c) => c.number === number && c.parent === null);
  if (!found) throw new CloudError(404, 'no-comment', `The review has no thread #${number}.`);
  return found.id;
}

// The author's reply in a thread (name: the account's display name, or the key's label, by default).
export async function replyToComment(review: string, comment: string, text: string, { name, api = cloudUrl() }: { name?: string; api?: string } = {}): Promise<CloudComment> {
  const connection = await connect(api);
  const parent = await commentId(connection, review, comment);
  return (await call<{ comment: CloudComment }>(connection, 'POST', `${reviewPath(connection, review)}/comments`, { parent, text, ...(name ? { name } : {}) })).comment;
}

export async function setCommentState(review: string, comment: string, state: 'open' | 'resolved', api: string = cloudUrl()): Promise<CloudComment> {
  const connection = await connect(api);
  const id = await commentId(connection, review, comment);
  return (await call<{ comment: CloudComment }>(connection, 'PATCH', `${reviewPath(connection, review)}/comments/${segment(id)}`, { state })).comment;
}

// The reviews of a course: those whose versions were built from it (versions[].course, protocol 6) and
// those of the space's publications built from it (meta.course.id), so that a course finds its
// reviews from any computer, whatever its publications are called. An AI key reads reviews only
// (D45): it finds them by their versions, without the publications.
export async function courseReviews(connection: Connection, courseId: string): Promise<{ publications: CloudPublication[]; reviews: CloudReview[] }> {
  const { reviews } = await call<{ reviews: CloudReview[] }>(connection, 'GET', reviewPath(connection));
  const builtFrom = (review: CloudReview) => review.versions.some((version) => version.course?.id === courseId);
  if (connection.credential.kind === 'ai') return { publications: [], reviews: reviews.filter(builtFrom) };
  const { publications } = await call<{ publications: CloudPublication[] }>(connection, 'GET', `/v1/spaces/${segment(connection.space)}/publications`);
  const ours = publications.filter((p) => p.meta?.course?.id === courseId);
  const names = new Set(ours.map((p) => p.name));
  return { publications: ours, reviews: reviews.filter((r) => names.has(r.publication) || builtFrom(r)) };
}
