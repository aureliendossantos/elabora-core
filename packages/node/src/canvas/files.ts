// Project files as the canvas page asks for them: the shared file serving of the local servers
// (http/files.ts: streamed, with range requests and revalidation).
export { MIME_TYPES, mimeType, byteRange, serveFile } from '../http/files.ts';
