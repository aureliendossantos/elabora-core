import type { AboutData, Backdrop, CourseData, ObjectDefinition, PlayerData, ResourceData, SectionData } from '@elabora/player/course-data';
import type { RenderFile, RenderOutline, RenderStyles, RenderView, ScreenRender } from '@elabora/player/canvas-protocol';
import type { Project, Screen } from '../project/model.ts';
import { loadProject, resolveBlockProps, screenBlocks } from '../project/load.ts';
import { createProjectFiles, fileHash, pathsUnder, projectPath, textFile } from '../project/files.ts';
import type { SourceFile } from '../project/files.ts';
import { valuesOfKind } from '../components/props.ts';
import { compileBackdrop, compileScreen, courseHead, courseVariables, createCompileContext, resourcesOf, sortedObjects } from '../compile/course-data.ts';
import { aboutCourse, itemEnabled, packageLanguages, playerConfig, playerContent, shownPlayer } from '../player/config.ts';
import type { CompileContext, CourseHead } from '../compile/course-data.ts';
import { assignKeys, readLock, screenEntities, toggledBlocks, toggledBy } from '../compile/state-model.ts';
import { translatedCourse } from '../i18n/translate.ts';
import { canonicalJSON, sha256, stringifyJSON } from '../util/json.ts';
import { objectsIn } from '../util/values.ts';
import { designStylesheets, inlineSheets, rootStyle, usedTypes } from './styles.ts';
import type { DesignStylesheets } from './styles.ts';

// One screen as the player shows it, in isolation: what the editor canvas needs to show exactly
// what learners will see (same player, templates and stylesheets) without building the course.
// The package's course data comes from the same functions (compileScreen, courseHead), so the
// canvas, captures and packages cannot drift apart.
//
// What every screen shares is computed once, in a RenderContext. Reuse it while course.json,
// plan.json, elabora.lock.json, components/, objects/ manifests and the theme are unchanged; a
// screen file edited since (the common case: an author types, an agent edits a block) may be
// rendered with it. Entities added by such an edit (an activity, a control, a block shown by an
// event) get provisional state keys, the next ones of the lock; a component type the course did
// not use yet brings its stylesheet.

export interface RenderOptions {
  // 'answered': every activity shows its tallest outcome and concealed blocks are shown.
  state?: 'initial' | 'answered';
  // Steps revealed up to this one (default: every step, as captures).
  step?: number;
  // A layer opened over the screen.
  layer?: string;
  // A timed screen as it is when one of its lines starts (or ends), or at a time in seconds (an
  // anchor resolved by anchorTime or resolveAt): its step, its caption, its timed blocks.
  at?: { line: string; edge?: 'start' | 'end' } | { time: number };
  // Every step shown, those after the first faded in their place (the editor's phone width).
  ghost?: boolean;
  // A dialogue of the screen after these choices, at rest (D61; RenderView.dialogue).
  dialogue?: { block: string; choices?: string[]; node?: string };
  // A translation of the course (translations/<language>.xlf; untranslated units keep the source
  // text). Default: the course language. Generated figures stay those of the source.
  language?: string;
  // Mark the elements that show a text prop (data-t-field="options.1.label"): the app's canvas,
  // where the author points at a text to edit it. Never in packages.
  fields?: boolean;
  // What the bars show that depends on the whole course (renderChrome), when the caller keeps it
  // (the engine, which renders it again after a change to any screen); else computed here.
  chrome?: RenderChrome;
}

// What the player's bars show that depends on every screen, not only on the one rendered: the
// outline, the items that show (a narrated screen brings the controls, a generated voice
// « IA et crédits »), « IA et crédits », and the languages a package of every language would hold.
export interface RenderChrome {
  outline: RenderOutline;
  player: PlayerData;
  about: AboutData;
  languages?: string[];
}

// Project files the canvas page asks for, by path in the package (the same path in the project
// folder), and what they are. A host serves them from the project folder; object-code and
// object-frame are generated from the object's folder (objects/<id>/object.js bundled, frame.html).
// hash: of the file's content (the snapshot's), or of what a generated file is made from; the
// canvas loads again what changed at the same path (an image replaced, object.js edited).
export type RenderedFileKind = 'asset' | 'style' | 'font' | 'object' | 'object-code' | 'object-frame';

