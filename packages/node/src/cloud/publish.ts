import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from '../build.ts';
import type { BuildReport } from '../build.ts';
import type { WebNavigation, WebProgress } from '../build-types.ts';
import { loadProjectFromDir } from '../project-reader.ts';
import { CloudError, REVIEW_PAGE_ORIGIN, cloudUrl, publicationUrl, segment } from './client.ts';
import { connect, guard } from './account.ts';
import type { Connection } from './account.ts';
import { recordPublished, screenHashes } from './records.ts';
import type { AnnouncedManifest, CloudPublication, CloudReview, PublicationMeta, PublishCheck, Visibility } from './types.ts';

// Publishing a module on Elabora's hosting (protocol « Publishing a version »): the files of a web
// build hashed, the manifest announced, only the blobs the space lacks sent (whole, or in parts above
// the API's limit), then the commit that switches the publication to the new version at once. A
// second publication of the same content transfers nothing.

export interface LocalFile {
  path: string; // relative, with / separators
  absolute: string;
  sha256: string;
  size: number;
}

export interface PublishProgress {
  phase: 'build' | 'hash' | 'send' | 'commit';
  file?: string;
  sentBytes?: number;
  totalBytes?: number;
}

export interface PublishResult {
  space: string;
  name: string;
  visibility: Visibility;
  unchanged: boolean; // the publication already served this content: nothing was sent
  version: string;
  previous: string | null;
  url: string | null; // null for a private publication: only a review serves it
  pinnedUrl: string | null;
  files: number;
  bytes: number;
  sentFiles: number;
  sentBytes: number;
  multipartFiles: number;
  reviews: { id: string; title: string; number: number | null; added: boolean }[]; // open reviews given the new version
}

async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// Every file under a folder, in code-point order of their paths.
export async function scanFolder(root: string): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/').normalize('NFC');
    files.push({ path: relative, absolute, sha256: await hashFile(absolute), size: fs.statSync(absolute).size });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const manifestOf = (files: readonly LocalFile[], noindex: boolean, meta: PublicationMeta): AnnouncedManifest => ({
  files: Object.fromEntries(files.map((file) => [file.path, { sha256: file.sha256, size: file.size }])),
  noindex,
  meta
});

async function readRange(file: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
      if (bytesRead === 0) throw new CloudError(0, 'E_CLOUD_FILE_CHANGED', `${file} changed while it was being sent: publish again.`);
      read += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

interface Announced {
  unchanged: boolean;
  upload?: string;
  version: string;
  previous?: string | null;
  url: string | null;
  missing: { sha256: string; size: number }[];
  limits?: { singlePutMaxBytes: number; partBytes: number };
}

const BLOB_TIMEOUT = 15 * 60_000;
const PARALLEL = 4;

// Publishes a folder already built for the web: announce, send what is missing, commit.
export async function publishFolder(connection: Connection, folder: string, { name, visibility, noindex, meta, onProgress = () => {} }: {
  name: string; visibility: Visibility; noindex: boolean; meta: PublicationMeta; onProgress?: (progress: PublishProgress) => void;
}): Promise<Omit<PublishResult, 'reviews'>> {
  const { client, credential, space } = connection;
  if (!fs.existsSync(path.join(folder, 'index.html'))) throw new CloudError(0, 'E_CLOUD_NOT_A_MODULE', `${folder} has no index.html: give a course folder, or a folder elabora build --target web wrote.`);
  onProgress({ phase: 'hash' });
  const files = await scanFolder(folder);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const base = `/v1/spaces/${segment(space)}`;
  const announced = await guard(credential, () => client.request<Announced>('POST', `${base}/publications/${segment(name)}/uploads`, { json: { visibility, manifest: manifestOf(files, noindex, meta) } }));
  const result = { space, name, visibility, version: announced.version, files: files.length, bytes, multipartFiles: 0 };
  if (announced.unchanged) {
    return { ...result, unchanged: true, previous: announced.version, url: announced.url, pinnedUrl: announced.url ? `${announced.url}@${announced.version}/` : null, sentFiles: 0, sentBytes: 0 };
  }
  const bySha = new Map(files.map((file) => [file.sha256, file]));
  const limit = announced.limits?.singlePutMaxBytes ?? 64 * 1024 * 1024;
  const totalBytes = announced.missing.reduce((sum, blob) => sum + blob.size, 0);
  let sentBytes = 0;
  let multipartFiles = 0;
  const upload = `${base}/uploads/${segment(announced.upload ?? '')}`;
  const send = async (missing: { sha256: string; size: number }) => {
    const file = bySha.get(missing.sha256);
    if (!file) throw new CloudError(0, 'E_CLOUD_PROTOCOL', `The API asked for a file this module does not have (${missing.sha256.slice(0, 12)}…).`);
    const blob = `${upload}/blobs/${missing.sha256}`;
    if (missing.size <= limit) {
      await guard(credential, async () => client.request('PUT', blob, { bytes: await readRange(file.absolute, 0, file.size), timeoutMs: BLOB_TIMEOUT }));
    } else {
      multipartFiles++;
      const started = await guard(credential, () => client.request<{ present: boolean; multipart?: string; partBytes?: number; parts?: number }>('POST', `${blob}/multipart`));
      if (!started.present) {
        const multipart = `${blob}/multipart/${encodeURIComponent(started.multipart ?? '')}`;
        const partBytes = started.partBytes ?? 0;
        const parts: { partNumber: number; etag: string }[] = [];
        for (let n = 1; n <= (started.parts ?? 0); n++) {
          const offset = (n - 1) * partBytes;
          const bytes = await readRange(file.absolute, offset, Math.min(partBytes, file.size - offset));
          const part = await guard(credential, () => client.request<{ partNumber: number; etag: string }>('PUT', `${multipart}/${n}`, { bytes, timeoutMs: BLOB_TIMEOUT }));
          parts.push({ partNumber: part.partNumber, etag: part.etag });
          onProgress({ phase: 'send', file: file.path, sentBytes: sentBytes + offset + bytes.byteLength, totalBytes });
        }
        await guard(credential, () => client.request('POST', `${multipart}/complete`, { json: { parts }, timeoutMs: BLOB_TIMEOUT }));
      }
    }
    sentBytes += missing.size;
    onProgress({ phase: 'send', file: file.path, sentBytes, totalBytes });
  };
  // A few at a time: blobs are independent until the commit, which checks them all.
  const queue = [...announced.missing];
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await send(next);
  }));
  onProgress({ phase: 'commit' });
  const committed = await guard(credential, () => client.request<{ version: string; url: string | null; pinnedUrl: string | null }>('POST', `${upload}/commit`));
  return { ...result, version: committed.version, unchanged: false, previous: announced.previous ?? null, url: committed.url, pinnedUrl: committed.pinnedUrl, sentFiles: announced.missing.length, sentBytes, multipartFiles };
}

