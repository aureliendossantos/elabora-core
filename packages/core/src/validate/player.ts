import type { CourseCheckContext } from './context.ts';
import { objectsIn } from '../util/values.ts';
import { isRecord } from '../compile/values.ts';
import { screenBlocks } from '../project/load.ts';
import { BARS, findItem, playerConfig, playerContent, hiddenBecause, aboutCourse } from '../player/config.ts';
import type { PlayerConfig } from '../player/config.ts';
import type { PlayerItemId } from '@elabora/player/course-data';
import { isHttpsUrl } from '../compile/course-data.ts';
import { svgLogoContrast } from '../player/logo.ts';
import { playerToken, resolveTokens, withPlayerTokens } from './theme.ts';

// The contrast under which a logo is said not to read on its bar: WCAG's for graphics (1.4.11, of
// which logos are exempt), as a measure of « stands out ».
const LOGO_CONTRAST = 3;

// The player's configuration (docs/decisions.md D58) against the course: the way back, the way to
// the end when Next is hidden, what a regulation or an accessibility standard needs shown, and the
// content its items name (the logo, the resources, the glossary and the texts that link to it).

// Formats every LMS's web server serves out of the box (IIS's default MIME map is the narrowest):
// other files may come back as errors from some LMSs (D7).
export const RESOURCE_TYPES: ReadonlySet<string> = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv', 'zip', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp3', 'm4a', 'mp4', 'webm']);

const where = (config: PlayerConfig, id: PlayerItemId): string => {
  const found = findItem(config, id);
  return found ? `/player/${found.bar}/items/${found.index}` : '/player';
};

