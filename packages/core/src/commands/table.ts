import type { Block, ComponentManifest, ComponentSlot, Course, CourseSection, Event, NarrationAudioWord, PatchOperation, Screen, ScreenLayer, Sound, Theme, Variable } from '@elabora/format';
import type { FileHash } from '../project/files.ts';
import { PLAYER_ITEMS, PLAYER_TOKENS } from '../player/config.ts';
import type { NarrationLine } from '../narration/narration.ts';
import { formatValue, objectSchema, LANGUAGE, PLAN_ID, SLUG, type ArgumentsOf, type InputSchema } from './arguments.ts';
import { SET } from './set-paths.ts';
import type { CommandContext, CommandOutput } from './context.ts';
import type { GivenFor, HostNeed, HostNeeds, JournaledCommand } from './host.ts';
import { createScreen, updateScreen, deleteScreen, moveScreen, duplicateScreen, type UpdateScreenArgs } from './screens.ts';
import { addBlock, updateBlock, removeBlock, moveBlock, duplicateBlock, detachBlock, type AddBlockArgs } from './blocks.ts';
import { placeBlock, arrangeScreen } from './placement.ts';
import { upsertLayer, removeLayer, upsertEvent, removeEvent, upsertVariable, removeVariable } from './layers-events-variables.ts';
import { updateCourseSettings, ignoreFindings } from './course.ts';
import { writePlan, setPlanText, revertPlanChange, createPlanVersion, approvePlan, setPlanNote, setPlanVoiceover, recordPlanSend, type CreatePlanVersionArgs } from './plan.ts';
import { renameId, renameVariable } from './rename.ts';
import { exportTranslation, translateText, approveTranslation } from './translation.ts';
import { replaceText } from './text.ts';
import {
  updateNarration, addNarrationLine, updateNarrationLine, moveNarrationLine, removeNarrationLine, removeSpeaker, splitStep, narrationFromPlan,
  setNarrationAudio, setNarrationWords, keepNarrationAudio, addNarrationLineWithAudio, setNarrationTextFromAudio,
  type AddNarrationLineArgs, type AddNarrationLineWithAudioArgs, type NarrationAudioFileArgs, type LineFromAudioFileArgs, type SetNarrationAudioArgs, type SetNarrationTextFromAudioArgs, type TextFromAudioFileArgs
} from './narration.ts';
import { setBlockTiming, type MomentPatch } from './timing.ts';
import { setDialogueNode, removeDialogueNode } from './dialogue.ts';
import { updatePlayer, type CourseResource } from './player.ts';
import { setContinuity } from './continuity.ts';
import { convertBlock } from './convert.ts';
import { createObject, writeObjectFile, writeDesignFile, OBJECT_FILES, type CreateObjectArgs } from './objects-design.ts';
import { createComponent, forkComponent, writeComponentFile, migrateComponents, addLibraryComponent, publishComponent, COMPONENT_FILES, type AddLibraryComponentArgs, type MigrateComponentsArgs } from './components.ts';
import { addFont, type AddFontArgs, type FontRequest } from './fonts.ts';
import { addResource, resourceTitle, type AddResourceRequest } from './resources.ts';
import { addSound, type AddSoundRequest } from './sounds.ts';
import { imageToVideo, replaceMediaReferences, setCaptions, type ImageToVideoRequest } from './media.ts';
import { settleImportReport } from './import-report.ts';
import { upgradeThemeCascade } from './theme.ts';
import { createCourse, type CourseBrief, type CourseStart } from './new-course.ts';
import type { CourseGlossary } from '@elabora/format';

// The commands by name (docs/decisions.md D84, D110): every command of the core, by the names the
// journal, the command line, the MCP tools and the engines give them, each with the JSON Schema of
// its arguments, what a tool says of it, and the core function that runs it. A server that runs
// commands on a project (a project's room in the cloud), the engines and the tools an agent writes
// with derive from it.
//
// A command that needs more than the project's files says what it expects from its host (needs: a
// kind of host.ts), and its run takes what the host gives: a font's files, a library's component,
// a line's audio made from a file. The host prepares it (a computer from its disk, its ffmpeg and
// its models; a browser from what it downloaded); the command only writes it. journal: what the
// journal records of a run, when it is not the command as it was called.
//
// The schema is what a tool may send: each command still checks its own arguments, and a caller
// with arguments from elsewhere (the journal, the app) runs the command, not the schema. Data and
// functions only: no validator, nothing done at load.

export interface NamedCommand<Schema extends InputSchema = InputSchema, Args = never, Result = unknown, Need extends HostNeed | undefined = HostNeed | undefined> {
  readonly description: string;
  readonly args: Schema;
  // Removes content (a tool's destructive hint).
  readonly destructive?: true;
  // A person's only: refused to an agent (E_PLAN_PERSON_ONLY).
  readonly personOnly?: true;
  // What its host gives it before it runs (host.ts); without it, the project's files are enough.
  readonly needs?: Need;
  readonly run: (context: CommandContext, args: Args, given: GivenFor<Need>) => CommandOutput<Result>;
  readonly journal?: (args: Args, given: GivenFor<Need>) => JournaledCommand;
}

// The run takes what the schema allows (the compiler checks each schema against its command), and
// its arguments' own type is what callers send (the engine's protocol, the app).
const command = <const Schema extends InputSchema, Args, Result, const Need extends HostNeed | undefined = undefined>(
  entry: NamedCommand<Schema, Args, Result, Need> & { readonly run: (context: CommandContext, args: ArgumentsOf<Schema>, given: GivenFor<Need>) => unknown }
): NamedCommand<Schema, Args, Result, Need> => entry;

// A run's result with what its host's work adds to it.
const adding = <Result, More extends object>(output: CommandOutput<Result>, more: More): CommandOutput<Result & More> => ({ ...output, result: { ...output.result, ...more } }) as CommandOutput<Result & More>;

// A block's width in the screen's column (the app says Moitié · Standard · Large · Bord à bord):
// full is the width of the text column, the default, not the window's.
const BLOCK_WIDTH = { enum: ['full', 'wide', 'half', 'bleed'], description: 'In the screen\'s column: half (two side by side on wide screens), full (the default: the width of the text column), wide (wider than the text), bleed (edge to edge of the window, of the slide in slides).' } as const;

// Blocks given whole, checked by the edit against the format.
const BLOCKS = { type: 'array', items: formatValue<Block>()({ type: 'object' }) } as const;

// How each step of a screen opens, by step number.
const STEPS = { type: ['object', 'null'], additionalProperties: { type: 'object', properties: { opens: { enum: ['continue', 'answered', 'explored'] }, label: { type: 'string' } }, additionalProperties: false } } as const;

const VARIABLE_ID = { type: 'string', pattern: '^[a-z][a-zA-Z0-9_]{0,31}$' } as const;

const MOMENT = formatValue<MomentPatch | null>()({
  type: ['object', 'null'],
  description: 'A moment and its effect: { "at": <anchor>, "effect": "rise", "duration": 0.5, "direction": "left" }. Anchors: { "line": "l2" } (the line starts), { "line": "l2", "edge": "end" }, { "line": "l2", "word": "imprimante" } (the voice says that word; a few words work too; occurrence: 2 for its second time; offset: 0.3 seconds after, negative before); on a screen without narration { "seconds": 1.5 } from the start of the block\'s step ({ "seconds": 1.5, "step": 2 }); { "step": 2 } or { "step": 2, "edge": "end" }. Effects: none, fade (default), rise, slide, zoom, wipe, draw, or the theme\'s (course.json theme.effects). Fields set to null go back to their default; the whole moment null removes it.'
});

