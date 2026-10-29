import type { Course, Project } from '../project/model.ts';
import type { PlayerBar, PlayerItem } from '@elabora/format';
import type { AboutData, PlayerBarData, PlayerData, PlayerItemData, PlayerItemId } from '@elabora/player/course-data';
import { screenOrder, screenBlocks } from '../project/load.ts';
import { getRegistry, behaviorOf } from '../components/registry.ts';
import { narrationLines } from '../narration/narration.ts';
import { soundAssets, soundSidecar, soundUses } from '../sounds/sounds.ts';
import { soundCredit } from '../sounds/licences.ts';
import { momentsOf, cuesOf } from '../narration/timeline.ts';
import { objectsIn } from '../util/values.ts';
import { isRecord } from '../compile/values.ts';
import { translationStatus, translationReady } from '../i18n/translate.ts';

// The player's configuration (docs/decisions.md D58): course.json player, two bars of ordered items.
// What the course says is filled in with the defaults here, once, for every reader: the compiler
// (what learners get), the validator (its checks), the editor of the app and the agents' operation
// (elabora_player). An item shows when it is enabled and has something to show; a bar with nothing
// to show is removed.

export const PLAYER_ITEMS = ['logo', 'title', 'progress', 'spacer', 'outline', 'controls', 'resources', 'glossary', 'language', 'display', 'credits', 'previous', 'next', 'exit'] as const satisfies readonly PlayerItemId[];

export type BarName = 'top' | 'bottom';
export const BARS: readonly BarName[] = ['top', 'bottom'];

export interface ControlsOptions {
  seekBar: boolean;
  captionsByDefault: boolean;
  volume: boolean;
  transcript: boolean;
  speeds: 'none' | '0.75-1.5' | '0.75-2';
}

// What the outline's button reads: « Sommaire », the title of the part shown, or of the screen shown.
export const OUTLINE_LABELS = ['outline', 'section', 'screen'] as const;
export type OutlineLabel = typeof OUTLINE_LABELS[number];

export const CONTROLS_DEFAULTS: Readonly<ControlsOptions> = { seekBar: true, captionsByDefault: false, volume: true, transcript: true, speeds: '0.75-2' };

// The speeds learners may choose, by option.
export const SPEEDS: Readonly<Record<ControlsOptions['speeds'], readonly number[]>> = {
  none: [1],
  '0.75-1.5': [0.75, 1, 1.25, 1.5],
  '0.75-2': [0.75, 1, 1.25, 1.5, 2]
};

// An item as configured, every option filled in.
export type ConfiguredItem =
  | { id: 'logo'; enabled: boolean; options: { asset: string | null; alt: string; plate: boolean } }
  | { id: 'outline'; enabled: boolean; options: { label: OutlineLabel } }
  | { id: 'controls'; enabled: boolean; options: ControlsOptions }
  | { id: 'glossary'; enabled: boolean; options: { linkTerms: boolean } }
  | { id: Exclude<PlayerItemId, 'logo' | 'outline' | 'controls' | 'glossary'>; enabled: boolean; options: Record<string, never> };

export interface ConfiguredBar {
  position: 'window' | 'page';
  items: ConfiguredItem[];
}

export interface PlayerConfig {
  top: ConfiguredBar;
  bottom: ConfiguredBar;
}

// What a new course gets (Lin 44, approved on 20 October 2026). Top: the course's identity and where
// the learner is, the spacer, then what they may open (as in the Lin pages 36 and 27: a title bar
// with Ressources and Glossaire on its right); the logo waits for an image. Bottom: the outline, the
// narration's controls, the spacer, Previous and Next (the players of Storyline and Rise).
export const DEFAULT_PLAYER: Readonly<Record<BarName, Required<PlayerBar>>> = {
  top: {
    position: 'window',
    items: [{ id: 'logo', enabled: false }, { id: 'title' }, { id: 'progress' }, { id: 'spacer' }, { id: 'resources' }, { id: 'glossary' }, { id: 'credits' }, { id: 'exit' }]
  },
  bottom: {
    position: 'window',
    items: [{ id: 'outline' }, { id: 'controls' }, { id: 'spacer' }, { id: 'previous' }, { id: 'next' }]
  }
};

