import type { Course, CourseGlossary, PlayerBar, PlayerItem } from '@elabora/format';
import type { PlayerItemId } from '@elabora/player/course-data';
import { isRecord } from '../util/values.ts';
import { DEFAULT_PLACES, DEFAULT_PLAYER, PLAYER_ITEMS, PLAYER_TOKENS, BARS, SPEEDS, OUTLINE_LABELS } from '../player/config.ts';
import type { BarName, OutlineLabel } from '../player/config.ts';
import { CommandError, Draft, type CommandContext, type CommandOutput } from './context.ts';
import { linkGlossaryTerms, unlinkGlossaryTerms } from './glossary-links.ts';
import type { LinkedTranslation, PlacedLink, RemovedLink } from './glossary-links.ts';
import { isHttpsUrl } from '../compile/course-data.ts';

export type CourseResource = NonNullable<Course['resources']>[number];

// The player's configuration (docs/decisions.md D58), changed in one undoable change: items enabled,
// disabled or moved, their options, the bars' positions, the player.* tokens, and the content its
// items show (the logo, the resources, the glossary, the credits). course.json player is written in
// full once changed, so that what the course has is what it says.
export interface UpdatePlayerArgs {
  enable?: PlayerItemId[];
  disable?: PlayerItemId[];
  // An item to a bar, at an index (default: the end); an item in neither bar comes back enabled.
  move?: { item: PlayerItemId; bar: BarName; index?: number }[];
  // Options by item; null puts an option back to its default.
  options?: {
    logo?: { asset?: string | null; alt?: string | null; plate?: boolean | null };
    outline?: { label?: OutlineLabel | null };
    progress?: { parts?: boolean | null; percent?: boolean | null };
    glossary?: { linkTerms?: boolean | null };
    controls?: { seekBar?: boolean | null; captionsByDefault?: boolean | null; volume?: boolean | null; transcript?: boolean | null; speeds?: 'none' | '0.75-1.5' | '0.75-2' | null };
  };
  position?: { top?: 'window' | 'page'; bottom?: 'window' | 'page' };
  // player.* tokens of the theme; null removes one (its default comes back).
  tokens?: Record<string, string | number | null>;
  // The bars as they were for a new course.
  reset?: boolean;
  resources?: CourseResource[];
  glossary?: CourseGlossary[];
  credits?: string[];
  // « Relier les termes aux écrans » on demand: every term (true) or those named, the first time
  // each is in each screen (glossary-links.ts). It also runs when the glossary option linkTerms is
  // turned on (every term) and for terms the glossary gains while the option is on.
  linkTerms?: true | string[];
}

const isItem = (value: unknown): value is PlayerItemId => typeof value === 'string' && (PLAYER_ITEMS as readonly string[]).includes(value);