// A publication's name: [a-z0-9], inner hyphens, 1 to 64 characters.
export const isPublicationName = (name: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name);

// The default name of a course's publication: its id, and <id>-review for the private one a review
// shows (a publication's visibility is fixed by its first commit, so the two never share a name).
export function defaultPublicationName(courseId: string, visibility: Visibility): string {
  const base = courseId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'module';
  return visibility === 'private' ? `${base}-review` : base;
}

export interface PublishCourseOptions {
  visibility?: Visibility;
  name?: string;
  image?: string; // a sharing image for a public publication
  progress?: WebProgress;
  navigation?: WebNavigation;
  index?: boolean; // ask to be indexed by search engines (only accounts allowed to; noindex otherwise)
  // One package of every approved language, switched in place by learners (D59), for a public
  // publication; a review shows one language per build (D42), so a private one refuses it.
  languages?: 'all';
  reviewOrigins?: string[]; // more review pages (development); https://revue.elabora.studio always
  api?: string;
  onProgress?: (progress: PublishProgress) => void;
}

interface CourseFacts { id: string; title: string; description: string; language: string; version: string }

function courseFacts(courseDir: string): CourseFacts {
  const project = loadProjectFromDir(courseDir);
  const course = project.course;
  if (!course) throw new CloudError(0, 'E_CLOUD_NOT_A_COURSE', `${path.resolve(courseDir)} is not an Elabora course (no course.json).`);
  return { id: course.id, title: course.title, description: course.description ?? '', language: course.language, version: course.version };
}

