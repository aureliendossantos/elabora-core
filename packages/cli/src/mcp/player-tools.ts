import * as edit from '@elabora/node/edit';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { playerState, PLAYER_ITEMS, PLAYER_TOKENS } from '@elabora/core/player/config';
import { playerTokenValue } from '@elabora/core/validate/theme';
import { validateProject } from '@elabora/core/validate/index';
import type { CourseGlossary } from '@elabora/format';
import type { CourseResource } from '@elabora/core/commands/player';
import { defineTool, editPayload, formatValue, objectSchema, textResult, agentFindings } from './tool.ts';

// The learner's player (D58): its two bars, their items and options, its tokens, and the content its
// items show. One operation reads it (no change asked) and changes it (one undoable change).

const ITEM = { enum: PLAYER_ITEMS } as const;
const BAR = { enum: ['top', 'bottom'] } as const;
const POSITION = { enum: ['window', 'page'] } as const;
const FLAG = { type: ['boolean', 'null'] } as const;

// What the player is now, with the findings about it (D58's checks, the player tokens' contrast).
export function playerReport(root: string, target: 'scorm12' | 'web' = 'scorm12') {
  const project = loadProjectFromDir(root);
  const course = project.course;
  const state = playerState(project, { web: target === 'web', tokens: (name) => playerTokenValue(course, name) });
  const findings = agentFindings(validateProject(project, { target }).diagnostics)
    .filter((d) => /^(E|W|I)_(PLAYER|RESOURCE|GLOSSARY|DUPLICATE_ENTRY)/.test(d.code) || (d.code === 'E_THEME_CONTRAST' && String(d.target ?? '').startsWith('player.')) || (d.file === 'course.json' && /^\/(player|resources|glossary)/.test(String(d.path ?? ''))));
  return { target, ...state, findings };
}