const DIALOGUE_BLOCK = { ...SLUG, description: 'A dialogue block (its id).' } as const;
const NULLABLE_ID = { type: ['string', 'null'] } as const;
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD (default: today).' } as const;
const VERSION = { type: ['string', 'integer'], description: 'A version of the plan: V2, or its number.' } as const;
const PLACE = { type: ['object', 'null'], properties: { x: { type: 'number', minimum: -1, maximum: 2 }, y: { type: 'number', minimum: -20, maximum: 20 }, width: { type: 'number', minimum: 0.01, maximum: 2 }, height: { type: 'number', minimum: 0.01, maximum: 20 }, z: { type: 'integer', minimum: 0, maximum: 999 } }, required: ['x', 'y', 'width'], additionalProperties: false } as const;
const PLAYER_ITEM = { enum: PLAYER_ITEMS } as const;
const PLAYER_BAR = { enum: ['top', 'bottom'] } as const;
const PLAYER_POSITION = { enum: ['window', 'page'] } as const;
const FLAG = { type: ['boolean', 'null'] } as const;
const TERM_IN_SCREEN = { type: 'object', additionalProperties: false, required: ['term', 'screen'], properties: { term: { type: 'string' }, screen: { type: 'string' } } } as const;

// The words of a line's audio and when they are said (seconds from its start), and the audio they were timed on.
const WORDS = formatValue<NarrationAudioWord[]>()({ type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 }, score: { type: 'number', minimum: 0, maximum: 1 } }, required: ['text', 'start', 'end'], additionalProperties: false } });
const AUDIO_HASH = formatValue<FileHash>()({ type: 'string', pattern: '^sha256:[0-9a-f]{64}$' });
const TRANSCRIPTION_SERVICE = { enum: ['local', 'elevenlabs'], description: 'Who transcribes: the author\'s computer (local, the default) or ElevenLabs (the author\'s quota: approvedPercent, the share they approved, D30).' } as const;

// The player's changes (D58): the MCP tool elabora_player takes them with what it reads and adds.
export const PLAYER_CHANGES = {
  enable: { type: 'array', items: PLAYER_ITEM },
  disable: { type: 'array', items: PLAYER_ITEM },
  move: { type: 'array', items: { type: 'object', properties: { item: PLAYER_ITEM, bar: PLAYER_BAR, index: { type: 'integer', minimum: 0 } }, required: ['item', 'bar'], additionalProperties: false } },
  options: {
    type: 'object', additionalProperties: false, properties: {
      logo: { type: 'object', additionalProperties: false, properties: { asset: { type: ['string', 'null'] }, alt: { type: ['string', 'null'] }, plate: FLAG } },
      outline: { type: 'object', additionalProperties: false, properties: { label: { enum: ['outline', 'section', 'screen', null], description: 'What the button reads: « Sommaire » (outline, the default), the title of the part shown (section) or of the screen shown (screen).' } } },
      progress: { type: 'object', additionalProperties: false, properties: { parts: { ...FLAG, description: 'One segment per section, each a button to it (the default); false: one bar in one piece, not a button.' }, percent: { ...FLAG, description: 'Show the percentage next to the bar (the default).' } } },
      glossary: { type: 'object', additionalProperties: false, properties: { linkTerms: FLAG } },
      controls: { type: 'object', additionalProperties: false, properties: { seekBar: FLAG, captionsByDefault: FLAG, volume: FLAG, transcript: FLAG, speeds: { enum: ['none', '0.75-1.5', '0.75-2', null] } } }
    }
  },
  position: { type: 'object', additionalProperties: false, properties: { top: PLAYER_POSITION, bottom: PLAYER_POSITION } },
  tokens: formatValue<Record<string, string | number | null>>()({ type: 'object', propertyNames: { enum: PLAYER_TOKENS }, additionalProperties: { type: ['string', 'number', 'null'] } }),
  reset: { type: 'boolean' },
  resources: formatValue<CourseResource[]>()({ type: 'array' }),
  glossary: formatValue<CourseGlossary[]>()({ type: 'array' }),
  credits: { type: 'array', items: { type: 'string' } },
  unlinkTerm: { ...TERM_IN_SCREEN, description: '« Retirer ce lien »: the glossary entry (its id) is no longer linked in that screen (its id).' },
  relinkTerm: { ...TERM_IN_SCREEN, description: 'The glossary entry (its id) linked again in that screen (its id).' }
} as const;

