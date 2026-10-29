import type {
  CourseData, WebDelivery, PlayerData, ResourceData, GlossaryData, AboutData, ScreenData, ScreenLayout, BlockData, EventData, Condition as ConditionData, Action as ActionData, Backdrop, ObjectDefinition, TokenValues,
  QuizProps, NumericProps, NumericTolerance, FillInProps, SortProps, ReflectionProps, DecisionProps, DialogueProps, ObjectBlockProps, ResultsProps, SpeechProps, VideoProps, AudioProps, AspectRatio, NarrationData, MomentData, TimingData, ContinuityData
} from '@elabora/player/course-data';
import type { DataSchema, DataType } from '@elabora/player/data-schema';
import { planIndex, resolveBlockProps, resolveTextRefs, screenOrder } from '../project/load.ts';
import { walkHeadings } from '../components/headings.ts';
import type { PlanIndex } from '../project/load.ts';
import type { Project, Course, Screen, Block, Event, Condition, Action, ObjectManifest, ObjectEvent } from '../project/model.ts';
import { renderMarkdown, markdownToText } from './markdown.ts';
import { markBlanks, placeBlanks } from './blanks.ts';
import { parseBlanks, blankMaxLength, stableShuffle } from '@elabora/player/fill-in';
import { resolveTokens, withPlayerTokens } from '../validate/theme.ts';
import { getRegistry } from '../components/registry.ts';
import type { Registry, ComponentDescriptor } from '../components/registry.ts';
import { renderTemplate, defaultAssetPath } from '../components/template.ts';
import type { ParsedTemplate } from '../components/template.ts';
import { applyDefaults } from '../components/props.ts';
import { controlsOf, controlEntity } from '../components/controls.ts';
import { activityEntity, readLock } from './state-model.ts';
import { continuityDuration, continuityEntity, continuityKey } from '../project/continuity.ts';
import type { StateKeys, StateLock, ActivityBehavior } from './state-model.ts';
import { dialogueData, speakerData } from '../dialogue/data.ts';
import { dialogueVoices } from '../dialogue/voices.ts';
import type { PackagedLines } from '../dialogue/voices.ts';
import { characterInline } from '../dialogue/character.ts';
import { dialogueKeys } from '../dialogue/keys.ts';
import { isRecord, recordOf, recordsOf, textOf, optionalTextOf, isText, isNumber, isOptional, numberOr, isJsonValue, jsonObjectOf } from './values.ts';
import { objectsIn } from '../util/values.ts';
import { screenTimeline, blockTimings, blockBeats, anchorTime, anchorTimeline, lineTimelines } from '../narration/timeline.ts';
import { isChartType, renderChart } from '../charts/index.ts';
import { isPredict } from '../charts/predict.ts';
import { withoutDirections } from '../narration/directions.ts';
import { inlineSvg, replaceImage } from '../render/svg-inline.ts';
import { readText } from '../project/files.ts';
import { pageMinutes } from '../project/duration.ts';
import type { ScreenTimeline, TimelineMoment } from '../narration/timeline.ts';
import { playerConfig, playerContent, shownPlayer, aboutCourse, withItemEnabled } from '../player/config.ts';
import { compileSounds, soundAssets, soundLength } from '../sounds/sounds.ts';
import type { InterfaceSounds } from '../sounds/sounds.ts';

// Turns the source project into the data the player reads (window.ELABORA_COURSE, typed CourseData
// by the player): plan references resolved, every block rendered from its component template (HTML
// with slots and behaviour hooks), behaviour data for activities (scoring stays in the player),
// state keys attached.
//
// One screen compiles on its own (compileScreen), from a context shared by every screen: the
// package's course data and the editor canvas come from the same function.
//
// Block props are read defensively: the build compiles validated projects only, but the canvas
// will show screens being written. A field the player needs and the source lacks gets a neutral
// value: '' for a text, NaN for an expected number (grading never matches it).

// What every screen of a course shares, computed once: it changes with the course, the plan, the
// components and the state keys, not with a screen.
export interface CompileContext {
  course: Course;
  registry: Registry;
  planIndex: PlanIndex;
  tokens: TokenValues;
  keys: StateKeys;
  sectionOf: ReadonlyMap<string, string>; // screen id → section id, from the course outline
  // Package path of an asset (a value of an asset prop, relative to assets/): assets/<name>, or
  // the rendition a build at a lower media quality ships under another extension.
  assetPath: (name: string) => string;
  // The app's canvas: templates mark the elements that show a text prop (data-t-field).
  fields?: boolean;
  // The narration track the build made for a screen, or for a layer of it (D62; none: the timeline
  // from the lines' sidecars, or estimated, without a track).
  narration?: (screenId: string, layer?: string) => NarrationTrack | undefined;
  // The web target's settings (D41): said in the course data.
  delivery?: WebDelivery;
  // Free navigation opens the navigation rules (mode free, no lock until complete), the narrations'
  // seek "seen" and the outline: the web target's navigation free (D41), or a preview's « Déverrouiller
  // la progression ».
  navigation: 'authored' | 'free';
  // The player's bars as learners get them (D58), and the glossary its texts link to.
  player: PlayerData;
  glossary: GlossaryData[];
  // A package of several languages (D59): its languages, the course's own first.
  languages?: string[];
  // elabora.lock.json as the project has it (or the lock a preview keeps): a dialogue's bit fields
  // count the keys of options removed since (dialogue/keys.ts).
  lock?: StateLock | null;
  // The audio of each line of a dialogue the build ships (D61; none: the lines' voices from their
  // sidecars, or estimated, without audio).
  dialogueAudio?: PackagedLines;
}

// A screen's narration as the build laid it out: the package paths of its track and captions, and
// each line's duration measured from its decoded audio.
export interface NarrationTrack {
  src: string;
  captions: string;
  durations: ReadonlyMap<string, number>;
  // The silences it laid out: before each line, then after the last (TimelineLayout.gaps).
  gaps?: readonly number[];
}

export interface CompileOptions {
  assetPath?: (name: string) => string;
  fields?: boolean;
  narration?: (screenId: string, layer?: string) => NarrationTrack | undefined;
  delivery?: WebDelivery;
  // free: every screen open, nothing to do or hear first (the web target says it in delivery).
  navigation?: 'authored' | 'free';
  // The lock the keys came from, when it is not elabora.lock.json (a preview's, BuildOptions.lock).
  lock?: StateLock;
  // The languages of a package of several languages (D59): the language item shows with them.
  languages?: string[];
  dialogueAudio?: PackagedLines;
  // The course's interface sounds (sounds/sounds.ts interfaceSounds), when the caller has them.
  interfaceSounds?: InterfaceSounds;
}