export const playerTool = defineTool({
  name: 'elabora_player',
  description: 'The learner\'s player (D58): read it, or change it in one undoable change. Two bars, top and bottom, each an ordered list of items: logo, title, progress, spacer (« Espace flexible »: one per bar, always on; the items before it go to the start of the line, those after it to the end, and the narration controls stretch before it does), outline (the drop-down table of contents), controls (the narration\'s play, seek bar, captions, volume, transcript, speeds), resources, glossary, credits (« IA et crédits »: an « IA » mark when the module has generated voices or media), display (« Affichage »: text size, larger captions, shortcuts; off in a new module), language (« Langue »: the learner switches between the package\'s languages, D59; off in a new module, shows only in a package built with --languages all and more than one language), previous, next, exit (Quit, SCORM only). An item shows when it is enabled and has something to show (resources, glossary entries, an AI mention or credits, a logo file); a bar with nothing to show is removed. Without changes, returns the bars (each item enabled or not, whether it shows and why not, its options), the items in neither bar, what the course has (its languages in the package too), how learners move through it (navigation.mode, lockUntilComplete), every player token with its value (player.top.background, player.top.text, player.bottom.background, player.bottom.text, player.accent, player.onAccent, player.progress, player.tooltip.background, player.tooltip.text, player.radius, player.density) and the findings about the player. To make the player fit a module\'s theme: set the bar colours from the charter (a light top bar with the text colour for airy themes, the primary colour for a strong identity), player.accent for Next and Play, player.radius to the theme\'s corners (999: pills), a logo (options.logo.asset, an image of assets/; options.logo.plate puts it on a light plate when it does not read on the bar, W_PLAYER_LOGO_CONTRAST), and keep the defaults otherwise; the contrast of every pair is checked. Never hand-write CSS for the bars when a token says it. Changes: enable, disable, move ({ item, bar, index }; the spacer moves within the bar named), options ({ logo: { asset, alt, plate }, outline: { screenTitle }, glossary: { linkTerms }, controls: { seekBar, captionsByDefault, volume, transcript, speeds: none | 0.75-1.5 | 0.75-2 } }; null resets an option), position ({ top, bottom }: window or page), tokens (player.* only; null removes), reset (the bars of a new course), resources ([{ id, title, description, asset }] for files of assets/ (PDFs and images open in the player), [{ id, title, description, url }] for https:// links, opened in a new tab; addResources: [{ path, title, description }] copies files from outside the course into assets/resources/ and adds them, titled by the PDF\'s own title or the file\'s name when no title is given), glossary ([{ id, term, definition, variants, translate, source }]; texts link to an entry with `[word](glossary:<id>)`; translate: false keeps a term and its variants as they are in every language; source says where a gathered term was found, { kind: "source", id: <name in sources/>, at: "p. 4" } or { kind: "screen", id: <screen> }, for the author: never shown to learners nor translated), credits (lines), linkTerms (« Relier les termes aux écrans »: true for every term, or the ids of some; the first time each term or a variant is in each screen\'s texts becomes a link, a screen that already links to it is left as it is; it also runs when glossary.linkTerms is turned on and for the terms the glossary gains while it is on, never otherwise, so a link the author removed stays removed; the result lists the links placed, and per translation the translated texts that took the same link and those left to translate again). Removing an entry from glossary removes its links in the same change, its words kept, in the translations too (result unlinked, translations[].unlinked). Keep speeds at 0.75-2 unless the author insists: learners who go at their own pace stay.',
  inputSchema: objectSchema({
    target: { enum: ['scorm12', 'web'], default: 'scorm12', description: 'Which package the report describes (exit shows in SCORM packages only).' },
    enable: { type: 'array', items: ITEM },
    disable: { type: 'array', items: ITEM },
    move: { type: 'array', items: { type: 'object', properties: { item: ITEM, bar: BAR, index: { type: 'integer', minimum: 0 } }, required: ['item', 'bar'], additionalProperties: false } },
    options: {
      type: 'object', additionalProperties: false, properties: {
        logo: { type: 'object', additionalProperties: false, properties: { asset: { type: ['string', 'null'] }, alt: { type: ['string', 'null'] }, plate: FLAG } },
        outline: { type: 'object', additionalProperties: false, properties: { screenTitle: FLAG } },
        glossary: { type: 'object', additionalProperties: false, properties: { linkTerms: FLAG } },
        controls: { type: 'object', additionalProperties: false, properties: { seekBar: FLAG, captionsByDefault: FLAG, volume: FLAG, transcript: FLAG, speeds: { enum: ['none', '0.75-1.5', '0.75-2', null] } } }
      }
    },
    position: { type: 'object', additionalProperties: false, properties: { top: POSITION, bottom: POSITION } },
    tokens: formatValue<Record<string, string | number | null>>()({ type: 'object', propertyNames: { enum: PLAYER_TOKENS }, additionalProperties: { type: ['string', 'number', 'null'] } }),
    reset: { type: 'boolean' },
    resources: formatValue<CourseResource[]>()({ type: 'array' }),
    glossary: formatValue<CourseGlossary[]>()({ type: 'array' }),
    credits: { type: 'array', items: { type: 'string' } },
    addResources: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', description: 'Absolute path of the file (a PDF, a spreadsheet, a document, an image).' }, title: { type: 'string' }, description: { type: 'string' } } }, description: 'Files copied into assets/resources/ and added to the resources, each in its own undoable change (before the other changes): titled by title, else the PDF\'s own title, else the file\'s name.' },
    linkTerms: formatValue<true | string[]>()({ anyOf: [{ const: true }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Link the glossary\'s terms to the screens, the first time in each: true for every term, or the ids of some.' })
  }),
  handler: ({ target, addResources, ...changes }, { root, author }) => {
    const asked = Object.entries(changes).some(([, value]) => value !== undefined);
    const added = (addResources ?? []).map((file) => edit.addResource(root, file, { author })).map((result) => ({ ...editPayload(result), resource: result.resource, path: result.path, reused: result.reused, titleFrom: result.titleFrom }));
    if (!asked && !added.length) return textResult(playerReport(root, target));
    return textResult({ ...(added.length ? { added } : {}), ...(asked ? editPayload(edit.updatePlayer(root, changes, { author })) : {}), player: playerReport(root, target) });
  }
});
