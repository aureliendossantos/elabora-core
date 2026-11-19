import type { Sound } from '@elabora/format';
import type { FileHash, SourceFile } from '../project/files.ts';
import type { MigrationSteps } from '../components/migrate.ts';
import type { Transcript } from '../narration/transcript.ts';
import type { LibraryComponent } from './components.ts';
import type { FontSource } from './fonts.ts';
import type { ObjectTemplates } from './objects-design.ts';
import type { SetNarrationAudioArgs } from './narration.ts';

// What a command expects from its host (docs/decisions/D110.md): what it cannot read in the
// project's files, given by whoever runs it before it runs. A computer reads it from its disk, a
// library folder or its own tools; a browser from what it downloaded or made itself. What only one
// host can do (encoding with ffmpeg, a local model, a render) is that host's work before the
// command: the command takes its result and writes it. A host that cannot give what a command
// expects refuses the command, by what the command declares (a project's room gives nothing).

// Bytes a change brings into the project, by hash: the bytes, or where the host keeps them (a file,
// on a computer). The command names them by hash; its host keeps them with the change, as it keeps
// the project's other files.
export type BroughtBytes = ReadonlyMap<string, Uint8Array | string>;

// What every given thing may bring.
interface Given {
  readonly bytes?: BroughtBytes;
}

type Words = NonNullable<SetNarrationAudioArgs['words']>;

// A line's audio as the course keeps it (an M4A in AAC, mono: D24), made by the host from the file
// it was given, its words timed by the host's aligner when it has one.
interface MadeAudio extends Given {
  readonly audio: { size: number; hash: FileHash };
  readonly duration: number;
  readonly words?: Words;
  readonly aligner?: string;
  readonly createdAt: string;
  readonly bytes: BroughtBytes;
}

export interface HostNeeds {
  // create_object: the files of a new free object, an activity's or a decoration's.
  objectTemplates: Given & { readonly templates: ObjectTemplates };
  // add_font: a font's faces and licence, from a vetted family, a Fontsource package or font files
  // (origin: where it came from, in words; notes: what the reading of it found).
  font: Given & { readonly source: FontSource; readonly origin: string; readonly notes: readonly string[]; readonly bytes: BroughtBytes };
  // add_component: a component of a library, its files and their bytes.
  libraryComponent: Given & { readonly component: LibraryComponent; readonly bytes: BroughtBytes };
  // publish_component: the library the host published the course's component to (its id).
  publication: Given & { readonly library: string };
  // migrate_components: the steps of each component's migrations.mjs, by component.
  componentMigrations: Given & { readonly steps: ReadonlyMap<string, MigrationSteps> };
  // add_resource: the file asked for, its name and its content as the snapshot will hold it, and
  // the title a PDF gives itself (null: none, or not a PDF).
  resourceFile: Given & { readonly name: string; readonly file: SourceFile; readonly pdfTitle: string | null };
  // set_narration_audio: the line's audio made from the file, and its mouth's envelope (D61) when
  // it could be measured; alignmentError: why its words could not be timed.
  lineAudio: MadeAudio & { readonly mouth?: string; readonly alignmentError?: string };
  // add_narration_line_with_audio: a recording made the line's audio, its text given or heard
  // (transcript: what the transcriber heard), in the course's language; voice: the name it goes by.
  recording: MadeAudio & { readonly language: string; readonly text: string; readonly voice: string; readonly transcript?: Transcript };
  // set_narration_text_from_audio: what the line's recording says (given, or heard: transcript),
  // its words timed on that text; audioHash: the audio it was heard in.
  heardText: Given & { readonly language: string; readonly text: string; readonly audioHash?: FileHash; readonly words?: Words; readonly aligner?: string; readonly transcript?: Transcript };
  // add_sound: the sound's file as the course keeps it (cut and faded as asked), its sidecar and its id.
  sound: Given & { readonly id: string; readonly extension: string; readonly file: SourceFile; readonly sidecar: Sound; readonly bytes: BroughtBytes };
  // image_to_video: the MP4 and its poster made from the image's file, the paths media jobs will
  // write (never taken), and the sizes in bytes of the image, the video and the poster.
  videoOfImage: Given & {
    readonly video: SourceFile; readonly poster: SourceFile; readonly posterExtension: '.webp' | '.jpg';
    readonly reserved: readonly string[]; readonly sizes: { image: number; video: number; poster: number }; readonly bytes: BroughtBytes;
  };
}

export type HostNeed = keyof HostNeeds;

// What a command of that need is given (undefined: a command that needs nothing but the files).
export type GivenFor<Need extends HostNeed | undefined> = Need extends HostNeed ? HostNeeds[Need] : undefined;

// What the journal records of a run (its name and arguments), when it is not the command as it was
// called: a file's content is in the operations, a library is named by its id, a line's audio by
// what was made of the file.
export interface JournaledCommand {
  readonly name: string;
  readonly args: unknown;
}
