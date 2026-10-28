import fs from 'node:fs';
import path from 'node:path';
import type { Course, Diagnostic, LmsProfile, Plan, PlanWaiver } from '@elabora/format';
import type { Project } from '@elabora/core/project/model';
import { findItem, packageLanguages, playerConfig } from '@elabora/core/player/config';
import { translatedProject } from '@elabora/core/render/screen';
import { translationPath, translationReady, translationStatus } from '@elabora/core/i18n/translate';
import { planContentHash, iterateBlocks, screenOrder, resolveBlockProps, planIndex } from '@elabora/core/project/load';
import { latestValidated, planState, versionLabel } from '@elabora/core/project/plan-versions';
import { planDiff } from '@elabora/core/project/plan-diff';
import { planCourse } from '@elabora/core/project/plan-order';
import type { PlanApprovalState } from '@elabora/core/project/plan-versions';
import { validateProject } from '@elabora/core/validate/index';
import { createReporter, applyIgnored, applyWaivers, summarize, sortDiagnostics } from '@elabora/core/diagnostics/index';
import { ignoredOf } from '@elabora/core/validate/index';
import type { Reporter, Summary } from '@elabora/core/diagnostics/index';
import { canonicalJSON, stringifyJSON } from '@elabora/core/util/json';
import { escapeHtml } from '@elabora/core/util/html';
import { readLock, assignKeys, buildStateModel, syncComponentVersions } from '@elabora/core/compile/state-model';
import { worstCaseLength } from '@elabora/player/state-codec';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { scorm12Manifest, structureFingerprint } from '@elabora/core/compile/scorm12-manifest';
import { listProfiles, resolveProfiles, scorm12Limits, targetProfileIds } from '@elabora/core/lms/profiles';
import { packageBreaches, packageFileKind, packageLimitFindings } from '@elabora/core/lms/package-limits';
import type { PackageFile } from '@elabora/core/lms/package-limits';
import type { Scorm12Limits } from '@elabora/core/lms/profiles';
import { proofMarkdown } from '@elabora/core/compile/proof';
import type { BuildReport, PlanCoverage, ReportPlan, ReportWeb } from '@elabora/core/compile/report';
import type { BuildTarget } from '@elabora/core/validate/context';
import type { WebBuildOptions, WebNavigation, WebProgress, WebReviewOptions } from './build-types.ts';
import { reviewOrigin } from '@elabora/player/review-protocol';
import type { WebDelivery } from '@elabora/player/course-data';
import { designStylesheets, rootStyle, usedTypes } from '@elabora/core/render/styles';
import { readProvenance } from '@elabora/core/project/generators';
import { isFontPath, fontLicenses } from '@elabora/core/project/fonts';
import { interfaceSounds, shippedPlayerSounds, soundAssets } from '@elabora/core/sounds/sounds';
import type { SoundsData } from '@elabora/player/course-data';
import { getRegistry, componentHash } from '@elabora/core/components/registry';
import type { Registry } from '@elabora/core/components/registry';
import { valuesOfKind } from '@elabora/core/components/props';
import { runtimeFiles, reviewFiles, playerSoundFile, vendorThree, compileObjectCode, objectFrameHtml, bundleErrorMessage, ELABORA_VERSION } from './bundles.ts';
import { planZip, writeZip, hashZip, ZipLimitError } from './packaging/zip-writer.ts';
import type { ZipInput, ZipPlan } from './packaging/zip-writer.ts';
import { packageMedia, packageSizes, mediaQualityOf } from './packaging/media.ts';
import type { MediaProgress } from './packaging/media.ts';
import type { PresetName } from '@elabora/core/media/presets';
import { MEDIA_EXTENSIONS, extensionOf } from '@elabora/core/media/conformance';
import { isSourcePath, projectPath, SOURCES_DIR, fileHash } from '@elabora/core/project/files';
import { cloneFile } from './blobs.ts';
import { loadProjectFromDir } from './project-reader.ts';
import { writeLock } from './state-lock.ts';
import { writeFileAtomic, sha256Hex as sha256 } from './util/fs.ts';
import { gatesStatus } from './objects/gates-record.ts';
import { narrationTracks, trackName } from './narration/tracks.ts';
import { dialogueLineAudio } from './narration/dialogue-audio.ts';
import type { DialogueLineAudio } from './narration/dialogue-audio.ts';
import type { PackagedLines } from '@elabora/core/dialogue/voices';

const PORTABLE = /^[A-Za-z0-9._/-]+$/;

export interface BuildOptions {
  profiles?: string[]; // target LMS profile ids (default: course.json delivery.lms, else ['unknown'], the strictest values)
  release?: boolean; // client delivery (approved plan required)
  out?: string; // output folder (default <project>/dist)
  emit?: 'zip' | 'dir' | 'both'; // 'dir' is used by preview and tests
  debug?: boolean; // unminified runtime
  writeLock?: boolean; // false: leave elabora.lock.json as it is (previews, captures)
  mediaQuality?: PresetName; // overrides course.json delivery.mediaQuality (default high: the masters)
  // 'link' (the preview): media are not written to the output folder; result.media says where they
  // are, and media a job is still writing are listed with null instead of stopping the build.
  media?: 'copy' | 'link';
  onMedia?: (progress: MediaProgress) => void; // renditions being encoded
  // A preview (elabora preview, the app's Aperçu): errors under a rule of the guardrails or of the
  // delivery checklist (accessibility, plan coverage, package limits) are reported without stopping
  // it, since the course runs without what they ask; errors of the course itself (format,
  // references, components, objects) still do.
  preview?: boolean;
  // What the build makes (docs/decisions.md D41): scorm12 (default), a SCORM 1.2 package for LMSs;
  // web, a module for a plain web server (<course>-<version>-web/ and its ZIP): no imsmanifest.xml,
  // no LMS profile or LMS rule, its own index.html (description, sharing image, noindex).
  target?: BuildTarget;
  web?: WebBuildOptions; // the web target's settings (refused with scorm12)
  // 'all': one package of every language (D59): the course's own and each translation that is ready
  // and approved, which learners switch in place (the player's language item). Default: the course's
  // own language only.
  languages?: 'all';
}

export type { WebBuildOptions, WebNavigation, WebProgress, WebReviewOptions } from './build-types.ts';

