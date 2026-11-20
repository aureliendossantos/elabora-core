// The media service of a browser's session (D102, D106, D108): importMedia and its jobs, a narration's
// waveform, recordings imported together, and what the commands that need media are given (lineAudio,
// recording, resourceFile, videoOfImage). A file comes with the request that names it: the window
// sends the File it holds beside the message, named by the token the request carries (`path`, `file`,
// `files`). The media Worker does the work; this side keeps what it makes and journals it.

import type { Author } from '@elabora/core/ops/types';
import type { Project } from '@elabora/core/project/model';
import { binaryFile, isTextPath, textFile } from '@elabora/core/project/files';
import type { ProjectFiles, SourceFile } from '@elabora/core/project/files';
import { extensionOf, fileMedia } from '@elabora/core/media/conformance';
import type { MediaInfo } from '@elabora/core/media/conformance';
import { importFolder, normaliseExtension, slugify, uniquePathAmong } from '@elabora/core/media/naming';
import { mediaFacts } from '@elabora/core/sync/media';
import { narrationLines } from '@elabora/core/narration/narration';
import { linesByName, recordingLines } from '@elabora/core/narration/recordings';
import type { HostNeed, HostNeeds } from '@elabora/core/commands/host';
import { EngineError } from '../../base/errors.ts';
import type { NewContents } from '../../base/changes.ts';
import type { EngineEvent, MediaImportResult, MediaJobInfo } from '../../protocol.ts';
import type { BrowserStore } from '../store.ts';
import type { MediaWorker } from '../worker-client.ts';
import type { MediaAnswer, MediaAsk } from './worker.ts';

// The files a request brings, by the token that names them.
export type Attachments = ReadonlyMap<string, Blob>;

export interface MediaHost {
  files(): ProjectFiles;
  project(): Project;
  store: BrowserStore;
  // A change of the media, journaled in the session's queue (source media); its number.
  journal(contents: NewContents): Promise<number | null>;
  emit(event: EngineEvent): void;
  // A line's words timed at once when it is written, where the align service keeps the aligner of its
  // language (D27): what the desktop's lineAudio gives too.
  wordsAtOnce?(language: string, audio: Blob, duration: number | null, text: string): Promise<{ words: NonNullable<HostNeeds['lineAudio']['words']>; aligner: string } | { alignmentError: string } | null>;
}

export interface ImportedRecording {
  file: string;
  status: 'imported' | 'unmatched' | 'failed';
  screen?: string;
  line?: string;
  by?: 'name';
  reason?: string;
  change?: number | null;
}

// A token's file name: what follows its last slash (« elabora-file:3fa1…/03-a-vous.wav »).
const nameOf = (token: string): string => token.slice(token.lastIndexOf('/') + 1) || 'media';

export function attached(attachments: Attachments, token: unknown, field: string): { file: Blob; name: string } {
  if (typeof token !== 'string' || !token) throw new EngineError('bad-request', `${field}: the token of a file the window gives`);
  const file = attachments.get(token);
  // A token is never read as a path: without its file, the request is a bad one.
  if (!file) throw new EngineError('bad-request', `${field}: ${token} came without its file`);
  return { file, name: nameOf(token) };
}

let jobs = 0;
const newJobId = () => `mj_${Date.now().toString(36)}${(++jobs).toString(36)}`;

export class BrowserMedia {
  readonly #worker: MediaWorker;
  readonly #host: MediaHost;
  readonly #jobs = new Map<string, { info: MediaJobInfo; controller: AbortController }>();
  readonly #peaks = new Map<string, Uint8Array>();

  constructor(worker: MediaWorker, host: MediaHost) {
    this.#worker = worker;
    this.#host = host;
  }

  async #ask(ask: MediaAsk, signal?: AbortSignal): Promise<Exclude<MediaAnswer, { error: string }>> {
    const { id, answer } = await this.#worker.ask(ask, signal);
    if ('error' in answer) throw new EngineError(answer.code ? 'refused' : 'internal', answer.error, answer.code ? { code: answer.code } : {});
    if ('master' in answer) queueMicrotask(() => setTimeout(() => this.#worker.forget(id), 0));
    return answer;
  }

  // A master's bytes kept by hash with its facts (for the room, D126), as the project's state holds it.
  // Written as it is read: a master of any size is never held whole here.
  async #keep(file: Blob, info: MediaInfo, rel: string): Promise<{ size: number; hash: string; source: SourceFile }> {
    const hash = await this.#host.store.keep(file, mediaFacts(info));
    return { size: file.size, hash, source: binaryFile(file.size, { hash: hash as `sha256:${string}`, media: fileMedia({ ...info, size: file.size }, rel) }) };
  }

  // ── importMedia, its jobs ──────────────────────────────────────────