// Builds a course for the web in a temporary folder and publishes it. Private: a review build
// (the review bridge for the review page, nothing kept, free navigation, noindex) without a public
// address; public: the course's own rules, its address as canonical, noindex unless asked. A new
// private version is also sent to the publication's open reviews, as their next version.
// A private build is a preview (D43): the checks of the guardrails and of the delivery
// checklist that fail stop the web and the package, never the reviewers; they come back in `checks`,
// so that the author sees what is still red. Errors of the course itself (format, references,
// components, objects) stop it as they stop any build.
export async function publishCourse(courseDir: string, options: PublishCourseOptions = {}): Promise<PublishResult & { report: BuildReport; checks: PublishCheck[] }> {
  const visibility = options.visibility ?? 'public';
  const api = options.api ?? cloudUrl();
  const facts = courseFacts(courseDir);
  const name = options.name ?? defaultPublicationName(facts.id, visibility);
  if (!isPublicationName(name)) throw new CloudError(0, 'E_CLOUD_NAME', `${JSON.stringify(name)} is not a publication name: lowercase letters, digits and hyphens, 1 to 64 characters.`);
  if (visibility === 'private' && options.image) throw new CloudError(0, 'E_CLOUD_PRIVATE_IMAGE', 'A private publication has no address of its own, so no sharing image.');
  if (visibility === 'private' && options.languages) throw new CloudError(0, 'E_CLOUD_PRIVATE_LANGUAGES', 'A review shows one language per build (D42): publish the review without languages; the package of every language is for the public publication.');
  const connection = await connect(api);
  const onProgress = options.onProgress ?? (() => {});
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-publish-'));
  try {
    onProgress({ phase: 'build' });
    const noindex = !options.index;
    const web = visibility === 'private'
      ? { review: { origins: [REVIEW_PAGE_ORIGIN, ...(options.reviewOrigins ?? [])] }, ...(options.progress ? { progress: options.progress } : {}), ...(options.navigation ? { navigation: options.navigation } : {}) }
      : { noindex, url: publicationUrl(connection.space, name), ...(options.image ? { image: options.image } : {}), ...(options.progress ? { progress: options.progress } : {}), ...(options.navigation ? { navigation: options.navigation } : {}) };
    const built = await build(courseDir, { target: 'web', web, out, emit: 'dir', ...(visibility === 'private' ? { preview: true } : {}), ...(options.languages ? { languages: options.languages } : {}) });
    if (!built.ok || !built.dirPath) {
      const errors = built.diagnostics.filter((d) => d.severity === 'error' && !d.waived);
      throw new CloudError(0, 'E_CLOUD_BUILD', `The course does not build for the web (${errors.length} error(s)): ${errors.slice(0, 3).map((d) => `${d.code} ${d.message}`).join('; ')}${errors.length > 3 ? '…' : ''}. elabora validate lists them.`, { diagnostics: errors });
    }
    const meta: PublicationMeta = { title: facts.title, description: facts.description, languages: built.report.languages ?? [facts.language], image: visibility === 'public' ? built.report.web?.image ?? null : null, course: { id: facts.id, version: facts.version } };
    const published = await publishFolder(connection, built.dirPath, { name, visibility, noindex: visibility === 'private' ? true : noindex, meta, onProgress });
    // The screens as they were built: a comment on this version is compared with them later.
    recordPublished(courseDir, { api, space: connection.space, name, visibility }, { version: published.version, course: facts.version, publishedAt: new Date().toISOString(), screens: screenHashes(loadProjectFromDir(courseDir)) });
    const reviews = visibility === 'private' ? await sendToOpenReviews(connection, name) : [];
    const checks: PublishCheck[] = built.diagnostics.filter((d) => d.severity === 'error' && !d.waived && d.rule)
      .map((d) => ({ code: d.code, message: d.message, rule: d.rule ?? null, target: d.target ?? d.file ?? null }));
    return { ...published, reviews, report: built.report, checks };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

// The publication's current version, sent to each of its reviews still open or read-only.
async function sendToOpenReviews(connection: Connection, publication: string): Promise<PublishResult['reviews']> {
  const { client, credential, space } = connection;
  const base = `/v1/spaces/${segment(space)}/reviews`;
  const { reviews } = await guard(credential, () => client.request<{ reviews: CloudReview[] }>('GET', `${base}?publication=${encodeURIComponent(publication)}`));
  const sent: PublishResult['reviews'] = [];
  for (const review of reviews.filter((r) => r.state !== 'closed')) {
    const answer = await guard(credential, () => client.request<{ added: boolean; review: CloudReview }>('POST', `${base}/${segment(review.id)}/versions`, { json: {} }));
    sent.push({ id: review.id, title: answer.review.title, number: answer.review.latest ?? null, added: answer.added });
  }
  return sent;
}

// Publishes a folder elabora build --target web already wrote, as it is: its title, description and
// language from its index.html, the course from its build report beside it when there is one.
export async function publishBuiltFolder(folder: string, { name, visibility = 'public', api = cloudUrl(), onProgress }: { name: string; visibility?: Visibility; api?: string; onProgress?: (progress: PublishProgress) => void }): Promise<PublishResult> {
  if (!isPublicationName(name)) throw new CloudError(0, 'E_CLOUD_NAME', `${JSON.stringify(name)} is not a publication name: lowercase letters, digits and hyphens, 1 to 64 characters.`);
  const index = path.join(folder, 'index.html');
  if (!fs.existsSync(index)) throw new CloudError(0, 'E_CLOUD_NOT_A_MODULE', `${folder} has no index.html: give a course folder, or a folder elabora build --target web wrote.`);
  const html = fs.readFileSync(index, 'utf8');
  const noindex = /<meta name="robots" content="noindex">/.test(html);
  const isReview = fs.existsSync(path.join(folder, 'elabora', 'review.js'));
  if (visibility === 'private' && !isReview) throw new CloudError(0, 'E_CLOUD_NOT_A_REVIEW_BUILD', `${folder} is not a review build: a private publication is shown by the review page, which needs elabora build --target web --review-origin ${REVIEW_PAGE_ORIGIN} (or give the course folder).`);
  const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const title = decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? name).trim() || name;
  const description = decode(/<meta name="description" content="([^"]*)">/.exec(html)?.[1] ?? '');
  const language = /<html lang="([^"]+)"/.exec(html)?.[1] ?? 'en';
  const report = readReport(folder);
  const image = visibility === 'public' ? (fs.readdirSync(folder).find((file) => /^share\.(png|jpe?g|webp)$/.test(file)) ?? null) : null;
  const connection = await connect(api);
  const published = await publishFolder(connection, folder, { name, visibility, noindex: visibility === 'private' || noindex, meta: { title, description, languages: report?.languages ?? [language], image, course: report ? { id: report.id, version: report.version } : null }, ...(onProgress ? { onProgress } : {}) });
  const reviews = visibility === 'private' ? await sendToOpenReviews(connection, name) : [];
  return { ...published, reviews };
}