const TABLE = {
  create_screen: command({
    description: 'Create a screen and insert it in a section. covers lists the plan items it implements. layout: a screen-level component of the course (its blocks go in its slots), with its layoutProps.',
    args: objectSchema({ id: SLUG, title: { type: 'string' }, covers: { type: 'array', items: PLAN_ID, minItems: 1 }, section: SLUG, after: { ...SLUG, description: 'Insert after this screen id.' }, completeWhen: { enum: ['viewed', 'interactions-done', 'action'] }, blocks: BLOCKS, layout: SLUG, layoutProps: { type: 'object' } }, ['id', 'title', 'covers']),
    run: createScreen
  }),
  update_screen: command({
    description: 'Change title, covers, completeWhen, required, showTitle, layout (a screen-level component), layoutProps (its props), style (theme.styles.screen), backdrop (a theme.backdrop variant, or none), continueRevealsSteps (false: only the screen\'s reveal-step events reveal its steps), narration (the script: lines with id, speaker, text, step and pauseBefore; advance and seek; replaced whole) or steps (how each step opens, by number: { "2": { "opens": "answered" } }, or "explored" for a Continue locked until the blocks above are explored; replaced whole) of a screen. null removes layout, layoutProps, style, backdrop, continueRevealsSteps, steps or narration. set changes one line or field of these by its path (narration.lines[l2].text, steps.2.opens, covers[OBJ-2]) and keeps the rest; a field given whole replaces it, and the result\'s removed says what that took away.',
    args: objectSchema({ id: SLUG, title: { type: 'string' }, covers: { type: 'array', items: PLAN_ID }, completeWhen: { enum: ['viewed', 'interactions-done', 'action'] }, required: { type: 'boolean' }, showTitle: { type: 'boolean' }, layout: { type: ['string', 'null'] }, layoutProps: { type: ['object', 'null'] }, style: { type: ['string', 'null'] }, backdrop: { type: ['string', 'null'] }, continueRevealsSteps: { type: ['boolean', 'null'] }, steps: formatValue<UpdateScreenArgs['steps']>()(STEPS), narration: formatValue<Screen['narration'] | null>()({ type: ['object', 'null'] }), set: SET }, ['id']),
    run: updateScreen
  }),
  delete_screen: command({
    description: 'Delete a screen file and remove it from its section.',
    args: objectSchema({ id: SLUG }, ['id']),
    destructive: true,
    run: deleteScreen
  }),
  move_screen: command({
    description: 'Move a screen to another position or section.',
    args: objectSchema({ id: SLUG, section: SLUG, after: SLUG, position: { type: 'integer', minimum: 0 } }, ['id']),
    run: moveScreen
  }),
  duplicate_screen: command({
    description: 'Copy a screen after it in its section: its blocks, layers and events get new ids (those named after the screen follow the copy\'s id), and the copy\'s events point at its own blocks and layers. The copy keeps the original\'s title unless given one.',
    args: objectSchema({ id: SLUG, newId: { ...SLUG, description: 'The copy\'s id (default: <id>-copy-<random suffix>).' }, title: { type: 'string', description: 'The copy\'s title.' } }, ['id']),
    run: duplicateScreen
  }),
  add_block: command({
    description: 'Add a block {id, type, props} (built-in type or course component) to a screen, one of its layers, or the slots of a component instance (parent + block.slot). Read elabora_get_schema(<type>) first. Component instances may carry blocks (their slot contents). Without an id the block gets one (<screen>-<type>-<random suffix>), returned as block. Without block.slot, on a screen with a layout or in a component instance, it goes in a slot that takes it (accepts its type, has room under maxBlocks): the slot of the block it follows (or replaces), else the default slot, else the first such slot (D134). replace: a block of the same list the new one takes the place of, in the same change.',
    args: objectSchema({ screen: SLUG, block: formatValue<AddBlockArgs['block']>()({ type: 'object', properties: { id: SLUG, type: SLUG, props: { type: 'object' }, blocks: { type: 'array', items: { type: 'object' } }, hidden: { type: 'boolean' }, width: BLOCK_WIDTH, slot: { type: 'string', description: 'Slot of the screen layout, or of the parent component instance.' }, style: { type: 'string', description: 'Named style of the type (theme.styles or the component styles).' }, optional: { type: 'boolean', description: 'Extra the learner may skip (a transcript, more detail): not waited for by steps that open once explored nor by interactions-done.' } }, required: ['type', 'props'] }), layer: SLUG, parent: { ...SLUG, description: 'Component instance receiving the block in one of its slots.' }, after: SLUG, position: { type: 'integer', minimum: 0 }, replace: { ...SLUG, description: 'A block of the same list the new one takes the place of: it goes in the same change, the new block where it was (instead of after and position).' } }, ['screen', 'block']),
    run: addBlock
  }),
  update_block: command({
    description: 'Edit a block by id (anywhere, slots included): props are merged (a prop set to null is removed; a prop given, a list included, replaces it whole, and the result\'s removed says what that took away); set changes one answer, item, row, node or field by its path (props.options[b].correct, props.items[i2].target, props.nodes[n1].options[a].text) and keeps the rest; also hidden, width, note, optional (true: extra the learner may skip, not waited for by steps that open once explored nor by interactions-done), slot and style (null removes), step (a block of the screen itself: the step that reveals it; null or 1: from the start), and continuity ({ key, duration? }: blocks of other screens with the same key carry on from one screen to the next, D65; null removes it; elabora_set_continuity links two blocks for you), and place (a block of the screen itself placed by hand, D72: { x, y, width, height?, z? } in shares of the placement frame, the reference window at the screen\'s width; in slides y from the frame\'s top, in scroll pages from the block\'s place in the page; null puts it back in the flow at its slot and rank; prefer a layout). For free-object blocks, props.props holds the declared prop values.',
    args: objectSchema({ block: SLUG, props: { type: 'object' }, hidden: { type: 'boolean' }, width: BLOCK_WIDTH, note: { type: 'string' }, optional: { type: 'boolean' }, slot: { type: ['string', 'null'] }, style: { type: ['string', 'null'] }, step: { type: ['integer', 'null'], minimum: 1, maximum: 12 }, continuity: { type: ['object', 'null'], properties: { key: SLUG, duration: { type: 'integer', minimum: 0, maximum: 3000 } }, required: ['key'], additionalProperties: false }, place: { type: ['object', 'null'], properties: { x: { type: 'number', minimum: -1, maximum: 2 }, y: { type: 'number', minimum: -20, maximum: 20 }, width: { type: 'number', minimum: 0.01, maximum: 2 }, height: { type: 'number', minimum: 0.01, maximum: 20 }, z: { type: 'integer', minimum: 0, maximum: 999 } }, required: ['x', 'y', 'width'], additionalProperties: false }, set: SET }, ['block']),
    run: updateBlock
  }),
  remove_block: command({
    description: 'Remove a block by id (with the blocks of its slots).',
    args: objectSchema({ block: SLUG }, ['block']),
    destructive: true,
    run: removeBlock
  }),
  move_block: command({
    description: 'Move a block within its screen, to another screen, into a layer, or into a slot of a component instance (parent, slot).',
    args: objectSchema({ block: SLUG, screen: SLUG, layer: SLUG, parent: SLUG, slot: { type: ['string', 'null'] }, after: SLUG, position: { type: 'integer', minimum: 0 } }, ['block']),
    run: moveBlock
  }),
  arrange_screen: command({
    description: 'Put the blocks of a screen placed by hand (D72, block place) back in the flow, each at its anchor (its slot and its rank in the list), in one undoable change: « Ranger » in the app. blocks: only these. To keep the look the author sketched, prefer a layout: read the places, put the blocks in the slots of a layout of the course (or a new one) and set its props, then remove each place.',
    args: objectSchema({ screen: SLUG, blocks: { type: 'array', items: SLUG, minItems: 1 } }, ['screen']),
    run: arrangeScreen
  }),
  duplicate_block: command({
    description: 'Duplicate a block (a component instance copies the blocks of its slots): new ids, same content, inserted after the original unless a target is given.',
    args: objectSchema({ block: SLUG, id: { ...SLUG, description: 'Id of the copy (default <id>-copy-<random suffix>).' }, screen: SLUG, layer: SLUG, parent: SLUG, after: SLUG, position: { type: 'integer', minimum: 0 } }, ['block']),
    run: duplicateBlock
  }),
  detach_block: command({
    description: 'Replace a component instance by its fallback: native blocks with the same content (plan links kept), then the blocks of its slots. The first block keeps the id (a fork of quiz becomes a quiz, learner state kept).',
    args: objectSchema({ block: SLUG }, ['block']),
    run: detachBlock
  }),
  convert_block: command({
    description: 'Change the form of content without rewriting it (« Transformer en… », D63): a block becomes another presentation of its type, or another type that holds the same content (panels ↔ steps ↔ interactive picture ↔ gallery, panels → a sort in pairs, steps → a sort in order or a process or milestones chart, statement ↔ callout ↔ text, image ↔ gallery of one, a text\'s bulleted list → panels or steps), in place, in one undoable change. Its id and its items\' ids are kept, so visited marks and translations follow; the result says what is kept, lost and added (starts empty), and whether learners who started lose their progress in the block. Without to, or with dryRun, nothing is written: the possible targets and those refused with their reason. Prefer it to removing a block and writing another one. language: fr or en for the sentences (default en).',
    args: objectSchema({ block: SLUG, to: { type: 'object', properties: { type: SLUG, presentation: { type: 'string', description: 'A presentation of the target type (default: its default one).' } }, required: ['type'], additionalProperties: false, description: 'The type to convert into, and its presentation.' }, dryRun: { type: 'boolean' }, language: { enum: ['en', 'fr'] } }, ['block']),
    run: convertBlock
  }),
  rename: command({
    description: 'Give a section, screen, layer, block or event another id, in one undoable change: every reference follows (sections, events, translation units, stylesheet selectors), a screen file takes the new name, and elabora.lock.json keeps the element\'s key, so learners in progress keep their progress. Refused when the new id is used or not a slug. Waivers of the plan that name the id follow too (waivers: how many).',
    args: objectSchema({ from: { ...SLUG, description: 'The id to rename.' }, to: { ...SLUG, description: 'The new id, unused in the course.' } }, ['from', 'to']),
    run: renameId
  }),
  upsert_layer: command({
    description: 'Create or replace a layer (an overlay opened by a show-layer action) on a screen. Without an id it is a new layer with a free one (<screen>-layer), and its blocks without ids get free ones.',
    args: objectSchema({ screen: SLUG, layer: formatValue<ScreenLayer>()({ type: 'object', properties: { id: SLUG, title: { type: 'string' }, blocks: { type: 'array', items: { type: 'object' } } }, required: ['title', 'blocks'] }) }, ['screen', 'layer']),
    run: upsertLayer
  }),
  remove_layer: command({
    description: 'Remove a layer from a screen, with its blocks. Events that still show or close it are reported by validation.',
    args: objectSchema({ screen: SLUG, id: SLUG }, ['screen', 'id']),
    destructive: true,
    run: removeLayer
  }),
  upsert_event: command({
    description: 'Create or replace an event (trigger → conditions → actions) on a screen. Read elabora_get_schema("event"). do may be empty (an event an author started in the app): it does nothing until it has an action, and validation warns (W_EVENT_NO_ACTION).',
    args: objectSchema({ screen: SLUG, event: formatValue<Event>()({ type: 'object' }) }, ['screen', 'event']),
    run: upsertEvent
  }),
  remove_event: command({
    description: 'Remove an event from a screen.',
    args: objectSchema({ screen: SLUG, id: SLUG }, ['screen', 'id']),
    destructive: true,
    run: removeEvent
  }),
  upsert_variable: command({
    description: 'Create or replace a course variable {id, type, default, …}. String variables need maxLength.',
    args: objectSchema({ variable: formatValue<Variable>()({ type: 'object' }) }, ['variable']),
    run: upsertVariable
  }),
  rename_variable: command({
    description: 'Give a course variable another name, in one undoable change: the events that read or write it follow, and elabora.lock.json keeps its key, so learners in progress keep its value.',
    args: objectSchema({ from: VARIABLE_ID, to: { ...VARIABLE_ID, description: 'The new name, unused.' } }, ['from', 'to']),
    run: renameVariable
  }),
  remove_variable: command({
    description: 'Remove a course variable. Refused while an event reads or writes it: change those events first.',
    args: objectSchema({ id: VARIABLE_ID }, ['id']),
    destructive: true,
    run: removeVariable
  }),
  update_course: command({
    description: 'Update course settings: title, description, version, theme (tokens), navigation, completion (reportAs, masteryScore), tracking, delivery (replaced whole: mediaQuality: high, medium or low, the media preset of the package; lms; languages: the package\'s languages, "all" or a list, D71; defaultLanguage: the one learners start in when their LMS gives none; languagePackages: one or each), ui labels, sections, speakers (id and name; voices chosen with elabora_voice_set), pronunciations (by language: text and say), narration (default advance and seek), presentation (mode scroll or slides, fit), sounds (the interface sounds, and the music and ambiences: background). null removes pronunciations or sounds. A setting given is replaced whole, and the result\'s removed says what that took away; set changes one key or entry by its path (navigation.mode, delivery.mediaQuality, speakers[guide].name, sections[intro].title) and keeps the rest.',
    args: objectSchema({ title: { type: 'string' }, description: { type: 'string' }, version: { type: 'string' }, theme: formatValue<Theme>()({ type: 'object' }), navigation: formatValue<Course['navigation']>()({ type: 'object' }), completion: formatValue<Course['completion']>()({ type: 'object' }), tracking: formatValue<Course['tracking']>()({ type: 'object' }), delivery: formatValue<Course['delivery']>()({ type: 'object' }), ui: formatValue<Course['ui']>()({ type: 'object' }), sections: formatValue<CourseSection[]>()({ type: 'array' }), presentation: formatValue<Course['presentation']>()({ type: 'object' }), speakers: formatValue<Course['speakers']>()({ type: 'array' }), pronunciations: formatValue<Course['pronunciations'] | null>()({ type: ['object', 'null'] }), narration: formatValue<Course['narration']>()({ type: 'object' }), sounds: formatValue<Course['sounds'] | null>()({ type: ['object', 'null'] }), set: SET }),
    run: updateCourseSettings
  }),
  replace_text: command({
    description: 'Replace words everywhere learners read them (course.json and the screens), in one undoable change. Never the plan\'s validated texts (they are the plan\'s: elabora_write_plan), never a link\'s address, maths or code; a free object\'s string keeps its placeholders and its length (else it is skipped and said). units: only these matches of elabora_find_text.',
    args: objectSchema({ find: { type: 'string', minLength: 1 }, replace: { type: 'string' }, caseSensitive: { type: 'boolean', default: false }, units: { type: 'array', items: { type: 'string' } } }, ['find', 'replace']),
    run: replaceText
  }),
  set_continuity: command({
    description: 'Continuity between screens (D65): a block carries on from a block of another screen instead of appearing again (a free object keeps running and moves to its new settings, update(props, transition); another block glides from where its counterpart was). with: the block it carries on from (they share a key: that block\'s, else this one\'s, else a new one; same type, free objects the same object; blocks of screens, not layers); with null: it no longer carries on from the screens before it (it still does to the screens after it). duration: the passage to it in ms (0 to 3000; null: 700). One undoable change.',
    args: objectSchema({ block: SLUG, with: { type: ['string', 'null'], description: 'The block of another screen it carries on from; null cuts it from the screens before it.' }, duration: { type: ['integer', 'null'], minimum: 0, maximum: 3000 } }, ['block']),
    run: setContinuity
  }),
  write_plan: command({
    description: 'Write the plan (plan.json, the working copy) at any time: the whole plan (plan) or a JSON Patch (RFC 6902) of it. Checked against the plan\'s schema before anything is written, refused with why. Before its first validation, draft it whole from what the author gave you (sources, objectives, the client\'s brief): the items grouped by part (items[].part), each objective with a short name of three to five words (objectives[].short), decided and question (D51). Once a version was validated, write the changes all the same and tell the author what you changed: the app marks them, and the author makes the next version and sends it. Refused when it would change a text kept « à l\'identique » (an item\'s lockedTexts, items[].lockedTexts[].verbatim): ask the author. Rewording a validated text is writing it here: every block with its textRef follows. Items moved (a move, a part changed) take the screens that cover them along in the same change (moved says which).',
    args: objectSchema({ plan: { type: 'object', description: 'The whole plan.json (id, title, objectives, items…).' }, patch: { type: 'array', items: formatValue<PatchOperation>()({ type: 'object' }), minItems: 1, description: 'A JSON Patch of the plan as it is.' } }),
    run: writePlan
  }),
  set_dialogue_node: command({
    description: 'Write one node of a dialogue block whole, in one undoable change: a new node (after: a node id, first: at the start; default: at the end), or the node with the same id replaced in place (moved with after or first). A node: { "id", "title"?, "lines": [{ "id", "speaker"?, "text", "expression"?, "cues"? }], "prompt"?, "options": [{ "id", "text", "label"?, "quality", "reply"?, "feedback"?, "points"?, "next"?, "retry"?, … }], "next"?, "end"? } (elabora_get_schema dialogue). To add an option or a line, write its node again with it. The findings say what is left to fix (a next to a node that does not exist).',
    args: objectSchema({ block: DIALOGUE_BLOCK, node: { type: 'object', description: 'The node, with its id.' }, after: { ...SLUG, description: 'Add (or move) it after this node.' }, first: { type: 'boolean', description: 'Add (or move) it first.' } }, ['block', 'node']),
    run: setDialogueNode
  }),
  remove_dialogue_node: command({
    description: 'Remove one node of a dialogue block, in one undoable change. What went to it (a next, an option\'s next, a start) is left for you to fix: the findings name it (E_DIALOGUE_TARGET).',
    args: objectSchema({ block: DIALOGUE_BLOCK, node: { ...SLUG, description: 'The node\'s id.' } }, ['block', 'node']),
    destructive: true,
    run: removeDialogueNode
  }),
  set_block_timing: command({
    description: 'When a block comes (in) and goes (out) on its screen\'s timeline, with an effect, in one undoable change: the blocks of a narrated screen appear as the voice names them, anchored to a line or a word of the narration (the anchor holds when the voice is generated again or translated); a screen without narration times them in seconds. Without in a block shows with its step, without out it stays until the end. A timed block keeps its place while it is not there (nothing moves). The contents of a stack (type stack) follow one another: give each its in. Read the result\'s diagnostics (E_TIMELINE_ANCHOR_MISSING, W_TEXT_TOO_FAST, E_ACTIVITY_LEAVES_UNANSWERED…), then elabora_timeline and elabora_look at the anchor.',
    args: objectSchema({ block: SLUG, in: MOMENT, out: MOMENT }, ['block']),
    run: setBlockTiming
  }),
  place_block: command({
    description: 'Place a block of a screen by hand (D72), with its anchor, in one undoable change: place { x, y, width, height?, z? } in shares of the placement frame (null puts it back in the flow, at its anchor); its anchor\'s slot in the screen\'s layout (null: the default slot) and its rank, after a block (null: first) or at a position. Left out, the anchor stays.',
    args: objectSchema({ block: SLUG, place: formatValue<Block['place'] | null>()(PLACE), slot: NULLABLE_ID, after: NULLABLE_ID, position: { type: ['integer', 'null'], minimum: 0 } }, ['block', 'place']),
    run: placeBlock
  }),
  ignore_findings: command({
    description: 'Ignore warnings or informations that have a key (Diagnostic.key), as the author\'s « Ignorer » does (D31), or bring them back (ignored: false). Errors are never ignored.',
    args: objectSchema({ findings: { type: 'array', minItems: 1, items: { type: 'object', properties: { code: { type: 'string', pattern: '^[WI]_[A-Z0-9_]+$' }, key: { type: 'string', minLength: 1, maxLength: 300 } }, required: ['code', 'key'], additionalProperties: false } }, ignored: { type: 'boolean' } }, ['findings']),
    run: ignoreFindings
  }),
  update_player: command({
    description: 'Change the learner\'s player (D58) in one undoable change: its two bars (enable, disable, move items), their options (null: the default), their position, the player.* tokens (null removes one), reset (the bars of a new course), the resources, the glossary and the credits, or a glossary entry no longer linked, or linked again, in a screen.',
    args: objectSchema(PLAYER_CHANGES),
    run: updatePlayer
  }),
  export_translation: command({
    description: 'Start a language of the course (translations/<lang>.xlf): every text to translate, in one undoable change.',
    args: objectSchema({ to: LANGUAGE }, ['to']),
    run: exportTranslation
  }),
  translate_text: command({
    description: 'Translate texts of the course into a language, in one undoable change (translations/<lang>.xlf): one unit (unit, target, state) or several (texts: { unit, target, state?, anchors? }, with the unit ids of the translation table). target null or empty clears a translation; a translation that breaks the source\'s Markdown, maths, links, code or placeholders, or its maxLength, is refused with the whole call.',
    args: objectSchema({
      language: LANGUAGE,
      unit: { type: 'string', minLength: 1 },
      target: { type: ['string', 'null'] },
      state: { enum: ['translated', 'reviewed', 'final'] },
      texts: { type: 'array', minItems: 1, items: { type: 'object', properties: { unit: { type: 'string', minLength: 1 }, target: { type: ['string', 'null'] }, state: { enum: ['translated', 'reviewed', 'final'] }, anchors: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', pattern: '^w-' }, word: { type: 'string', minLength: 1 }, occurrence: { type: 'integer', minimum: 1 } }, required: ['id', 'word'], additionalProperties: false } } }, required: ['unit', 'target'], additionalProperties: false } }
    }, ['language']),
    run: translateText
  }),
  approve_translation: command({
    description: 'Record the approval of a translated plan (translations/<lang>.approval.json), which a release in that language needs. A person\'s, with the name it shows (by). An agent\'s is refused without authorApproved, the contentHash of the translated plan the author said yes to (E_TRANSLATION_ASK_AUTHOR says what to ask): it records their approval made through it.',
    args: objectSchema({ to: LANGUAGE, by: { type: 'string', minLength: 1, maxLength: 200 }, reference: { type: 'string', minLength: 1, maxLength: 200 }, date: DATE, authorApproved: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } }, ['to']),
    run: approveTranslation
  }),
  set_plan_text: command({
    description: 'A validated text of the plan reworded (by its id, or by the block that shows it): the plan\'s text, in one undoable change. A text kept « à l\'identique » is refused to an agent (E_PLAN_VERBATIM_LOCKED).',
    args: objectSchema({ text: { type: 'string', minLength: 1, description: 'A validated text id (TXT-3).' }, block: { ...SLUG, description: 'A text, heading or callout block that shows it.' }, markdown: { type: 'string' } }, ['markdown']),
    run: setPlanText
  }),
  revert_plan_change: command({
    description: 'One change of the plan since a version undone (its key in the plan diff, item:ITEM-3): back to the latest validated version, or the one given.',
    args: objectSchema({ key: { type: 'string', minLength: 1 }, version: VERSION }, ['key']),
    run: revertPlanChange
  }),
  create_plan_version: command({
    description: 'The plan\'s working copy frozen as its next version (« Créer la V3 »). A person\'s only.',
    args: objectSchema({ note: { type: 'string' }, date: DATE }),
    personOnly: true,
    run: (context, args: CreatePlanVersionArgs) => createPlanVersion(context, args)
  }),
  approve_plan: command({
    description: 'The client\'s validation of a version of the plan (the latest by default), by whom, with a reference. A person\'s only.',
    args: objectSchema({ version: VERSION, by: { type: 'string', minLength: 1 }, reference: { type: 'string' }, date: DATE }, ['by']),
    personOnly: true,
    run: approvePlan
  }),
  set_plan_note: command({
    description: 'A note for the client on a change of the plan in no version yet (target: its key in the plan diff); text null removes it.',
    args: objectSchema({ target: { type: 'string', minLength: 1 }, text: { type: ['string', 'null'] } }, ['target', 'text']),
    run: setPlanNote
  }),
  update_narration: command({
    description: 'How a screen\'s narration plays, or a layer\'s (layer: only seek applies): advance (learner, auto, next-screen) and seek (seen, free, none); null: the course\'s default.',
    args: objectSchema({ screen: SLUG, layer: SLUG, advance: { enum: ['learner', 'auto', 'next-screen', null] }, seek: { enum: ['seen', 'free', 'none', null] } }, ['screen']),
    run: updateNarration
  }),
  add_narration_line: command({
    description: 'A line added to a screen\'s narration, or a layer\'s: a voice\'s ({ text, speaker?, step?, pauseBefore?, delivery?, pronunciations? }) or a sound\'s ({ sound, caption?, volume?, step?, pauseBefore? }), after a line (null: first; default: last). Without an id it gets one.',
    args: objectSchema({ screen: SLUG, layer: SLUG, line: formatValue<AddNarrationLineArgs['line']>()({ type: 'object' }), after: NULLABLE_ID }, ['screen', 'line']),
    run: addNarrationLine
  }),
  update_narration_line: command({
    description: 'A line of a screen\'s narration changed: its text (its word anchors follow their words), speaker, step, pause before, delivery or pronunciations (null: the default); a sound line\'s sound, caption and volume.',
    args: objectSchema({
      screen: SLUG, line: SLUG,
      text: { type: ['string', 'null'] }, speaker: NULLABLE_ID, step: { type: ['integer', 'null'], minimum: 1 }, pauseBefore: { type: ['number', 'null'] },
      delivery: formatValue<NarrationLine['delivery'] | null>()({ type: ['object', 'null'] }), pronunciations: formatValue<NarrationLine['pronunciations'] | null>()({ type: ['object', 'null'] }),
      sound: SLUG, caption: { type: ['string', 'null'] }, volume: { type: ['number', 'null'] }
    }, ['screen', 'line']),
    run: updateNarrationLine
  }),
  move_narration_line: command({
    description: 'A line of a screen\'s narration moved after another (null: first).',
    args: objectSchema({ screen: SLUG, line: SLUG, after: NULLABLE_ID }, ['screen', 'line', 'after']),
    run: moveNarrationLine
  }),
  remove_narration_line: command({
    description: 'A line removed from a screen\'s narration, with its audio.',
    args: objectSchema({ screen: SLUG, line: SLUG }, ['screen', 'line']),
    destructive: true,
    run: removeNarrationLine
  }),
  remove_speaker: command({
    description: 'A speaker leaves the course; its lines go to another speaker (to), or to none.',
    args: objectSchema({ speaker: SLUG, to: SLUG }, ['speaker']),
    destructive: true,
    run: removeSpeaker
  }),
  narration_from_plan: command({
    description: 'A screen\'s script from the voice-over of the plan items it covers (replace: a screen that has a narration loses it, and its audio).',
    args: objectSchema({ screen: SLUG, replace: { type: 'boolean' } }, ['screen']),
    run: narrationFromPlan
  }),
  split_step: command({
    description: '« Couper à une réplique »: the line and those after it in its step start the next step; later steps, their blocks, settings, anchors and reveal-step actions move one on.',
    args: objectSchema({ screen: SLUG, line: SLUG }, ['screen', 'line']),
    run: splitStep
  }),
  // ── what needs nothing but the files, beyond an agent's tools ─────────
  set_plan_voiceover: command({
    description: 'The voice-over of a plan item (a storyboard\'s voice-over column), line by line, written in the plan. A screen that covers the item then takes it as its narration script (elabora narration from-plan). lines: [{ speaker, text }], speaker a course.json speaker id (default: the first); null removes the voice-over. It is translated with the plan, and not kept word for word in the module (the script can be reworded).',
    args: objectSchema({ item: { type: 'string', minLength: 1, description: 'A plan item id (ITEM-3).' }, lines: { type: ['array', 'null'], minItems: 1, maxItems: 60, items: { type: 'object', properties: { speaker: SLUG, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['text'], additionalProperties: false } } }, ['item', 'lines']),
    run: setPlanVoiceover
  }),
  record_plan_send: command({
    description: 'A version of the plan sent to the client, recorded on it: its format (docx, pdf, html, or review: a review link) and its day (default: today). An export of the plan records its own.',
    args: objectSchema({ version: VERSION, format: { enum: ['docx', 'pdf', 'html', 'review'] }, date: DATE }, ['version', 'format']),
    run: recordPlanSend
  }),
  keep_narration_audio: command({
    description: '« La voix dit bien ce texte »: a line whose audio is out of date only because its text was corrected (a checked transcription, a typo) keeps its audio, now up to date for that text; its words follow the corrected text.',
    args: objectSchema({ screen: SLUG, line: SLUG, language: LANGUAGE }, ['screen', 'line']),
    run: keepNarrationAudio
  }),
  set_narration_words: command({
    description: 'The word times of a line\'s audio (forced alignment, D27) written into its sidecar, with what timed them (aligner); audioHash: the audio they were timed on (refused when the line\'s audio changed since); mouth: the mouth\'s envelope measured again with these words.',
    args: objectSchema({ screen: SLUG, line: SLUG, language: LANGUAGE, audioHash: AUDIO_HASH, words: WORDS, aligner: { type: 'string', minLength: 1 }, mouth: { type: 'string' } }, ['screen', 'line', 'words', 'aligner']),
    run: setNarrationWords
  }),
  set_captions: command({
    description: 'Captions for a video block (E_VIDEO_CAPTIONS_MISSING): a WebVTT text, or a SubRip one converted to WebVTT, written under assets/captions/ (named after the block unless name is given; the same text already there is reused) and named by the block\'s captions prop, in one change.',
    args: objectSchema({ block: { ...SLUG, description: 'The video block.' }, text: { type: 'string', description: 'The captions, WebVTT or SubRip.' }, name: { type: 'string', description: 'File name under assets/captions/, without extension (default: the block id).' } }, ['block', 'text']),
    run: setCaptions
  }),
  settle_import_report: command({
    description: 'The report of an import (D47) settled: decisions the import made accepted as they are (accept: their places in its decisions), or the report closed and its file removed (close).',
    args: objectSchema({ accept: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } }, close: { type: 'boolean' } }),
    run: settleImportReport
  }),
  optimize_media: command({
    description: 'Media files made into their web format under other names (assets/video/intro.mov became intro.mp4): every reference to each old path names the new one, and the old files go, in one change.',
    args: objectSchema({ moves: { type: 'array', minItems: 1, items: { type: 'object', properties: { from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } }, required: ['from', 'to'], additionalProperties: false } } }, ['moves']),
    run: replaceMediaReferences
  }),
  write_object_file: command({
    description: 'Write one file of a free object: object.manifest.json, object.js, object.tests.json or object.notes.md. Then run elabora_test_object.',
    args: objectSchema({ object: SLUG, file: { enum: OBJECT_FILES }, content: { type: 'string' } }, ['object', 'file', 'content']),
    run: writeObjectFile,
    // The content is in the operations: the journal says how long it was.
    journal: (args) => ({ name: 'write_object_file', args: { object: args.object, file: args.file, bytes: args.content.length } })
  }),
  write_design_file: command({
    description: 'Write a design file: theme/<name>.css (course stylesheet) or generators/<name>.mjs (asset generator). Design is free; content stays in blocks. Read the design layer first (elabora_docs design; skill elabora-visual-design).',
    args: objectSchema({ file: { type: 'string' }, content: { type: 'string' } }, ['file', 'content']),
    run: writeDesignFile,
    journal: (args) => ({ name: 'write_design_file', args: { file: args.file, bytes: args.content.length } })
  }),
  upgrade_theme: command({
    description: 'Put the theme\'s rules under the components (course.json theme.cascade components-over-theme, docs D32) without changing how the course looks: a course without theme.cascade (I_THEME_CASCADE_OLD) still has its theme after the component stylesheets, so a general theme rule (.t-figure img { width: 100% }) silently overrides a component\'s own rule. The theme\'s declarations of properties the components also set go into a top-level @layer overrides { … } block of the theme stylesheet (which stays over the components); the rest become the course\'s defaults, under them. Then move out of that block the rules that are course-wide defaults, and look again (elabora_look, elabora_check_fit name what the theme still overrides: W_STYLE_COMPONENT_OVERRIDDEN). One change; elabora_undo reverts it.',
    args: objectSchema({}),
    run: (context) => upgradeThemeCascade(context)
  }),
  create_component: command({
    description: 'Create a course component (components/<id>/): a block type (level block) or a screen layout (level screen), with its props schema, slots, template and stylesheet. Read the components page first (elabora_docs components; skill elabora-components); then write the files with elabora_write_component_file and check with elabora_preview_component.',
    args: objectSchema({ id: SLUG, title: { type: 'string' }, level: { enum: ['block', 'screen'] }, description: { type: 'string' }, props: formatValue<ComponentManifest['props']>()({ type: 'object' }), slots: { type: 'array', items: formatValue<ComponentSlot>()({ type: 'object' }) }, template: { type: 'string' }, css: { type: 'string' } }, ['id', 'title']),
    run: createComponent
  }),
  fork_component: command({
    description: 'Fork a component (built-in or course) under a new id: the fork remembers its parent, copies its template to change, inherits props (add more with propsExtend), slots, styles, fallback and stylesheet. Forks of quiz, numeric, decision and results keep their behaviour: scoring, saved state, SCORM records.',
    args: objectSchema({ component: SLUG, id: SLUG, title: { type: 'string' }, copyCss: { type: 'boolean' } }, ['component', 'id']),
    run: forkComponent
  }),
  write_component_file: command({
    description: 'Write a file of a course component, to change its look, markup or props: component.json (manifest: props, slots, fallback, styles, examples, version), template.html, component.css or migrations.mjs (steps that migrate instance props when the props shape changes).',
    args: objectSchema({ component: SLUG, file: { enum: COMPONENT_FILES }, content: { type: 'string' } }, ['component', 'file', 'content']),
    run: writeComponentFile,
    journal: (args) => ({ name: 'write_component_file', args: { component: args.component, file: args.file, bytes: args.content.length } })
  }),

  create_course: command({
    description: 'A new module\'s first files in an empty project (D112), as « Nouveau module » writes them (D111): course.json, plan.json (a draft), an intro screen and the rules for agents (AGENTS.md, CLAUDE.md); a folder\'s .gitignore is not the project\'s. id: the course\'s id; brief: what the author said of it (D51); from: a browser\'s host gives the module template or the charter it starts from (D124). A project that has a course.json already is left as it is (created: false).',
    args: objectSchema({
      id: SLUG, title: { type: 'string', minLength: 1 }, language: LANGUAGE,
      brief: formatValue<CourseBrief>()({
        type: 'object', additionalProperties: false, properties: {
          audience: { type: 'string', maxLength: 200 }, businessGoal: { type: 'string', maxLength: 1000 },
          duration: { type: 'object', additionalProperties: false, properties: { min: { type: 'integer', minimum: 1, maximum: 600 }, max: { type: 'integer', minimum: 1, maximum: 600 } } },
          presentation: { enum: ['scroll', 'slides'] }, lms: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' }
        }
      }),
      // A browser's host only (D124): the template or the charter it starts from, its files given whole.
      from: formatValue<CourseStart>()({
        type: 'object', required: ['kind', 'files'],
        properties: {
          kind: { enum: ['template', 'charter'] }, template: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 }, courseId: { type: ['string', 'null'] }, course: { type: 'object' },
          files: { type: 'object', additionalProperties: { type: 'object', required: ['kind'], properties: { kind: { enum: ['text', 'binary'] }, text: { type: 'string' }, hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }, size: { type: 'integer', minimum: 0 } } } }
        }
      })
    }, ['id', 'title']),
    run: createCourse,
    // The files it started from are in the operations: the journal names the template.
    journal: ({ from, ...args }) => ({ name: 'create_course', args: { ...args, ...(from ? { from: { kind: from.kind, ...(from.kind === 'template' ? { template: from.template } : { title: from.title, courseId: from.courseId }), files: Object.keys(from.files).length } } : {}) } })
  }),

  // ── what needs its host (host.ts) ─────────────────────────────────────
  create_object: command({
    description: 'Scaffold a free object (objects/<id>/: manifest, code, tests, notes) serving given plan objectives. Only when no native block can do the job. decoration: a decoration of the course backdrop instead (theme.backdrop.object; no objectives): a 2D canvas that follows the course (ctx.context with the screen\'s rank, its section\'s, the direction), keeps out of the player\'s bars and lands at once when frames are still.',
    args: objectSchema({ id: SLUG, title: { type: 'string' }, objectives: { type: 'array', items: PLAN_ID, minItems: 1 }, items: { type: 'array', items: PLAN_ID }, decoration: { type: 'boolean' } }, ['id', 'title']),
    needs: 'objectTemplates',
    run: (context, args: CreateObjectArgs, given) => createObject(context, args, given.templates)
  }),
  add_font: command({
    description: 'Embed a font in the course with its licence: copies its WOFF2 files and licence into theme/fonts/<id>/, declares its faces in course.json theme.fonts (the player writes the @font-face rules) and gives its CSS stack to tokens (for: body → font.body, heading → font.heading, any other name → custom token font.<name> such as mono or display, read as var(--t-font-mono); none for no token; default: the font\'s usual role). Takes the latin files, and the latin-ext files too when the language of the course or of a translation needs them (Polish, Czech, Romanian, Turkish…: one face per file, with its unicode range, loaded only by pages that use its letters); subsets chooses. family: a vetted font (elabora_list_fonts). Another font: from, the folder or .tgz of its Fontsource package (npm pack @fontsource-variable/<id>), whose other subsets (cyrillic, greek, vietnamese…) subsets can name; or files, local WOFF2 files, with license, their licence file (weights and style are read from the files). Adding a family again replaces its faces (add it again after adding a language). Undo with elabora_undo.',
    args: objectSchema({
      family: { type: 'string', description: 'A vetted family ("EB Garamond"), or the family name to declare for from/files (default: the font\'s own).' },
      weights: { type: 'array', items: { type: 'integer', minimum: 100, maximum: 900, multipleOf: 100 }, description: 'Static fonts: the weights to take (default: all vetted; 400 and 700 for a Fontsource package). A variable file covers its whole range.' },
      styles: { type: 'array', items: { enum: ['normal', 'italic'] }, description: 'Default: every style there is.' },
      subsets: { type: 'array', items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' }, minItems: 1, description: 'The subsets to embed: latin, latin-ext (vetted fonts), or any of a Fontsource package (cyrillic, greek, vietnamese…). Default: latin, and latin-ext when a language of the course needs it.' },
      for: { type: 'array', items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' }, description: 'Tokens that get the font\'s stack: body, heading, mono, display… or ["none"].' },
      from: { type: 'string', description: 'Folder or .tgz of a Fontsource package (npm @fontsource/<id>, @fontsource-variable/<id>): its files of the subsets (with their unicode ranges) and LICENSE.' },
      files: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Local WOFF2 (or WOFF) files of one family.' },
      license: { type: 'string', description: 'With files: the licence file of the font (OFL.txt, LICENSE…).' }
    }),
    needs: 'font',
    run: (context, args: FontRequest & AddFontArgs, font) => {
      const output = addFont(context, { for: args.for, subsets: args.subsets }, font.source);
      return adding(output, { notes: [...font.notes, ...output.result.notes], origin: font.origin });
    }
  }),
  add_component: command({
    description: 'Copy a component from a library folder (a client design system shared by several courses) into the course, pinned with its origin; upgrade: true replaces the course copy with the library version (then run elabora_migrate_components if needed).',
    args: objectSchema({ library: { type: 'string', description: 'Path of the library folder.' }, component: SLUG, as: SLUG, upgrade: { type: 'boolean' }, force: { type: 'boolean' } }, ['library', 'component']),
    needs: 'libraryComponent',
    run: (context, args: AddLibraryComponentArgs & { library: string }, given) => addLibraryComponent(context, args, given.component),
    // The library by its id, not by where it is on a computer.
    journal: (args, given) => ({ name: args.upgrade ? 'upgrade_component' : 'add_component', args: { library: given.component.library, component: args.component, as: args.as || args.component } })
  }),
  publish_component: command({
    description: 'Copy a course component into a library folder so other courses can add it; the course copy records the library as its origin.',
    args: objectSchema({ library: { type: 'string' }, component: SLUG }, ['library', 'component']),
    needs: 'publication',
    run: (context, args: { library: string; component: string }, published) => publishComponent(context, { component: args.component, library: published.library }),
    journal: (args, published) => ({ name: 'publish_component', args: { library: published.library, component: args.component } })
  }),
  migrate_components: command({
    description: 'Run pending migration steps (components/<id>/migrations.mjs) on every instance, check them against the new schema, and write them in one undoable edit (nothing is written if one fails).',
    args: objectSchema({ component: SLUG, from: { type: 'string', description: 'Version the instances are at, when elabora.lock.json does not know it.' } }),
    needs: 'componentMigrations',
    run: (context, args: MigrateComponentsArgs, given) => migrateComponents(context, args, given.steps),
    journal: (args) => ({ name: 'migrate_components', args: { component: args.component, from: args.from } })
  }),
  add_resource: command({
    description: '« Ajouter une ressource »: a file (a PDF, a spreadsheet, a document, an image) copied as it is into assets/resources/ and added to the player\'s resources (D58), titled as asked, else by the title a PDF gives itself, else by its name, in one change; the same content already there is not copied twice.',
    args: objectSchema({ path: { type: 'string', minLength: 1, description: 'The file.' }, title: { type: 'string' }, description: { type: 'string' } }, ['path']),
    needs: 'resourceFile',
    run: (context, args: AddResourceRequest, given) => {
      const { title, from } = resourceTitle(args.title, given.name, given.pdfTitle);
      return adding(addResource(context, { name: given.name, file: given.file, title, ...(args.description ? { description: args.description } : {}) }), { titleFrom: from });
    },
    journal: (args, given) => ({ name: 'add_resource', args: { name: given.name, title: resourceTitle(args.title, given.name, given.pdfTitle).title, ...(args.description ? { description: args.description } : {}) } })
  }),
  add_sound: command({
    description: '« Ajouter un son » (D67): a sound of the library (from: its id), one found through Openverse (openverse:<uuid>) or a file, into assets/sounds/ with its sidecar (where it comes from, its licence), cut (trim) and faded out (fade) as asked; line: a sound line saying it in a narration, placed in the same change.',
    args: objectSchema({
      from: { type: 'string', minLength: 1 }, id: SLUG,
      trim: { type: 'object', properties: { start: { type: 'number', minimum: 0 }, end: { type: 'number', exclusiveMinimum: 0 } }, required: ['start', 'end'], additionalProperties: false },
      fade: { type: 'number', exclusiveMinimum: 0 }, loop: { type: 'boolean' },
      title: { type: 'string' }, author: { type: 'string' }, license: { type: 'string' }, url: { type: 'string' },
      caption: formatValue<Record<string, string>>()({ type: 'object', additionalProperties: { type: 'string' }, description: 'By language.' }),
      generated: formatValue<Sound['generated']>()({ type: 'object' }),
      line: { type: 'object', properties: { screen: SLUG, layer: SLUG, after: NULLABLE_ID, step: { type: 'integer', minimum: 1 }, caption: { type: 'string' }, volume: { type: 'number' } }, required: ['screen'], additionalProperties: false }
    }, ['from']),
    needs: 'sound',
    run: (context, args: AddSoundRequest, sound) => adding(
      addSound(context, { id: sound.id, extension: sound.extension, file: sound.file, sidecar: sound.sidecar, ...(args.line ? { line: args.line } : {}) }),
      { source: sound.sidecar.source ?? 'file', license: sound.sidecar.license, duration: sound.sidecar.duration ?? 0 }
    ),
    journal: (args, sound) => ({ name: 'add_sound', args: { id: sound.id, from: args.from, ...(args.line ? { line: args.line } : {}) } })
  }),
  image_to_video: command({
    description: '« Transformer en vidéo »: an image block whose file is animated (GIF, animated WebP or PNG) made a video block that loops like it, several times lighter, its MP4 and poster made by its host; blocks: other image blocks showing the same file, made videos with it. The image\'s file goes when nothing else names it. One change: undo puts the image back.',
    args: objectSchema({ block: { ...SLUG, description: 'The image block.' }, blocks: { type: 'array', items: SLUG } }, ['block']),
    needs: 'videoOfImage',
    run: (context, args: ImageToVideoRequest, made) => adding(imageToVideo(context, {
      block: args.block, ...(args.blocks?.length ? { blocks: args.blocks } : {}),
      reserved: made.reserved, video: made.video, poster: made.poster, posterExtension: made.posterExtension
    }), { bytes: made.sizes }),
    journal: (args) => ({ name: 'image_to_video', args: { block: args.block, ...(args.blocks?.length ? { blocks: args.blocks } : {}) } })
  }),
  set_narration_audio: command({
    description: 'The audio of a line (D24) from a file: a voice tool\'s, or a recording (provider "recording", not generated), made by its host an M4A in AAC, mono (trim: its silence at both ends trimmed), with its sidecar, its words timed when its host has the word aligner of its language (or as given), in one change.',
    args: objectSchema({
      screen: SLUG, line: SLUG, language: LANGUAGE, file: { type: 'string', minLength: 1 },
      provider: { type: 'string', minLength: 1 }, voice: { type: 'string' }, generated: { type: 'boolean' },
      words: WORDS, aligner: { type: 'string' }, take: { type: 'integer', minimum: 1 }, credit: { type: 'string' }, model: { type: 'string' }, trim: { type: 'boolean' }
    }, ['screen', 'line', 'file', 'provider', 'voice', 'generated']),
    needs: 'lineAudio',
    run: (context, args: NarrationAudioFileArgs, made) => adding(setNarrationAudio(context, lineAudioArgs(args, made)), made.alignmentError ? { alignmentError: made.alignmentError } : {}),
    journal: (args, made) => ({ name: 'set_narration_audio', args: lineAudioArgs(args, made) })
  }),
  add_narration_line_with_audio: command({
    description: '« Nouvelle réplique depuis un fichier audio… » (D46): a line made from a recording, its text given or heard by its host\'s transcriber (service), its words timed, its audio the recording, after a line (null: first; default: last), in one change.',
    args: objectSchema({
      screen: SLUG, file: { type: 'string', minLength: 1 }, text: { type: 'string' }, after: NULLABLE_ID, step: { type: 'integer', minimum: 1 }, speaker: SLUG, layer: SLUG, language: LANGUAGE,
      trim: { type: 'boolean' }, service: TRANSCRIPTION_SERVICE, approvedPercent: { type: 'number', minimum: 0 }, install: { type: 'boolean' }
    }, ['screen', 'file']),
    needs: 'recording',
    run: (context, args: LineFromAudioFileArgs, heard) => adding(addNarrationLineWithAudio(context, recordingArgs(args, heard)), { text: heard.text, ...(heard.transcript ? { transcript: heard.transcript } : {}) }),
    journal: (args, heard) => ({ name: 'add_narration_line_with_audio', args: recordingArgs(args, heard) })
  }),
  set_narration_text_from_audio: command({
    description: '« Régénérer le texte d\'après l\'audio » (D46): a line\'s text becomes what its recording says (text: as the author checked it; else heard by its host\'s transcriber now); the recording stays, its words timed again. audioHash: the audio it was heard in (refused when the line\'s audio changed since).',
    args: objectSchema({ screen: SLUG, line: SLUG, language: LANGUAGE, text: { type: 'string' }, audioHash: AUDIO_HASH, service: TRANSCRIPTION_SERVICE, approvedPercent: { type: 'number', minimum: 0 }, install: { type: 'boolean' } }, ['screen', 'line']),
    needs: 'heardText',
    run: (context, args: TextFromAudioFileArgs, heard) => adding(setNarrationTextFromAudio(context, heardTextArgs(args, heard)), heard.transcript ? { transcript: heard.transcript } : {}),
    journal: (args, heard) => ({ name: 'set_narration_text_from_audio', args: heardTextArgs(args, heard) })
  }),
} as const;