  async importMedia(params: { path?: unknown; to?: string; name?: string }, attachments: Attachments, author: Author): Promise<MediaImportResult> {
    const { file, name } = attached(attachments, params.path, 'path');
    const probed = await this.#ask({ op: 'probe', file, name });
    if (!('info' in probed)) throw new EngineError('internal', 'The media Worker gave no facts.');
    const info = probed.info;
    const folder = importFolder(info.kind, params.to);
    if (!folder) throw new EngineError('bad-request', `Media go under assets/: give a folder of it, such as "images" or "assets/images" (not "${params.to}").`);
    const stem = name.replace(/\.[^.]+$/, '');
    const extension = probed.extension ?? normaliseExtension(extensionOf(name));
    const taken = new Set([...this.#host.files().keys(), ...[...this.#jobs.values()].filter(({ info: job }) => job.status === 'queued' || job.status === 'running').map(({ info: job }) => job.output)].map((rel) => rel.toLowerCase()));
    const output = uniquePathAmong(`${folder}/${slugify(params.name ?? stem)}${extension}`, (candidate) => taken.has(candidate.toLowerCase()));
    const job: MediaJobInfo = { id: newJobId(), type: 'import', status: 'queued', input: name, output, replaces: null, progress: 0, error: null, warnings: [], createdAt: new Date().toISOString(), finishedAt: null };
    const controller = new AbortController();
    this.#jobs.set(job.id, { info: job, controller });
    this.#emitJob(job);
    void this.#run(job, file, name, author, controller.signal);
    return { path: output, job: { ...job } };
  }

  async #run(job: MediaJobInfo, file: Blob, name: string, author: Author, signal: AbortSignal): Promise<void> {
    job.status = 'running';
    this.#emitJob(job);
    try {
      const made = await this.#ask({ op: 'master', kind: 'import', file, name }, signal);
      if (signal.aborted) return;
      if (!('master' in made)) throw new Error('The media Worker gave no master.');
      const { source } = await this.#keep(made.master.file, made.master.info, job.output);
      if (signal.aborted) return;
      await this.#host.journal({ updates: new Map([[job.output, source]]), author, command: { name: 'import_media', args: { file: job.output } }, source: 'media' });
      job.status = 'done';
      job.progress = 1;
    } catch (error) {
      if (signal.aborted) return;
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      if (error instanceof EngineError && error.code) job.code = error.code;
    }
    job.finishedAt = new Date().toISOString();
    this.#emitJob(job);
  }

  jobs(): MediaJobInfo[] {
    return [...this.#jobs.values()].map(({ info }) => ({ ...info }));
  }

  cancel(id: string): MediaJobInfo {
    const job = this.#jobs.get(id);
    if (!job) throw new EngineError('not-found', `No media job ${id}`);
    if (job.info.status === 'queued' || job.info.status === 'running') {
      job.controller.abort();
      job.info.status = 'cancelled';
      job.info.finishedAt = new Date().toISOString();
      this.#emitJob(job.info);
    }
    return { ...job.info };
  }

  #emitJob(job: MediaJobInfo): void {
    this.#host.emit({ type: 'mediaJob', job: { ...job, warnings: [...job.warnings] } });
  }

  // Jobs still running end with the session.
  close(): void {
    for (const { controller } of this.#jobs.values()) controller.abort();
    this.#worker.close();
  }

  // ── a narration's waveform, recordings ─────────────────────────────

  async narrationPeaks(screen: string, language: string | undefined, perSecond = 50): Promise<{ screen: string; language: string; perSecond: number; lines: { line: string; duration: number; peaks: Uint8Array }[] } | null> {
    const project = this.#host.project();
    const lang = language || project.course?.language || '';
    const infos = narrationLines(project, screen, lang);
    if (!infos) return null;
    const rate = Math.max(1, Math.min(200, Math.round(perSecond)));
    const lines: { line: string; duration: number; peaks: Uint8Array }[] = [];
    for (const info of infos) {
      const file = this.#host.files().get(info.audio);
      if (!info.duration || file?.kind !== 'binary' || !file.hash) continue;
      const key = `${file.hash}-${rate}`;
      let peaks = this.#peaks.get(key);
      if (!peaks) {
        const audio = await this.#host.store.medium(file.hash);
        if (!audio) continue;
        const answer = await this.#ask({ op: 'peaks', file: audio, name: info.audio, perSecond: rate, duration: file.media?.duration ?? null });
        if (!('peaks' in answer)) continue;
        peaks = answer.peaks;
        this.#peaks.set(key, peaks);
      }
      lines.push({ line: info.id, duration: info.duration, peaks });
    }
    return { screen, language: lang, perSecond: rate, lines };
  }

  // Recordings of several lines at once, each to the line its name gives (finding a line by what it
  // says needs the word aligner: the others come back unmatched).
  async importNarrationFiles(params: { files?: unknown; screen?: string; language?: string; keepSilence?: boolean }, attachments: Attachments, write: (args: Record<string, unknown>) => Promise<number | null>): Promise<{ language: string; files: ImportedRecording[] }> {
    const files = params.files;
    if (!Array.isArray(files) || !files.length) throw new EngineError('bad-request', 'files: the tokens of the recordings');
    for (const token of files) attached(attachments, token, 'files');
    const project = this.#host.project();
    const lang = params.language || project.course?.language || '';
    if (params.screen && !project.screens.has(params.screen)) throw new EngineError('not-found', `Unknown screen "${params.screen}".`);
    const lines = recordingLines(project, params.screen, lang);
    if (!lines.length) throw new EngineError('refused', params.screen ? `Screen "${params.screen}" has no narration.` : 'The course has no narrated screen.');
    const found = linesByName(lines, (files as string[]).map(nameOf), params.screen);
    const results: ImportedRecording[] = [];
    for (const [i, token] of (files as string[]).entries()) {
      const line = found[i];
      if (!line) { results.push({ file: token, status: 'unmatched', reason: `no line is named so: name it after its line (${lines.slice(0, 3).map((l) => l.line).join(', ')}…); finding a line by what it says needs the word aligner, not in this browser yet` }); continue; }
      const result: ImportedRecording = { file: token, status: 'imported', screen: line.screen, line: line.line, by: 'name' };
      try {
        result.change = await write({ screen: line.screen, line: line.line, ...(params.language ? { language: params.language } : {}), file: token, provider: 'recording', voice: '', generated: false, trim: !params.keepSilence });
      } catch (error) {
        result.status = 'failed';
        result.reason = error instanceof Error ? error.message : String(error);
      }
      results.push(result);
    }
    return { language: lang, files: results };
  }

  // ── what the commands that need media are given (D110) ────────────

  async provide(need: HostNeed, args: Record<string, unknown>, attachments: Attachments): Promise<HostNeeds[HostNeed]> {
    if (need === 'lineAudio' || need === 'recording') {
      const { file, name } = attached(attachments, args.file, 'file');
      const made = await this.#ask({ op: 'master', kind: 'line', file, name, trim: need === 'recording' ? args.trim !== false : !!args.trim });
      if (!('master' in made)) throw new EngineError('internal', 'The media Worker gave no audio.');
      const rel = `assets/narration/${name}`;
      const { size, hash } = await this.#keep(made.master.file, made.master.info, rel);
      const duration = made.master.info.duration;
      if (!duration) throw new EngineError('refused', `${name}: its length could not be read.`, { code: 'E_MEDIA_UNREADABLE' });
      // Its bytes are kept already (keep): the command brings none of its own.
      const audio = { audio: { size, hash: hash as `sha256:${string}` }, duration, createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), bytes: new Map() };
      const project = this.#host.project();
      const language = (typeof args.language === 'string' && args.language) || project.course?.language || '';
      if (need === 'lineAudio') {
        if (Array.isArray(args.words)) return { ...audio, words: args.words as HostNeeds['lineAudio']['words'], ...(typeof args.aligner === 'string' ? { aligner: args.aligner } : {}) };
        const text = typeof args.screen === 'string' ? narrationLines(project, args.screen, language)?.find((line) => line.id === args.line)?.text : null;
        const timed = text ? await this.#host.wordsAtOnce?.(language, made.master.file, duration, text) : null;
        return { ...audio, ...(timed ?? {}) };
      }
      const text = typeof args.text === 'string' ? args.text.replace(/\s+/g, ' ').trim() : '';
      // Without its text, a recording must be heard: the transcribe service, not in this browser.
      if (!text) throw new EngineError('not-available', 'A line made from a recording needs its text here: hearing it needs the transcribe service.', { code: 'E_NOT_HERE' });
      const timed = await this.#host.wordsAtOnce?.(language, made.master.file, duration, text);
      return { ...audio, ...(timed && 'words' in timed ? timed : {}), language, text, voice: name };
    }
    if (need === 'resourceFile') {
      const { file, name } = attached(attachments, args.path, 'path');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let text: string | null = null;
      if (isTextPath(name)) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = null; } }
      if (text !== null) return { name, file: textFile(text), pdfTitle: null };
      const hash = await this.#host.store.keep(file);
      // A PDF's own title is read on the desktop; here the resource is titled as asked, else by its name.
      return { name, file: binaryFile(file.size, { hash: hash as `sha256:${string}` }), pdfTitle: null, bytes: new Map() };
    }
    if (need === 'videoOfImage') throw new EngineError('refused', 'This browser cannot turn an animated image into a video yet: do it in the desktop app.', { code: 'E_MEDIA_ENCODER_MISSING' });
    throw new EngineError('not-available', `${need} is not given by the media service here.`, { code: 'E_NOT_HERE' });
  }
}

export const MEDIA_NEEDS: ReadonlySet<HostNeed> = new Set(['lineAudio', 'recording', 'resourceFile', 'videoOfImage']);
