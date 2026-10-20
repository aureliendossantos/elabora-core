import { loadProject } from '@elabora/core/project/load';
import { readText } from '@elabora/core/project/files';
import { parseJSON } from '@elabora/core/util/json';
import type { MediaStatus, ProjectFiles, SourceFile, SyncArtefact } from '@elabora/core/project/files';
import { sameContent } from '@elabora/core/ops/json';
import type { LoadError, Project, Screen, ScreenEntry } from '@elabora/core/project/model';
import { COURSE_CHECKS, FILE_CHECKS, createValidationContext, ignoredOf, validateScreen } from '@elabora/core/validate/index';
import type { Check, CheckContext, ValidationContext, ValidationOptions } from '@elabora/core/validate/index';
import { hasCourse, startRun } from '@elabora/core/validate/context';
import { applyIgnored, applyWaivers, createReporter, sortDiagnostics, summarize } from '@elabora/core/diagnostics/index';
import type { Diagnostic, Summary } from '@elabora/core/diagnostics/index';

// The project a session holds in memory: the files snapshot (what the journal knows of the folder),
// the project loaded from it, a validation context, and the findings per screen and for the project
// checks, kept up to date incrementally (docs/architecture/engine.md):
//   - a screen file changed: its screen checks run again, then the screen checks of the screens that
//     mention an id whose content changed in it (checks that read other screens: visited conditions,
//     duplicate block ids, go-to targets), and the project checks that read screens (the others keep
//     their findings: object code and component templates are not analysed again);
//   - an asset changed: the screens that mention it, and every project check;
//   - any other project file (course.json, plan, components, objects, theme…): everything;
//   - the media status (jobs under way, unreadable media): the screens that name the files whose
//     status changed (I_MEDIA_PROCESSING or E_ASSET_MISSING), and every project check.
// A JSON file whose text on disk does not parse keeps its last valid content in the snapshot; its
// parse error is reported in its screen's findings (or the project's) until it parses again.

export interface DiagnosticsDelta {
  screens: Map<string, Diagnostic[]>; // screens whose findings changed
  removed: string[]; // screens that are gone
  project: Diagnostic[] | null; // the project findings, when they changed
  summary: Summary;
}

// Files no check reads.
const NOT_VALIDATED = /^(AGENTS\.md|CLAUDE\.md|README\.md|translations\/.*)$/;
const SCREEN_FILE = /^screens\/([^/]+)\.json$/;

export class ProjectState {
  readonly root: string;
  readonly options: ValidationOptions;
  #files: ProjectFiles;
  #artefacts: SyncArtefact[];
  #media: MediaStatus | undefined;
  #project: Project;
  #context: ValidationContext;
  #broken = new Map<string, string>(); // path → parse error of the text on disk
  // What the checks found, and the project they found it in.
  #screenFindings = new Map<string, Diagnostic[]>();
  #projectFindings: Diagnostic[] = [];
  #projectByCheck = new Map<string, Diagnostic[]>();
  #validated: Project;
  // What the last delta reported: findings plus parse errors.
  #reportedScreens = new Map<string, Diagnostic[]>();
  #reportedProject: Diagnostic[] = [];
  // Changes since the last validation, and since the last takeChanged (renders).
  #pending = new Set<string>();
  #changed = new Set<string>();
  #pendingProjectChecks = false; // those that read screens (load errors)
  #pendingAllProjectChecks = false;
  #brokenChanged = new Set<string>();