export interface RenderedFile extends RenderFile {
  kind: RenderedFileKind;
}

export interface RenderedScreen extends ScreenRender {
  styles: RenderStyles;
  files: RenderedFile[];
}

export interface RenderContext {
  // The project the context was made from.
  readonly source: Project;
  // The project screens are compiled from: the source, or its translation.
  readonly project: Project;
  readonly language: string;
  readonly compile: CompileContext;
  // The next key of the lock once every entity of the course has one: provisional keys start there.
  readonly nextKey: number;
  readonly toggled: ReadonlySet<string>;
  readonly head: CourseHead;
  readonly variables: CourseData['variables'];
  readonly backdrop: Backdrop | null;
  readonly backdropObjects: ReadonlyMap<string, ObjectDefinition>;
  readonly design: DesignStylesheets;
  readonly styles: RenderStyles;
  readonly designFiles: readonly RenderedFile[];
  // The resources the bars offer (D58: course.json resources, with the sizes of their files).
  readonly resources: ResourceData[];
}

// What every screen shares: compile context and state keys (as the build assigns them, without
// writing the lock), course-level fields, backdrop, design stylesheets.
export function createRenderContext(project: Project, { language, fields }: Pick<RenderOptions, 'language' | 'fields'> = {}): RenderContext {
  const source = project.course;
  if (!source) throw new Error('The project has no course.json to render.');
  const target = language && language !== source.language ? translatedProject(project, language) : project;
  const assigned = assignKeys(target, readLock(target), { dryRun: true });
  const compile = createCompileContext(target, assigned.keys, { fields });
  const backdropObjects = new Map<string, ObjectDefinition>();
  const backdrop = compileBackdrop(target, compile, backdropObjects);
  const head = courseHead(compile);
  const design = designStylesheets(target, compile.registry, usedTypes(target));
  return {
    source: project, project: target, language: compile.course.language, compile, nextKey: assigned.lock.next, toggled: toggledBlocks(target),
    head, variables: courseVariables(compile), backdrop, backdropObjects, design, styles: renderStyles(design, head), designFiles: designFiles(target, design),
    resources: resourcesOf(target, compile)
  };
}

// The bars' part that depends on every screen (RenderChrome), in the language shown.
export function renderChrome(project: Project, { language: asked }: { language?: string } = {}, context?: RenderContext): RenderChrome {
  const sourceLanguage = project.course?.language;
  const language = asked || sourceLanguage;
  const shared = context && context.language === language ? context : createRenderContext(project, { language: asked });
  const target = shared.source === project ? shared.project : language !== sourceLanguage && language ? translatedProject(project, language) : project;
  // « Langue » enabled: the languages a package of every language would hold (D59).
  const languages = itemEnabled(playerConfig(project.course), 'language') ? packageLanguages(project) : undefined;
  const several = languages && languages.length > 1 ? languages : undefined;
  const player = shownPlayer(playerConfig(target.course), playerContent(target, { languages: several?.length ?? 1 }), { assetPath: shared.compile.assetPath });
  return { outline: outlineOf(shared, target), player, about: aboutCourse(target), ...(several ? { languages: several } : {}) };
}