// The web target's defaults: a publication, as the course was designed and resumed where the
// learner left (D41). A showcase says progress none and navigation free.
export const WEB_DEFAULTS = { progress: 'local', navigation: 'authored' } as const satisfies Required<Pick<WebBuildOptions, 'progress' | 'navigation'>>;
// A review build's defaults (D42): a reviewer goes anywhere, keeps nothing, and the link stays out of
// search engines.
export const WEB_REVIEW_DEFAULTS = { progress: 'none', navigation: 'free', noindex: true } as const satisfies Required<Pick<WebBuildOptions, 'progress' | 'navigation' | 'noindex'>>;
export const WEB_PROGRESS: readonly WebProgress[] = ['local', 'none'];
export const WEB_NAVIGATION: readonly WebNavigation[] = ['authored', 'free'];

// The target and its settings, checked: a wrong value is a caller's mistake (the CLI, the MCP server
// and the engine check what people and agents give them first).
function targetOf(options: BuildOptions): { target: BuildTarget; web: Required<Pick<WebBuildOptions, 'progress' | 'navigation' | 'noindex'>> & Pick<WebBuildOptions, 'url' | 'image' | 'review'> | null } {
  const target = options.target ?? 'scorm12';
  if (target !== 'scorm12' && target !== 'web') throw new TypeError(`target is scorm12 or web (not ${JSON.stringify(target)})`);
  if (target !== 'web') {
    if (options.web !== undefined) throw new TypeError('web settings are for the web target (target: "web")');
    return { target, web: null };
  }
  if (options.profiles?.length) throw new TypeError('LMS profiles are for the scorm12 target: a module for the web reports to no LMS');
  const review = options.web?.review;
  if (review !== undefined && (typeof review !== 'object' || review === null || !Array.isArray(review.origins) || !review.origins.every((origin) => typeof origin === 'string'))) throw new TypeError('web review is { origins: string[] }');
  const defaults = review ? WEB_REVIEW_DEFAULTS : { ...WEB_DEFAULTS, noindex: false };
  const { progress = defaults.progress, navigation = defaults.navigation, noindex = defaults.noindex, url, image } = options.web ?? {};
  if (!WEB_PROGRESS.includes(progress)) throw new TypeError(`web progress is local or none (not ${JSON.stringify(progress)})`);
  if (!WEB_NAVIGATION.includes(navigation)) throw new TypeError(`web navigation is authored or free (not ${JSON.stringify(navigation)})`);
  return { target, web: { progress, navigation, noindex: noindex === true, ...(url !== undefined ? { url } : {}), ...(image !== undefined ? { image } : {}), ...(review ? { review: { origins: [...review.origins] } } : {}) } };
}

// The build stopped (validation or packaging errors): nothing was written but the lock.
export interface BuildFailure {
  ok: false;
  diagnostics: Diagnostic[];
  summary: Summary;
  report?: undefined;
  files?: undefined;
  media?: undefined;
  zipPath?: undefined;
  dirPath?: undefined;
  reportPath?: undefined;
}

// The package was made (a preview's may come with errors: see BuildOptions.preview).
export interface BuildSuccess {
  ok: true;
  diagnostics: Diagnostic[];
  summary: Summary;
  report: BuildReport;
  files: Map<string, Buffer>; // the package's files held in memory, by path
  // The package's media, by path: the file on disk (a master or a rendition) the ZIP streams and the
  // folder clones; null: a media job is still writing it (media: 'link' only).
  media: Map<string, string | null>;
  zipPath?: string; // emit zip or both
  dirPath?: string; // emit dir or both
  reportPath: string;
}

export type BuildResult = BuildFailure | BuildSuccess;
// The build report (<course>-<version>-<target>.report.json) is described in @elabora/core: the proof
// dossier and `elabora diff` read it there.
export type { BuildReport };

