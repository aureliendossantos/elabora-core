import fs from 'node:fs';
import path from 'node:path';
import { detectAuthor } from '@elabora/node/journal/index';
import {
  libraryRoot, setLibraryRoot, listProjects, getProject, resolveProjectId, readCourseInfo, createProject, duplicateProject, renameProject,
  trashProject, listTrash, restoreFromTrash, deleteFromTrash, emptyTrash, exportProject, importArchive, importFolder, archiveName,
  type LibraryProject, type Progress, type ImportedProject
} from '@elabora/node/library/index';
import { ArgumentError } from '../arguments.ts';
import { moduleTemplate } from '@elabora/node/module-templates';
import { sourcesSize } from '@elabora/node/sources/index';
import type { ImportChoices } from '@elabora/core/import/convert';
import { defineCommand, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

// The app's project library and project archives (docs/architecture/storage.md, Project library and
// archives). Projects stay plain folders: these commands find, create and exchange them; every
// other command works on a project's folder as on any course folder.

// Help lines: the usage, then its description from column 54 (on the next line when the usage is long).
const COLUMN = 54;
const entry = (usage: string, ...description: string[]): string => {
  const head = `  ${usage}`;
  const rest = description.map((line) => `${' '.repeat(COLUMN)}${line}`);
  return (head.length < COLUMN ? [`${head.padEnd(COLUMN)}${description[0]}`, ...rest.slice(1)] : [head, ...rest]).join('\n');
};

const HELP = [
  entry('projects list [--json] [--validate]', 'Projects of the library, newest first: title, course, date, size,', 'validation, folder (--validate checks those not checked yet)'),
  entry('projects path [<id>] [--set <dir> [--move|--copy]]', 'Folder of the library, or of a project (id or its first characters).', '--set: use another folder; --move takes the projects along; --copy', 'moves them by copying and checking every file (another disk)'),
  entry('projects create <course-id> --title <t> [--language fr] [--template <id>]', 'Create a course in the library, blank or from a module template', '(elabora templates)'),
  entry('projects duplicate <id> [--title <t>]', 'Copy a project under a new id (same course id; the history stays)'),
  entry('projects rename <id> --title <t>', 'Change the title of a project (an undoable edit of course.json)'),
  entry('projects trash <id>', 'Move a project, history included, to the library\'s trash'),
  entry('projects trash list|restore <entry>|empty [--older-than <days>]', 'What the trash holds; put a project back; delete for good'),
  entry('export [dir] [--out <file>] [--history] [--sources] [--json]', 'Write a project archive (default dist/<course-id>.elabora): the', 'project\'s files and, with --history, its journal and backups; with', '--sources, the author\'s sources (sources/, may hold personal data)'),
  entry('import <archive|folder> [--replace [<id>] | --copy] [--json]', 'Import into the library: an archive (every file checked) or a folder', '(copied). When the library holds the course already, say --replace', '(the replaced files go to the trash, the history stays) or --copy'),
  entry('import <file> [dir] [--title <t>] [--id <id>] [--lang fr] [--choose <decision>=<choice>,…] [--json]', 'Beta: a Storyline 360 project (.story), a course Storyline published', '(folder or zip, web or LMS) or a Rise 360 export, as a new module: in', 'dir, or else the library. Writes import-report.json (every loss, the', 'choices to make); --choose takes one of its choices: presentation=scroll,', 'backgrounds=keep, timing=steps, fonts=theme, media-accessibility=errors'),
].join('\n');

const PROJECTS_USAGE = 'Usage: elabora projects list|path|create|duplicate|rename|trash …';

// ── output ──

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const pad = (value: number) => String(value).padStart(2, '0');
function localTime(iso: string | null): string {
  if (!iso) return 'unknown date';
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const shortId = (id: string) => (id.length === 36 ? id.slice(0, 8) : id);

function validationText(project: LibraryProject): string {
  if (project.error) return `✘ ${project.error}`;
  const v = project.validation;
  if (!v) return 'not checked yet';
  return `${v.errors ? '✘' : '✔'} ${v.errors} error(s), ${v.warnings} warning(s)`;
}

function printProject(project: LibraryProject): void {
  console.log(`  ${shortId(project.id).padEnd(10)}${project.title ?? '(no title)'}`);
  const facts = [project.courseId ?? '(no course id)', project.language, localTime(project.modifiedAt), `${size(project.size)}${project.sourcesSize ? ` + ${size(project.sourcesSize)} of sources` : ''}${project.dataSize ? ` + ${size(project.dataSize)} of history and caches` : ''}`, validationText(project)];
  console.log(`  ${''.padEnd(10)}${facts.filter(Boolean).join(' · ')}`);
  console.log(`  ${''.padEnd(10)}${project.path}`);
}

// Progress of long exports and imports on stderr (stdout keeps the result): a line rewritten in
// place on a terminal, a line per quarter otherwise; nothing for small projects.
const PROGRESS_FROM_BYTES = 32 * 1024 * 1024;
const PHASES: Record<Progress['phase'], string> = { reading: 'Reading the files', writing: 'Writing the archive', extracting: 'Extracting and checking', copying: 'Copying the files' };

function progressReporter(): { onProgress: (progress: Progress) => void; end: () => void } {
  const terminal = process.stderr.isTTY === true;
  let phase: Progress['phase'] | null = null;
  let lastDraw = 0;
  let quarter = 0;
  let drawn = false;
  const end = () => {
    if (drawn && terminal) process.stderr.write('\r\x1b[K');
    drawn = false;
  };
  return {
    end,
    onProgress(progress) {
      if (progress.total < PROGRESS_FROM_BYTES) return;
      if (progress.phase !== phase) {
        end();
        phase = progress.phase;
        quarter = 0;
      }
      const percent = Math.min(100, Math.floor((progress.done / progress.total) * 100));
      const line = `${PHASES[progress.phase]}: ${percent}% (${size(progress.done)} of ${size(progress.total)})`;
      if (terminal) {
        const now = Date.now();
        if (now - lastDraw < 100 && percent < 100) return;
        lastDraw = now;
        process.stderr.write(`\r\x1b[K${line}`);
        drawn = true;
      } else if (Math.floor(percent / 25) > quarter) {
        quarter = Math.floor(percent / 25);
        process.stderr.write(`${line}\n`);
      }
    },
  };
}

// ── projects ──

const list = defineCommand({
  name: 'projects list',
  flags: { json: 'boolean', validate: 'boolean' },
  run({ positionals, flags }) {
    if (positionals.length) throw new ArgumentError(`Unexpected argument ${positionals[0]}`);
    const root = libraryRoot();
    const projects = listProjects({ validate: flags.validate });
    if (flags.json) {
      printJson({ library: root, projects });
      return 0;
    }
    if (!projects.length) {
      console.log(`No projects in the library ${root}.\nCreate one with elabora projects create, or import an archive or a folder with elabora import.`);
      return 0;
    }
    console.log(`Library ${root}: ${projects.length} project(s)\n`);
    for (const project of projects) printProject(project);
    return 0;
  }
});

const pathCommand = defineCommand({
  name: 'projects path',
  flags: { set: 'string', move: 'boolean', copy: 'boolean' },
  run({ positionals: [reference], flags }) {
    if ((flags.move || flags.copy) && !flags.set) throw new ArgumentError('--move and --copy go with --set <dir>');
    if (flags.set && reference) throw new ArgumentError('--set changes the library\'s folder, not a project\'s');
    return reportingFailures(async () => {
      if (reference) {
        console.log(getProject(resolveProjectId(reference)).path);
        return 0;
      }
      if (!flags.set) {
        console.log(libraryRoot());
        return 0;
      }
      const progress = progressReporter();
      const move = flags.move || flags.copy;
      const result = await setLibraryRoot(flags.set, {
        move, copy: flags.copy,
        onProgress: ({ done, total }) => progress.onProgress({ phase: 'copying', done, total })
      });
      progress.end();
      if (result.method === 'none') console.log(`The library is already in ${result.to}.`);
      else if (result.method === 'setting') console.log(`✔ The library is now ${result.to}.${move ? '' : `\n  Projects left in ${result.from} are not in it: move them with --move.`}`);
      else console.log(`✔ Moved the library to ${result.to}: ${result.projects} project(s), ${size(result.bytes)}, by ${result.method === 'rename' ? 'renaming its folder' : 'copying and checking every file'}.`);
      return 0;
    });
  }
});

const create = defineCommand({
  name: 'projects create',
  flags: { title: 'string', language: 'string', template: 'string' },
  run({ positionals: [courseId], flags }) {
    if (!courseId || !flags.title) { console.error('Usage: elabora projects create <course-id> --title <title> [--language fr] [--template <id>]'); return 2; }
    return reportingFailures(async () => {
      const template = flags.template ? moduleTemplate(flags.template) : null;
      const project = await createProject({ id: courseId, title: flags.title!, language: flags.language ?? (template ? 'fr' : undefined), ...(template ? { template: template.dir } : {}) });
      const next = template ? 'README.md says how its charter works; replace the placeholder texts with the storyboard\'s' : 'put the client\'s validated plan in plan.json';
      console.log(`✔ Created "${project.title}" (${project.courseId}) as project ${shortId(project.id)}${template ? ` from the template ${template.id}` : ''}.\n  ${project.path}\nNext: ${next}, then run elabora validate in that folder.`);
      return 0;
    });
  }
});

const duplicate = defineCommand({
  name: 'projects duplicate',
  flags: { title: 'string' },
  run({ positionals: [reference], flags }) {
    if (!reference) { console.error('Usage: elabora projects duplicate <id> [--title <title>]'); return 2; }
    return reportingFailures(async () => {
      const copy = await duplicateProject(resolveProjectId(reference), { title: flags.title, author: detectAuthor() });
      console.log(`✔ Duplicated as project ${shortId(copy.id)} ("${copy.title}").\n  ${copy.path}`);
      return 0;
    });
  }
});

const rename = defineCommand({
  name: 'projects rename',
  flags: { title: 'string' },
  run({ positionals: [reference], flags }) {
    if (!reference || !flags.title) { console.error('Usage: elabora projects rename <id> --title <title>'); return 2; }
    return reportingFailures(async () => {
      const project = await renameProject(resolveProjectId(reference), flags.title!, { author: detectAuthor() });
      console.log(`✔ Project ${shortId(project.id)} is now "${project.title}" (elabora undo in its folder takes it back).`);
      return 0;
    });
  }
});

const trash = defineCommand({
  name: 'projects trash',
  flags: { 'older-than': 'string' },
  run({ positionals: [first, second], flags }) {
    if (!first) { console.error('Usage: elabora projects trash <id> | trash list | trash restore <entry> | trash delete <entry> | trash empty [--older-than <days>]'); return 2; }
    const days = flags['older-than'] === undefined ? undefined : Number(flags['older-than']);
    if (days !== undefined && (!Number.isFinite(days) || days < 0)) throw new ArgumentError('--older-than takes a number of days');
    if (days !== undefined && first !== 'empty') throw new ArgumentError('--older-than goes with trash empty');
    return reportingFailures(async () => {
      if (first === 'list') {
        const entries = listTrash();
        if (!entries.length) { console.log('The trash is empty.'); return 0; }
        for (const item of entries) {
          console.log(`  ${item.entry}\n      ${item.title ?? '(no title)'} · ${item.courseId ?? '(no course id)'} · ${item.reason === 'replaced' ? 'replaced by an import' : 'trashed'} ${localTime(item.trashedAt)} · deleted for good from ${localTime(item.expiresAt)} · ${size(item.size)}`);
        }
        return 0;
      }
      if (first === 'restore') {
        if (!second) { console.error('Usage: elabora projects trash restore <entry> (elabora projects trash list gives the entries)'); return 2; }
        const project = await restoreFromTrash(second);
        console.log(`✔ Restored "${project.title}" as project ${shortId(project.id)}.\n  ${project.path}`);
        return 0;
      }
      if (first === 'delete') {
        if (!second) { console.error('Usage: elabora projects trash delete <entry> (elabora projects trash list gives the entries)'); return 2; }
        const removed = await deleteFromTrash(second);
        console.log(`✔ Deleted "${removed.title ?? removed.courseId ?? removed.id}" from the trash for good (${size(removed.size)}). This cannot be undone.`);
        return 0;
      }
      if (first === 'empty') {
        const result = await emptyTrash({ olderThanDays: days });
        console.log(result.removed.length ? `✔ Deleted ${result.removed.length} project(s) from the trash for good (${size(result.bytes)}).` : 'Nothing to delete.');
        return 0;
      }
      const entry = await trashProject(resolveProjectId(first));
      console.log(`✔ Moved "${entry.title}" to the trash (${entry.entry}). elabora projects trash restore ${entry.entry} puts it back.`);
      return 0;
    });
  }
});

// ── archives ──

const exportCommand = defineCommand({
  name: 'export',
  flags: { out: 'string', history: 'boolean', sources: 'boolean', json: 'boolean' },
  run({ positionals: [dir = '.'], flags }) {
    return reportingFailures(async () => {
      const out = flags.out ?? path.join(dir, 'dist', archiveName(readCourseInfo(dir).courseId));
      const progress = progressReporter();
      const result = await exportProject(dir, out, { history: flags.history, sources: flags.sources, onProgress: progress.onProgress }).finally(progress.end);
      if (flags.json) {
        printJson(result);
        return 0;
      }
      const history = result.history ? `, history: ${result.history.versions} version(s), ${result.history.journalMonths} month(s) of journal` : '';
      const sources = result.sources ? `, ${result.sources.files} file(s) of sources` : '';
      console.log(`✔ Exported ${result.courseId ?? 'the course'} to ${result.file} (${size(result.size)}, ${result.files} files${sources}${history}).`);
      if (!result.sources && sourcesSize(dir).files) console.log('  The author\'s sources (sources/) are not in it: --sources adds them.');
      for (const skipped of result.skipped) console.log(`  left out: ${skipped.path} (${skipped.reason === 'symlink' ? 'a symbolic link' : 'a sync service\'s conflict copy'})`);
      for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
      return 0;
    });
  }
});

// The choices of the import report, as --choose takes them (decision=choice).
const CHOICES: Record<string, { key: keyof ImportChoices; values: readonly string[] }> = {
  presentation: { key: 'presentation', values: ['slides', 'scroll'] },
  backgrounds: { key: 'backgrounds', values: ['drop', 'keep'] },
  timing: { key: 'timing', values: ['together', 'steps'] },
  fonts: { key: 'fonts', values: ['substitute', 'theme'] },
  'media-accessibility': { key: 'mediaAccessibility', values: ['decorative', 'errors'] }
};

function parseChoices(entries: readonly string[]): Partial<ImportChoices> {
  const choices: Record<string, string> = {};
  for (const entry of entries) {
    const [name, value] = entry.split('=');
    const known = CHOICES[name];
    if (!known || !known.values.includes(value)) throw new ArgumentError(`--choose takes decision=choice among ${Object.entries(CHOICES).map(([key, { values }]) => `${key}=${values.join('|')}`).join(', ')} (not ${entry})`);
    choices[known.key] = value;
  }
  return choices as Partial<ImportChoices>;
}

// A Storyline or Rise module made into an Elabora module (beta, docs/decisions.md D47).
async function importForeign(file: string, dir: string | undefined, flags: { title?: string; id?: string; lang?: string; choose?: string[]; json: boolean }): Promise<number> {
  const { importCourse, IMPORT_REPORT_FILE } = await import('@elabora/node/import/index');
  const result = await importCourse({ file, dir, title: flags.title, id: flags.id, language: flags.lang, choices: parseChoices(flags.choose ?? []), author: detectAuthor() });
  if (flags.json) { printJson(result); return result.validation.errors ? 1 : 0; }
  const { report } = result;
  console.log(`✔ Beta import of ${report.source.kind === 'rise' ? 'a Rise 360 export' : report.source.kind === 'storyline-source' ? 'a Storyline project' : 'a course published by Storyline'}: ${result.project ? `project ${shortId(result.project.id)} of the library` : 'a new module'}.\n  ${result.dir}`);
  console.log(`  ${report.summary}`);
  for (const decision of report.decisions) {
    console.log(`  • ${decision.title}`);
    if (decision.choices.length > 1) console.log(`      ${decision.choices.map((choice) => `${decision.id}=${choice.id}${choice.id === decision.applied ? ' (applied)' : ''}`).join(' · ')}`);
  }
  console.log(`  ${report.losses.length} loss(es), each in ${IMPORT_REPORT_FILE}.${result.fonts.length ? ` Fonts embedded: ${result.fonts.join(', ')}.` : ''}`);
  console.log(`  ${result.validation.errors ? '✘' : '✔'} ${result.validation.errors} error(s), ${result.validation.warnings} warning(s) (elabora validate).`);
  return result.validation.errors ? 1 : 0;
}

const importCommand = defineCommand({
  name: 'import',
  flags: { replace: 'optional', copy: 'boolean', json: 'boolean', title: 'string', id: 'string', lang: 'string', choose: 'list' },
  run({ positionals, flags }) {
    // `--replace x.elabora`: the optional value is the archive, not a project id.
    let source = positionals[0];
    let replace = flags.replace;
    if (!source && typeof replace === 'string') {
      source = replace;
      replace = true;
    }
    if (!source) { console.error('Usage: elabora import <archive|folder> [--replace [<id>] | --copy] [--json]\n       elabora import <file.story|published course|Rise export> [dir] [--title <t>] [--choose <decision>=<choice>,…] [--json]'); return 2; }
    if (replace !== undefined && flags.copy) throw new ArgumentError('--replace and --copy exclude each other');
    return reportingFailures(async () => {
      if (!fs.existsSync(source)) throw new Error(`${source} does not exist.`);
      // Storyline and Rise first: what is neither goes on as an Elabora archive or folder.
      const { detectImport } = await import('@elabora/node/import/index');
      const detected = await detectImport(source);
      if (detected.kind && detected.kind !== 'elabora-archive' && detected.kind !== 'elabora-folder') {
        if (replace !== undefined || flags.copy) throw new ArgumentError('--replace and --copy are for Elabora archives: a Storyline or Rise module is always imported as a new module.');
        return importForeign(source, positionals[1], flags);
      }
      if (positionals[1]) throw new ArgumentError(`${source} is ${detected.kind ? detected.reason : 'not a Storyline or Rise module'}: only those are imported into a folder; an Elabora archive or folder goes into the library.`);
      if (flags.title || flags.id || flags.lang || flags.choose) throw new ArgumentError('--title, --id, --lang and --choose are for Storyline and Rise modules.');
      const progress = progressReporter();
      let result;
      try {
        if (fs.statSync(source).isDirectory()) {
          if (replace !== undefined) throw new Error('A folder is always imported as a new project: import it, then trash the project it replaces.');
          result = await importFolder(source, { onProgress: progress.onProgress });
        } else {
          result = await importArchive(source, {
            onExisting: replace !== undefined ? 'replace' : flags.copy ? 'copy' : 'ask',
            replace: typeof replace === 'string' ? resolveProjectId(replace) : undefined,
            author: detectAuthor(),
            onProgress: progress.onProgress
          });
        }
      } finally {
        progress.end();
      }
      if (flags.json) printJson(result);
      if (result.status === 'exists') {
        if (!flags.json) {
          console.error(`✘ The library holds the course ${result.archive.courseId} already:`);
          for (const project of result.existing) console.error(`  ${shortId(project.id).padEnd(10)}${project.title ?? '(no title)'} · modified ${localTime(project.modifiedAt)} · ${project.path}`);
          console.error(`Nothing imported. Run again with --replace${result.existing.length > 1 ? ' <id>' : ''} (its files go to the trash, its history stays) or --copy (a new project beside it).`);
        }
        return 1;
      }
      if (!flags.json) printImported(result);
      return 0;
    });
  }
});

function printImported(result: ImportedProject): void {
  const { project, validation } = result;
  const what = result.replaced ? `Replaced project ${shortId(project.id)} with "${project.title}"` : `Imported "${project.title}" (${project.courseId}) as project ${shortId(project.id)}`;
  console.log(`✔ ${what}.\n  ${project.path}\n  ${validation.errors ? '✘' : '✔'} ${validation.errors} error(s), ${validation.warnings} warning(s).`);
  if (result.history) console.log(`  History: ${result.history.versions} version(s) and ${result.history.journalMonths} month(s) of journal added.`);
  if (result.replaced) {
    console.log(`  The replaced files are in the trash (${result.replaced.trashEntry}).${result.replaced.version ? ` Backup version ${result.replaced.version} holds the project as it was.` : ''}`);
  }
  for (const skipped of result.skipped) console.log(`  left out: ${skipped.path} (${skipped.reason === 'symlink' ? 'a symbolic link' : 'a sync service\'s conflict copy'})`);
}

export const projectLibraryCommands: CommandGroup = {
  title: 'Projects (the app\'s library: one plain folder per project; archives to exchange them)',
  help: HELP,
  commands: [list, pathCommand, create, duplicate, rename, trash, exportCommand, importCommand],
  subcommandUsage: { projects: PROJECTS_USAGE }
};
