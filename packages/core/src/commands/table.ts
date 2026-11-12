import type { Block, Course, CourseSection, Event, PatchOperation, Screen, ScreenLayer, Theme, Variable } from '@elabora/format';
import { PLAYER_ITEMS, PLAYER_TOKENS } from '../player/config.ts';
import type { NarrationLine } from '../narration/narration.ts';
import { formatValue, objectSchema, LANGUAGE, PLAN_ID, SLUG, type ArgumentsOf, type InputSchema } from './arguments.ts';
import type { CommandContext, CommandOutput } from './context.ts';
import { createScreen, updateScreen, deleteScreen, moveScreen, duplicateScreen, type UpdateScreenArgs } from './screens.ts';
import { addBlock, updateBlock, removeBlock, moveBlock, duplicateBlock, detachBlock, type AddBlockArgs } from './blocks.ts';
import { placeBlock, arrangeScreen } from './placement.ts';
import { upsertLayer, removeLayer, upsertEvent, removeEvent, upsertVariable, removeVariable } from './layers-events-variables.ts';
import { updateCourseSettings, ignoreFindings } from './course.ts';
import { writePlan, setPlanText, revertPlanChange, createPlanVersion, approvePlan, setPlanNote } from './plan.ts';
import { renameId, renameVariable } from './rename.ts';
import { exportTranslation, translateText, approveTranslation } from './translation.ts';
import { replaceText } from './text.ts';
import { updateNarration, addNarrationLine, updateNarrationLine, moveNarrationLine, removeNarrationLine, removeSpeaker, splitStep, narrationFromPlan, type AddNarrationLineArgs } from './narration.ts';
import { setBlockTiming, type MomentPatch } from './timing.ts';
import { setDialogueNode, removeDialogueNode } from './dialogue.ts';
import { updatePlayer, type CourseResource } from './player.ts';
import { setContinuity } from './continuity.ts';
import { convertBlock } from './convert.ts';
import type { CourseGlossary } from '@elabora/format';

// The commands by name (docs/decisions.md D84): those that need nothing but the project's files,
// by the names the journal, the command line, the MCP tools and the engine give them, each with the
// JSON Schema of its arguments, what a tool says of it, and the core function that runs it. A server
// that runs commands on a project (a project's room in the cloud) and the tools an agent writes
// with derive from it. Nothing that renders, speaks, or reads a disk or a library is here (templates,
// fonts, components from a library, media): those need the author's computer.
//
// The schema is what a tool may send: each command still checks its own arguments, and a caller
// with arguments from elsewhere (the journal, the app) runs the command, not the schema. Data and
// functions only: no validator, nothing done at load.

export interface NamedCommand<Schema extends InputSchema = InputSchema> {
  readonly description: string;
  readonly args: Schema;
  // Removes content (a tool's destructive hint).
  readonly destructive?: true;
  // A person's only: refused to an agent (E_PLAN_PERSON_ONLY).
  readonly personOnly?: true;
  readonly run: (context: CommandContext, args: ArgumentsOf<Schema>) => CommandOutput<unknown>;
}