export function checkPlayer(ctx: CourseCheckContext): void {
  const { course, reporter, project } = ctx;
  const file = 'course.json';
  const config = playerConfig(course);
  const content = playerContent(project, { web: ctx.options.target === 'web' });
  const shows = (id: PlayerItemId) => { const found = findItem(config, id); return !!found && !hiddenBecause(found.item, content); };
  const enabled = (id: PlayerItemId) => !!findItem(config, id)?.item.enabled;

  // An item named twice (in one bar or in both; the spacer, twice in one bar): the first place counts.
  const seen = new Map<string, string>();
  for (const bar of BARS) {
    objectsIn(isRecord(course.player) && isRecord(course.player[bar]) ? course.player[bar].items : undefined).forEach((item, index) => {
      const id = item.id === 'spacer' ? `spacer@${bar}` : String(item.id);
      const at = `/player/${bar}/items/${index}`;
      if (seen.has(id)) reporter.emit('E_PLAYER_ITEM_DUPLICATE', { file, path: at, target: String(item.id), message: `The player item "${String(item.id)}" is listed twice (${seen.get(id)} and ${at}): the first place counts${item.id === 'spacer' ? ' (one spacer in each bar)' : ''}.` });
      else seen.set(id, at);
    });
  }

  // The logo's file, and whether an SVG logo reads on its bar (unless it is on its plate).
  const logo = findItem(config, 'logo');
  if (logo?.item.id === 'logo' && logo.item.enabled && logo.item.options.asset) {
    const asset = logo.item.options.asset;
    if (!content.logo(asset)) reporter.emit('E_ASSET_MISSING', { file, path: `${where(config, 'logo')}/options/asset`, target: 'logo', message: `The player's logo assets/${asset} is not in the course.` });
    else if (!logo.item.options.plate && /\.svg$/i.test(asset)) {
      const svg = project.files.get(`assets/${asset}`);
      const bar = logo.bar === 'top' ? 'player.top.background' : 'player.bottom.background';
      const measured = svg?.kind === 'text' ? svgLogoContrast(svg.text, playerToken(withPlayerTokens(resolveTokens(course)), bar)) : null;
      if (measured && measured.ratio < LOGO_CONTRAST) {
        // The ratio as data, for the app's own words (« 1,3:1 sur la barre du haut »).
        const ratio = Math.round(measured.ratio * 100) / 100;
        reporter.emit('W_PLAYER_LOGO_CONTRAST', { file, path: `${where(config, 'logo')}/options/plate`, target: 'logo', key: `player/logo@${asset}`, measured: ratio, limit: LOGO_CONTRAST, details: { bar: logo.bar, token: bar, background: measured.background, ratio, asset: `assets/${asset}` }, message: `The logo assets/${asset} would not read on the ${logo.bar} bar (${measured.background}): its colours reach ${measured.ratio.toFixed(2)}:1 at best, under ${LOGO_CONTRAST}:1. Put it on its light plate (options.plate), give the bar another colour, or use a version of the logo for dark backgrounds.` });
      }
    }
  }

  const screens = ctx.order.length;
  // No way back: neither the outline nor Previous (screens may have their own buttons).
  if (screens > 1 && !enabled('outline') && !enabled('previous')) {
    reporter.emit('W_PLAYER_NO_WAY_BACK', { file, path: '/player', key: 'player/way-back@outline,previous', message: 'The player has neither the outline nor Previous: learners cannot go back to a screen they saw, unless the screens give them their own buttons.' });
  }

  // Next hidden: the end must be reachable through the screens' own navigation.
  if (screens > 1 && !enabled('next')) {
    const blocked = deadEnds(ctx, config);
    if (blocked.length) {
      reporter.emit('W_PLAYER_END_UNREACHABLE', {
        file, path: where(config, 'next'), target: blocked[0].screen, key: `player/next@${blocked.map((entry) => entry.screen).join(',')}`, details: { screens: blocked },
        message: `Next is hidden and learners cannot reach the last screen: ${blocked.map((entry) => `"${entry.screen}" ${entry.why}`).join('; ')}.`
      });
    }
  }

  // What a regulation or an accessibility standard needs shown.
  const about = aboutCourse(project);
  if (about.ai && !shows('credits')) {
    const what = [about.ai.voices ? 'AI-generated voices' : null, ...(about.ai.media ?? []).map((kind) => `AI-generated ${kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'sounds'}`)].filter(Boolean).join(', ');
    reporter.emit('W_PLAYER_AI_MENTION_HIDDEN', { file, path: where(config, 'credits'), key: `player/credits@${what}`, message: `The course has ${what}, and the player hides « IA et crédits », which says so. The EU AI Act (Regulation (EU) 2024/1689, article 50(4) and (5), applicable since 2 August 2026) asks that synthetic audio, images and video that resemble real people be disclosed clearly, at the latest when learners first meet them.` });
  }
  const voiced = ctx.order.some(({ id }) => objectsIn(ctx.screens.get(id)?.data.narration?.lines).length > 0);
  if (voiced && !shows('controls')) {
    reporter.emit('W_PLAYER_CONTROLS_HIDDEN', { file, path: where(config, 'controls'), key: 'player/controls@hidden', message: 'Narrated screens play their voice, and the player hides its controls: learners can neither pause it, nor turn on captions, nor read the transcript. WCAG 2.2 (1.2.2 Captions, 1.4.2 Audio Control, 2.2.2 Pause, level A), EN 301 549 (9.1.2.2, 9.1.4.2, 9.2.2.2) and RGAA 4.1 (criteria 4.3 and 4.10) need them.' });
  }
  const controls = findItem(config, 'controls')?.item;
  if (voiced && controls?.id === 'controls' && shows('controls') && !controls.options.transcript) {
    reporter.emit('W_PLAYER_TRANSCRIPT_HIDDEN', { file, path: `${where(config, 'controls')}/options/transcript`, key: 'player/transcript@hidden', message: 'The player hides the transcript of narrated screens: learners who cannot hear the voice have the captions only, which go by. WCAG 2.2 (1.2.1 and 1.2.3, level A), EN 301 549 (9.1.2.1, 9.1.2.3) and RGAA 4.1 (criterion 4.1) ask for a text version of what is said.' });
  }
  if (controls?.id === 'controls' && shows('controls') && controls.options.speeds === 'none' && content.timed) {
    reporter.emit('I_PLAYER_SPEEDS_NONE', { file, path: `${where(config, 'controls')}/options/speeds`, key: 'player/speeds@none', message: 'Learners cannot change the narration\'s speed.' });
  }
  if (ctx.options.target !== 'web' && !enabled('exit')) {
    reporter.emit('W_PLAYER_EXIT_HIDDEN', { file, path: where(config, 'exit'), key: 'player/exit@hidden', message: 'The player hides Quit: in an LMS, the session then ends only when the window closes (D3).' });
  }

  // Resources: their files, their formats, their ids.
  const resourceIds = new Set<string>();
  objectsIn(course.resources).forEach((resource, index) => {
    const at = `/resources/${index}`;
    if (resourceIds.has(resource.id)) reporter.emit('E_DUPLICATE_ENTRY', { file, path: `${at}/id`, target: resource.id, message: `Two resources have the id "${resource.id}".` });
    resourceIds.add(resource.id);
    if (typeof resource.url === 'string') {
      if (!isHttpsUrl(resource.url)) reporter.emit('E_RESOURCE_URL', { file, path: `${at}/url`, target: resource.id, message: `The resource "${resource.id}" links to "${resource.url}", which is not an https:// address.` });
      return;
    }
    if (typeof resource.asset !== 'string') return;
    if (!project.files.has(`assets/${resource.asset}`)) reporter.emit('E_ASSET_MISSING', { file, path: `${at}/asset`, target: resource.id, message: `The resource "${resource.id}" names assets/${resource.asset}, which is not in the course.` });
    const extension = /\.([A-Za-z0-9]+)$/.exec(resource.asset)?.[1]?.toLowerCase() ?? '';
    if (!RESOURCE_TYPES.has(extension)) reporter.emit('W_RESOURCE_TYPE', { file, path: `${at}/asset`, target: resource.id, key: `resource/${resource.id}@${extension}`, message: `The resource "${resource.id}" is a .${extension || '(no extension)'} file, which some LMS web servers refuse to serve.` });
  });

  // The glossary, and the texts that link to it.
  const terms = new Set<string>();
  objectsIn(course.glossary).forEach((entry, index) => {
    if (terms.has(entry.id)) reporter.emit('E_DUPLICATE_ENTRY', { file, path: `/glossary/${index}/id`, target: entry.id, message: `Two glossary entries have the id "${entry.id}".` });
    terms.add(entry.id);
  });
  for (const { id } of ctx.order) {
    const screen = ctx.screens.get(id);
    if (!screen) continue;
    for (const { block, path } of screenBlocks(screen.data, screen.file)) {
      for (const [pointer, text] of strings(block.props, `${path}/props`)) {
        for (const match of text.matchAll(/\]\(glossary:([^)\s]*)\)/g)) {
          if (!terms.has(match[1])) reporter.emit('E_GLOSSARY_TERM_UNKNOWN', { file: screen.file, path: pointer, target: block.id, message: `A text of block "${block.id}" links to glossary:${match[1]}, and course.json glossary has no entry "${match[1]}"${terms.size ? ` (${[...terms].slice(0, 12).join(', ')})` : ''}.` });
        }
      }
    }
  }
}