// Where an item that is in neither bar goes when it is enabled: its place in a new course, else the
// place Lin 44 draws it (language after the top bar's spacer, display after the bottom bar's).
export const DEFAULT_PLACES: Readonly<Record<PlayerItemId, { bar: BarName; after: readonly PlayerItemId[] }>> = Object.fromEntries([
  ...BARS.flatMap((bar) => DEFAULT_PLAYER[bar].items.map((item, index, items) => [item.id, { bar, after: items.slice(0, index).map((before) => before.id).reverse() }])),
  ['language', { bar: 'top', after: ['spacer', 'progress', 'title', 'logo'] }],
  ['display', { bar: 'bottom', after: ['spacer', 'controls', 'outline'] }]
]) as Record<PlayerItemId, { bar: BarName; after: readonly PlayerItemId[] }>;

const isItemId = (value: unknown): value is PlayerItemId => typeof value === 'string' && (PLAYER_ITEMS as readonly string[]).includes(value);

// One item with its options filled in (values of the wrong type take the default: the validator
// reports them).
export function configuredItem(item: PlayerItem): ConfiguredItem | null {
  if (!isItemId(item.id)) return null;
  const enabled = item.enabled !== false;
  const options = isRecord(item.options) ? item.options : {};
  const flag = (name: keyof ControlsOptions | 'plate' | 'linkTerms', fallback: boolean) => (typeof options[name] === 'boolean' ? options[name] as boolean : fallback);
  switch (item.id) {
    case 'logo': return { id: 'logo', enabled, options: { asset: typeof options.asset === 'string' && options.asset ? options.asset : null, alt: typeof options.alt === 'string' ? options.alt : '', plate: flag('plate', false) } };
    case 'glossary': return { id: 'glossary', enabled, options: { linkTerms: flag('linkTerms', true) } };
    // « Espace flexible »: always on.
    case 'spacer': return { id: 'spacer', enabled: true, options: {} };
    case 'outline': return { id: 'outline', enabled, options: { label: (OUTLINE_LABELS as readonly unknown[]).includes(options.label) ? options.label as OutlineLabel : 'outline' } };
    case 'controls': return {
      id: 'controls', enabled,
      options: {
        seekBar: flag('seekBar', CONTROLS_DEFAULTS.seekBar), captionsByDefault: flag('captionsByDefault', CONTROLS_DEFAULTS.captionsByDefault),
        volume: flag('volume', CONTROLS_DEFAULTS.volume), transcript: flag('transcript', CONTROLS_DEFAULTS.transcript),
        speeds: typeof options.speeds === 'string' && options.speeds in SPEEDS ? options.speeds as ControlsOptions['speeds'] : CONTROLS_DEFAULTS.speeds
      }
    };
    default: return { id: item.id, enabled, options: {} };
  }
}

// course.json player with the defaults: a bar left out is its default; an item named twice keeps its
// first place (E_PLAYER_ITEM_DUPLICATE).
export function playerConfig(course: Pick<Course, 'player'> | null | undefined): PlayerConfig {
  const seen = new Set<string>();
  const own = (name: BarName) => (isRecord(course?.player) && isRecord(course.player[name]) ? course.player[name] : null);
  const listed = (name: BarName) => { const items = own(name)?.items; return Array.isArray(items) ? items : null; };
  // A bar without its own list has the default items, less those the author placed elsewhere: an
  // item the author placed wins over a default.
  // (The spacer is one per bar: one bar's does not take the other's.)
  const placed = new Set(BARS.flatMap((name) => (listed(name) ?? []).filter((item) => isRecord(item)).map((item) => String(item.id))).filter((id) => id !== 'spacer'));
  const bar = (name: BarName): ConfiguredBar => {
    const source = own(name) ?? DEFAULT_PLAYER[name];
    const items = listed(name) ?? DEFAULT_PLAYER[name].items.filter((item) => !placed.has(item.id));
    let spacer = false;
    return {
      position: source.position === 'page' ? 'page' : 'window',
      items: items.flatMap((item) => {
        if (!isRecord(item)) return [];
        if (item.id === 'spacer') { if (spacer) return []; spacer = true; } else if (seen.has(String(item.id))) return [];
        const configured = configuredItem(item as PlayerItem);
        if (!configured) return [];
        if (configured.id !== 'spacer') seen.add(configured.id);
        return [configured];
      })
    };
  };
  return { top: bar('top'), bottom: bar('bottom') };
}