// The run takes what the schema allows: the compiler checks each schema against its command.
const command = <const Schema extends InputSchema>(entry: NamedCommand<Schema>): NamedCommand<Schema> => entry;

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
    description: 'Change title, covers, completeWhen, required, showTitle, layout (a screen-level component), layoutProps (its props), style (theme.styles.screen), backdrop (a theme.backdrop variant, or none), continueRevealsSteps (false: only the screen\'s reveal-step events reveal its steps), narration (the script: lines with id, speaker, text, step and pauseBefore; advance and seek; replaced whole) or steps (how each step opens, by number: { "2": { "opens": "answered" } }, or "explored" for a Continue locked until the blocks above are explored; replaced whole) of a screen. null removes layout, layoutProps, style, backdrop, continueRevealsSteps, steps or narration.',
    args: objectSchema({ id: SLUG, title: { type: 'string' }, covers: { type: 'array', items: PLAN_ID }, completeWhen: { enum: ['viewed', 'interactions-done', 'action'] }, required: { type: 'boolean' }, showTitle: { type: 'boolean' }, layout: { type: ['string', 'null'] }, layoutProps: { type: ['object', 'null'] }, style: { type: ['string', 'null'] }, backdrop: { type: ['string', 'null'] }, continueRevealsSteps: { type: ['boolean', 'null'] }, steps: STEPS, narration: formatValue<Screen['narration'] | null>()({ type: ['object', 'null'] }) }, ['id']),
    // The schema checks the shape of steps, which objectSchema types as a plain record.
    run: (context, args) => updateScreen(context, args as UpdateScreenArgs)
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
    description: 'Add a block {id, type, props} (built-in type or course component) to a screen, one of its layers, or the slots of a component instance (parent + block.slot). Read elabora_get_schema(<type>) first. Component instances may carry blocks (their slot contents). Without an id the block gets one (<screen>-<type>-<random suffix>), returned as block.',
    args: objectSchema({ screen: SLUG, block: formatValue<AddBlockArgs['block']>()({ type: 'object', properties: { id: SLUG, type: SLUG, props: { type: 'object' }, blocks: { type: 'array', items: { type: 'object' } }, hidden: { type: 'boolean' }, width: BLOCK_WIDTH, slot: { type: 'string', description: 'Slot of the screen layout, or of the parent component instance.' }, style: { type: 'string', description: 'Named style of the type (theme.styles or the component styles).' }, optional: { type: 'boolean', description: 'Extra the learner may skip (a transcript, more detail): not waited for by steps that open once explored nor by interactions-done.' } }, required: ['type', 'props'] }), layer: SLUG, parent: { ...SLUG, description: 'Component instance receiving the block in one of its slots.' }, after: SLUG, position: { type: 'integer', minimum: 0 } }, ['screen', 'block']),
    run: addBlock
  }),
  update_block: command({
    description: 'Edit a block by id (anywhere, slots included): props are merged (a prop set to null is removed); also hidden, width, note, optional (true: extra the learner may skip, not waited for by steps that open once explored nor by interactions-done), slot and style (null removes), step (a block of the screen itself: the step that reveals it; null or 1: from the start), and continuity ({ key, duration? }: blocks of other screens with the same key carry on from one screen to the next, D65; null removes it; elabora_set_continuity links two blocks for you), and place (a block of the screen itself placed by hand, D72: { x, y, width, height?, z? } in shares of the placement frame, the reference window at the screen\'s width; in slides y from the frame\'s top, in scroll pages from the block\'s place in the page; null puts it back in the flow at its slot and rank; prefer a layout). For free-object blocks, props.props holds the declared prop values.',
    args: objectSchema({ block: SLUG, props: { type: 'object' }, hidden: { type: 'boolean' }, width: BLOCK_WIDTH, note: { type: 'string' }, optional: { type: 'boolean' }, slot: { type: ['string', 'null'] }, style: { type: ['string', 'null'] }, step: { type: ['integer', 'null'], minimum: 1, maximum: 12 }, continuity: { type: ['object', 'null'], properties: { key: SLUG, duration: { type: 'integer', minimum: 0, maximum: 3000 } }, required: ['key'], additionalProperties: false }, place: { type: ['object', 'null'], properties: { x: { type: 'number', minimum: -1, maximum: 2 }, y: { type: 'number', minimum: -20, maximum: 20 }, width: { type: 'number', minimum: 0.01, maximum: 2 }, height: { type: 'number', minimum: 0.01, maximum: 20 }, z: { type: 'integer', minimum: 0, maximum: 999 } }, required: ['x', 'y', 'width'], additionalProperties: false } }, ['block']),
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
    description: 'Update course settings: title, description, version, theme (tokens), navigation, completion (reportAs, masteryScore), tracking, delivery (replaced whole: mediaQuality: high, medium or low, the media preset of the package; lms; languages: the package\'s languages, "all" or a list, D71; defaultLanguage: the one learners start in when their LMS gives none; languagePackages: one or each), ui labels, sections, speakers (id and name; voices chosen with elabora_voice_set), pronunciations (by language: text and say), narration (default advance and seek), presentation (mode scroll or slides, fit), sounds (the interface sounds, and the music and ambiences: background). null removes pronunciations or sounds.',
    args: objectSchema({ title: { type: 'string' }, description: { type: 'string' }, version: { type: 'string' }, theme: formatValue<Theme>()({ type: 'object' }), navigation: formatValue<Course['navigation']>()({ type: 'object' }), completion: formatValue<Course['completion']>()({ type: 'object' }), tracking: formatValue<Course['tracking']>()({ type: 'object' }), delivery: formatValue<Course['delivery']>()({ type: 'object' }), ui: formatValue<Course['ui']>()({ type: 'object' }), sections: formatValue<CourseSection[]>()({ type: 'array' }), presentation: formatValue<Course['presentation']>()({ type: 'object' }), speakers: formatValue<Course['speakers']>()({ type: 'array' }), pronunciations: formatValue<Course['pronunciations'] | null>()({ type: ['object', 'null'] }), narration: formatValue<Course['narration']>()({ type: 'object' }), sounds: formatValue<Course['sounds'] | null>()({ type: ['object', 'null'] }) }),
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
    description: 'Write the plan (plan.json, the working copy) at any time: the whole plan (plan) or a JSON Patch (RFC 6902) of it. Checked against the plan\'s schema before anything is written, refused with why. Before its first validation, draft it whole from what the author gave you (sources, objectives, the client\'s brief): the items grouped by part (items[].part), each objective with a short name of three to five words (objectives[].short), decided and question (D51). Once a version was validated, write the changes all the same and tell the author what you changed: the app marks them, and the author makes the next version and sends it. Refused when it would change a text kept « à l\'identique » (lockedTexts[].verbatim): ask the author. Rewording a validated text is writing it here: every block with its textRef follows. Items moved (a move, a part changed) take the screens that cover them along in the same change (moved says which).',
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
    run: createPlanVersion
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
} as const;

// The table with each entry's own schema type (the MCP tools read their arguments' type from it).
export const NAMED_COMMANDS: { readonly [Name in keyof typeof TABLE]: (typeof TABLE)[Name] } = TABLE;
export type CommandName = keyof typeof TABLE;
export const COMMAND_NAMES = Object.freeze(Object.keys(TABLE) as CommandName[]);

// A command for arguments from elsewhere (a submission, a request): the room's view. The command
// checks them and throws CommandError when they do not fit.
export interface RunnableCommand {
  readonly name: CommandName;
  readonly description: string;
  readonly args: InputSchema;
  readonly destructive: boolean;
  readonly personOnly: boolean;
  run(context: CommandContext, args: unknown): CommandOutput<unknown>;
}

export function namedCommand(name: string): RunnableCommand | null {
  if (!Object.hasOwn(TABLE, name)) return null;
  const entry = TABLE[name as CommandName] as NamedCommand<InputSchema> & { destructive?: true; personOnly?: true };
  return { name: name as CommandName, description: entry.description, args: entry.args, destructive: !!entry.destructive, personOnly: !!entry.personOnly, run: (context, args) => entry.run(context, args as never) };
}