export function updatePlayer(context: CommandContext, args: UpdatePlayerArgs): CommandOutput<{ changed: string[]; linked: PlacedLink[]; unlinked: RemovedLink[]; translations: LinkedTranslation[] }> {
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  const changed: string[] = [];
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  // The glossary option linkTerms before the change (on unless said otherwise).
  const linkingBefore = BARS.some((bar) => (isRecord(course.player) && isRecord(course.player[bar]) && Array.isArray(course.player[bar].items) ? course.player[bar].items : []).some((item) => isRecord(item) && item.id === 'glossary' && isRecord(item.options) && item.options.linkTerms === false)) ? false : true;
  const glossaryBefore = new Set((Array.isArray(course.glossary) ? course.glossary : []).map((entry) => entry.id));
  // The bars as the player reads them (config.ts playerConfig): a bar without its own list of items
  // has the default items, less those the author placed in the other bar.
  const own = (name: BarName): PlayerBar | null => (!args.reset && isRecord(course.player) && isRecord(course.player[name]) ? course.player[name] as PlayerBar : null);
  const placed = new Set(BARS.flatMap((name) => (Array.isArray(own(name)?.items) ? own(name)!.items! : []).filter((item) => isRecord(item)).map((item) => String(item.id))));
  const current = (name: BarName): PlayerBar => {
    const bar = own(name);
    if (!bar) return { ...clone(DEFAULT_PLAYER[name]), items: clone(DEFAULT_PLAYER[name].items).filter((item) => args.reset || !placed.has(item.id)) };
    return { ...clone(bar), items: Array.isArray(bar.items) ? clone(bar.items) : clone(DEFAULT_PLAYER[name].items).filter((item) => !placed.has(item.id)) };
  };
  const bars: Record<BarName, PlayerBar> = { top: current('top'), bottom: current('bottom') };
  for (const name of BARS) bars[name].items = (bars[name].items ?? []).filter((item) => isRecord(item));
  if (args.reset) changed.push('reset');
  const locate = (id: PlayerItemId): { bar: BarName; index: number } | null => {
    for (const name of BARS) { const index = (bars[name].items ?? []).findIndex((item) => item.id === id); if (index >= 0) return { bar: name, index }; }
    return null;
  };
  // An item in neither bar goes back where a new course has it (or where Lin 44 draws it: language,
  // display), after the nearest of the items before it that is there.
  const restore = (id: PlayerItemId): PlayerItem => {
    const { bar, after: before } = DEFAULT_PLACES[id];
    const items = bars[bar].items ?? [];
    const after = before.map((other) => items.findIndex((item) => item.id === other)).find((index) => index >= 0);
    const item: PlayerItem = { id };
    items.splice(after === undefined ? 0 : after + 1, 0, item);
    bars[bar].items = items;
    return item;
  };
  const itemOf = (id: PlayerItemId): PlayerItem => { const found = locate(id); return found ? (bars[found.bar].items ?? [])[found.index] : restore(id); };
  const check = (id: unknown, what: string) => { if (!isItem(id)) throw new CommandError(`${what}: "${String(id)}" is not a player item (${PLAYER_ITEMS.join(', ')}).`); };

  // The spacer is one per bar and always on: enabled, a bar without one gets it back at its place.
  const spacerIn = (bar: BarName) => (bars[bar].items ?? []).findIndex((item) => item.id === 'spacer');
  for (const id of args.enable ?? []) {
    check(id, 'enable');
    if (id === 'spacer') {
      for (const bar of BARS) {
        if (spacerIn(bar) >= 0) continue;
        const items = bars[bar].items ?? [];
        const after = DEFAULT_PLACES.spacer.bar === bar ? DEFAULT_PLACES.spacer.after : bar === 'top' ? ['progress', 'title', 'logo'] : ['controls', 'outline'];
        const index = after.map((other) => items.findIndex((item) => item.id === other)).find((found) => found >= 0);
        items.splice(index === undefined ? 0 : index + 1, 0, { id: 'spacer' });
        bars[bar].items = items;
      }
    } else { const item = itemOf(id); delete item.enabled; }
    changed.push(`enable ${id}`);
  }
  for (const id of args.disable ?? []) {
    check(id, 'disable');
    if (id === 'spacer') throw new CommandError('disable: the spacer (« Espace flexible ») is always on; move it to say where the start of a line ends.');
    const item = itemOf(id); item.enabled = false; changed.push(`disable ${id}`);
  }
  for (const move of args.move ?? []) {
    check(move.item, 'move');
    if (!BARS.includes(move.bar)) throw new CommandError(`move: the bar is top or bottom, not "${String(move.bar)}".`);
    // The spacer moves within its bar (each bar has its own).
    const found = move.item === 'spacer' ? (spacerIn(move.bar) >= 0 ? { bar: move.bar, index: spacerIn(move.bar) } : null) : locate(move.item);
    const item = found ? (bars[found.bar].items ?? []).splice(found.index, 1)[0] : { id: move.item };
    const items = bars[move.bar].items ?? [];
    if (move.index !== undefined && !(Number.isInteger(move.index) && move.index >= 0)) throw new CommandError(`move ${move.item}: the index is a whole number from 0, not "${String(move.index)}".`);
    const index = move.index === undefined ? items.length : Math.min(items.length, move.index);
    items.splice(index, 0, item);
    bars[move.bar].items = items;
    changed.push(`move ${move.item} to ${move.bar} ${index}`);
  }
  for (const [id, options] of Object.entries(args.options ?? {})) {
    check(id, 'options');
    if (!isRecord(options)) continue;
    const item = itemOf(id as PlayerItemId);
    const next: Record<string, unknown> = { ...(isRecord(item.options) ? item.options : {}) };
    for (const [key, value] of Object.entries(options)) {
      if (id === 'controls' && key === 'speeds' && value !== null && !(String(value) in SPEEDS)) throw new CommandError(`controls speeds: none, 0.75-1.5 or 0.75-2, not "${String(value)}".`);
      if (id === 'outline' && key === 'label' && value !== null && !(OUTLINE_LABELS as readonly unknown[]).includes(value)) throw new CommandError(`outline label: outline, section or screen, not "${String(value)}".`);
      if (value === null || value === undefined || value === '') delete next[key]; else next[key] = value;
      changed.push(`${id}.${key}`);
    }
    if (Object.keys(next).length) item.options = next; else delete item.options;
  }
  for (const name of BARS) {
    const position = args.position?.[name];
    if (position === undefined) continue;
    if (position !== 'window' && position !== 'page') throw new CommandError(`position of the ${name} bar: window or page, not "${String(position)}".`);
    if (position === 'window') delete bars[name].position; else bars[name].position = position;
    changed.push(`${name} position ${position}`);
  }
  course.player = { top: bars.top, bottom: bars.bottom };

  if (args.tokens && Object.keys(args.tokens).length) {
    const theme = isRecord(course.theme) ? course.theme : {};
    const tokens: Record<string, unknown> = { ...(isRecord(theme.tokens) ? theme.tokens : {}) };
    for (const [name, value] of Object.entries(args.tokens)) {
      if (!(PLAYER_TOKENS as readonly string[]).includes(name)) throw new CommandError(`"${name}" is not a player token (${PLAYER_TOKENS.join(', ')}); other tokens are set with update_course theme.`);
      if (value === null) delete tokens[name]; else tokens[name] = value;
      changed.push(name);
    }
    course.theme = { ...theme, tokens: tokens as NonNullable<Course['theme']>['tokens'] };
  }
  // Content that would only be flagged once written is refused here: ids twice, a file not in assets/.
  const ids = (entries: readonly { id?: unknown }[], what: string) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const id = String(entry.id ?? '');
      if (seen.has(id)) throw new CommandError(`${what}: two entries have the id "${id}".`);
      seen.add(id);
    }
  };
  if (args.resources) {
    ids(args.resources, 'resources');
    for (const resource of args.resources) {
      if (typeof resource.asset === 'string' && !draft.file(`assets/${resource.asset}`)) throw new CommandError(`resources: "${resource.id}" names assets/${resource.asset}, which is not in the course (import it with media import first).`);
      if (typeof resource.url === 'string' && !isHttpsUrl(resource.url)) throw new CommandError(`resources: "${resource.id}" links to "${resource.url}": a link is an https:// address.`);
      if ((typeof resource.asset === 'string') === (typeof resource.url === 'string')) throw new CommandError(`resources: "${resource.id}" has an asset or a url, one of the two.`);
    }
  }
  if (args.glossary) ids(args.glossary, 'glossary');
  for (const key of ['resources', 'glossary', 'credits'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length) (course as Record<string, unknown>)[key] = value; else delete (course as Record<string, unknown>)[key];
    changed.push(key);
  }
  // « Relier les termes aux écrans »: on demand; when the option is turned on (every term); for the
  // terms the glossary gains while it is on. Never otherwise: a link the author removed stays removed.
  const glossaryItem = BARS.flatMap((bar) => bars[bar].items ?? []).find((item) => item.id === 'glossary');
  const linking = !(isRecord(glossaryItem?.options) && glossaryItem.options.linkTerms === false);
  const glossary = Array.isArray(course.glossary) ? course.glossary : [];
  const toLink = args.linkTerms === true || (linking && !linkingBefore) ? glossary.map((entry) => entry.id)
    : [...new Set([...(Array.isArray(args.linkTerms) ? args.linkTerms : []), ...(linking && args.glossary ? glossary.filter((entry) => !glossaryBefore.has(entry.id)).map((entry) => entry.id) : [])])];
  if (Array.isArray(args.linkTerms)) for (const id of args.linkTerms) if (!glossary.some((entry) => entry.id === id)) throw new CommandError(`linkTerms: the glossary has no entry "${id}".`);
  // Entries removed take their links with them, in the same change: each link to them in the screens
  // becomes its words, and the translations that had those texts up to date lose the same links
  // (translations[].unlinked). A link left to an entry that is gone would stop the build.
  const removedTerms = args.glossary ? [...glossaryBefore].filter((id) => !glossary.some((entry) => entry.id === id)) : [];
  const { removed: unlinked, translations: unlinkedTranslations } = removedTerms.length ? unlinkGlossaryTerms(context.project(), draft, removedTerms) : { removed: [], translations: [] };
  if (unlinked.length) changed.push(`unlink removed terms (${unlinked.length} link${unlinked.length === 1 ? '' : 's'})`);
  // The translations that had the texts linked up to date take the same links where the term's
  // translation is; the others are said (translations[].stale).
  const { placed: linked, translations: linkedTranslations } = toLink.length ? linkGlossaryTerms(context.project(), draft, glossary, toLink) : { placed: [], translations: [] };
  if (args.linkTerms) changed.push(`link terms (${linked.length} link${linked.length === 1 ? '' : 's'})`);
  if (!changed.length) throw new CommandError('Nothing to change: name items to enable, disable or move, options, positions, tokens, resources, glossary, credits or terms to link.');
  draft.writeJson('course.json', course);
  // One entry per translation: what the links removed and placed did to it.
  const translations: LinkedTranslation[] = [];
  for (const entry of [...unlinkedTranslations, ...linkedTranslations]) {
    const known = translations.find((candidate) => candidate.language === entry.language);
    if (!known) { translations.push({ ...entry, linked: [...entry.linked], stale: [...entry.stale], ...(entry.unlinked ? { unlinked: [...entry.unlinked] } : {}) }); continue; }
    known.linked.push(...entry.linked);
    known.stale = [...new Set([...known.stale, ...entry.stale])].sort();
    if (entry.unlinked) known.unlinked = [...(known.unlinked ?? []), ...entry.unlinked];
  }
  translations.sort((a, b) => a.language.localeCompare(b.language));
  return { files: draft.files(), result: { changed, linked, unlinked, translations } };
}