export function renderScreen(project: Project, screenId: string, options: RenderOptions = {}, context?: RenderContext): RenderedScreen {
  const sourceLanguage = project.course?.language;
  const language = options.language || sourceLanguage;
  const shared = context && context.language === language ? context : createRenderContext(project, { language: options.language, fields: options.fields });
  // The context's own project, or the project edited since (translated when the context is).
  const target = shared.source === project ? shared.project : language !== sourceLanguage && language ? translatedProject(project, language) : project;
  const screen = target.screens.get(screenId)?.data;
  if (!screen) throw new Error(`Screen "${screenId}" not found (screens/${screenId}.json).`);
  const edited = target !== shared.project;
  const compile = edited ? withProvisionalKeys(shared, screenId, screen) : shared.compile;
  const compiled = compileScreen(target, screenId, compile);

  const objects = new Map(shared.backdropObjects);
  for (const [id, definition] of compiled.objects) objects.set(id, definition);
  const section = objectsIn(shared.compile.course.sections).find((candidate) => candidate.id === compiled.screen.section);
  const sections: SectionData[] = section ? [{ ...section, screens: [screenId] }] : [];
  const chrome = options.chrome ?? renderChrome(project, { language: options.language }, shared);
  const course: CourseData = {
    ...shared.head,
    ...(chrome.languages ? { languages: chrome.languages } : {}),
    player: chrome.player,
    ...(shared.backdrop ? { backdrop: shared.backdrop } : {}),
    sections,
    screens: [compiled.screen],
    variables: shared.variables,
    objects: sortedObjects(objects),
    ...(shared.resources.length ? { resources: shared.resources } : {}),
    ...(chrome.about.ai || chrome.about.credits ? { about: chrome.about } : {}),
    build: { id: 'canvas' }
  };

  // A component type the course did not use when the context was made brings its stylesheet.
  const design = edited && missingStylesheet(shared, screen) ? designStylesheets(target, shared.compile.registry, [...usedTypes(shared.project), ...screenTypes(screen)]) : null;
  const styles = design ? renderStyles(design, shared.head) : shared.styles;
  const files = new Map<string, RenderedFile>();
  for (const file of screenFiles(target, screen, compile, course.objects)) files.set(file.path, file);
  for (const file of design ? designFiles(target, design) : shared.designFiles) if (!files.has(file.path)) files.set(file.path, file);
  for (const file of chromeFiles(target, chrome.player, shared.resources)) if (!files.has(file.path)) files.set(file.path, file);

  const view: RenderView = { state: options.state === 'answered' ? 'answered' : 'initial', step: options.step ?? null, layer: options.layer ?? null, ...(options.at ? { at: options.at } : {}), ...(options.ghost ? { ghost: true } : {}), ...(options.dialogue ? { dialogue: options.dialogue } : {}) };
  return { screen: screenId, course, view, styles, files: [...files.values()], outline: chrome.outline };
}

// The course's screens in order, by section, with their titles in the language shown (the live
// bars' outline, Previous and Next). A screen listed without its file is left out.
function outlineOf(shared: RenderContext, target: Project): RenderOutline {
  return {
    sections: objectsIn(shared.compile.course.sections).map((section) => ({
      id: section.id, title: section.title,
      screens: (section.screens ?? []).filter((id) => target.screens.has(id)).map((id) => ({ id, title: target.screens.get(id)?.data.title ?? id }))
    }))
  };
}

// The files of the bars: the logo's, and the resources' (their preview and their download).
function chromeFiles(project: Project, player: PlayerData, resources: readonly ResourceData[]): RenderedFile[] {
  const paths = new Set<string>();
  for (const bar of [player.top, player.bottom]) for (const item of bar?.items ?? []) if (item.id === 'logo') paths.add(item.src);
  for (const resource of resources) if (resource.kind === 'file') paths.add(resource.src);
  return [...paths].flatMap((src) => { const path = projectPath(src); return path === null ? [] : [{ path, kind: 'asset' as const, hash: fileHash(project.files, path) }]; });
}

// State keys of the entities a screen edited since the context was made adds, after those of the
// lock (rendering never writes the lock: the next build assigns the real ones).
function withProvisionalKeys(shared: RenderContext, screenId: string, screen: Screen): CompileContext {
  const toggled = new Set([...shared.toggled, ...toggledBy(screen)]);
  const keys = shared.compile.keys;
  const missing = screenEntities(shared.project, screenId, screen, toggled).filter((entity) => !(entity in keys));
  if (!missing.length) return shared.compile;
  const added = Object.fromEntries(missing.map((entity, index) => [entity, (shared.nextKey + index).toString(36)]));
  return { ...shared.compile, keys: { ...keys, ...added } };
}

// Types a screen uses: its layout and its blocks (layers and slots included).
function screenTypes(screen: Screen): string[] {
  return [...(typeof screen.layout === 'string' ? [screen.layout] : []), ...[...screenBlocks(screen)].map(({ block }) => block.type)];
}