// A line's audio as its host made it from the file (set_narration_audio): what the core writes.
function lineAudioArgs(args: NarrationAudioFileArgs, made: HostNeeds['lineAudio']): SetNarrationAudioArgs {
  return {
    screen: args.screen, line: args.line, ...(args.language ? { language: args.language } : {}),
    audio: made.audio, duration: made.duration, provider: args.provider, voice: args.voice, generated: args.generated,
    ...(made.words ? { words: made.words, ...(made.aligner ? { aligner: made.aligner } : {}) } : {}),
    ...(args.take ? { take: args.take } : {}), ...(args.credit ? { credit: args.credit } : {}), ...(args.model ? { model: args.model } : {}),
    ...(made.mouth !== undefined ? { mouth: made.mouth } : {}), createdAt: made.createdAt
  };
}

// A line made from a recording (add_narration_line_with_audio): its text and its audio.
function recordingArgs(args: LineFromAudioFileArgs, heard: HostNeeds['recording']): AddNarrationLineWithAudioArgs {
  return {
    screen: args.screen, ...(args.after !== undefined ? { after: args.after } : {}), ...(args.layer !== undefined ? { layer: args.layer } : {}), language: heard.language,
    line: { text: heard.text, ...(args.speaker ? { speaker: args.speaker } : {}), ...(typeof args.step === 'number' ? { step: args.step } : {}) },
    audio: heard.audio, duration: heard.duration, provider: 'recording', voice: heard.voice, generated: false,
    ...(heard.words ? { words: heard.words, ...(heard.aligner ? { aligner: heard.aligner } : {}) } : {}), createdAt: heard.createdAt
  };
}

