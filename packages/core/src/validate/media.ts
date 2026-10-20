import type { CheckContext } from './context.ts';
import type { ConformanceReason } from '../media/conformance.ts';

// Media files of assets/ against their master format (docs/architecture/media.md), from what the
// store that read the files found (BinaryFile.media, Project.media). A store without a probe gives
// no media information: nothing is reported then, except that media could not be checked.

export function checkMedia(ctx: CheckContext): void {
  const { project, reporter } = ctx;
  for (const [rel, file] of project.files) {
    if (file.kind !== 'binary' || !file.media || file.media.conformant) continue;
    reporter.emit('W_MEDIA_NOT_OPTIMIZED', { file: rel, message: `${rel}: ${file.media.reasons.map(reasonText).join(' ')} Run \`elabora media optimize ${rel}\`.` });
  }
  for (const { path, message } of project.media?.unreadable ?? []) reporter.emit('E_MEDIA_UNREADABLE', { file: path, message: `${path} cannot be read as media: ${message}` });
  if (project.media?.toolsMissing) reporter.emit('I_MEDIA_TOOLS_MISSING', { message: 'ffprobe was not found: media files added or changed since the last check are not checked.' });
}

// The GPS position is a privacy matter before it is a format matter: said so.
const reasonText = (reason: ConformanceReason): string => (reason.code === 'location'
  ? 'Privacy: the file holds the GPS position where it was recorded, and it would ship to every learner.'
  : reason.message);