// The configuration with an item enabled: in its place, or where a new course has it (the web
// target's free navigation shows the outline, D41).
export function withItemEnabled(config: PlayerConfig, id: PlayerItemId): PlayerConfig {
  const next: PlayerConfig = { top: { ...config.top, items: config.top.items.map((item) => ({ ...item })) }, bottom: { ...config.bottom, items: config.bottom.items.map((item) => ({ ...item })) } };
  const found = findItem(next, id);
  if (found) { next[found.bar].items[found.index].enabled = true; return next; }
  const { bar, after } = DEFAULT_PLACES[id];
  const item = configuredItem({ id });
  const before = after.map((other) => next[bar].items.findIndex((entry) => entry.id === other)).find((index) => index >= 0);
  if (item) next[bar].items.splice(before === undefined ? 0 : before + 1, 0, item);
  return next;
}

// Where an item is, enabled or not; null when neither bar lists it.
export function findItem(config: PlayerConfig, id: PlayerItemId): { bar: BarName; index: number; item: ConfiguredItem } | null {
  for (const bar of BARS) {
    const index = config[bar].items.findIndex((item) => item.id === id);
    if (index >= 0) return { bar, index, item: config[bar].items[index] };
  }
  return null;
}

// Whether an item is enabled in one of the bars (whatever it would show).
export const itemEnabled = (config: PlayerConfig, id: PlayerItemId): boolean => !!findItem(config, id)?.item.enabled;

// What the course has for the items that need content.
export interface PlayerContent {
  // A screen has a timeline (narrated, or timed in seconds): the controls show.
  timed: boolean;
  // A screen without a timeline speaks all the same (a layer's narration, a dialogue): the controls
  // show its transcript (D62, D61).
  spoken?: boolean;
  resources: number;
  glossary: number;
  // « IA et crédits » has something to say: AI-generated voices or media, or credits.
  about: boolean;
  // Built for the web (D41): no LMS to go back to, so no Quit.
  web: boolean;
  // The languages the package holds (D59): the language item shows with more than one.
  languages: number;
  // The logo's file is in the course.
  logo: (asset: string) => boolean;
}

// Why an item that is enabled does not show (null: it shows).
export function hiddenBecause(item: ConfiguredItem, content: PlayerContent): string | null {
  if (!item.enabled) return 'disabled';
  switch (item.id) {
    case 'logo': return !item.options.asset ? 'no image' : content.logo(item.options.asset) ? null : 'image missing';
    case 'controls': return content.timed || content.spoken ? null : 'no narrated screen';
    case 'resources': return content.resources ? null : 'no resource';
    case 'glossary': return content.glossary ? null : 'no glossary entry';
    case 'credits': return content.about ? null : 'no AI mention or credit';
    case 'exit': return content.web ? 'web target' : null;
    case 'language': return content.languages > 1 ? null : 'one language in the package';
    default: return null;
  }
}

// The items that show, bar by bar; a bar with none is null. exit never shows on the web.
export function shownPlayer(config: PlayerConfig, content: PlayerContent, { assetPath = (name: string) => `assets/${name}` }: { assetPath?: (name: string) => string } = {}): PlayerData {
  const bar = (name: BarName): PlayerBarData | null => {
    const items = config[name].items.flatMap((item): PlayerItemData[] => {
      if (hiddenBecause(item, content)) return [];
      switch (item.id) {
        case 'logo': return [{ id: 'logo', src: assetPath(item.options.asset ?? ''), alt: item.options.alt, plate: item.options.plate }];
        case 'outline': return [{ id: 'outline', label: item.options.label }];
        case 'controls': return [{ id: 'controls', seekBar: item.options.seekBar, captionsByDefault: item.options.captionsByDefault, volume: item.options.volume, transcript: item.options.transcript, speeds: [...SPEEDS[item.options.speeds]] }];
        default: return [{ id: item.id }];
      }
    });
    // A spacer alone shows nothing.
    return items.some((item) => item.id !== 'spacer') ? { position: config[name].position, items } : null;
  };
  return { top: bar('top'), bottom: bar('bottom') };
}