// A line's text from what its recording says (set_narration_text_from_audio).
function heardTextArgs(args: TextFromAudioFileArgs, heard: HostNeeds['heardText']): SetNarrationTextFromAudioArgs {
  return {
    screen: args.screen, line: args.line, language: heard.language, text: heard.text, ...(heard.audioHash ? { audioHash: heard.audioHash } : {}),
    ...(heard.words ? { words: heard.words, ...(heard.aligner ? { aligner: heard.aligner } : {}) } : {})
  };
}

// The table with each entry's own types (the MCP tools read their arguments' schema from it, the
// engines and the app their arguments' type).
export const NAMED_COMMANDS: { readonly [Name in keyof typeof TABLE]: (typeof TABLE)[Name] } = TABLE;
export type CommandName = keyof typeof TABLE;
export const COMMAND_NAMES = Object.freeze(Object.keys(TABLE) as CommandName[]);

type RunOf<Name extends CommandName> = (typeof TABLE)[Name]['run'];
// What a command takes, by name: what callers send (a renamed argument breaks every caller).
export type CommandArgs = { [Name in CommandName]: RunOf<Name> extends (context: CommandContext, args: infer Args, given: never) => unknown ? Args : never };
// What it reports, beside its change.
export type CommandResult<Name extends CommandName> = RunOf<Name> extends (context: CommandContext, args: never, given: never) => CommandOutput<infer Result> ? Result : never;
// What it expects from its host (undefined: nothing but the files).
export type CommandNeed<Name extends CommandName> = [NonNullable<(typeof TABLE)[Name]['needs']>] extends [never] ? undefined : NonNullable<(typeof TABLE)[Name]['needs']>;
// The commands that need nothing but the project's files: what any host runs.
export type FileCommandName = { [Name in CommandName]: CommandNeed<Name> extends undefined ? Name : never }[CommandName];

// A command for arguments from elsewhere (a submission, a request): the room's view. The command
// checks them and throws CommandError when they do not fit. needs: what its host must give run
// (null: nothing); a host that cannot refuses the command.
export interface RunnableCommand {
  readonly name: CommandName;
  readonly description: string;
  readonly args: InputSchema;
  readonly destructive: boolean;
  readonly personOnly: boolean;
  readonly needs: HostNeed | null;
  run(context: CommandContext, args: unknown, given?: unknown): CommandOutput<unknown>;
  // What the journal records of a run with these arguments.
  journal(args: unknown, given?: unknown): JournaledCommand;
}

export function namedCommand(name: string): RunnableCommand | null {
  if (!Object.hasOwn(TABLE, name)) return null;
  const entry = TABLE[name as CommandName] as NamedCommand<InputSchema, unknown, unknown, HostNeed | undefined>;
  return {
    name: name as CommandName, description: entry.description, args: entry.args, destructive: !!entry.destructive, personOnly: !!entry.personOnly, needs: entry.needs ?? null,
    run: (context, args, given) => entry.run(context, args, given as never),
    journal: (args, given) => (entry.journal ? entry.journal(args, given as never) : { name, args })
  };
}