export function createCompileContext(project: Project, keys: StateKeys, { assetPath = defaultAssetPath, fields = false, narration, delivery, navigation: asked, lock, languages, dialogueAudio }: CompileOptions = {}): CompileContext {
  const course = project.course;
  if (!course) throw new Error('The project has no course.json to compile.');
  const sectionOf = new Map<string, string>();
  for (const { id, section } of screenOrder(project)) sectionOf.set(id, section);
  // Free navigation shows the outline (D41): every screen is open from it.
  const navigation = delivery?.navigation === 'free' || asked === 'free' ? 'free' : 'authored';
  const config = navigation === 'free' ? withItemEnabled(playerConfig(course), 'outline') : playerConfig(course);
  const several = languages && languages.length > 1 ? languages : undefined;
  const player = shownPlayer(config, playerContent(project, { web: !!delivery, languages: several?.length ?? 1 }), { assetPath });
  return { course, registry: getRegistry(project), planIndex: planIndex(project.plan), tokens: withPlayerTokens(resolveTokens(course)), keys, lock: lock ?? readLock(project), sectionOf, assetPath, ...(fields ? { fields } : {}), ...(narration ? { narration } : {}), ...(delivery ? { delivery } : {}), navigation, player, glossary: glossaryOf(course), ...(several ? { languages: several } : {}), ...(dialogueAudio ? { dialogueAudio } : {}) };
}

// The course's glossary as the player reads it.
function glossaryOf(course: Course): GlossaryData[] {
  return objectsIn(course.glossary).filter((entry) => isText(entry.id) && isText(entry.term)).map((entry) => ({
    id: entry.id, term: entry.term, definition: textOf(entry.definition),
    ...(Array.isArray(entry.variants) && entry.variants.length ? { variants: entry.variants.filter(isText) } : {})
  }));
}

// The course's resources: files with their package path, type and size, and links (D58). A file
// missing from assets/ (E_ASSET_MISSING) or an address that is not https:// (E_RESOURCE_URL) is
// reported by the validator and left out.
export function resourcesOf(project: Project, context: CompileContext): ResourceData[] {
  return objectsIn(project.course?.resources).flatMap((resource): ResourceData[] => {
    if (!isText(resource.id) || !isText(resource.title)) return [];
    const head = { id: resource.id, title: resource.title, ...(isText(resource.description) && resource.description ? { description: resource.description } : {}) };
    if (isText(resource.url)) return isHttpsUrl(resource.url) ? [{ ...head, kind: 'link', url: resource.url }] : [];
    const asset = resource.asset;
    const file = isText(asset) ? project.files.get(`assets/${asset}`) : undefined;
    if (!file || !isText(asset)) return [];
    const extension = /\.([A-Za-z0-9]+)$/.exec(asset)?.[1]?.toLowerCase() ?? '';
    return [{ ...head, kind: 'file', src: context.assetPath(asset), type: extension, bytes: file.kind === 'binary' ? file.size : new TextEncoder().encode(file.text).length }];
  });
}