function readReport(folder: string): { id: string; version: string; languages?: string[] } | null {
  try {
    const report = JSON.parse(fs.readFileSync(`${path.resolve(folder)}.report.json`, 'utf8')) as { course?: { id?: unknown; version?: unknown }; languages?: unknown };
    const languages = Array.isArray(report.languages) && report.languages.every((language) => typeof language === 'string') ? { languages: report.languages as string[] } : {};
    return typeof report.course?.id === 'string' && typeof report.course.version === 'string' ? { id: report.course.id, version: report.course.version, ...languages } : null;
  } catch { return null; }
}

// The space's publications, as the API lists them.
export async function listPublications(api: string = cloudUrl()): Promise<{ space: string; publications: CloudPublication[] }> {
  const { client, credential, space } = await connect(api);
  const { publications } = await guard(credential, () => client.request<{ publications: CloudPublication[] }>('GET', `/v1/spaces/${segment(space)}/publications`));
  return { space, publications };
}

const VERSION_ID = /^[0-9a-f]{16}$/;
export const isVersionId = (id: string): boolean => VERSION_ID.test(id);

function publicationPath(name: string, version?: string): string {
  if (!isPublicationName(name)) throw new CloudError(0, 'E_CLOUD_NAME', `${JSON.stringify(name)} is not a publication name.`);
  if (version !== undefined && !isVersionId(version)) throw new CloudError(0, 'E_CLOUD_VERSION', `${JSON.stringify(version)} is not a version (16 hexadecimal digits, as elabora publication versions gives them).`);
  return `/publications/${segment(name)}`;
}

// A publication and every version the hosting keeps of it (the current one is `publication.version`).
export async function publicationVersions(name: string, api: string = cloudUrl()): Promise<{ space: string; publication: CloudPublication; versions: string[] }> {
  const { client, credential, space } = await connect(api);
  const base = publicationPath(name);
  const { manifest: _manifest, versions, ...publication } = await guard(credential, () => client.request<CloudPublication & { manifest: unknown; versions: string[] }>('GET', `/v1/spaces/${segment(space)}${base}`));
  return { space, publication, versions };
}

export interface WithdrawnVersion {
  name: string;
  version: string;
  withdrawn: true;
  visibility: Visibility;
  reviews: number; // the reviews that showed it: it stays in their list, marked withdrawn
  blobsDeleted: number; // files no other version of the space uses
}

// Takes one older version down while the publication goes on: its pinned address answers 404, a review
// that showed it lists it as withdrawn, and the files only it used are deleted. The current version is
// refused (publish a newer one first, or unpublish).
export async function withdrawVersion(name: string, version: string, api: string = cloudUrl()): Promise<WithdrawnVersion> {
  const { client, credential, space } = await connect(api);
  const base = publicationPath(name, version);
  return guard(credential, () => client.request<WithdrawnVersion>('DELETE', `/v1/spaces/${segment(space)}${base}/versions/${version}`));
}

export interface Unpublished {
  unpublished: boolean;
  versionsDeleted: number;
  blobsDeleted: number;
  uploadsExpired: number;
}

// Takes a publication off the web (« Retirer du web »): its addresses answer 404 within seconds,
// every version and the files only it used are deleted. A publication a review shows is refused
// (CloudError in-review): deleting its last review removes it.
export async function unpublish(name: string, api: string = cloudUrl()): Promise<Unpublished & { space: string; name: string }> {
  const { client, credential, space } = await connect(api);
  const base = publicationPath(name);
  const answer = await guard(credential, () => client.request<Unpublished>('DELETE', `/v1/spaces/${segment(space)}${base}`));
  return { ...answer, space, name };
}