// Whether a screen has a timeline: narration lines, blocks timed in seconds or to words, or cues
// (narration/timeline.ts screenTimeline lays out the same screens).
export function screenIsTimed(project: Project, screenId: string): boolean {
  const screen = project.screens.get(screenId)?.data;
  if (!screen) return false;
  return objectsIn(screen.narration?.lines).length > 0 || momentsOf(project, screen).length > 0 || cuesOf(screen).length > 0;
}

// A screen whose layers speak or which holds a dialogue: it has a transcript (D62, D61).
export function screenSpeaks(project: Project, screenId: string): boolean {
  const screen = project.screens.get(screenId)?.data;
  if (!screen) return false;
  const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item)) : []);
  // A dialogue, or a fork of it (its behaviour).
  const registry = getRegistry(project);
  const dialogue = (blocks: unknown): boolean => records(blocks).some((block) => (typeof block.type === 'string' && behaviorOf(registry, block.type) === 'dialogue') || dialogue(block.blocks));
  return records(screen.layers).some((layer) => records((layer.narration as { lines?: unknown } | undefined)?.lines).length > 0 || dialogue(layer.blocks)) || dialogue(screen.blocks);
}

// What « IA et crédits » says of the course in a language (default: its own): the speakers whose
// lines have a generated voice (AI Act, art. 50), the media blocks marked generated, the author's
// credits, then the credits its voices ask for. A narration not generated yet whose speakers have a
// voice of a voice tool counts as generated: it will be.
export function aboutCourse(project: Project, { language, credits: authorCredits }: { language?: string; credits?: readonly string[] } = {}): AboutData {
  const course = project.course;
  const voices = new Set<string>();
  let voiced = false;
  const voiceCredits: string[] = [];
  const media = new Set<'image' | 'video' | 'audio'>();
  for (const { id } of screenOrder(project)) {
    const screen = project.screens.get(id)?.data;
    if (!screen) continue;
    for (const line of narrationLines(project, id, language) ?? []) {
      const speaker = objectsIn(course?.speakers).find((candidate) => candidate.id === line.speaker);
      const synthetic = line.generated === true || (line.generated === null && !!speaker && objectsIn(Object.values(speaker.voices ?? {})).some((voice) => voice.provider !== 'recording'));
      if (synthetic) { voiced = true; if (line.speakerName) voices.add(line.speakerName); }
      if (line.credit) voiceCredits.push(line.credit);
    }
    for (const { block } of screenBlocks(screen)) {
      if (!isRecord(block.props) || block.props.generated !== true) continue;
      media.add(block.type === 'video' ? 'video' : block.type === 'audio' ? 'audio' : 'image');
    }
    // A layout's picture (an opening's, D63).
    if (isRecord(screen.layoutProps) && screen.layoutProps.generated === true) media.add('image');
  }
  // The sounds it plays (D67): the credits their licences ask for, and those an AI made.
  const soundCredits: string[] = [];
  const assets = soundAssets(project);
  for (const id of new Set(soundUses(project).map((use) => use.id))) {
    const asset = assets.get(id);
    const sidecar = asset ? soundSidecar(project, asset) : null;
    if (sidecar?.generated) media.add('audio');
    const credit = soundCredit(sidecar, language ?? course?.language ?? 'en');
    if (credit) soundCredits.push(credit);
  }
  const credits = [...new Set([...(authorCredits ?? (Array.isArray(course?.credits) ? course.credits : []).filter((line): line is string => typeof line === 'string')), ...voiceCredits, ...soundCredits].filter((line) => line.trim()))];
  const ai = voiced || media.size ? { ...(voiced ? { voices: [...voices] } : {}), ...(media.size ? { media: (['image', 'video', 'audio'] as const).filter((kind) => media.has(kind)) } : {}) } : null;
  return { ...(ai ? { ai } : {}), ...(credits.length ? { credits } : {}) };
}

