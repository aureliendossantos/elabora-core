import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '@elabora/core/project/model';
import { screenOrder } from '@elabora/core/project/load';
import { narrationLines } from '@elabora/core/narration/narration';
import { lineWordTimes } from '@elabora/core/narration/words';
import { isMouth } from '@elabora/core/narration/mouth';
import type { PresetName } from '@elabora/core/media/presets';
import { canonicalJSON } from '@elabora/core/util/json';
import { projectFileHash } from '../file-hash.ts';
import { ensureRendition } from '../media/renditions.ts';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { sha256Hex as sha256, writeFileAtomic } from '../util/fs.ts';
import { narrationCacheDir } from './tracks.ts';
import { lineMouth } from './mouth.ts';

// The audio of a dialogue's lines in a package (D61): one file per line and language, the line's
// audio (assets/narration/<language>/<screen>/<line>.m4a) at the package's media quality (the
// master at high, or its rendition when the preset asks for less: delivery.mediaQuality), at
// narration/<screen>.<block>/<line>.m4a (narration/<language>/… for another language of the
// package, D59). The dot is never in an id: the folder never meets a screen's or a layer's track
// (narration/<screen>.m4a, narration/<screen>.<layer>.m4a) nor a language's folder. The mouth's
// envelope comes from the line's sidecar, or is measured here once (cached by the audio's hash and
// its words): the same inputs give the same package.

export interface DialogueLineFile {
  screen: string;
  block: string;
  line: string;
  // In the package, and on disk (the master or its rendition).
  path: string;
  file: string;
  duration: number;
  mouth: string | null;
  // The audio's hash (the build's id follows it), and the credit its voice asks for.
  hash: string;
  credit: string | null;
  generated: boolean;
}

export interface DialogueLineAudio {
  lines: DialogueLineFile[];
  failures: { screen: string; line: string; message: string }[];
}

// Changes when the envelope's measure changes: every cached envelope is measured again.
const MOUTH_VERSION = 1;

export const dialogueLinePath = (screen: string, block: string, line: string, folder = '', extension = '.m4a'): string => `narration/${folder ? `${folder}/` : ''}${screen}.${block}/${line}${extension}`;

export async function dialogueLineAudio(project: Project, { folder, quality = 'high', tools: given }: { folder?: string; quality?: PresetName; tools?: MediaTools | null } = {}): Promise<DialogueLineAudio> {
  const out: DialogueLineAudio = { lines: [], failures: [] };
  const language = project.course?.language ?? '';
  let tools: MediaTools | null | undefined = given;
  const needTools = async () => {
    if (tools === undefined) tools = await findMediaTools().catch(() => null);
    if (!tools) throw new Error('ffmpeg is needed for the audio of dialogue lines: install it (or set ELABORA_FFMPEG).');
    return tools;
  };
  for (const { id: screen } of screenOrder(project)) {
    for (const info of narrationLines(project, screen, language) ?? []) {
      if (info.track.kind !== 'dialogue' || info.status === 'missing' || info.status === 'untranslated' || !info.duration || !info.text) continue;
      try {
        const master = path.join(project.root, info.audio);
        const file = quality === 'high' ? master : (await ensureRendition(project.root, info.audio, quality, { tools: await needTools() })).file;
        const hash = await projectFileHash(project.root, info.audio);
        let mouth = info.mouth;
        if (mouth === null) {
          const words = lineWordTimes(info.text, info.duration, info.words, language).map((word) => ({ text: word.text, start: word.start, end: word.end }));
          const key = sha256(canonicalJSON({ v: MOUTH_VERSION, audio: hash, words })).slice(0, 32);
          const cached = path.join(narrationCacheDir(project.root), `${key}.mouth`);
          const known = fs.existsSync(cached) ? fs.readFileSync(cached, 'utf8') : null;
          if (known !== null && isMouth(known)) mouth = known;
          else {
            mouth = await lineMouth(await needTools(), master, words);
            fs.mkdirSync(path.dirname(cached), { recursive: true });
            writeFileAtomic(cached, mouth);
          }
        }
        out.lines.push({
          screen, block: info.track.block, line: info.id, path: dialogueLinePath(screen, info.track.block, info.id, folder, path.extname(file).toLowerCase() || '.m4a'), file,
          duration: info.duration, mouth, hash, credit: info.credit, generated: info.generated === true
        });
      } catch (error) {
        out.failures.push({ screen, line: info.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return out;
}
