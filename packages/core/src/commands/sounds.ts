import type { Sound } from '@elabora/format';
import type { SourceFile } from '../project/files.ts';
import { fileHash, getFile, textFile } from '../project/files.ts';
import { slugify } from '../import/convert.ts';
import { stringifyJSON } from '../util/json.ts';
import { SCHEMA_VERSION } from '@elabora/format';
import { SOUNDS_FOLDER, soundAssets } from '../sounds/sounds.ts';
import { CommandError, Draft, type CommandContext, type CommandOutput } from './context.ts';

// « Ajouter un son » (docs/decisions.md D67): a sound's file into assets/sounds/<id>.<ext> with its
// sidecar <id>.json (where it comes from, its licence), in one journaled change. The same content
// already there under that id is kept; another id is found for another content (-2, -3…). Using it
// (a play-sound, a sound line, a background track) is another change.

export interface AddSoundArgs {
  id: string;
  extension: string; // .flac, .ogg, .opus, .m4a, .mp3
  file: SourceFile;
  sidecar: Sound;
}
export interface AddSoundResult {
  id: string;
  path: string;
  sidecar: string;
  reused: boolean;
}

export function addSound(context: CommandContext, args: AddSoundArgs): CommandOutput<AddSoundResult> {
  const draft = new Draft(context.files);
  const base = slugify(args.id, 'sound', 48);
  if (!/^\.(flac|ogg|opus|m4a|mp3|webm)$/.test(args.extension)) throw new CommandError(`A sound is kept as FLAC or as the lossy file it came as (Ogg, Opus, M4A, MP3), not ${args.extension}.`);
  const assets = soundAssets({ files: context.files });
  const hash = args.file.kind === 'binary' ? args.file.hash ?? null : null;
  let id = base;
  for (let n = 2; ; n++) {
    const existing = assets.get(id);
    if (!existing) break;
    if (hash !== null && fileHash(context.files, existing.path) === hash) {
      const sidecar = getFile(context.files, existing.sidecar);
      if (!sidecar) draft.writeFile(existing.sidecar, textFile(sidecarText(args.sidecar)));
      return { files: draft.files(), result: { id, path: existing.path, sidecar: existing.sidecar, reused: true } };
    }
    id = `${base}-${n}`;
  }
  const path = `${SOUNDS_FOLDER}/${id}${args.extension}`;
  const sidecar = `${SOUNDS_FOLDER}/${id}.json`;
  draft.writeFile(path, args.file);
  draft.writeFile(sidecar, textFile(sidecarText(args.sidecar)));
  return { files: draft.files(), result: { id, path, sidecar, reused: false } };
}

const sidecarText = (sidecar: Sound): string => stringifyJSON({ $schema: `https://elabora.studio/schemas/${SCHEMA_VERSION}/sound.schema.json`, ...sidecar });