// An address a resource may link to: https:// with a host (no other scheme, no credentials).
export const isHttpsUrl = (value: string): boolean => /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?(?:[/?#][^\s<>"]*)?$/.test(value);

// One screen as the player shows it, and the definitions of the free objects its blocks place.
export interface CompiledScreen {
  screen: ScreenData;
  objects: Map<string, ObjectDefinition>; // by object id
}

export function compileCourseData(project: Project, keys: StateKeys, { buildId, assetPath, narration, delivery, navigation, lock, languages, dialogueAudio, interfaceSounds }: { buildId: string } & CompileOptions): CourseData {
  const context = createCompileContext(project, keys, { assetPath, narration, delivery, navigation, ...(lock ? { lock } : {}), languages, dialogueAudio });
  const usedObjects = new Map<string, ObjectDefinition>();
  // A listed screen without its file is reported by the validator (E_SCREEN_NOT_FOUND).
  const screens = screenOrder(project).filter(({ id }) => project.screens.has(id)).map(({ id }) => {
    const compiled = compileScreen(project, id, context);
    for (const [objectId, definition] of compiled.objects) usedObjects.set(objectId, definition);
    return compiled.screen;
  });
  const backdrop = compileBackdrop(project, context, usedObjects);
  const resources = resourcesOf(project, context);
  const about: AboutData = aboutCourse(project);
  const sounds = compileSounds(project, { assetPath: context.assetPath, ...(interfaceSounds ? { settings: interfaceSounds } : {}) });
  return {
    ...courseHead(context),
    ...(backdrop ? { backdrop } : {}),
    sections: context.course.sections,
    screens,
    variables: courseVariables(context),
    objects: sortedObjects(usedObjects),
    ...(resources.length ? { resources } : {}),
    ...(about.ai || about.credits ? { about } : {}),
    ...(sounds ? { sounds } : {}),
    ...(delivery ? { delivery } : {}),
    build: { id: buildId }
  };
}

// The credits a voice asks for (CC-BY voices: their attribution), each once, in the order met;
// none: no key (courses without them keep their bytes).
function creditsOf(credits: readonly (string | null | undefined)[]): { credits?: string[] } {
  const distinct = [...new Set(credits.filter((credit): credit is string => !!credit))];
  return distinct.length ? { credits: distinct } : {};
}

// The course-level fields of the course data that come before the backdrop, the sections and the
// screens (the order of the course data). The canvas reduces a course to one screen around them.
export type CourseHead = Pick<CourseData, 'format' | 'id' | 'title' | 'language' | 'languages' | 'version' | 'ui' | 'navigation' | 'player' | 'glossary' | 'completion' | 'tracking' | 'tokens' | 'presentation' | 'fonts'>;

export function courseHead(context: CompileContext): CourseHead {
  const course = context.course;
  return {
    format: course.format,
    id: course.id,
    title: course.title,
    language: course.language,
    ...(context.languages ? { languages: context.languages } : {}),
    version: course.version,
    ui: course.ui || {},
    navigation: { mode: course.navigation?.mode || 'linear', lockUntilComplete: course.navigation?.lockUntilComplete === true, ...(freeNavigation(context) ? { mode: 'free' as const, lockUntilComplete: false } : {}) },
    player: context.player,
    ...(context.glossary.length ? { glossary: context.glossary } : {}),
    completion: { reportAs: 'completed-incomplete', ...(course.completion || {}) },
    tracking: { exitAfterCompletion: 'suspend', recordInteractions: true, heartbeatSeconds: 60, ...(course.tracking || {}) },
    tokens: context.tokens,
    presentation: { mode: 'scroll', contentWidth: 760, wideWidth: 1100, ...(course.presentation || {}) },
    fonts: objectsIn(course.theme?.fonts).map((font) => ({ family: font.family, src: font.src, weight: font.weight || '400', style: font.style || 'normal', ...(font.unicodeRange ? { unicodeRange: font.unicodeRange } : {}) }))
  };
}

// Free navigation (D41): every screen open from the outline and from Next, nothing to do or to hear
// first.
const freeNavigation = (context: CompileContext): boolean => context.navigation === 'free';

export function courseVariables(context: CompileContext): CourseData['variables'] {
  return objectsIn(context.course.variables).map((variable) => ({ ...variable, key: variable.persist === false ? null : context.keys[`var:${variable.id}`] }));
}

// Free-object definitions by id, sorted (course data).
export function sortedObjects(objects: ReadonlyMap<string, ObjectDefinition>): Record<string, ObjectDefinition> {
  const sorted: Record<string, ObjectDefinition> = {};
  for (const [id, definition] of [...objects].sort(([a], [b]) => a.localeCompare(b))) sorted[id] = definition;
  return sorted;
}

export function compileScreen(project: Project, screenId: string, context: CompileContext): CompiledScreen {
  const screen = project.screens.get(screenId)?.data;
  if (!screen) throw new Error(`Screen "${screenId}" not found (screens/${screenId}.json).`);
  // The registry of the context: a screen edited since the context was made keeps its components.
  const layoutDescriptor = screen.layout ? context.registry.get(screen.layout) : undefined;
  const layout = layoutDescriptor?.level === 'screen' ? layoutDescriptor : null;
  // Heading levels in reading order: the screen under its title, each layer under its own (h2).
  const headingBefore = walkHeadings(context.registry, context.planIndex, screen.blocks, layout).before;
  for (const layer of objectsIn(screen.layers)) for (const [id, level] of walkHeadings(context.registry, context.planIndex, layer.blocks, null, 2).before) headingBefore.set(id, level);
  // The timeline of a timed screen: where its lines, words and timed blocks fall; and the timeline of
  // each layer that has one (D62). Block ids are unique in the course: one map holds every timing.
  const track = context.narration?.(screenId);
  const timeline = screenTimeline(project, screenId, { durations: track?.durations, gaps: track?.gaps });
  const layerTimelines = new Map<string, { timeline: ScreenTimeline; track: NarrationTrack | undefined }>();
  for (const layer of objectsIn(screen.layers)) {
    const own = context.narration?.(screenId, layer.id);
    const found = screenTimeline(project, screenId, { layer: layer.id, durations: own?.durations, gaps: own?.gaps });
    if (found) layerTimelines.set(layer.id, { timeline: found, track: own });
  }
  const timings = new Map(timeline ? blockTimings(timeline) : []);
  const beats = new Map(timeline ? blockBeats(timeline) : []);
  for (const { timeline: own } of layerTimelines.values()) {
    for (const [block, timing] of blockTimings(own)) timings.set(block, timing);
    for (const [block, beat] of blockBeats(own)) beats.set(block, beat);
  }
  const scope: ScreenScope = { project, screen: screenId, context, objects: new Map(), headingBefore, timings, beats };
  const compileBlocks = (blocks: Block[] | undefined, within = scope): BlockData[] => objectsIn(blocks).map((block) => compileBlock(block, within));
  // A block of a layer never carries on to another screen (D65, E_CONTINUITY_PLACE).
  const layerScope: ScreenScope = { ...scope, inLayer: true };
  const data: ScreenData = {
    id: screenId, key: context.keys[`screen:${screenId}`], section: context.sectionOf.get(screenId) ?? '', title: screen.title,
    showTitle: screen.showTitle !== false, required: screen.required !== false,
    ...(screen.style ? { style: screen.style } : {}),
    ...(screen.backdrop ? { backdrop: screen.backdrop } : {}),
    ...(screen.continueRevealsSteps === false ? { continueRevealsSteps: false as const } : {}),
    ...(screen.steps && Object.keys(screen.steps).length ? { steps: compileSteps(screen.steps) } : {}),
    completeWhen: screen.completeWhen || 'viewed', covers: screen.covers,
    ...narrationOf(screen, timeline, track, context),
    blocks: compileBlocks(screen.blocks),
    layers: objectsIn(screen.layers).map((layer) => {
      const own = layerTimelines.get(layer.id);
      return { id: layer.id, title: layer.title, presentation: layer.presentation || 'dialog', ...(own ? layerNarrationOf(screen, layer, own.timeline, own.track, context) : {}), blocks: compileBlocks(layer.blocks, layerScope) };
    }),
    events: objectsIn(screen.events).filter(isEventData).map((event) => seekTimes(event, timeline, layerTimelines, lineTimelines(screen))),
    // Screen layout: a screen-level component rendered with the screen's layoutProps.
    ...(layout?.tpl ? { layout: compileLayout(project, screenId, screen, layout, layout.tpl, context) } : {})
  };
  return { screen: data, objects: scope.objects };
}

// The timeline of a timed screen: its narration's lines with their times, words and captions, its
// segments, the events on it and the track the build made (none in the canvas, or until every line
// has its audio). A screen timed in seconds has no line: its timeline runs on the page's clock.
function narrationOf(screen: Screen, timeline: ScreenTimeline | null, track: NarrationTrack | undefined, context: CompileContext): { narration?: NarrationData } {
  if (!timeline) return {};
  const source = objectsIn(screen.narration?.lines);
  const infos = timeline.lines.map((line) => timeline.infos.get(line.id));
  const voiced = infos.filter((info) => info && info.status !== 'missing' && info.status !== 'untranslated');
  return {
    narration: {
      advance: screen.narration?.advance || context.course.narration?.advance || 'learner', seek: seekOf(screen, context),
      src: timeline.narrated ? track?.src ?? null : null, captions: timeline.narrated ? track?.captions ?? null : null, duration: timeline.duration, estimated: timeline.estimated && !track,
      generated: voiced.some((info) => info?.generated === true),
      ...creditsOf(voiced.map((info) => info?.credit)),
      lines: timeline.lines.map((line, index) => ({
        id: line.id, step: line.step, speaker: infos[index]?.speakerName ?? null, text: withoutDirections(infos[index]?.text ?? textOf((source[index] as { text?: unknown } | undefined)?.text)), start: line.start, end: line.end, cues: line.cues,
        ...(infos[index]?.sound ? { sound: true as const } : {}),
        ...(line.words.length ? { words: line.words.map((word): [string, number, number] => [word.text, word.start, word.end]) } : {})
      })),
      segments: timeline.segments,
      cues: timeline.cues.map((cue) => ({ time: cue.time, event: cue.event }))
    }
  };
}

// A layer's timeline (D62): its lines, its segment (one, from its opening) and its cues, played
// through (advance auto) from 0 each time it opens, by its own track.
function layerNarrationOf(screen: Screen, layer: NonNullable<Screen['layers']>[number], timeline: ScreenTimeline, track: NarrationTrack | undefined, context: CompileContext): { narration?: NarrationData } {
  const seek = layer.narration?.seek || context.course.narration?.seek || 'seen';
  const { narration } = narrationOf(screen, timeline, track, context);
  return narration ? { narration: { ...narration, advance: 'auto', seek: seek === 'seen' && freeNavigation(context) ? 'free' : seek } } : {};
}

// How far learners may move in a narration's timeline; free navigation frees what is "seen" (a
// timeline without a bar, "none", stays so).
function seekOf(screen: Screen, context: CompileContext): NarrationData['seek'] {
  const seek = screen.narration?.seek || context.course.narration?.seek || 'seen';
  return seek === 'seen' && freeNavigation(context) ? 'free' : seek;
}

// A seek-timeline action knows the time of its moment, on the timeline it moves (the screen's, or the
// layer's it names or whose line it goes to).
function seekTimes(event: Event & EventData, screenTimeline: ScreenTimeline | null, layers: ReadonlyMap<string, { timeline: ScreenTimeline }>, lines: ReadonlyMap<string, string | null>): Event & EventData {
  const timelineOf = (action: Extract<EventData['do'][number], { type: 'seek-timeline' }>) => {
    const layer = anchorTimeline(isRecord(action.to) ? action.to : null, action.layer, lines);
    return layer === null ? screenTimeline : layers.get(layer)?.timeline ?? null;
  };
  const timed = (actions: EventData['do'] | undefined) => actions?.map((action) => {
    if (action.type !== 'seek-timeline' || !isRecord(action.to)) return action;
    const timeline = timelineOf(action);
    const layer = anchorTimeline(action.to, action.layer, lines);
    return timeline ? { ...action, ...(layer !== null ? { layer } : {}), time: anchorTime(timeline, action.to).time } : action;
  });
  if (!event.do.some((action) => action.type === 'seek-timeline') && !event.else?.some((action) => action.type === 'seek-timeline')) return event;
  return { ...event, do: timed(event.do)!, ...(event.else ? { else: timed(event.else) } : {}) } as Event & EventData;
}

// A block that carries on from one screen to another (D65): its key, the passage's length, and the
// key of the chain's saved state when it has one (a free object's).
function continuityOf(block: Block, keys: StateKeys): { continuity?: ContinuityData } {
  const key = continuityKey(block);
  if (!key) return {};
  const state = keys[continuityEntity(key)];
  return { continuity: { key, duration: continuityDuration(block), ...(state ? { state } : {}) } };
}

// A timed block's moments as the player plays them.
function timingOf(timing: { in?: TimelineMoment; out?: TimelineMoment } | undefined): { timing?: TimingData } {
  if (!timing) return {};
  const moment = (found: TimelineMoment): MomentData => ({ at: found.at, effect: found.effect, duration: found.duration, ...(found.direction ? { direction: found.direction } : {}) });
  return { timing: { ...(timing.in ? { in: moment(timing.in) } : {}), ...(timing.out ? { out: moment(timing.out) } : {}) } };
}

// Step settings in step order, without empty entries (the player reads them by step number).
function compileSteps(steps: NonNullable<Screen['steps']>): NonNullable<ScreenData['steps']> {
  const out: NonNullable<ScreenData['steps']> = {};
  for (const key of Object.keys(steps).sort((a, b) => Number(a) - Number(b))) {
    const settings = steps[key];
    if (!settings || typeof settings !== 'object') continue;
    out[key] = { ...(settings.opens ? { opens: settings.opens } : {}), ...(settings.label ? { label: settings.label } : {}) };
  }
  return out;
}

function compileLayout(project: Project, screenId: string, screen: Screen, layout: ComponentDescriptor, template: ParsedTemplate, context: CompileContext): ScreenLayout {
  const props = applyDefaults(layout.schema, resolveTextRefs(screen.layoutProps || {}, context.planIndex));
  const html = renderTemplate(template, { props, schema: layout.schema, id: screen.id, language: context.course.language, assetPath: context.assetPath, fields: context.fields }).html;
  return { id: layout.id, lineage: layout.lineage, fullBleed: layout.fullBleed, defaultSlot: layout.defaultSlot, html, ...layoutFacts(project, screenId, html) };
}

// What the layout hook of a screen shows (D63), when its template has it: the page's reading time
// (data-t-duration), which the player words from its labels.
function layoutFacts(project: Project, screenId: string, html: string): Pick<ScreenLayout, 'minutes'> {
  return html.includes('data-t-duration') ? { minutes: pageMinutes(project, screenId) } : {};
}

// A block shown empty: the player renders its html (none), whatever its type.
function emptyBlock(block: Block, placement: Partial<Pick<BlockData, 'hidden' | 'step' | 'slot' | 'style' | 'optional'>>): BlockData {
  return { id: textOf(block.id), type: textOf(block.type), width: block.width || 'full', ...placement, html: '' };
}

// What compiling the blocks of one screen needs, and the free objects they place.
interface ScreenScope {
  project: Project;
  screen: string;
  context: CompileContext;
  objects: Map<string, ObjectDefinition>;
  // Level of the heading before each block (templates' relative headings follow it).
  headingBefore: Map<string, number>;
  // When timed blocks come and go (blocks of the screen and of its components' slots).
  timings: Map<string, { in?: TimelineMoment; out?: TimelineMoment }>;
  // When the voice brings the items of charts, and when it is done with them (D60).
  beats: Map<string, { items: Record<string, number>; end?: number }>;
  // Compiling the blocks of a layer.
  inLayer?: boolean;
}

function compileBlock(block: Block, scope: ScreenScope): BlockData {
  const { context } = scope;
  const descriptor = context.registry.get(block.type);
  const placement = {
    ...(block.hidden ? { hidden: true as const } : {}),
    ...((block.step ?? 1) > 1 ? { step: block.step } : {}),
    ...timingOf(scope.timings.get(block.id)),
    ...(block.slot ? { slot: block.slot } : {}),
    ...(block.style ? { style: block.style } : {}),
    // Extra the learner may skip: not waited for by steps that open once explored nor by interactions-done (D63).
    ...(block.optional === true ? { optional: true as const } : {}),
    // Continuity between screens (D65); a free object's state is the chain's.
    ...(scope.inLayer ? {} : continuityOf(block, context.keys))
  };
  // A block the player cannot show (unknown type: E_COMPONENT_UNKNOWN) compiles to an empty block, so
  // a screen being written still renders.
  if (!descriptor) return emptyBlock(block, placement);
  const props = recordOf(applyDefaults(descriptor.schema, resolveBlockProps(block, context.planIndex, context.registry)));
  const visibilityKey = context.keys[`block:${block.id}`];
  // The fields are written in the order of the course data: id … style, key, vkey, html … defaultSlot, props, blocks.
  const head = { id: block.id, type: block.type, width: block.width || 'full', ...(descriptor.lineage.length > 1 ? { lineage: descriptor.lineage } : {}) };
  // vkey: visibility changed by events.
  // A fill-in's text renders with a marker where each blank is, then each marker becomes its hook (D63).
  const fillIn = descriptor.root === 'fill-in';
  const template = descriptor.render === 'template' && descriptor.tpl ? templateData(block, descriptor, descriptor.tpl, fillIn ? { ...props, markdown: markBlanks(props.markdown) } : props, context, scope.headingBefore.get(block.id)) : null;
  if (template && descriptor.root === 'image') template.html = inlineImage(template.html, block, props, scope);
  if (template && fillIn) template.html = placeBlanks(template.html);
  const rendered = {
    ...(visibilityKey ? { vkey: visibilityKey } : {}),
    ...(template ?? {}),
    ...(template?.visits ? exploreOf(descriptor.root, props) : {})
  };
  const nested = objectsIn(block.blocks);
  const children = nested.length ? { blocks: nested.map((child) => compileBlock(child, scope)) } : {};
  // key: learner state of activities (forks of an activity keep its behaviour, so its state).
  const activityKey = (behavior: ActivityBehavior): string => context.keys[activityEntity(behavior, block.id)];

  // Charts and diagrams (D60): drawn here, moved by the player's chart behaviour; a trend in predict
  // mode is an activity (its guess is kept, and scored when it says so).
  if (descriptor.root && isChartType(descriptor.root)) {
    const chart = renderChart(descriptor.root, props, { id: block.id, language: context.course.language || 'en', tokens: context.tokens, fields: context.fields });
    const beats = scope.beats.get(block.id);
    const predict = isPredict(descriptor.root, props);
    const chartProps = {
      chart: descriptor.root,
      ...(typeof props.highlight === 'string' ? { highlight: props.highlight } : {}),
      ...(beats ? { beats: beats.items, ...(beats.end !== undefined ? { beatsEnd: beats.end } : {}), revealOnBeats: props.revealOnBeats !== false } : {}),
      ...(chart.data ?? {})
    };
    return { ...head, behavior: predict ? 'predict' : 'chart', ...placement, ...(predict ? { key: activityKey('predict') } : {}), ...rendered, html: chart.html, props: chartProps, ...children } as BlockData;
  }

  // Data for the behaviours (player) and for the components rendered by code.
  switch (descriptor.root) {
    case 'quiz': return { ...head, behavior: 'quiz', ...placement, key: activityKey('quiz'), ...rendered, props: quizProps(props), ...children };
    case 'numeric': return { ...head, behavior: 'numeric', ...placement, key: activityKey('numeric'), ...rendered, props: numericProps(props), ...children };
    case 'fill-in': return { ...head, behavior: 'fill-in', ...placement, key: activityKey('fill-in'), ...rendered, props: fillInProps(props, block.id), ...children };
    case 'sort': return { ...head, behavior: 'sort', ...placement, key: activityKey('sort'), ...rendered, props: sortProps(props, block.id), ...children };
    case 'reflection': return { ...head, behavior: 'reflection', ...placement, key: activityKey('reflection'), ...rendered, props: reflectionProps(props), ...children };
    case 'decision': return { ...head, behavior: 'decision', ...placement, key: activityKey('decision'), ...rendered, props: decisionProps(props), ...children };
    case 'dialogue': return { ...head, behavior: 'dialogue', ...placement, key: activityKey('dialogue'), ...rendered, props: dialogueProps(block.id, props, scope), ...children };
    case 'free-object': {
      // A free object without manifest (E_OBJECT_NOT_FOUND) shows nothing.
      const objectProps = objectBlockProps(props, scope);
      if (!objectProps) return emptyBlock(block, placement);
      return { ...head, type: 'free-object', behavior: 'object', ...placement, key: activityKey('object'), ...rendered, props: objectProps, ...children };
    }
    case 'results': return { ...head, behavior: 'results', ...placement, ...rendered, props: resultsProps(props), ...children };
    case 'speech': return { ...head, behavior: 'speech', ...placement, ...rendered, props: speechProps(props, scope), ...children };
    case 'video': return { ...head, type: 'video', ...placement, ...rendered, props: videoProps(props, context.assetPath), ...children };
    case 'audio': return { ...head, type: 'audio', ...placement, ...rendered, props: audioProps(props, context.assetPath), ...children };
    default: return { ...head, ...placement, ...rendered, ...children };
  }
}

// What the controls of a steps block or an interactive picture (and their forks) are, for the words of
// a locked Continue (D63): steps, a timeline's events, markers.
function exploreOf(root: string | null, props: Record<string, unknown>): { explore?: 'steps' | 'events' | 'markers' } {
  if (root === 'steps') return { explore: props.presentation === 'timeline' ? 'events' : 'steps' };
  if (root === 'hotspots') return { explore: 'markers' };
  return {};
}

// An image block (or a fork) with inline: true and an SVG asset: the drawing in the page in place of
// its <img> (render/svg-inline.ts), so that the draw effect, the theme and currentColor reach it.
function inlineImage(html: string, block: Block, props: Record<string, unknown>, scope: ScreenScope): string {
  if (props.inline !== true || typeof props.asset !== 'string' || !/\.svg$/i.test(props.asset)) return html;
  const source = readText(scope.project.files, `assets/${props.asset}`);
  if (source === null) return html;
  return replaceImage(html, scope.context.assetPath(props.asset), ({ img, alt, className }) => inlineSvg(source, { prefix: `t-svg-${block.id}`, label: alt ?? undefined, decorative: props.decorative === true || !alt, className: className ?? undefined }).html || img);
}

// A block rendered by its component template: its HTML, and the key of each control (button, tab,
// disclosure) under which its visited state is saved.
function templateData(block: Block, descriptor: ComponentDescriptor, template: ParsedTemplate, props: Record<string, unknown>, context: CompileContext, headingLevel: number | undefined): { html: string; visits?: Record<string, string>; defaultSlot?: string | null } {
  const html = renderTemplate(template, { props, schema: descriptor.schema, id: block.id, language: context.course.language, assetPath: context.assetPath, headingLevel, fields: context.fields }).html;
  const visits: Record<string, string> = {};
  for (const name of controlsOf(html).keys()) {
    const key = context.keys[controlEntity(block.id, name)];
    if (key) visits[name] = key;
  }
  return { html, ...(Object.keys(visits).length ? { visits } : {}), ...(descriptor.slots.length ? { defaultSlot: descriptor.defaultSlot } : {}) };
}

function quizProps(props: Record<string, unknown>): QuizProps {
  return {
    mode: props.mode === 'multiple' ? 'multiple' : 'single', objective: optionalTextOf(props.objective), scored: props.scored !== false, weight: numberOr(props.weight, 1),
    attempts: numberOr(props.attempts, 1), showCorrectAnswer: props.showCorrectAnswer !== false,
    ...(props.feedbackStyle === 'compact' ? { feedbackStyle: 'compact' as const } : {}),
    ...(props.presentation === 'images' || props.presentation === 'image' ? { presentation: props.presentation } : {}),
    options: recordsOf(props.options).map((option) => ({ id: textOf(option.id), text: textOf(option.text), correct: !!option.correct, feedbackHtml: renderMarkdown(option.feedback) })),
    ...questionRefOf(props)
  };
}

function numericProps(props: Record<string, unknown>): NumericProps {
  const feedback = recordOf(props.feedback);
  return {
    answer: expectedNumberOf(props.answer), tolerance: toleranceOf(props.tolerance), unit: typeof props.unit === 'string' ? props.unit : '', objective: optionalTextOf(props.objective),
    scored: props.scored !== false, weight: numberOr(props.weight, 1), attempts: numberOr(props.attempts, 1), showCorrectAnswer: props.showCorrectAnswer !== false,
    feedback: { correctHtml: renderMarkdown(feedback.correct), incorrectHtml: renderMarkdown(feedback.incorrect) },
    misconceptions: recordsOf(props.misconceptions).map((misconception) => ({ id: textOf(misconception.id), value: expectedNumberOf(misconception.value), tolerance: toleranceOf(misconception.tolerance), feedbackHtml: renderMarkdown(misconception.feedback) })),
    ...questionRefOf(props)
  };
}

// D63's activities. A fill-in: its blanks' answers (out of the text), and the words its menus or its
// bank offer, shuffled the same way at every build.
function fillInProps(props: Record<string, unknown>, blockId: string): FillInProps {
  const presentation = props.presentation === 'menus' || props.presentation === 'bank' ? props.presentation : 'typed';
  const blanks = parseBlanks(props.markdown).map((blank) => ({ answers: blank.answers, maxLength: blankMaxLength(blank) }));
  const distractors = (Array.isArray(props.distractors) ? props.distractors : []).filter(isText).map((word) => word.trim()).filter(Boolean);
  const firsts = blanks.map((blank) => blank.answers[0]).filter(isText);
  // menus: each word once; bank: a word per blank (two blanks may take the same word), then the distractors.
  const words = presentation === 'menus' ? stableShuffle([...new Set([...firsts, ...distractors])], blockId) : presentation === 'bank' ? stableShuffle([...firsts, ...distractors], blockId) : [];
  const feedback = recordOf(props.feedback);
  return {
    presentation, objective: optionalTextOf(props.objective), scored: props.scored !== false, weight: numberOr(props.weight, 1), attempts: numberOr(props.attempts, 1),
    showCorrectAnswer: props.showCorrectAnswer !== false, ignoreAccents: props.ignoreAccents === true, blanks, words,
    feedback: { correctHtml: renderMarkdown(feedback.correct), incorrectHtml: renderMarkdown(feedback.incorrect) }
  };
}

// A sort: its items in the author's order with the index of their target, and the order they show in.
function sortProps(props: Record<string, unknown>, blockId: string): SortProps {
  const presentation = props.presentation === 'categories' || props.presentation === 'order' ? props.presentation : 'pairs';
  const labelOf = (entry: Record<string, unknown>) => textOf(entry.text) || textOf(entry.alt) || textOf(entry.id);
  const targets = presentation === 'order' ? [] : recordsOf(props.targets).map((target) => ({ id: textOf(target.id), label: labelOf(target) }));
  const items = recordsOf(props.items).map((item) => ({ id: textOf(item.id), label: labelOf(item), target: presentation === 'order' ? -1 : targets.findIndex((target) => target.id === item.target) }));
  const feedback = recordOf(props.feedback);
  return {
    presentation, objective: optionalTextOf(props.objective), scored: props.scored !== false, weight: numberOr(props.weight, 1), attempts: numberOr(props.attempts, 1),
    showCorrectAnswer: props.showCorrectAnswer !== false, items, targets, shuffled: stableShuffle(items.map((_, index) => index), blockId),
    feedback: { correctHtml: renderMarkdown(feedback.correct), incorrectHtml: renderMarkdown(feedback.incorrect) }
  };
}

// A reflection: never scored; its prompt as text for « Mes réponses ».
function reflectionProps(props: Record<string, unknown>): ReflectionProps {
  const scale = recordOf(props.scale);
  const integer = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isInteger(value) ? value : fallback);
  return {
    presentation: props.presentation === 'scale' ? 'scale' : 'text', objective: optionalTextOf(props.objective), prompt: markdownToText(props.prompt),
    maxLength: integer(props.maxLength, 500), rows: integer(props.rows, 4), modelHtml: renderMarkdown(props.model), download: props.download === true,
    scale: { min: integer(scale.min, 1), max: integer(scale.max, 5), minLabel: textOf(scale.minLabel), maxLabel: textOf(scale.maxLabel) }
  };
}

function decisionProps(props: Record<string, unknown>): DecisionProps {
  return {
    objective: optionalTextOf(props.objective), scored: !!props.scored, weight: numberOr(props.weight, 1), allowChange: !!props.allowChange,
    options: recordsOf(props.options).map((option) => ({ id: textOf(option.id), label: textOf(option.label), feedbackHtml: renderMarkdown(option.feedback), ...(typeof option.correct === 'boolean' ? { correct: option.correct } : {}) }))
  };
}

// A dialogue (D61): its graph for the walk, the stage directions left out of what learners read, its
// Markdown as HTML, its speakers (their characters' SVG sanitized for the page), its keys, and the
// voice of each line (its audio in the package, or the estimate) with its cues' times.
function dialogueProps(blockId: string, props: Record<string, unknown>, scope: ScreenScope): DialogueProps {
  const { context, project } = scope;
  const variables = new Map(objectsIn(context.course.variables).map((variable) => [variable.id, variable.default]));
  let sounds: ReturnType<typeof soundAssets> | null = null;
  return dialogueData(props, {
    course: context.course, keys: dialogueKeys(blockId, context.keys, context.lock ?? null), assetPath: context.assetPath, directions: 'strip', markdown: (text) => renderMarkdown(text),
    voice: dialogueVoices(project, scope.screen, { ...(context.dialogueAudio ? { packaged: context.dialogueAudio } : {}) }),
    soundLength: (sound) => { const asset = (sounds ??= soundAssets(project)).get(sound); return asset ? soundLength(project, asset) : null; },
    look: (speaker, svg) => {
      const source = readText(project.files, `assets/${svg}`);
      const drawn = source === null ? null : characterInline(source, speaker);
      return drawn ? { inline: drawn.inline, manifest: drawn.manifest } : null;
    },
    env: { variable: (id) => { const value = variables.get(id); return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' ? value : undefined; } }
  });
}

// A character speaking (D63): its speaker's name, colour and look, as a dialogue's (its SVG sanitized).
function speechProps(props: Record<string, unknown>, scope: ScreenScope): SpeechProps {
  const { context, project } = scope;
  const speaker = objectsIn(context.course.speakers).find((entry) => entry.id === props.speaker);
  return {
    speaker: speaker ? speakerData(speaker, context.assetPath, (id, svg) => {
      const source = readText(project.files, `assets/${svg}`);
      const drawn = source === null ? null : characterInline(source, id);
      return drawn ? { inline: drawn.inline, manifest: drawn.manifest } : null;
    }) : null
  };
}

function objectBlockProps(props: Record<string, unknown>, scope: ScreenScope): ObjectBlockProps | null {
  const manifest = scope.project.objects.get(textOf(props.object))?.manifest;
  if (!manifest) return null;
  scope.objects.set(manifest.id, objectDefinition(manifest));
  const a11y = props.a11y;
  return {
    object: manifest.id, title: textOf(props.title), props: jsonObjectOf({ ...objectPropDefaults(manifest, scope.context.tokens), ...recordOf(props.props) }),
    aspectRatio: aspectRatioOf(props.aspectRatio) ?? '16:9', narrowAspectRatio: aspectRatioOf(props.narrowAspectRatio) ?? null,
    minHeight: numberOr(props.minHeight, null), maxHeight: numberOr(props.maxHeight, null),
    textAlternativeHtml: renderMarkdown(props.textAlternative), scored: !!props.scored, weight: numberOr(props.weight, 1),
    ...(isObjectA11y(a11y) ? { a11y } : {}),
    // Words of the object: manifest strings, reworded or translated by the block.
    strings: { ...manifestStrings(manifest), ...stringsOf(props.strings) }
  };
}

function resultsProps(props: Record<string, unknown>): ResultsProps {
  return {
    showScore: props.showScore !== false, showStatus: props.showStatus !== false, allowRetry: !!props.allowRetry,
    passedMessageHtml: renderMarkdown(props.passedMessage), failedMessageHtml: renderMarkdown(props.failedMessage), completedMessageHtml: renderMarkdown(props.completedMessage)
  };
}

function videoProps(props: Record<string, unknown>, assetPath: (name: string) => string): VideoProps {
  return {
    src: assetPath(String(props.asset)), captions: props.captions ? assetPath(String(props.captions)) : undefined, poster: props.poster ? assetPath(String(props.poster)) : undefined,
    title: textOf(props.title), transcriptHtml: renderMarkdown(props.transcript), alt: textOf(props.alt), loop: !!props.loop, decorative: !!props.decorative, generated: !!props.generated
  };
}

function audioProps(props: Record<string, unknown>, assetPath: (name: string) => string): AudioProps {
  return { src: assetPath(String(props.asset)), title: textOf(props.title), transcriptHtml: renderMarkdown(props.transcript), decorative: !!props.decorative, generated: !!props.generated };
}

// Backdrop: CSS layers and a decorative object mounted once behind the course.
export function compileBackdrop(project: Project, context: CompileContext, usedObjects: Map<string, ObjectDefinition>): Backdrop | null {
  const source = context.course.theme?.backdrop;
  if (!source) return null;
  const backdrop: Backdrop = { layers: source.layers || [], variants: Object.keys(source.variants || {}), ...(source.default ? { default: source.default } : {}) };
  const manifest = source.object && project.objects.get(source.object.id)?.manifest;
  if (source.object && manifest) {
    usedObjects.set(manifest.id, objectDefinition(manifest));
    backdrop.object = { object: manifest.id, props: jsonObjectOf({ ...objectPropDefaults(manifest, context.tokens), ...(source.object.props || {}) }) };
  }
  return backdrop;
}

// What the player needs of a free object's manifest to host it.
function objectDefinition(manifest: ObjectManifest): ObjectDefinition {
  const id = manifest.id;
  return {
    id, version: manifest.version, dir: `objects/${id}`,
    objects: objectsIn(manifest.objects),
    events: Object.fromEntries(objectsIn(manifest.events).map((event) => [event.name, { payload: payloadSchemaOf(event.payload), tracking: event.tracking || null }])),
    persistMax: manifest.persistState?.enabled ? (manifest.persistState.maxLength || 300) : 0,
    assets: objectsIn(manifest.assets).map((asset) => ({ id: asset.id, file: asset.file, type: asset.type || 'other' })),
    permissions: manifest.sandbox?.permissions || [],
    a11y: { description: manifest.a11y?.description, keyboard: manifest.a11y?.keyboard },
    ...(manifest.pedagogicalRole === 'decoration' ? { decoration: true as const } : {})
  };
}

// The payload schema of an object event, which the player checks payloads against: the subset of
// JSON Schema both the format and the player's validator know (a manifest that strays from it
// fails validation, and its payloads go unchecked).
const payloadSchemaOf = (schema: ObjectEvent['payload']): DataSchema | null => (isDataSchema(schema) ? schema : null);

const DATA_TYPES: ReadonlySet<string> = new Set<DataType>(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
function isDataSchema(value: unknown): value is DataSchema {
  if (!isRecord(value)) return false;
  const { type, items, properties, required } = value;
  return isOptional(type, () => (Array.isArray(type) ? type : [type]).every((name) => typeof name === 'string' && DATA_TYPES.has(name)))
    && isOptional(value.enum, () => Array.isArray(value.enum) && value.enum.every(isJsonValue))
    && isOptional(items, isDataSchema)
    && isOptional(properties, () => isRecord(properties) && Object.values(properties).every(isDataSchema))
    && isOptional(required, () => Array.isArray(required) && required.every(isText))
    && isOptional(value.minimum, isNumber) && isOptional(value.maximum, isNumber) && isOptional(value.maxLength, isNumber) && isOptional(value.maxItems, isNumber)
    && isOptional(value.description, isText);
}

// Prop values of a free object before a block or the backdrop sets its own: the manifest default,
// or the theme token the prop takes its default from.
function objectPropDefaults(manifest: ObjectManifest, tokens: TokenValues): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, declared] of Object.entries(manifest.props?.properties || {})) {
    const schema = recordOf(declared);
    const token = schema['x-token'];
    values[name] = typeof token === 'string' && tokens[token] !== undefined ? tokens[token] : schema.default;
  }
  return values;
}

// ── events ───────────────────────────────────────────────────────────
// Events go to the player as authored. The format's types leave the fields of a trigger, a
// condition or an action optional; the schema requires them per type, and the player relies on
// it. An event that misses one is reported by the validator and left out here.
function isEventData(event: Event): event is Event & EventData {
  return typeof event.id === 'string' && isRecord(event.on) && Array.isArray(event.do) && event.do.every(isActionData)
    && (event.if === undefined || (Array.isArray(event.if) && event.if.every(isConditionData))) && (event.else === undefined || (Array.isArray(event.else) && event.else.every(isActionData)));
}

function isConditionData(condition: Condition): condition is Condition & ConditionData {
  if (!isRecord(condition)) return false;
  if (typeof condition.dialogue === 'string') return typeof condition.ending === 'string' || typeof condition.chosen === 'string' || typeof condition.done === 'boolean' || (isRecord(condition.score) && typeof condition.score.value === 'number');
  return typeof condition.visited === 'string' || (typeof condition.variable === 'string' && condition.op !== undefined && condition.value !== undefined);
}

function isActionData(action: Action): action is Action & ActionData {
  if (!isRecord(action)) return false;
  switch (action.type) {
    case 'go-to': return typeof action.screen === 'string';
    case 'show-layer': return typeof action.layer === 'string';
    case 'hide-layer': return action.layer === undefined || typeof action.layer === 'string';
    case 'show-block': case 'hide-block': return typeof action.block === 'string';
    case 'reveal-step': return typeof action.step === 'number';
    case 'set-variable': return typeof action.variable === 'string' && action.value !== undefined;
    case 'increment-variable': return typeof action.variable === 'string' && typeof action.by === 'number';
    case 'set-object-props': return typeof action.block === 'string' && isJsonValue(action.props) && isRecord(action.props);
    case 'complete-screen': case 'exit-course': case 'pause-timeline': case 'play-timeline': return true;
    case 'seek-timeline': return isRecord(action.to);
    case 'play-media': case 'pause-media': return typeof action.block === 'string';
    case 'start-dialogue': case 'restart-dialogue': return typeof action.block === 'string';
    case 'goto-dialogue': return typeof action.block === 'string' && typeof action.node === 'string';
    case 'play-sound': return typeof action.sound === 'string';
    case 'stop-sound': return action.sound === undefined || typeof action.sound === 'string';
    default: return false;
  }
}

// ── reading props ────────────────────────────────────────────────────
const expectedNumberOf = (value: unknown): number => (typeof value === 'number' ? value : NaN);
const questionRefOf = (props: Record<string, unknown>): { questionRef?: string } => (typeof props.questionRef === 'string' && props.questionRef ? { questionRef: props.questionRef } : {});

const toleranceOf = (value: unknown): NumericTolerance | null => (isRecord(value) && isOptional(value.absolute, isNumber) && isOptional(value.percent, isNumber) ? value : null);

const ASPECT_RATIOS: ReadonlySet<string> = new Set<AspectRatio>(['16:9', '21:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', 'auto', 'fill']);
const isAspectRatio = (value: unknown): value is AspectRatio => typeof value === 'string' && ASPECT_RATIOS.has(value);
const aspectRatioOf = (value: unknown): AspectRatio | undefined => (isAspectRatio(value) ? value : undefined);

function isObjectA11y(value: unknown): value is { description?: string; keyboard?: string } {
  return isRecord(value) && isOptional(value.description, isText) && isOptional(value.keyboard, isText);
}

// The words a manifest declares (a string without text fails the schema).
function manifestStrings(manifest: ObjectManifest): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const [key, string] of Object.entries(manifest.strings || {})) { const { text } = recordOf(string); if (typeof text === 'string') strings[key] = text; }
  return strings;
}

function stringsOf(value: unknown): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const [key, text] of Object.entries(recordOf(value))) if (typeof text === 'string') strings[key] = text;
  return strings;
}