// The languages a package of every language would hold (elabora build --languages all, D59): the
// course's own, then each translation whose texts are ready and whose translated plan is approved.
export function packageLanguages(project: Project): string[] {
  const own = project.course?.language;
  if (!own) return [];
  const approved = translationStatus(project).filter((status) => translationReady(status) && status.exists && status.plan === 'approved').map((status) => status.language).sort();
  return [own, ...approved.filter((language) => language !== own)];
}

// What the course has for the player's items.
export function playerContent(project: Project, { web = false, languages = 1 }: { web?: boolean; languages?: number } = {}): PlayerContent {
  const course = project.course;
  const about = aboutCourse(project);
  return {
    timed: screenOrder(project).some(({ id }) => screenIsTimed(project, id)),
    spoken: screenOrder(project).some(({ id }) => screenSpeaks(project, id)),
    resources: objectsIn(course?.resources).length,
    glossary: objectsIn(course?.glossary).length,
    about: !!(about.ai || about.credits?.length),
    web,
    languages,
    logo: (asset) => project.files.has(`assets/${asset}`) || !!project.media?.processing.includes(`assets/${asset}`)
  };
}

// ── What agents and the app read (elabora_player, elabora player) ────────
export interface PlayerItemState {
  id: PlayerItemId;
  enabled: boolean;
  // It shows in packages built for this target; else why not.
  shows: boolean;
  why?: string;
  options: ConfiguredItem['options'];
}

export interface PlayerState {
  top: { position: 'window' | 'page'; shown: boolean; items: PlayerItemState[] };
  bottom: { position: 'window' | 'page'; shown: boolean; items: PlayerItemState[] };
  // Items in neither bar (not shown; --enable puts one back at its default place).
  unused: PlayerItemId[];
  // What the items that need content have; languages: those a package of every language would hold
  // (elabora build --languages all; the language item shows with more than one).
  content: { timed: boolean; resources: number; glossary: number; ai: AboutData['ai'] | null; credits: number; languages: string[] };
  // The rules of the way through, kept in course.json navigation, which the editor shows with the
  // outline (mode) and Next (lockUntilComplete).
  navigation: { mode: 'linear' | 'free'; lockUntilComplete: boolean };
  // The player's colours and size as packages get them: the course's own token, else its default.
  tokens: Record<string, { value: string | number; set: boolean }>;
}

export const PLAYER_TOKENS = ['player.top.background', 'player.top.text', 'player.bottom.background', 'player.bottom.text', 'player.accent', 'player.onAccent', 'player.progress', 'player.tooltip.background', 'player.tooltip.text', 'player.radius', 'player.density'] as const;

export function playerState(project: Project, { web = false, tokens }: { web?: boolean; tokens: (name: string) => string | number }): PlayerState {
  const config = playerConfig(project.course);
  const languages = packageLanguages(project);
  const content = playerContent(project, { web, languages: languages.length });
  const about = aboutCourse(project);
  const bar = (name: BarName) => {
    const items = config[name].items.map((item): PlayerItemState => {
      const why = hiddenBecause(item, content);
      return { id: item.id, enabled: item.enabled, shows: !why, ...(why ? { why } : {}), options: item.options };
    });
    return { position: config[name].position, shown: items.some((item) => item.shows && item.id !== 'spacer'), items };
  };
  const own = project.course?.theme?.tokens ?? {};
  return {
    top: bar('top'), bottom: bar('bottom'),
    unused: PLAYER_ITEMS.filter((id) => !findItem(config, id)),
    content: { timed: content.timed, resources: content.resources, glossary: content.glossary, ai: about.ai ?? null, credits: about.credits?.length ?? 0, languages },
    navigation: { mode: project.course?.navigation?.mode === 'free' ? 'free' : 'linear', lockUntilComplete: project.course?.navigation?.lockUntilComplete === true },
    tokens: Object.fromEntries(PLAYER_TOKENS.map((name) => [name, { value: tokens(name), set: name in own }]))
  };
}
