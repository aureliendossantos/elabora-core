import type { Course } from '@elabora/format';
import type { SourceFile } from '../project/files.ts';
import { getFile, pathsUnder, fileHash } from '../project/files.ts';
import { slugify } from '../import/convert.ts';
import { CommandError, Draft, listIn, type CommandContext, type CommandOutput } from './context.ts';
import type { CourseResource } from './player.ts';

// A file added to the player's resources (docs/decisions.md D58): copied into assets/resources/
// under a readable name of its own (« Fiche réflexe (v2).pdf » → fiche-reflexe-v2.pdf, then
// fiche-reflexe-v2-2.pdf when the name is taken by another file), and its entry added to
// course.json resources, in one change. The same content already in assets/resources/ is not
// copied twice: the entry names it. The file's bytes come with the change (@elabora/node
// edit.addResource reads them, and the title a PDF gives itself).

export const RESOURCES_FOLDER = 'assets/resources';

// What the app, the CLI and agents ask (@elabora/node edit.addResource reads the file).
export interface AddResourceRequest {
  // The file: an absolute path, or one relative to the working folder.
  path: string;
  title?: string;
  description?: string;
}

// What the pure command is given.
export interface AddResourceArgs {
  // The file's own name (its extension is kept, in lower case).
  name: string;
  // Its content as the snapshot will hold it (text, or binary with its hash).
  file: SourceFile;
  title: string;
  description?: string;
}

export interface AddResourceResult {
  resource: CourseResource;
  // The file in the course (assets/…) and whether it was there already.
  path: string;
  reused: boolean;
}

const extensionOf = (name: string): string => /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0].toLowerCase() ?? '';

export function addResource(context: CommandContext, args: AddResourceArgs): CommandOutput<AddResourceResult> {
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  const resources = listIn<CourseResource>(course as Record<string, unknown>, 'resources', 'course.json', { create: true });
  const title = args.title.trim();
  if (!title) throw new CommandError('A resource has a title: give one, or a file whose name says something.');
  const extension = extensionOf(args.name);
  const base = slugify(args.name.slice(0, args.name.length - extension.length), 'resource', 60);

  // The same content already there: named, not copied again.
  const hash = args.file.kind === 'binary' ? args.file.hash ?? null : null;
  const same = (path: string) => {
    const existing = getFile(context.files, path);
    if (!existing || existing.kind !== args.file.kind) return false;
    return args.file.kind === 'text' ? existing.kind === 'text' && existing.text === args.file.text : hash !== null && fileHash(context.files, path) === hash;
  };
  let path = pathsUnder(context.files, RESOURCES_FOLDER).find(same) ?? null;
  const reused = path !== null;
  if (!path) {
    for (let n = 1; ; n++) {
      const candidate = `${RESOURCES_FOLDER}/${base}${n > 1 ? `-${n}` : ''}${extension}`;
      if (!draft.exists(candidate)) { path = candidate; break; }
    }
    draft.writeFile(path, args.file);
  }

  const asset = path.slice('assets/'.length);
  const taken = new Set(resources.map((resource) => String(resource?.id ?? '')));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const resource: CourseResource = { id, title, ...(args.description?.trim() ? { description: args.description.trim() } : {}), asset };
  resources.push(resource);
  draft.writeJson('course.json', course);
  return { files: draft.files(), result: { resource, path, reused } };
}
