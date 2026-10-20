// Elabora's hosting from the core (docs/decisions.md D43): signing in by e-mail code, publishing a
// module, sharing it for review and reading the comments placed in the course's sources. The command
// line (elabora account, publish, review) and the MCP server's read tools call it; the app will too.

export { DEFAULT_CLOUD_URL, REVIEW_PAGE_ORIGIN, CONTENT_DOMAIN, CloudClient, CloudError, cloudUrl, publicationUrl, maskSecret, scrubSecrets } from './client.ts';
export { sessionFile, invitationFile, aiKeyFile, resolveCredential, requireCredential, otherApiCredentials, readKeyFile, statusOf, isSpaceName, readSession, setSessionStore, isAiKey, readAiKey, removeAiKey } from './credentials.ts';
export type { Credential, CredentialKind, CredentialSource, CredentialStatus } from './credentials.ts';
export { serviceInfo, startSignIn, verifySignIn, keepInvitation, connect, accountStatus, handleAvailable, chooseHandle, signOut, defaultDevice, systemName, updateAccount, accountSessions, revokeSession, requestDeletionCode, deleteAccount, createAiKey, listAiKeys, revokeAiKey, sessionRequired } from './account.ts';
export type { ServiceInfo, SignedIn, Connection, AccountView, CreatedAiKey } from './account.ts';
export { scanFolder, manifestOf, publishFolder, publishCourse, publishBuiltFolder, listPublications, publicationVersions, withdrawVersion, unpublish, isVersionId, defaultPublicationName, isPublicationName } from './publish.ts';
export type { LocalFile, PublishProgress, PublishResult, PublishCourseOptions, WithdrawnVersion, Unpublished } from './publish.ts';
export { isReviewId, createReview, setReviewNote, listReviews, getReview, fetchReview, fetchComments, regenerateLink, setReviewState, renameReview, addReviewVersion, deleteReview, listComments, replyToComment, setCommentState, courseReviews } from './reviews.ts';
export type { ReviewWithLink, CommentsQuery } from './reviews.ts';
export { resolveComments, reviewComments } from './resolve.ts';
export type { ResolveOptions, ReviewCommentsOptions } from './resolve.ts';
export { readRecords, screenHashes } from './records.ts';
export type { PublicationRecord, PublishedVersion } from './records.ts';
export type * from './types.ts';