export async function build(dir: string, options: BuildOptions = {}): Promise<BuildResult> {
  const { target, web } = targetOf(options);
  const project = loadProjectFromDir(dir);
  const profiles = web ? [] : targetProfileIds(project.course, options.profiles);
  const validation = validateProject(project, { profiles, release: !!options.release, target });
  const { course, plan } = project;
  const stops = (items: readonly Diagnostic[]) => items.some((d) => d.severity === 'error' && !d.waived && !(options.preview && d.rule));
  // A project without course.json or plan.json does not validate.
  if (stops(validation.diagnostics) || !course || !plan) return { ok: false, diagnostics: validation.diagnostics, summary: validation.summary };

  const reporter = createReporter();
  reporter.merge(validation.diagnostics);
  const lock = readLock(project);
  const { keys, added } = assignKeys(project, lock);
  const stateKeys: Record<string, string> = keys;
  const versionsChanged = syncComponentVersions(project, lock);
  if ((added || versionsChanged) && options.writeLock !== false) writeLock(project.root, lock);

  const files = new Map<string, Buffer>();

  // Assets referenced by props of kind asset (only those: unused files are not shipped).
  const registry = getRegistry(project);
  const planLookup = planIndex(plan);
  const assetNames: string[] = [];
  const shipAsset = (asset: unknown) => {
    if (typeof asset === 'string') assetNames.push(asset);
  };
  for (const { block } of iterateBlocks(project)) {
    const descriptor = registry.get(block.type);
    if (!descriptor) continue;
    for (const found of valuesOfKind(descriptor.schema, resolveBlockProps(block, planLookup, registry), 'asset')) shipAsset(found.value);
  }
  for (const { id } of screenOrder(project)) {
    const screen = project.screens.get(id)?.data;
    const layout = screen?.layout ? registry.get(screen.layout) : null;
    if (layout && screen?.layoutProps) for (const found of valuesOfKind(layout.schema, screen.layoutProps, 'asset')) shipAsset(found.value);
  }
  // The player's logo and the course's resources (D58): files of assets/ the course names itself.
  const logo = findItem(playerConfig(course), 'logo')?.item;
  if (logo?.id === 'logo' && logo.enabled && logo.options.asset) shipAsset(logo.options.asset);
  for (const resource of course.resources ?? []) shipAsset(resource.asset);
  // Sounds of the course an interface role plays instead of the player's own (D67).
  const interfaceSettings = interfaceSounds(project);
  if (interfaceSettings.active) {
    const sounds = soundAssets(project);
    for (const source of Object.values(interfaceSettings.roles)) if (source?.kind === 'sound') shipAsset(sounds.get(source.id)?.asset);
  }
  // Media are files on disk (masters, or renditions below the high quality); other assets are read.
  const quality = mediaQualityOf(course, options.mediaQuality);
  const isMedia = (name: string) => {
    const file = project.files.get(`assets/${name}`);
    if (!file) return !!project.media?.processing.includes(`assets/${name}`);
    return file.kind === 'binary' && (!!file.media || MEDIA_EXTENSIONS.has(extensionOf(name)));
  };
  const names = [...new Set(assetNames)];
  for (const name of names) if (!isMedia(name)) files.set(`assets/${name}`, fs.readFileSync(path.join(project.root, 'assets', name)));
  const packaged = await packageMedia(project, names.filter(isMedia), quality, { taken: new Set(files.keys()), onProgress: options.onMedia });
  for (const failure of packaged.failures) reporter.emit('E_MEDIA_RENDITION', { file: failure.asset, message: `${failure.asset} at the ${quality} quality: ${failure.message}` });
  const media = new Map<string, string | null>();
  for (const m of packaged.media) {
    if (m.file === null && options.media !== 'link') reporter.emit('E_ASSET_MISSING', { file: `assets/${m.name}`, message: `assets/${m.name} is still being converted by a media job: wait for it (elabora media status --wait), or build without --no-wait.` });
    media.set(m.path, m.file);
  }
  const assetPaths = new Map(packaged.media.filter((m) => m.path !== `assets/${m.name}`).map((m) => [m.name, m.path]));

  // Narration: one track per narrated screen whose lines all have their audio, with its captions
  // (D24), and one per narrated layer (D62). The tracks ship from the project's cache, like media.
  const narration = await narrationTracks(project);
  const trackOwner = (failure: { screen: string; layer: string | null }) => (failure.layer === null ? `screen "${failure.screen}"` : `layer "${failure.layer}" of screen "${failure.screen}"`);
  for (const failure of narration.failures) reporter.emit('E_NARRATION_TRACK', { file: `screens/${failure.screen}.json`, target: failure.screen, message: `The narration track of ${trackOwner(failure)} could not be made: ${failure.message}` });
  for (const track of narration.tracks) {
    media.set(track.path, track.file);
    files.set(track.captionsPath, Buffer.from(track.vtt));
  }
  const tracks = new Map(narration.tracks.map((track) => [track.name, track]));
  // The lines of dialogues: one file per line (D61), at the package's media quality.
  const dialogueLines = await dialogueLineAudio(project, { quality });
  for (const failure of dialogueLines.failures) reporter.emit('E_NARRATION_TRACK', { file: `screens/${failure.screen}.json`, target: failure.screen, message: `The audio of dialogue line "${failure.line}" of screen "${failure.screen}" could not be packaged: ${failure.message}` });
  for (const line of dialogueLines.lines) media.set(line.path, line.file);

  // A package of several languages (D59): the course in each translation that is ready and approved,
  // with its own narration tracks (narration/<lang>/).
  const languages = options.languages === 'all' ? packageLanguages(project) : [course.language];
  // A translation the package leaves out is said, with what it lacks: a link of the glossary placed
  // since, a text edited, a plan not approved make a language go without a word otherwise.
  if (options.languages === 'all') {
    for (const status of translationStatus(project)) {
      if (!status.exists || languages.includes(status.language)) continue;
      const lacks = [
        status.toTranslate ? `${status.toTranslate} text${status.toTranslate === 1 ? '' : 's'} to translate` : '',
        status.stale ? `${status.stale} text${status.stale === 1 ? '' : 's'} out of date (the source changed since)` : '',
        status.problems.length ? `${status.problems.length} translation${status.problems.length === 1 ? '' : 's'} refused (${status.problems[0].message})` : '',
        status.anchors.toPlace.length ? `${status.anchors.toPlace.length} word anchor${status.anchors.toPlace.length === 1 ? '' : 's'} to place` : '',
        translationReady(status) && status.plan !== 'approved' ? `its translated plan is ${status.plan}` : ''
      ].filter(Boolean);
      reporter.emit('W_PACKAGE_LANGUAGE_LEFT_OUT', { file: translationPath(status.language), target: status.language, message: `The ${status.language} translation is not in the package of every language: ${lacks.join('; ') || 'it is not ready'}.` });
    }
  }
  const others = languages.slice(1).map((language) => ({ language, project: translatedProject(project, language) }));
  const otherTracks = new Map<string, Map<string, (typeof narration.tracks)[number]>>();
  const otherLines = new Map<string, DialogueLineAudio>();
  for (const other of others) {
    const lines = await dialogueLineAudio(other.project, { folder: other.language, quality });
    for (const failure of lines.failures) reporter.emit('E_NARRATION_TRACK', { file: `screens/${failure.screen}.json`, target: failure.screen, message: `The ${other.language} audio of dialogue line "${failure.line}" of screen "${failure.screen}" could not be packaged: ${failure.message}` });
    for (const line of lines.lines) media.set(line.path, line.file);
    otherLines.set(other.language, lines);
    const made = await narrationTracks(other.project, { folder: other.language });
    for (const failure of made.failures) reporter.emit('E_NARRATION_TRACK', { file: `screens/${failure.screen}.json`, target: failure.screen, message: `The ${other.language} narration track of ${trackOwner(failure)} could not be made: ${failure.message}` });
    // As in the course's own language: a screen whose lines are not all said runs silent on estimated
    // times, which the build says since the validator reads the course's own language only.
    for (const name of made.silent) {
      if (!tracks.has(name)) continue;
      const [screen, layer] = name.split('.');
      reporter.emit('W_NARRATION_AUDIO_MISSING', { file: `screens/${screen}.json`, target: screen, message: `${layer ? `Layer "${layer}" of screen "${screen}"` : `Screen "${screen}"`} has narration lines without audio in ${other.language}: learners who choose ${other.language} get its timeline silent, on estimated times.` });
    }
    for (const track of made.tracks) {
      media.set(track.path, track.file);
      files.set(track.captionsPath, Buffer.from(track.vtt));
    }
    otherTracks.set(other.language, new Map(made.tracks.map((track) => [track.name, track])));
  }

  // Design layer: theme stylesheet, component stylesheets, embedded fonts and the files they reference.
  const design = designFiles(project, registry);
  for (const [name, content] of design.files) files.set(name, content);

  // Free objects: compiled code, sandboxed frame, declared assets.
  let needsThree = false;
  const usedObjects = new Set<string>();
  for (const { block } of iterateBlocks(project)) if (block.type === 'free-object' && typeof block.props?.object === 'string') usedObjects.add(block.props.object);
  if (course.theme?.backdrop?.object?.id) usedObjects.add(course.theme.backdrop.object.id);
  for (const id of [...usedObjects].sort()) {
    const object = project.objects.get(id);
    const manifest = object?.manifest;
    if (!object || !manifest) continue; // reported by the validator
    if (manifest.requires?.three) needsThree = true;
    let code: string;
    try {
      code = await compileObjectCode(path.join(project.root, object.folder), { minify: !options.debug });
    } catch (error) {
      reporter.emit('E_OBJECT_PARSE', { file: `objects/${id}/object.js`, target: id, message: `Build of object.js failed: ${bundleErrorMessage(error)}` });
      continue;
    }
    files.set(`objects/${id}/object.js`, Buffer.from(code));
    files.set(`objects/${id}/frame.html`, Buffer.from(objectFrameHtml(manifest, { language: course.language })));
    for (const asset of manifest.assets || []) files.set(`objects/${id}/${asset.file}`, fs.readFileSync(path.join(project.root, object.folder, asset.file)));
  }
  // The web target's address and sharing image.
  const share = web ? webShare(project.root, web, reporter) : null;
  if (share?.image) files.set(share.image.path, share.image.content);
  // A review build: the origins of the pages that may show it, checked.
  const review = web?.review ? reviewOf(project, course, web.review, reporter) : null;
  if (stops(reporter.errors)) return finish(reporter, project);

  // Free font licences let a package embed a font when their text travels with it: the licence
  // files of the folder of each packaged font go next to it (W_FONT_LICENSE_MISSING when none).
  const licenses = [...new Set([...files.keys()].filter(isFontPath).flatMap((font) => fontLicenses(project.files.keys(), font)))].sort();
  for (const license of licenses) if (!files.has(license)) files.set(license, fs.readFileSync(path.join(project.root, license)));

  for (const [name, content] of Object.entries(await runtimeFiles({ debug: options.debug }))) files.set(name, Buffer.from(content));
  if (needsThree) for (const [name, content] of Object.entries(vendorThree())) files.set(name, content);
  // The review bridge ships in review builds only: every other build is the same, byte for byte.
  if (review) for (const [name, content] of Object.entries(await reviewFiles({ debug: options.debug }))) files.set(name, Buffer.from(content));

  const delivery: WebDelivery | undefined = web ? { target: 'web', progress: web.progress, navigation: web.navigation, ...(review ? { review } : {}) } : undefined;
  const buildId = sha256(canonicalJSON({
    elabora: ELABORA_VERSION, course, plan, keys, media: quality !== 'high' && packaged.media.length ? quality : undefined, design: [...design.files.entries()].map(([name, content]) => [name, sha256(content)]),
    fontLicenses: licenses.length ? licenses.map((name) => [name, sha256(files.get(name) as Buffer)]) : undefined,
    components: [...project.components.values()].map((component) => [component.id, componentHash(component)]),
    screens: [...project.screens.entries()].sort(), objects: [...usedObjects].sort().map((id) => [id, project.objects.get(id)?.manifest, project.objects.get(id)?.code]),
    narration: tracks.size ? [...tracks.values()].map((track) => [track.name, track.key]) : undefined,
    dialogueLines: dialogueLines.lines.length ? dialogueLines.lines.map((line) => [line.path, line.hash, line.mouth]) : undefined,
    delivery,
    languages: others.length ? languages.map((language) => [language, fileHash(project.files, `translations/${language}.xlf`) ?? null, [...(otherTracks.get(language)?.values() ?? [])].map((track) => [track.name, track.key]), ...(otherLines.get(language)?.lines.length ? [otherLines.get(language)!.lines.map((line) => [line.path, line.hash, line.mouth])] : [])]) : undefined
  })).slice(0, 16);
  const several = others.length ? { languages } : {};
  const assetPathOf = assetPaths.size ? { assetPath: (name: string) => assetPaths.get(name) ?? `assets/${name}` } : {};
  const linesOf = (made: DialogueLineAudio | undefined): { dialogueAudio?: PackagedLines } => {
    if (!made?.lines.length) return {};
    const shipped = new Map(made.lines.map((line) => [`${line.screen}/${line.line}`, { src: line.path, mouth: line.mouth, duration: line.duration }]));
    return { dialogueAudio: (screen: string, line: string) => shipped.get(`${screen}/${line}`) };
  };
  const data: CompiledCourse = compileCourseData(project, keys, {
    buildId, ...assetPathOf, interfaceSounds: interfaceSettings, ...linesOf(dialogueLines),
    ...(tracks.size ? { narration: (screen: string, layer?: string) => tracks.get(trackName(screen, layer ?? null))?.track } : {}),
    ...(delivery ? { delivery } : {}), ...several
  });
  files.set('elabora/course.js', Buffer.from(`window.ELABORA_COURSE = ${JSON.stringify(data)};\n`));
  // The player's interface sounds the course data names (D67).
  for (const name of shippedPlayerSounds(data.sounds)) files.set(name, playerSoundFile(name));
  // The other languages' course data, loaded when a learner chooses one (the same element keys).
  for (const other of others) {
    const own = otherTracks.get(other.language);
    const translated = compileCourseData(other.project, keys, {
      buildId, ...assetPathOf, interfaceSounds: interfaceSettings, ...linesOf(otherLines.get(other.language)),
      ...(own?.size ? { narration: (screen: string, layer?: string) => own.get(trackName(screen, layer ?? null))?.track } : {}),
      ...(delivery ? { delivery } : {}), ...several
    });
    files.set(`elabora/course.${other.language}.js`, Buffer.from(`(window.ELABORA_COURSES = window.ELABORA_COURSES || {})[${JSON.stringify(other.language)}] = ${JSON.stringify(translated)};\n`));
  }
  if (design.css) files.set('elabora/theme.css', Buffer.from(design.css));
  files.set('index.html', Buffer.from(indexHtml(data, { themeCss: !!design.css, review: !!review, ...(share ? { web: { ...share.head, description: course.description } } : {}) })));
  if (!web) files.set('imsmanifest.xml', Buffer.from(scorm12Manifest(course, [...files.keys(), ...media.keys()])));

  // The author's sources are never published (D49). The validator refuses whatever points into
  // sources/; this holds whatever path a file took: no entry is under sources/, none is read there.
  const sourcesDir = path.join(project.root, SOURCES_DIR);
  const fromSources = (file: string) => { const rel = path.relative(sourcesDir, file); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  for (const name of [...files.keys(), ...media.keys()]) {
    const key = projectPath(name) ?? name;
    const file = media.get(name);
    if (isSourcePath(key) || (file && fromSources(file))) reporter.emit('E_SOURCE_REFERENCED', { file: name, message: `${name} would publish one of the author's sources (sources/): import it into assets/ and point to that.` });
  }
  if (stops(reporter.errors)) return finish(reporter, project);

  // Package rules of the target profiles (checklist item 8). An LMS of delivery.lms that no profile
  // has (E_LMS_UNKNOWN) does not stop a preview: it is left out. A module for the web has none.
  const targets = web ? [] : resolveProfiles(profiles.filter((id) => id === 'all' || listProfiles().some((profile) => profile.id === id)));
  const limits = scorm12Limits(targets);
  for (const name of [...files.keys(), ...media.keys()]) {
    if (!PORTABLE.test(name)) reporter.emit('E_FILENAME_NOT_PORTABLE', { file: name, message: `File name "${name}" is not portable.` });
    const extension = path.extname(name).toLowerCase();
    if (!web && limits.forbiddenExtensions.includes(extension)) reporter.emit('E_FORBIDDEN_EXTENSION', { file: name, message: `${extension} files are refused by ${targets.filter((profile) => profile.packaging?.forbiddenExtensions?.includes(extension)).map((profile) => profile.id).join(', ')}.` });
  }
  // The ZIP is planned first: its exact size is known before anything is written.
  const inputs: ZipInput[] = [...files].map(([name, content]): ZipInput => ({ name, data: content }));
  for (const [name, file] of media) if (file !== null) inputs.push({ name, file });
  let zipPlan: ZipPlan | null = null;
  try {
    zipPlan = await planZip(inputs);
  } catch (error) {
    if (!(error instanceof ZipLimitError)) throw error;
    reporter.emit('E_PACKAGE_TOO_LARGE', { message: error.message });
  }
  if (zipPlan && !web) {
    // Size, extracted size, files and compression ratio against the LMSs targeted: errors for those
    // chosen, warnings naming the documented LMSs that would refuse it when none is.
    const facts = { zipBytes: zipPlan.size, unzippedBytes: zipPlan.uncompressed, files: zipPlan.entries.length };
    const breaches = packageBreaches(targets, facts);
    if (breaches.length) {
      const sized = breaches.some((breach) => breach.measure === 'zip' || breach.measure === 'unzipped');
      const qualities = sized && packaged.media.length
        ? (await packageSizes(project, packaged.media, zipPlan.size, quality)).map((size) => ({ quality: size.preset, bytes: size.bytes, estimated: !size.measured }))
        : null;
      const media = new Map(packaged.media.map((m) => [m.path, m]));
      const voices = new Map(narration.tracks.map((track) => [track.path, track]));
      const file = (name: string, bytes: number): PackageFile => {
        const m = media.get(name);
        const asset = m ? `assets/${m.name}` : name.startsWith('assets/') ? name : undefined;
        const seconds = m?.info?.duration ? Math.round(m.info.duration) : voices.get(name)?.duration ? Math.round(voices.get(name)?.duration ?? 0) : undefined;
        return { path: name, ...(asset ? { asset } : {}), bytes, kind: packageFileKind(name), ...(seconds ? { seconds } : {}) };
      };
      const heaviest = [...zipPlan.entries].sort((a, b) => b.compressedSize - a.compressedSize || a.name.localeCompare(b.name)).slice(0, 5).map((entry) => file(entry.name, entry.compressedSize));
      const saved = (entry: { size: number; compressedSize: number }) => entry.size - entry.compressedSize;
      const shrinking = [...zipPlan.entries].sort((a, b) => saved(b) - saved(a) || a.name.localeCompare(b.name)).slice(0, 5).map((entry) => file(entry.name, entry.size));
      for (const { code, fields } of packageLimitFindings(breaches, { quality, qualities, heaviest, shrinking }, facts)) reporter.emit(code, fields);
    }
  }
  if (stops(reporter.errors) || !zipPlan) return finish(reporter, project);
  // A module for the web is a folder to serve: the folder and its ZIP by default.
  const emit = options.emit || (web ? 'both' : 'zip');
  const outDir = path.resolve(options.out || path.join(project.root, 'dist'));
  const base = `${course.id}-${course.version}-${target}`;
  let zipPath: string | undefined;
  let packageHash: string;
  if (emit === 'zip' || emit === 'both') {
    zipPath = path.join(outDir, `${base}.zip`);
    packageHash = (await writeZip(zipPath, zipPlan)).sha256;
  } else {
    packageHash = await hashZip(zipPlan);
  }

  const model = { ...buildStateModel(project, keys, lock), ...(others.length ? { languages } : {}) };
  const report = buildReport({
    dialogueVoices: dialogueLines.lines,
    project, course, plan, registry, profiles: targets, keys: stateKeys, target, web: web && share ? { progress: web.progress, navigation: web.navigation, noindex: web.noindex, url: share.head.url ?? null, image: share.image?.path ?? null, ...(review ? { review: { origins: review.origins } } : {}) } : null, suspendDataWorstCase: worstCaseLength(model), data,
    pkg: { sha256: packageHash, bytes: zipPlan.size, files: zipPlan.entries.length, uncompressedBytes: zipPlan.uncompressed },
    media: packaged.media.length ? { quality, files: packaged.media.map((m) => ({ asset: `assets/${m.name}`, path: m.path, bytes: m.file && fs.existsSync(m.file) ? fs.statSync(m.file).size : 0, rendition: m.rendition })) } : null,
    narration: narration.tracks.length || narration.silent.length || dialogueLines.lines.length ? (() => {
      const lines = dialogueLines.lines.map((line) => ({ screen: line.screen, block: line.block, line: line.line, path: line.path, bytes: fs.statSync(line.file).size, seconds: line.duration }));
      const credits = [...new Set([...narration.tracks.flatMap((track) => track.credits), ...dialogueLines.lines.map((line) => line.credit).filter((credit): credit is string => !!credit)])].sort();
      return {
        bytes: narration.tracks.reduce((sum, track) => sum + track.bytes + Buffer.byteLength(track.vtt), 0) + lines.reduce((sum, line) => sum + line.bytes, 0),
        seconds: Math.round((narration.tracks.reduce((sum, track) => sum + track.duration, 0) + lines.reduce((sum, line) => sum + line.seconds, 0)) * 10) / 10,
        tracks: narration.tracks.map((track) => ({ screen: track.screen, ...(track.layer !== null ? { layer: track.layer } : {}), path: track.path, captions: track.captionsPath, bytes: track.bytes, seconds: track.duration })),
        silent: narration.silent,
        ...(credits.length ? { credits } : {}),
        ...(lines.length ? { lines } : {})
      };
    })() : null,
    limits, release: !!options.release, diagnostics: sortDiagnostics(applyIgnored(applyWaivers(reporter.items, plan.waivers || []), ignoredOf(project.course))), licenses,
    languages: others.length ? languages : null
  });
  let dirPath: string | undefined;
  // A folder of this package left by an earlier build (elabora test writes one) is written again,
  // so the output folder never holds a copy older than the ZIP next to it.
  const staleDir = emit === 'zip' && fs.existsSync(path.join(outDir, base));
  if (emit === 'dir' || emit === 'both' || staleDir) {
    const target = path.join(outDir, base);
    dirPath = target;
    fs.rmSync(target, { recursive: true, force: true });
    for (const [name, content] of files) {
      fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
      fs.writeFileSync(path.join(target, name), content);
    }
    // Media are clones where the file system shares blocks (APFS, Btrfs, XFS): no copy of 300 MB.
    if (options.media !== 'link') {
      for (const [name, file] of media) {
        if (file === null) continue;
        fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
        if (!(await cloneFile(file, path.join(target, name)))) await fs.promises.copyFile(file, path.join(target, name));
      }
    }
  }
  const reportPath = path.join(outDir, `${base}.report.json`);
  writeFileAtomic(reportPath, stringifyJSON(report));
  writeFileAtomic(path.join(outDir, `${base}.proof.md`), proofMarkdown(report));
  const diagnostics = sortDiagnostics(applyIgnored(applyWaivers(reporter.items, plan.waivers || []), ignoredOf(project.course)));
  return {
    ok: true, diagnostics, summary: summarize(diagnostics), report, files, media,
    ...(zipPath !== undefined ? { zipPath } : {}), ...(dirPath !== undefined ? { dirPath } : {}), reportPath
  };
}

function finish(reporter: Reporter, project: Project): BuildFailure {
  const diagnostics = sortDiagnostics(applyIgnored(applyWaivers(reporter.items, project.plan?.waivers || []), ignoredOf(project.course)));
  return { ok: false, diagnostics, summary: summarize(diagnostics) };
}

interface DesignFiles {
  files: Map<string, Buffer>;
  css: string; // elabora/theme.css, empty without design layer
  components: string[];
}

// Theme stylesheet, component stylesheets and fonts (assembled by the core, as the editor canvas
// gets them): copied with the files their url() point to, and tied together by elabora/theme.css in
// cascade layers (player < components < theme).
function designFiles(project: Project, registry: Registry): DesignFiles {
  const design = designStylesheets(project, registry, usedTypes(project));
  const files = new Map<string, Buffer>();
  const add = (rel: string) => {
    const file = path.join(project.root, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.set(rel, fs.readFileSync(file));
  };
  for (const sheet of design.sheets) {
    files.set(sheet.path, Buffer.from(sheet.css));
    for (const target of sheet.files) add(target);
  }
  for (const font of design.fonts) add(font.src);
  return { files, css: design.css, components: design.components };
}

// What the build reads of the compiled course (window.ELABORA_COURSE, compiled by the core).
interface CompiledBlock {
  id: string;
  type: string;
  behavior?: string | null;
  blocks?: CompiledBlock[];
}

interface CompiledScreen {
  id: string;
  title: string;
  covers: string[];
  completeWhen: string;
  layout?: { id: string };
  narration?: { src: string | null; generated: boolean };
  blocks: CompiledBlock[];
  layers: { blocks: CompiledBlock[] }[];
}

interface CompiledCourse {
  id: string;
  title: string;
  version: string;
  language: string;
  tokens: Record<string, string | number>;
  presentation?: { contentWidth?: number; wideWidth?: number };
  screens: CompiledScreen[];
  objects: Record<string, { id: string; version: string }>;
  sounds?: SoundsData;
  build: { id: string };
}

// A review build's origins, as the browser writes them, sorted, each once (E_WEB_REVIEW_ORIGIN for a
// value that is not one), and the course's languages: its own, the language of the course it
// translates, and those of its translations (translations/<lang>.xlf).
function reviewOf(project: Project, course: Course, options: WebReviewOptions, reporter: Reporter): { origins: string[]; languages: string[] } {
  const origins = new Set<string>();
  for (const value of options.origins) {
    const origin = reviewOrigin(value);
    if (origin) origins.add(origin);
    else reporter.emit('E_WEB_REVIEW_ORIGIN', { target: value, message: `"${value}" is not the origin of a review page: https://host[:port], or http://localhost[:port] for development (no path, wildcard or credentials).` });
  }
  if (!options.origins.length) reporter.emit('E_WEB_REVIEW_ORIGIN', { message: 'A review build needs the origin of the review page (--review-origin https://revue.elabora.studio).' });
  const translations = [...project.files.keys()].map((name) => /^translations\/([A-Za-z0-9-]+)\.xlf$/.exec(name)?.[1]).filter((language): language is string => !!language);
  const languages = [...new Set([course.language, ...(course.translationOf ? [course.translationOf.language] : []), ...translations])];
  return { origins: [...origins].sort(), languages: [languages[0], ...languages.slice(1).sort()] };
}

// The head of a module for the web: what search engines and sharing previews read.
interface WebHead {
  description?: string;
  noindex: boolean;
  url?: string; // absolute address of index.html
  image?: string; // the sharing image's address: absolute with url, else relative to index.html
}

// A module for the web: its address checked and its sharing image read (D41).
interface WebShare {
  head: WebHead;
  image: { path: string; content: Buffer } | null; // in the package
}

const IMAGE_TYPES: { extension: string; test: (head: Buffer) => boolean }[] = [
  { extension: 'png', test: (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { extension: 'jpg', test: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { extension: 'webp', test: (head) => head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP' }
];

function webShare(root: string, web: { noindex: boolean; url?: string; image?: string }, reporter: Reporter): WebShare {
  let url: URL | null = null;
  if (web.url !== undefined) {
    try { url = new URL(web.url); } catch { url = null; }
    if (!url || !/^https?:$/.test(url.protocol) || url.search || url.hash || url.username || url.password) {
      reporter.emit('E_WEB_URL', { target: web.url, message: `"${web.url}" is not the absolute address of a page (https://…, without query, fragment or credentials).` });
      url = null;
    }
  }
  let image: WebShare['image'] = null;
  const inSources = (file: string) => { const rel = path.relative(path.join(root, SOURCES_DIR), file); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  if (web.image !== undefined && inSources(path.resolve(root, web.image))) {
    reporter.emit('E_SOURCE_REFERENCED', { target: web.image, message: `The sharing image "${web.image}" is one of the author's sources, which are never published (they keep their metadata): import it (elabora media import . ${web.image}) and give the name it prints under assets/.` });
  } else if (web.image !== undefined) {
    const file = path.resolve(root, web.image);
    let head: Buffer | null = null;
    try { head = fs.statSync(file).isFile() ? fs.readFileSync(file) : null; } catch { head = null; }
    const type = head ? IMAGE_TYPES.find((candidate) => candidate.test(head)) : undefined;
    if (!head) reporter.emit('E_WEB_IMAGE', { target: web.image, message: `The sharing image "${web.image}" was not found (${file}).` });
    else if (!type) reporter.emit('E_WEB_IMAGE', { target: web.image, message: `The sharing image "${web.image}" is not a PNG, JPEG or WebP file.` });
    else image = { path: `share.${type.extension}`, content: head };
    if (image && !url && web.url === undefined) reporter.emit('W_WEB_IMAGE_WITHOUT_URL', { target: web.image, message: 'The sharing image is in the module, but previews need its absolute address: build with --url.' });
  }
  // An address without a file name is the module's folder (…/gearset → …/gearset/): the files of
  // index.html are relative to it, and so is the sharing image.
  const page = url && (url.pathname.endsWith('/') || /\.[^/]*$/.test(url.pathname) ? url : new URL(`${url.href}/`));
  return {
    head: {
      noindex: web.noindex,
      ...(page ? { url: page.href } : {}),
      ...(image ? { image: page ? new URL(image.path, page).href : image.path } : {})
    },
    image
  };
}

function webHead(data: CompiledCourse, web: WebHead): string {
  const meta = (attribute: 'name' | 'property', key: string, value: string) => `\n<meta ${attribute}="${key}" content="${escapeHtml(value)}">`;
  const description = web.description?.trim();
  return [
    description ? meta('name', 'description', description) : '',
    web.noindex ? meta('name', 'robots', 'noindex') : '',
    web.url ? `\n<link rel="canonical" href="${escapeHtml(web.url)}">` : '',
    meta('property', 'og:type', 'website'),
    meta('property', 'og:title', data.title),
    description ? meta('property', 'og:description', description) : '',
    web.url ? meta('property', 'og:url', web.url) : '',
    web.image ? meta('property', 'og:image', web.image) + meta('property', 'og:image:alt', data.title) : '',
    meta('name', 'twitter:card', web.image ? 'summary_large_image' : 'summary')
  ].join('');
}

function indexHtml(data: CompiledCourse, { themeCss = false, web, review = false }: { themeCss?: boolean; web?: WebHead; review?: boolean } = {}): string {
  return `<!doctype html>
<html lang="${escapeHtml(data.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Elabora ${ELABORA_VERSION}">
<link rel="icon" href="data:,">
<title>${escapeHtml(data.title)}</title>${web ? webHead(data, web) : ''}
<link rel="stylesheet" href="elabora/player.css">${themeCss ? '\n<link rel="stylesheet" href="elabora/theme.css">' : ''}
<style>${rootStyle(data.tokens, data.presentation)}</style>
</head>
<body>
<div id="elabora-app"></div>
<noscript>${data.language.startsWith('fr') ? 'Ce module nécessite JavaScript.' : 'This course requires JavaScript.'}</noscript>
<script src="elabora/course.js"></script>
<script src="elabora/player.js"></script>${review ? '\n<script src="elabora/review.js"></script>' : ''}
</body>
</html>
`;
}

interface ReportInput {
  // The dialogue lines shipped with their audio (D61).
  dialogueVoices?: { screen: string; block: string; generated: boolean }[];
  project: Project;
  course: Course;
  plan: Plan;
  registry: Registry;
  profiles: LmsProfile[];
  keys: Record<string, string>;
  suspendDataWorstCase: number;
  data: CompiledCourse;
  pkg: BuildReport['package'];
  media: BuildReport['media'] | null;
  narration: BuildReport['narration'] | null;
  limits: Scorm12Limits;
  target: BuildTarget;
  web: ReportWeb | null;
  release: boolean;
  diagnostics: Diagnostic[];
  licenses: string[]; // licence files carried next to the packaged fonts
  languages: string[] | null; // a package of several languages (D59)
}

// The validated version a build is made against, and what changed in the working copy since (D52).
function planValidation(project: Project): Pick<ReportPlan, 'validated' | 'changesSince'> {
  const validated = latestValidated(project);
  if (!validated?.data.validation || !project.plan) return { validated: null, changesSince: null };
  const { by, date, reference } = validated.data.validation;
  const version = versionLabel(validated.number);
  const changes = planDiff(validated.data.plan, project.plan, planCourse(project)).changes;
  return {
    validated: { version, by, date, reference: reference ?? null, contentHash: validated.data.contentHash },
    changesSince: changes.length ? { version, changes: changes.map(({ key, kind, id, status, label }) => ({ key, kind, id, status, label })), verbatim: changes.filter((change) => change.verbatim).map((change) => change.id) } : null
  };
}

function buildReport({ project, course, plan, registry, profiles, keys, suspendDataWorstCase, data, pkg, media, narration, limits, target, web, release, diagnostics, licenses, languages, dialogueVoices }: ReportInput): BuildReport {
  const flat = (blocks: CompiledBlock[] | undefined): CompiledBlock[] => (blocks || []).flatMap((block) => [block, ...flat(block.blocks)]);
  const uses = new Map<string, number>();
  for (const screen of data.screens) {
    if (screen.layout) uses.set(screen.layout.id, (uses.get(screen.layout.id) || 0) + 1);
    for (const block of [...flat(screen.blocks), ...screen.layers.flatMap((layer) => flat(layer.blocks))]) if (!registry.get(block.type)?.builtin) uses.set(block.type, (uses.get(block.type) || 0) + 1);
  }
  const sourceScreens = screenOrder(project).map((entry) => project.screens.get(entry.id)?.data).filter((screen) => screen !== undefined);
  const coverage = (plan.items || []).map((item): PlanCoverage => {
    const screens = sourceScreens.filter((screen) => screen.covers?.includes(item.id));
    const usedBy = (prop: string, id: string) => screens.flatMap((screen) => [...(screen.blocks || []), ...(screen.layers || []).flatMap((layer) => layer.blocks || [])]
      .filter((block) => block.props?.[prop] === id).map((block) => `${screen.id}/${block.id}`));
    return {
      id: item.id, kind: item.kind, title: item.title, objectives: item.objectives,
      screens: screens.map((screen) => screen.id),
      lockedTexts: (item.lockedTexts || []).map((text) => ({ id: text.id, usedBy: usedBy('textRef', text.id) })),
      questions: (item.questions || []).map((question) => ({ id: question.id, usedBy: usedBy('questionRef', question.id) })),
      activities: data.screens.filter((compiled) => screens.some((screen) => screen.id === compiled.id))
        .flatMap((compiled) => flat(compiled.blocks).filter((block) => ['quiz', 'numeric', 'fill-in', 'sort', 'reflection', 'decision', 'object'].includes(block.behavior ?? '')).map((block) => `${block.type}:${block.id}`))
    };
  });
  const generated: BuildReport['generatedMedia'] = [];
  for (const { block, screen } of iterateBlocks(project)) if (block.props?.generated) generated.push({ screen: screen.id, block: block.id, type: block.type });
  // A layout's picture (an opening's, D63), named by its layout.
  for (const [id, { data: screen }] of project.screens) if (screen.layout && screen.layoutProps?.generated === true) generated.push({ screen: id, block: 'layout', type: screen.layout });
  // A narration spoken by a generated voice (its lines' sidecars say so).
  for (const screen of data.screens) if (screen.narration?.generated && screen.narration.src) generated.push({ screen: screen.id, block: 'narration', type: 'voice' });
  // The dialogues said by a generated voice (D61): one entry per dialogue.
  for (const key of new Set((dialogueVoices ?? []).filter((line) => line.generated).map((line) => `${line.screen}\u0000${line.block}`))) {
    const [screen, block] = key.split('\u0000');
    generated.push({ screen: screen!, block: block!, type: 'voice' });
  }
  return {
    format: 'elabora-build-report/1',
    elabora: ELABORA_VERSION,
    target,
    ...(web ? { web } : {}),
    release,
    course: { id: data.id, title: data.title, version: data.version, language: data.language },
    ...(languages ? { languages } : {}),
    buildId: data.build.id,
    package: pkg,
    ...(media ? { media } : {}),
    ...(narration ? { narration } : {}),
    structure: structureFingerprint(course),
    stateKeys: keys,
    budget: web ? { suspendDataWorstCase, suspendDataLimit: null, source: web.progress === 'local' ? 'web: the browser\'s localStorage, no LMS limit' : 'web: nothing kept' } : { suspendDataWorstCase, suspendDataLimit: limits.suspendDataMax, source: limits.suspendDataSource },
    profiles: profiles.map((profile) => ({ id: profile.id, name: profile.name, documentedAt: profile.documentedAt, updateFamily: profile.update?.family ?? null, toMeasure: profile.toMeasure })),
    plan: {
      id: plan.id, title: plan.title, approvalState: planState(project), ...planValidation(project),
      contentHash: planContentHash(plan), businessGoal: plan.businessGoal || null, spacing: plan.spacing || [],
      objectives: (plan.objectives || []).map((objective) => ({ id: objective.id, statement: objective.statement, bloom: objective.bloom || null })),
      coverage, waivers: plan.waivers || []
    },
    screens: data.screens.map((screen) => ({ id: screen.id, title: screen.title, covers: screen.covers, completeWhen: screen.completeWhen, ...(screen.layout ? { layout: screen.layout.id } : {}), blocks: flat(screen.blocks).map((block) => block.type) })),
    // Components of the course: definition version, lineage (forks), library origin, instances.
    components: [...registry.values()].filter((descriptor) => !descriptor.builtin).map((descriptor) => ({
      id: descriptor.id, title: descriptor.title, version: descriptor.version, level: descriptor.level, ...(descriptor.parent ? { extends: descriptor.parent } : {}), ...(descriptor.behavior ? { behavior: descriptor.behavior } : {}),
      ...(descriptor.origin ? { origin: `${descriptor.origin.library}/${descriptor.origin.component}@${descriptor.origin.version}` } : {}), instances: uses.get(descriptor.id) || 0
    })),
    objects: Object.values(data.objects).flatMap((compiled) => {
      // Packaged objects have a manifest: validation stops the build otherwise.
      const object = project.objects.get(compiled.id);
      if (!object?.manifest) return [];
      const { manifest } = object;
      // Automated gates: the record left by the last full `elabora object test`; human gates stay pending.
      return [{
        id: compiled.id, version: compiled.version, planRefs: manifest.planRefs, pedagogicalRole: manifest.pedagogicalRole,
        gates: { automated: gatesStatus(path.join(project.root, object.folder)), human: 'pending' as const }
      }];
    }),
    generatedMedia: generated,
    generatedAssets: Object.entries(readProvenance(project).assets || {}).map(([asset, entry]) => ({ asset, generator: entry.generator })),
    design: { stylesheet: course.theme?.stylesheet || null, fonts: (course.theme?.fonts || []).map((font) => font.family), fontLicenses: licenses, layouts: [...new Set(data.screens.map((screen) => screen.layout?.id).filter((id): id is string => !!id))].sort(), presentation: course.presentation?.mode || 'scroll' },
    tests: null,
    diagnostics,
    summary: summarize(diagnostics),
    pending: ['accessibility-manual', 'sme-review', web ? 'web-smoke' : 'lms-smoke', ...Object.keys(data.objects).map((id) => `object-review:${id}`)]
  };
}
