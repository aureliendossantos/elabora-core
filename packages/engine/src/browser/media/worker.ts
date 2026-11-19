// The media Worker (D106): started by the engine's Worker at its first medium, it probes files and makes
// their masters, a line's audio, a sound, a waveform. It makes no request to the network and holds no
// secret: it reads the Blobs it is sent, writes its results to the origin's private file system
// (media-work/), and answers the engine's Worker, which keeps them and sends them to the team. The only
// things it loads are its own script and, when it is given, the AAC encoder's address (D107).

import type { MediaInfo } from '@elabora/core/media/conformance';
import { probeFile, MediaUnreadable } from './probe.ts';
import { canWriteWebp, imageMaster, MediaEncoderMissing, MediaNotDecodable } from './image.ts';
import { masterPlan } from '@elabora/core/media/conformance';
import { fileTarget, videoMaster } from './video.ts';
import { lineAudio, linePeaks, soundMaster } from './audio.ts';
import { provideAac } from './encoders.ts';

export type MediaAsk =
  | { op: 'probe'; file: Blob; name: string }
  // import: a medium's master by the desktop's plan; line: a narration line's audio; sound: a sound of the course.
  | { op: 'master'; kind: 'import' | 'line' | 'sound'; file: Blob; name: string; trim?: boolean; loops?: boolean }
  | { op: 'peaks'; file: Blob; name: string; perSecond: number; duration: number | null };

export type MediaAnswer =
  // extension: the master's an import will write (null: the input's).
  | { info: MediaInfo; extension: string | null }
  // file: the master (the input itself when kept as it is), info: its facts; extension: null when the input's.
  | { master: { file: Blob; extension: string | null; action: string; info: MediaInfo } }
  | { peaks: Uint8Array }
  | { error: string; code?: string };

// The engine's Worker's messages: init (once), a question by id, or a cancel of one.
// forget: the engine kept a master's bytes, its file here goes.
export type MediaMessage = { kind: 'init'; aacEncoder?: string } | { kind: 'ask'; id: number; ask: MediaAsk } | { kind: 'cancel'; id: number } | { kind: 'forget'; id: number };

const scope = self as unknown as { onmessage: ((event: MessageEvent<MediaMessage>) => void) | null; postMessage(message: { id: number; answer: MediaAnswer }): void };
let aac = provideAac(undefined);
const running = new Map<number, AbortController>();

scope.onmessage = ({ data }) => {
  if (data.kind === 'init') { aac = provideAac(data.aacEncoder); return; }
  if (data.kind === 'cancel') { running.get(data.id)?.abort(); return; }
  if (data.kind === 'forget') { void navigator.storage.getDirectory().then((root) => root.getDirectoryHandle('media-work')).then((folder) => folder.removeEntry(`job-${data.id}`)).catch(() => {}); return; }
  const controller = new AbortController();
  running.set(data.id, controller);
  answer(data.id, data.ask, controller.signal)
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error), ...(codeOf(error) ? { code: codeOf(error) } : {}) }))
    .then((result) => { running.delete(data.id); scope.postMessage({ id: data.id, answer: result }); });
};

const codeOf = (error: unknown): string | undefined =>
  error instanceof MediaUnreadable ? 'E_MEDIA_UNREADABLE' : error instanceof MediaEncoderMissing || error instanceof MediaNotDecodable ? error.code : undefined;

async function answer(id: number, ask: MediaAsk, signal: AbortSignal): Promise<MediaAnswer> {
  if (ask.op === 'peaks') return { peaks: await linePeaks(ask.file, ask.name, ask.perSecond, ask.duration) };
  const info = await probeFile(ask.file, ask.name);
  if (ask.op === 'probe') return { info, extension: info.kind === 'vector' ? null : masterPlan(info, { importing: true, webp: info.kind !== 'image' || await canWriteWebp() }).extension };
  if (info.kind === 'image' && ask.kind === 'import') {
    const made = await imageMaster(ask.file, ask.name, info);
    return { master: { file: made.blob, extension: made.extension, action: made.action, info: made.action === 'copy' ? info : await probeFile(made.blob, `master${made.extension ?? ''}`) } };
  }
  if (info.kind === 'vector') return { master: { file: ask.file, extension: null, action: 'copy', info } };
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle('media-work', { create: true });
  const handle = await folder.getFileHandle(`job-${id}`, { create: true });
  const target = await fileTarget(handle);
  const made = ask.kind === 'line' ? { ...(await lineAudio(ask.file, ask.name, info, { trim: !!ask.trim, target, aac, signal })), extension: '.m4a' }
    : ask.kind === 'sound' ? await soundMaster(ask.file, ask.name, info, { loops: ask.loops, target, aac, signal })
    : await videoMaster(ask.file, ask.name, info, { target, aac, signal });
  if (made.action === 'copy') {
    await target.close().catch(() => {});
    // Kept as it came: a line or a video keeps the input's extension, a sound the plan's (the same).
    return { master: { file: ask.file, extension: null, action: 'copy', info } };
  }
  const file = await handle.getFile();
  return { master: { file, extension: made.extension, action: made.action, info: await probeFile(file, `master${made.extension ?? ''}`) } };
}