function missingStylesheet(shared: RenderContext, screen: Screen): boolean {
  const known = new Set(shared.design.components);
  return screenTypes(screen).some((type) => (shared.compile.registry.get(type)?.cssChain || []).some((id) => !known.has(id)));
}

function renderStyles(design: DesignStylesheets, head: CourseHead): RenderStyles {
  const sheets = inlineSheets(design, rootStyle(head.tokens, head.presentation));
  return { hash: sha256(canonicalJSON(sheets)).slice(0, 16), sheets };
}

function designFiles(project: Project, design: DesignStylesheets): RenderedFile[] {
  const files = new Map<string, RenderedFileKind>();
  for (const sheet of design.sheets) for (const path of sheet.files) if (!files.has(path)) files.set(path, 'style');
  for (const font of design.fonts) { const path = projectPath(font.src); if (path !== null && !files.has(path)) files.set(path, 'font'); }
  return [...files].map(([path, kind]) => ({ path, kind, hash: fileHash(project.files, path) }));
}

// Assets of the screen's blocks and layout (props of kind asset, as the build ships them) and the
// files of the free objects it places.
function screenFiles(project: Project, screen: Screen, compile: CompileContext, objects: Readonly<Record<string, ObjectDefinition>>): RenderedFile[] {
  const { registry, planIndex } = compile;
  const files: RenderedFile[] = [];
  const add = (path: string | null, kind: RenderedFileKind, hash = path === null ? null : fileHash(project.files, path)) => { if (path !== null) files.push({ path, kind, hash }); };
  const asset = (value: unknown) => add(typeof value === 'string' ? projectPath(`assets/${value}`) : null, 'asset');
  for (const { block } of screenBlocks(screen)) {
    const descriptor = registry.get(block.type);
    if (descriptor) for (const found of valuesOfKind(descriptor.schema, resolveBlockProps(block, planIndex, registry), 'asset')) asset(found.value);
  }
  const layout = typeof screen.layout === 'string' ? registry.get(screen.layout) : undefined;
  if (layout && screen.layoutProps) for (const found of valuesOfKind(layout.schema, screen.layoutProps, 'asset')) asset(found.value);
  for (const definition of Object.values(objects)) {
    // The frame is made from the manifest (and the course language), object.js from every file of
    // the object's folder (the code and what it imports).
    const manifest = `${definition.dir}/object.manifest.json`;
    add(`${definition.dir}/frame.html`, 'object-frame', `sha256:${sha256(`${fileHash(project.files, manifest) ?? ''}|${compile.course.language}`)}`);
    add(`${definition.dir}/object.js`, 'object-code', `sha256:${sha256(pathsUnder(project.files, definition.dir).map((path) => `${path}:${fileHash(project.files, path) ?? ''}`).join('\n'))}`);
    for (const file of definition.assets) add(typeof file.file === 'string' ? projectPath(`${definition.dir}/${file.file}`) : null, 'object');
  }
  return files;
}

// The course in another language, as `elabora translate build` writes it (course.json, plan.json and
// the screens with the translations applied), in memory. Untranslated units keep the source text,
// and so do translations that break it (a lost placeholder, too long): the language shows as far as
// it goes while it is being written.
const translations = new WeakMap<Project, Map<string, Project>>();
export function translatedProject(project: Project, language: string): Project {
  let byLanguage = translations.get(project);
  if (!byLanguage) { byLanguage = new Map(); translations.set(project, byLanguage); }
  const cached = byLanguage.get(language);
  if (cached) return cached;
  const { files: documents } = translatedCourse(project, { to: language, allowMissing: true, skipBroken: true });
  const entries: [string, SourceFile][] = [];
  for (const [path, file] of project.files) {
    if (path.startsWith('translations/') || path.startsWith('plan-versions/')) continue;
    const document = documents.get(path);
    entries.push([path, document ? textFile(stringifyJSON(document)) : file]);
  }
  // The translated plan's validated version, when its translation is approved.
  for (const [path, document] of documents) if (path.startsWith('plan-versions/')) entries.push([path, textFile(stringifyJSON(document))]);
  const translated = loadProject(createProjectFiles(entries), { root: project.root });
  byLanguage.set(language, translated);
  return translated;
}