  constructor(root: string, files: ProjectFiles, artefacts: SyncArtefact[], options: ValidationOptions = {}, media?: MediaStatus) {
    this.root = root;
    this.options = options;
    this.#files = files;
    this.#artefacts = artefacts;
    this.#media = media;
    this.#project = loadProject(files, { root, artefacts, ...(media ? { media } : {}) });
    this.#context = createValidationContext(this.#project, options);
    this.#validated = this.#project;
    for (const id of this.#project.screens.keys()) this.#screenFindings.set(id, validateScreen(this.#context, id));
    this.#runProjectChecks(false);
    for (const id of this.#project.screens.keys()) this.#reportedScreens.set(id, this.#assembleScreen(id));
    this.#reportedProject = this.#assembleProject();
  }

  get files(): ProjectFiles { return this.#files; }
  get project(): Project { return this.#project; }
  get context(): ValidationContext { return this.#context; }
  get artefacts(): readonly SyncArtefact[] { return this.#artefacts; }
  get media(): MediaStatus | undefined { return this.#media; }
  brokenError(path: string): string | undefined { return this.#broken.get(path); }

  // Sets or removes files (null: deleted). Returns the paths whose content changed.
  update(changes: Iterable<readonly [string, SourceFile | null]>): string[] {
    let next: Map<string, SourceFile> | null = null;
    const changed: string[] = [];
    for (const [path, file] of changes) {
      const current = (next ?? this.#files).get(path);
      if (file === null ? current === undefined : current === file) continue;
      // The same content read again keeps its entry (and what it knows: a media verdict), unless
      // the new entry brings a verdict the old one lacks.
      if (file && current && sameContent(current, file) && !(file.kind === 'binary' && file.media && !(current.kind === 'binary' && current.media))) continue;
      next ??= new Map(this.#files);
      if (file === null) next.delete(path);
      else next.set(path, file);
      changed.push(path);
    }
    if (!next) return [];
    this.#files = next;
    for (const path of changed) {
      this.#pending.add(path);
      this.#changed.add(path);
    }
    this.#reload(changed);
    return changed;
  }

  // The text on disk of a JSON file does not parse (error), or parses again (null).
  setBroken(path: string, error: string | null): boolean {
    if ((this.#broken.get(path) ?? null) === error) return false;
    if (error === null) this.#broken.delete(path);
    else this.#broken.set(path, error);
    this.#brokenChanged.add(path);
    return true;
  }

  // What the store knows of media changed: jobs under way (their outputs), unreadable media, ffprobe.
  setMedia(media: MediaStatus): boolean {
    const before = this.#media ?? { processing: [], unreadable: [], toolsMissing: false };
    // Each fact by a key, with the file it is about.
    const facts = (status: MediaStatus) => new Map<string, string>([
      ...status.processing.map((path): [string, string] => [JSON.stringify(['processing', path]), path]),
      ...status.unreadable.map(({ path, message }): [string, string] => [JSON.stringify(['unreadable', path, message]), path])
    ]);
    const was = facts(before);
    const now = facts(media);
    const moved = [...[...was].filter(([key]) => !now.has(key)), ...[...now].filter(([key]) => !was.has(key))].map(([, path]) => path);
    if (!moved.length && before.toolsMissing === media.toolsMissing) return false;
    this.#media = media;
    // Each file whose status changed is re-checked as a changed asset would be (its screens, and
    // every project check).
    for (const path of moved) this.#pending.add(path);
    if (before.toolsMissing !== media.toolsMissing) this.#pendingAllProjectChecks = true;
    this.#project = { ...this.#project, media };
    this.#context = createValidationContext(this.#project, this.options);
    return true;
  }

  setArtefacts(artefacts: SyncArtefact[]): void {
    const key = (list: readonly SyncArtefact[]) => JSON.stringify(list.map((a) => [a.path, a.kind, a.original]).sort());
    if (key(artefacts) === key(this.#artefacts)) return;
    this.#artefacts = artefacts;
    this.#pendingProjectChecks = true; // they are load errors, reported by a project check
    this.#reload([]);
  }

  // When only screen files changed (an author typing, an agent editing blocks), the project is the
  // previous one with those screens replaced: nothing else is parsed again, and the components (so
  // the registry and the analyses of templates) stay the same objects.
  // A project in another format than this Elabora's is read whole (an older one is migrated in memory:
  // its files are not the snapshot's).
  #reload(changed: readonly string[]): void {
    const current = !this.#project.migration && !this.#project.loadErrors.some((error) => error.code === 'E_FORMAT_NEWER');
    const screensOnly = current && changed.length > 0 && changed.every((path) => SCREEN_FILE.test(path));
    this.#project = screensOnly
      ? withScreens(this.#project, this.#files, changed)
      : loadProject(this.#files, { root: this.root, artefacts: this.#artefacts, ...(this.#media ? { media: this.#media } : {}) });
    this.#context = createValidationContext(this.#project, this.options);
  }

  // Runs the checks the changes since the last call affect. Returns what changed in the findings,
  // or null when nothing did.
  validate(): DiagnosticsDelta | null {
    const touched = [...this.#pending];
    this.#pending.clear();
    const project = this.#project;
    let full = false;
    let projectChecks = this.#pendingProjectChecks || this.#pendingAllProjectChecks;
    const allProjectChecks = this.#pendingAllProjectChecks;
    this.#pendingProjectChecks = false;
    this.#pendingAllProjectChecks = false;
    const touchedScreens = new Set<string>();
    const assets: string[] = [];
    for (const path of touched) {
      const screen = SCREEN_FILE.exec(path);
      if (screen) touchedScreens.add(screen[1]);
      else if (path.startsWith('assets/')) assets.push(path);
      else if (!NOT_VALIDATED.test(path)) full = true;
    }

    const screens = new Set<string>();
    // Only the project checks that read screens, when nothing but screens changed.
    const screensOnly = !full && !assets.length && !allProjectChecks;
    if (full) {
      for (const id of project.screens.keys()) screens.add(id);
      projectChecks = true;
    } else if (touchedScreens.size || assets.length) {
      projectChecks = true;
      const changedIds = new Set<string>();
      for (const id of touchedScreens) {
        changedSignatures(this.#validated.screens.get(id)?.data, project.screens.get(id)?.data, changedIds);
        if (project.screens.has(id)) screens.add(id);
      }
      const needles = [...[...changedIds].map((id) => JSON.stringify(id)), ...assets.map((path) => path.slice('assets/'.length))];
      if (needles.length) {
        for (const [id, entry] of project.screens) {
          if (screens.has(id)) continue;
          const text = readText(this.#files, entry.file) ?? '';
          if (needles.some((needle) => text.includes(needle))) screens.add(id);
        }
      }
    }

    const removed: string[] = [];
    for (const id of [...this.#screenFindings.keys()]) {
      if (project.screens.has(id)) continue;
      this.#screenFindings.delete(id);
      removed.push(id);
    }
    for (const id of screens) this.#screenFindings.set(id, validateScreen(this.#context, id));
    if (projectChecks) this.#runProjectChecks(screensOnly);
    this.#validated = project;

    // Parse errors of files on disk: their screen's list, or the project's.
    let projectCandidate = projectChecks;
    for (const path of this.#brokenChanged) {
      const screen = SCREEN_FILE.exec(path);
      if (screen && project.screens.has(screen[1])) screens.add(screen[1]);
      else projectCandidate = true;
    }
    this.#brokenChanged.clear();

    const delta: DiagnosticsDelta = { screens: new Map(), removed: [], project: null, summary: summarize([]) };
    for (const id of removed) {
      if (this.#reportedScreens.delete(id)) delta.removed.push(id);
    }
    for (const id of screens) {
      const list = this.#assembleScreen(id);
      if (!sameList(list, this.#reportedScreens.get(id))) {
        this.#reportedScreens.set(id, list);
        delta.screens.set(id, list);
      }
    }
    if (projectCandidate) {
      const list = this.#assembleProject();
      if (!sameList(list, this.#reportedProject)) {
        this.#reportedProject = list;
        delta.project = list;
      }
    }
    if (!delta.screens.size && !delta.removed.length && !delta.project) return null;
    delta.summary = this.summary;
    return delta;
  }

  // The paths whose content changed since the last call.
  takeChanged(): string[] {
    const paths = [...this.#changed];
    this.#changed.clear();
    return paths;
  }

  // Whether changes wait for validate().
  get stale(): boolean {
    return this.#pending.size > 0 || this.#pendingProjectChecks || this.#pendingAllProjectChecks || this.#brokenChanged.size > 0;
  }

  get summary(): Summary {
    const all: Diagnostic[] = [...this.#reportedProject];
    for (const list of this.#reportedScreens.values()) all.push(...list);
    return summarize(all);
  }

  // Findings as last reported: per screen, and the project's.
  diagnostics(): { screens: Map<string, Diagnostic[]>; project: Diagnostic[]; summary: Summary } {
    return { screens: new Map(this.#reportedScreens), project: this.#reportedProject, summary: this.summary };
  }

  // A screen's findings and the project findings located in its file.
  screenDiagnostics(id: string): Diagnostic[] {
    const file = this.#project.screens.get(id)?.file ?? `screens/${id}.json`;
    return sortDiagnostics([...(this.#reportedScreens.get(id) ?? []), ...this.#reportedProject.filter((d) => d.file === file)]);
  }

  // The project checks in their order, as validateProjectChecks runs them, keeping the findings of
  // each; screensOnly: only those that read screens run again, the others keep their findings.
  #runProjectChecks(screensOnly: boolean): void {
    const run = startRun(this.#context);
    const runChecks = <C extends CheckContext>(checks: readonly Check<C>[], context: C) => {
      for (const check of checks) {
        if (check.scope !== 'project' || (screensOnly && !check.readsScreens)) continue;
        const start = context.reporter.items.length;
        check.run(context);
        this.#projectByCheck.set(check.name, context.reporter.items.slice(start));
      }
    };
    runChecks(FILE_CHECKS, run);
    if (hasCourse(run)) runChecks(COURSE_CHECKS, run);
    else for (const check of COURSE_CHECKS) this.#projectByCheck.delete(check.name);
    const waivers = Array.isArray(this.#project.plan?.waivers) ? this.#project.plan.waivers.filter((waiver) => waiver !== null && waiver !== undefined) : [];
    applyIgnored(applyWaivers(run.reporter.items, waivers), ignoredOf(this.#project.course));
    const findings: Diagnostic[] = [];
    for (const check of [...FILE_CHECKS, ...COURSE_CHECKS]) findings.push(...(this.#projectByCheck.get(check.name) ?? []));
    this.#projectFindings = sortDiagnostics(findings);
  }

  #assembleScreen(id: string): Diagnostic[] {
    const findings = this.#screenFindings.get(id) ?? [];
    const error = this.#broken.get(`screens/${id}.json`);
    return error === undefined ? findings : sortDiagnostics([parseError(`screens/${id}.json`, error), ...findings]);
  }

  #assembleProject(): Diagnostic[] {
    const errors: Diagnostic[] = [];
    for (const [path, error] of this.#broken) {
      const screen = SCREEN_FILE.exec(path);
      if (!screen || !this.#project.screens.has(screen[1])) errors.push(parseError(path, error));
    }
    return errors.length ? sortDiagnostics([...errors, ...this.#projectFindings]) : this.#projectFindings;
  }
}

// The project with some screen files read again, as loadProject reads them (screens in file name
// order, a file that does not parse reported as a load error).
export function withScreens(project: Project, files: ProjectFiles, paths: readonly string[]): Project {
  const changed = new Set(paths);
  const screens = new Map<string, ScreenEntry>();
  for (const [id, entry] of project.screens) if (!changed.has(entry.file)) screens.set(id, entry);
  const loadErrors: LoadError[] = project.loadErrors.filter((error) => !changed.has(error.file));
  for (const file of paths) {
    const text = readText(files, file);
    if (text === null) continue; // deleted
    const parsed = parseJSON(text);
    if (parsed.error !== undefined) loadErrors.push({ code: 'E_JSON_PARSE', file, message: parsed.error });
    else if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) loadErrors.push({ code: 'E_SCHEMA', file, message: '/: must be object (schema screen)' });
    else screens.set((SCREEN_FILE.exec(file) as RegExpExecArray)[1], { file, data: parsed.value as Screen });
  }
  const ordered = new Map([...screens].sort(([, a], [, b]) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)));
  return { ...project, files, screens: ordered, loadErrors };
}

function parseError(path: string, error: string): Diagnostic {
  return createReporter().emit('E_JSON_PARSE', { file: path, message: `${path} does not parse (${error}): its last valid content is used until it is fixed.` });
}

function sameList(a: readonly Diagnostic[], b: readonly Diagnostic[] | undefined): boolean {
  return b !== undefined && a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

// The content of each element with an id (screen, layers, blocks, events…), by id: what other
// screens may read of this one.
function signatures(value: unknown, out: Map<string, string>): Map<string, string> {
  if (Array.isArray(value)) {
    for (const item of value) signatures(item, out);
  } else if (value !== null && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') out.set(id, (out.get(id) ?? '') + JSON.stringify(value));
    for (const item of Object.values(value)) signatures(item, out);
  }
  return out;
}

// Adds the ids whose element was added, removed or changed between two versions of a screen.
export function changedSignatures(before: unknown, after: unknown, out: Set<string>): Set<string> {
  const was = signatures(before, new Map());
  const now = signatures(after, new Map());
  for (const [id, signature] of was) if (now.get(id) !== signature) out.add(id);
  for (const id of now.keys()) if (!was.has(id)) out.add(id);
  return out;
}
