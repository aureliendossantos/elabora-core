import fs from 'node:fs';
import path from 'node:path';
import type { CommandArgs, CommandName, CommandNeed } from '@elabora/core/commands/table';
import type { HostNeed, HostNeeds } from '@elabora/core/commands/host';
import { CommandError, migrationPlans, OBJECT_FILES, type ObjectTemplates } from '@elabora/core/commands/index';
import type { MigrationSteps } from '@elabora/core/components/migrate';
import type { TranscribeProgress } from '../transcribe/types.ts';
import type { MediaTools } from '../media/tools.ts';
import { TEMPLATES_DIR } from '../scaffold.ts';
import { loadProjectFromDir } from '../project-reader.ts';
import { loadMigrations } from '../component-migrations.ts';
import { resolveFont } from '../fonts/index.ts';
import { readLibrary, libraryComponent, publishToLibrary } from './library.ts';
import { resourceFile } from './resources.ts';
import type { EditOptions } from './executor.ts';

// What this computer gives the commands that need their host (docs/decisions/D110.md): read from
// its disk (a font, a library's component, an object's templates, a resource's file, components'
// migration steps), or made by its own tools (a line's audio with ffmpeg and the word aligner, the
// text of a recording with the transcriber, a sound cut and faded, a video made from an image).
// Each provider prepares what its command expects, gives it to use (which runs the command), and
// cleans up after it.

// How the host works, beside the command's arguments.
export interface HostOptions extends EditOptions {
  tools?: MediaTools;        // ffmpeg and its encoders (default: those found on this computer)
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;                 // a video made from an image
  onTranscribe?: (progress: TranscribeProgress) => void;   // the transcriber, its download included
  align?: boolean;           // false: a line's audio written with its words untimed (elabora narration align times them later)
  onAlign?: () => void;      // the word aligner starts on a line's audio
}

// The needs whose provider works asynchronously (a module imported, a tool run): their command's
// run answers a promise.
export type AsyncNeed = 'componentMigrations' | 'lineAudio' | 'recording' | 'heardText' | 'sound' | 'videoOfImage';

// What a command of that need takes.
type ArgsFor<Need extends HostNeed> = { [Name in CommandName]: CommandNeed<Name> extends Need ? CommandArgs[Name] : never }[CommandName];

export type Provider<Need extends HostNeed> = <R>(dir: string, args: ArgsFor<Need>, options: HostOptions, use: (given: HostNeeds[Need]) => R) => Need extends AsyncNeed ? Promise<R> : R;

// An activity's template (templates/object/) or a decoration's (templates/object-decoration/).
function objectTemplates(decoration: boolean): ObjectTemplates {
  const read = (file: string) => fs.readFileSync(path.join(TEMPLATES_DIR, decoration ? 'object-decoration' : 'object', file), 'utf8');
  return Object.fromEntries(OBJECT_FILES.map((file) => [file, read(file)])) as ObjectTemplates;
}

export const PROVIDERS: { readonly [Need in HostNeed]: Provider<Need> } = {
  objectTemplates: (_dir, args, _options, use) => use({ templates: objectTemplates(!!args.decoration) }),
  font: (_dir, args, _options, use) => {
    const font = resolveFont(args);
    return use({ source: font.source, origin: font.origin, notes: font.notes, bytes: font.sources });
  },
  libraryComponent: (_dir, args, _options, use) => {
    const { source, sources } = libraryComponent(readLibrary(args.library), args.component);
    return use({ component: source, bytes: sources });
  },
  // The component copied into the library first (outside the course: not undoable).
  publication: (dir, args, _options, use) => {
    const library = readLibrary(args.library);
    const project = loadProjectFromDir(dir);
    const source = project.components.get(args.component);
    if (!source?.manifest) throw new CommandError(`No component "${args.component}" in components/`);
    publishToLibrary(library, source, path.join(project.root, source.folder));
    return use({ library: library.id });
  },
  resourceFile,
  // Importing migrations.mjs is asynchronous: the steps are loaded first, then the change runs.
  componentMigrations: async (dir, args, _options, use) => {
    const project = loadProjectFromDir(dir);
    const steps = new Map<string, MigrationSteps>();
    for (const { descriptor } of migrationPlans(project, args)) steps.set(descriptor.id, await loadMigrations(project.root, descriptor));
    return use({ steps });
  },
  // Media and models are imported when a command needs them.
  lineAudio: async (dir, args, options, use) => (await import('../narration/audio.ts')).lineAudio(dir, args, options, use),
  recording: async (dir, args, options, use) => (await import('../narration/from-audio.ts')).recording(dir, args, options, use),
  heardText: async (dir, args, options, use) => (await import('../narration/from-audio.ts')).heardText(dir, args, options, use),
  sound: async (dir, args, options, use) => (await import('../sounds/add.ts')).soundFile(dir, args, options, use),
  videoOfImage: async (dir, args, options, use) => (await import('../media/to-video.ts')).videoOfImage(dir, args, options, use)
};