// The strings of a value, with their JSON pointers.
function* strings(value: unknown, pointer: string): Generator<[string, string]> {
  if (typeof value === 'string') { if (value.includes('glossary:')) yield [pointer, value]; return; }
  if (Array.isArray(value)) { for (const [index, item] of value.entries()) yield* strings(item, `${pointer}/${index}`); return; }
  if (isRecord(value)) for (const [key, item] of Object.entries(value)) yield* strings(item, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
}

// With Next hidden: the screens learners reach from the first one through the screens' own
// navigation (go-to events whose trigger they can reach, the outline when navigation is free), and
// those among them that lead nowhere further. Empty when the last screen is reached. In slides, a
// step that opens with Next (it reads Continue there) cannot be reached, nor what is in it, unless
// the step opens once answered, an event reveals it, or a narration plays it (its Continue is in the
// screen). A narration that goes to the next screen by itself is not a way forward: it stops on
// phones and for learners who choose « M'arrêter à chaque étape ».
export function deadEnds(ctx: CourseCheckContext, config: PlayerConfig = playerConfig(ctx.course)): { screen: string; why: string }[] {
  const order = ctx.order.map(({ id }) => id);
  const last = order.length - 1;
  if (last <= 0) return [];
  if (ctx.course.navigation?.mode === 'free' && findItem(config, 'outline')?.item.enabled) return [];
  const slides = ctx.course.presentation?.mode === 'slides';
  const forward = new Map<number, Set<number>>();
  const stuck = new Map<number, string>();
  order.forEach((id, index) => {
    const screen = ctx.screens.get(id)?.data;
    const targets = new Set<number>();
    forward.set(index, targets);
    if (!screen) return;
    // The step of each block of the screen (blocks in a component instance take the instance's).
    const stepOf = new Map<string, number>();
    const walk = (blocks: unknown, step: number | null) => {
      for (const block of objectsIn(Array.isArray(blocks) ? blocks : undefined) as Record<string, unknown>[]) {
        const own = step ?? (typeof block.step === 'number' ? block.step : 1);
        if (typeof block.id === 'string') stepOf.set(block.id, own);
        walk(block.blocks, own);
      }
    };
    walk(screen.blocks, null);
    const steps = [...new Set(stepOf.values())].sort((a, b) => a - b);
    const narrated = objectsIn(screen.narration?.lines).length > 0;
    // Steps learners reach without Next: all of them in scroll pages (Continue is in the page) and on
    // narrated screens; in slides, the first, then those opened once answered or by an event.
    const reached = new Set<number>(!slides || narrated ? steps : [steps[0] ?? 1]);
    const events = objectsIn(screen.events);
    const available = (event: Record<string, unknown>) => {
      const on = isRecord(event.on) ? event.on : {};
      const target = typeof on.target === 'string' ? on.target : null;
      return target === null || !stepOf.has(target) || reached.has(stepOf.get(target)!);
    };
    for (let grew = true; grew;) {
      grew = false;
      for (const [position, step] of steps.entries()) {
        if (reached.has(step)) continue;
        const opens = isRecord(screen.steps) && isRecord(screen.steps[String(step)]) ? screen.steps[String(step)].opens : undefined;
        const revealed = events.some((event) => available(event) && [...objectsIn(event.do), ...objectsIn(event.else)].some((action) => action.type === 'reveal-step' && Number(action.step) >= step));
        if ((opens === 'answered' && reached.has(steps[position - 1])) || revealed) { reached.add(step); grew = true; }
      }
    }
    for (const event of events) {
      if (!available(event)) continue;
      for (const action of [...objectsIn(event.do), ...objectsIn(event.else)]) {
        if (action.type !== 'go-to') continue;
        if (action.screen === 'next') targets.add(index + 1);
        else if (action.screen === 'previous') targets.add(index - 1);
        else if (typeof action.screen === 'string' && order.includes(action.screen)) targets.add(order.indexOf(action.screen));
      }
    }
    if (reached.size < steps.length) stuck.set(index, 'shows its steps with Next');
  });
  const reached = new Set<number>([0]);
  const queue = [0];
  while (queue.length) {
    const index = queue.shift()!;
    for (const target of forward.get(index) ?? []) if (target >= 0 && target <= last && !reached.has(target)) { reached.add(target); queue.push(target); }
  }
  if (reached.has(last)) return [];
  return [...reached].sort((a, b) => a - b)
    .filter((index) => ![...(forward.get(index) ?? [])].some((target) => target > index && target <= last))
    .map((index) => ({ screen: order[index], why: stuck.get(index) ?? 'has no go-to event to a later screen' }));
}
