import type { Block, Course, CourseSection, Event, Screen, ScreenLayer, Theme, Variable } from '@elabora/format';
import type { AddBlockArgs, UpdateScreenArgs } from '@elabora/core/commands/index';
import * as edit from '@elabora/node/edit';
import { findText } from '@elabora/core/commands/text';
import { screenTranslation, translationTable, translationStatus, translationReady } from '@elabora/core/i18n/translate';
import type { TranslationRow } from '@elabora/core/i18n/translate';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { defineTool, editResult, errorResult, formatValue, objectSchema, LANGUAGE, PLAN_ID, SLUG, textResult } from './tool.ts';

// Blocks given whole, checked by the edit against the format.
const BLOCKS = { type: 'array', items: formatValue<Block>()({ type: 'object' }) } as const;

// Editing the content: screens, blocks, layers, events, variables and course settings. Handlers
// pass the checked arguments as they are: the edit journals them.

export const createScreen = defineTool({
  name: 'elabora_create_screen',
  description: 'Create a screen and insert it in a section. covers lists the plan items it implements. layout: a screen-level component of the course (its blocks go in its slots), with its layoutProps.',
  inputSchema: objectSchema({ id: SLUG, title: { type: 'string' }, covers: { type: 'array', items: PLAN_ID, minItems: 1 }, section: SLUG, after: { ...SLUG, description: 'Insert after this screen id.' }, completeWhen: { enum: ['viewed', 'interactions-done', 'action'] }, blocks: BLOCKS, layout: SLUG, layoutProps: { type: 'object' } }, ['id', 'title', 'covers']),
  handler: (args, { root, author }) => editResult(edit.createScreen(root, args, { author }))
});

// How each step of a screen opens, by step number.
const STEPS = { type: ['object', 'null'], additionalProperties: { type: 'object', properties: { opens: { enum: ['continue', 'answered', 'explored'] }, label: { type: 'string' } }, additionalProperties: false } } as const;

export const updateScreen = defineTool({
  name: 'elabora_update_screen',
  description: 'Change title, covers, completeWhen, required, showTitle, layout (a screen-level component), layoutProps (its props), style (theme.styles.screen), backdrop (a theme.backdrop variant, or none), continueRevealsSteps (false: only the screen\'s reveal-step events reveal its steps), narration (the script: lines with id, speaker, text, step and pauseBefore; advance and seek; replaced whole) or steps (how each step opens, by number: { "2": { "opens": "answered" } }, or "explored" for a Continue locked until the blocks above are explored; replaced whole) of a screen. null removes layout, layoutProps, style, backdrop, continueRevealsSteps, steps or narration.',
  inputSchema: objectSchema({ id: SLUG, title: { type: 'string' }, covers: { type: 'array', items: PLAN_ID }, completeWhen: { enum: ['viewed', 'interactions-done', 'action'] }, required: { type: 'boolean' }, showTitle: { type: 'boolean' }, layout: { type: ['string', 'null'] }, layoutProps: { type: ['object', 'null'] }, style: { type: ['string', 'null'] }, backdrop: { type: ['string', 'null'] }, continueRevealsSteps: { type: ['boolean', 'null'] }, steps: STEPS, narration: formatValue<Screen['narration'] | null>()({ type: ['object', 'null'] }) }, ['id']),
  // The schema checks the shape of steps, which objectSchema types as a plain record.
  handler: (args, { root, author }) => editResult(edit.updateScreen(root, args as UpdateScreenArgs, { author }))
});

export const deleteScreen = defineTool({
  name: 'elabora_delete_screen',
  destructive: true,
  description: 'Delete a screen file and remove it from its section.',
  inputSchema: objectSchema({ id: SLUG }, ['id']),
  handler: (args, { root, author }) => editResult(edit.deleteScreen(root, args, { author }))
});

export const moveScreen = defineTool({
  name: 'elabora_move_screen',
  description: 'Move a screen to another position or section.',
  inputSchema: objectSchema({ id: SLUG, section: SLUG, after: SLUG, position: { type: 'integer', minimum: 0 } }, ['id']),
  handler: (args, { root, author }) => editResult(edit.moveScreen(root, args, { author }))
});

export const addBlock = defineTool({
  name: 'elabora_add_block',
  description: 'Add a block {id, type, props} (built-in type or course component) to a screen, one of its layers, or the slots of a component instance (parent + block.slot). Read elabora_get_schema(<type>) first. Component instances may carry blocks (their slot contents). Without an id the block gets a free one (<screen>-<type>), returned as block.',
  inputSchema: objectSchema({ screen: SLUG, block: formatValue<AddBlockArgs['block']>()({ type: 'object', properties: { id: SLUG, type: SLUG, props: { type: 'object' }, blocks: { type: 'array', items: { type: 'object' } }, hidden: { type: 'boolean' }, width: { enum: ['full', 'wide', 'half', 'bleed'] }, slot: { type: 'string', description: 'Slot of the screen layout, or of the parent component instance.' }, style: { type: 'string', description: 'Named style of the type (theme.styles or the component styles).' }, optional: { type: 'boolean', description: 'Extra the learner may skip (a transcript, more detail): not waited for by steps that open once explored nor by interactions-done.' } }, required: ['type', 'props'] }), layer: SLUG, parent: { ...SLUG, description: 'Component instance receiving the block in one of its slots.' }, after: SLUG, position: { type: 'integer', minimum: 0 } }, ['screen', 'block']),
  handler: (args, { root, author }) => editResult(edit.addBlock(root, args, { author }))
});

export const updateBlock = defineTool({
  name: 'elabora_update_block',
  description: 'Edit a block by id (anywhere, slots included): props are merged (a prop set to null is removed); also hidden, width, note, optional (true: extra the learner may skip, not waited for by steps that open once explored nor by interactions-done), slot and style (null removes), step (a block of the screen itself: the step that reveals it; null or 1: from the start), and continuity ({ key, duration? }: blocks of other screens with the same key carry on from one screen to the next, D65; null removes it; elabora_set_continuity links two blocks for you). For free-object blocks, props.props holds the declared prop values.',
  inputSchema: objectSchema({ block: SLUG, props: { type: 'object' }, hidden: { type: 'boolean' }, width: { enum: ['full', 'wide', 'half', 'bleed'] }, note: { type: 'string' }, optional: { type: 'boolean' }, slot: { type: ['string', 'null'] }, style: { type: ['string', 'null'] }, step: { type: ['integer', 'null'], minimum: 1, maximum: 12 }, continuity: { type: ['object', 'null'], properties: { key: SLUG, duration: { type: 'integer', minimum: 0, maximum: 3000 } }, required: ['key'], additionalProperties: false } }, ['block']),
  handler: (args, { root, author }) => editResult(edit.updateBlock(root, args, { author }))
});

export const setContinuity = defineTool({
  name: 'elabora_set_continuity',
  description: 'Continuity between screens (D65): a block carries on from a block of another screen instead of appearing again (a free object keeps running and moves to its new settings, update(props, transition); another block glides from where its counterpart was). with: the block it carries on from (they share a key: that block\'s, else this one\'s, else a new one; same type, free objects the same object; blocks of screens, not layers); with null: it no longer carries on from the screens before it (it still does to the screens after it). duration: the passage to it in ms (0 to 3000; null: 700). One undoable change.',
  inputSchema: objectSchema({ block: SLUG, with: { type: ['string', 'null'], description: 'The block of another screen it carries on from; null cuts it from the screens before it.' }, duration: { type: ['integer', 'null'], minimum: 0, maximum: 3000 } }, ['block']),
  handler: (args, { root, author }) => editResult(edit.setContinuity(root, args, { author }))
});

export const removeBlock = defineTool({
  name: 'elabora_remove_block',
  destructive: true,
  description: 'Remove a block by id (with the blocks of its slots).',
  inputSchema: objectSchema({ block: SLUG }, ['block']),
  handler: (args, { root, author }) => editResult(edit.removeBlock(root, args, { author }))
});

export const moveBlock = defineTool({
  name: 'elabora_move_block',
  description: 'Move a block within its screen, to another screen, into a layer, or into a slot of a component instance (parent, slot).',
  inputSchema: objectSchema({ block: SLUG, screen: SLUG, layer: SLUG, parent: SLUG, slot: { type: ['string', 'null'] }, after: SLUG, position: { type: 'integer', minimum: 0 } }, ['block']),
  handler: (args, { root, author }) => editResult(edit.moveBlock(root, args, { author }))
});

export const duplicateBlock = defineTool({
  name: 'elabora_duplicate_block',
  description: 'Duplicate a block (a component instance copies the blocks of its slots): new ids, same content, inserted after the original unless a target is given.',
  inputSchema: objectSchema({ block: SLUG, id: { ...SLUG, description: 'Id of the copy (default <id>-copy).' }, screen: SLUG, layer: SLUG, parent: SLUG, after: SLUG, position: { type: 'integer', minimum: 0 } }, ['block']),
  handler: (args, { root, author }) => editResult(edit.duplicateBlock(root, args, { author }))
});

export const detachBlock = defineTool({
  name: 'elabora_detach_block',
  description: 'Replace a component instance by its fallback: native blocks with the same content (plan links kept), then the blocks of its slots. The first block keeps the id (a fork of quiz becomes a quiz, learner state kept).',
  inputSchema: objectSchema({ block: SLUG }, ['block']),
  handler: (args, { root, author }) => editResult(edit.detachBlock(root, args, { author }))
});

export const convertBlock = defineTool({
  name: 'elabora_convert_block',
  description: 'Change the form of content without rewriting it (« Transformer en… », D63): a block becomes another presentation of its type, or another type that holds the same content (panels ↔ steps ↔ interactive picture ↔ gallery, panels → a sort in pairs, steps → a sort in order or a process or milestones chart, statement ↔ callout ↔ text, image ↔ gallery of one, a text\'s bulleted list → panels or steps), in place, in one undoable change. Its id and its items\' ids are kept, so visited marks and translations follow; the result says what is kept, lost and added (starts empty), and whether learners who started lose their progress in the block. Without to, or with dryRun, nothing is written: the possible targets and those refused with their reason. Prefer it to removing a block and writing another one. language: fr or en for the sentences (default en).',
  inputSchema: objectSchema({ block: SLUG, to: { type: 'object', properties: { type: SLUG, presentation: { type: 'string', description: 'A presentation of the target type (default: its default one).' } }, required: ['type'], additionalProperties: false, description: 'The type to convert into, and its presentation.' }, dryRun: { type: 'boolean' }, language: { enum: ['en', 'fr'] } }, ['block']),
  handler: (args, { root, author }) => editResult(edit.convertBlock(root, args, { author }))
});

export const rename = defineTool({
  name: 'elabora_rename',
  description: 'Give a section, screen, layer, block or event another id, in one undoable change: every reference follows (sections, events, translation units, stylesheet selectors), a screen file takes the new name, and elabora.lock.json keeps the element\'s key, so learners in progress keep their progress. Refused when the new id is used or not a slug. Waivers of the plan that name the id follow too (waivers: how many).',
  inputSchema: objectSchema({ from: { ...SLUG, description: 'The id to rename.' }, to: { ...SLUG, description: 'The new id, unused in the course.' } }, ['from', 'to']),
  handler: (args, { root, author }) => editResult(edit.rename(root, args, { author }))
});

export const upsertLayer = defineTool({
  name: 'elabora_upsert_layer',
  description: 'Create or replace a layer (an overlay opened by a show-layer action) on a screen. Without an id it is a new layer with a free one (<screen>-layer), and its blocks without ids get free ones.',
  inputSchema: objectSchema({ screen: SLUG, layer: formatValue<ScreenLayer>()({ type: 'object', properties: { id: SLUG, title: { type: 'string' }, blocks: { type: 'array', items: { type: 'object' } } }, required: ['title', 'blocks'] }) }, ['screen', 'layer']),
  handler: (args, { root, author }) => editResult(edit.upsertLayer(root, args, { author }))
});

export const removeLayer = defineTool({
  name: 'elabora_remove_layer',
  destructive: true,
  description: 'Remove a layer from a screen, with its blocks. Events that still show or close it are reported by validation.',
  inputSchema: objectSchema({ screen: SLUG, id: SLUG }, ['screen', 'id']),
  handler: (args, { root, author }) => editResult(edit.removeLayer(root, args, { author }))
});

export const upsertEvent = defineTool({
  name: 'elabora_upsert_event',
  description: 'Create or replace an event (trigger → conditions → actions) on a screen. Read elabora_get_schema("event"). do may be empty (an event an author started in the app): it does nothing until it has an action, and validation warns (W_EVENT_NO_ACTION).',
  inputSchema: objectSchema({ screen: SLUG, event: formatValue<Event>()({ type: 'object' }) }, ['screen', 'event']),
  handler: (args, { root, author }) => editResult(edit.upsertEvent(root, args, { author }))
});

export const removeEvent = defineTool({
  name: 'elabora_remove_event',
  destructive: true,
  description: 'Remove an event from a screen.',
  inputSchema: objectSchema({ screen: SLUG, id: SLUG }, ['screen', 'id']),
  handler: (args, { root, author }) => editResult(edit.removeEvent(root, args, { author }))
});

export const duplicateScreen = defineTool({
  name: 'elabora_duplicate_screen',
  description: 'Copy a screen after it in its section: its blocks, layers and events get new ids (those named after the screen follow the copy\'s id), and the copy\'s events point at its own blocks and layers. The copy keeps the original\'s title unless given one.',
  inputSchema: objectSchema({ id: SLUG, newId: { ...SLUG, description: 'The copy\'s id (default: <id>-copy).' }, title: { type: 'string', description: 'The copy\'s title.' } }, ['id']),
  handler: (args, { root, author }) => editResult(edit.duplicateScreen(root, args, { author }))
});

export const upsertVariable = defineTool({
  name: 'elabora_upsert_variable',
  description: 'Create or replace a course variable {id, type, default, …}. String variables need maxLength.',
  inputSchema: objectSchema({ variable: formatValue<Variable>()({ type: 'object' }) }, ['variable']),
  handler: (args, { root, author }) => editResult(edit.upsertVariable(root, args, { author }))
});

const VARIABLE_ID = { type: 'string', pattern: '^[a-z][a-zA-Z0-9_]{0,31}$' } as const;

export const renameVariable = defineTool({
  name: 'elabora_rename_variable',
  description: 'Give a course variable another name, in one undoable change: the events that read or write it follow, and elabora.lock.json keeps its key, so learners in progress keep its value.',
  inputSchema: objectSchema({ from: VARIABLE_ID, to: { ...VARIABLE_ID, description: 'The new name, unused.' } }, ['from', 'to']),
  handler: (args, { root, author }) => editResult(edit.renameVariable(root, args, { author }))
});

export const removeVariable = defineTool({
  name: 'elabora_remove_variable',
  destructive: true,
  description: 'Remove a course variable. Refused while an event reads or writes it: change those events first.',
  inputSchema: objectSchema({ id: VARIABLE_ID }, ['id']),
  handler: (args, { root, author }) => editResult(edit.removeVariable(root, args, { author }))
});

export const findTextTool = defineTool({
  name: 'elabora_find_text',
  readOnly: true,
  description: 'Where words occur in what learners read (course.json and the screens, not the plan\'s validated texts): each match with its translation unit id, file, JSON pointer, screen, block and number of occurrences. In Markdown, a link\'s address, maths and code are not searched.',
  inputSchema: objectSchema({ query: { type: 'string', minLength: 1 }, caseSensitive: { type: 'boolean', default: false } }, ['query']),
  handler: ({ query, caseSensitive }, { root }) => textResult(findText(loadProjectFromDir(root), query, { caseSensitive }))
});

export const replaceTextTool = defineTool({
  name: 'elabora_replace_text',
  description: 'Replace words everywhere learners read them (course.json and the screens), in one undoable change. Never the plan\'s validated texts (they are the plan\'s: elabora_write_plan), never a link\'s address, maths or code; a free object\'s string keeps its placeholders and its length (else it is skipped and said). units: only these matches of elabora_find_text.',
  inputSchema: objectSchema({ find: { type: 'string', minLength: 1 }, replace: { type: 'string' }, caseSensitive: { type: 'boolean', default: false }, units: { type: 'array', items: { type: 'string' } } }, ['find', 'replace']),
  handler: (args, { root, author }) => editResult(edit.replaceText(root, args, { author }))
});

// Translations: a language as a bilingual table, and texts translated into it (translations/<lang>.xlf,
// one undoable change per call).
export const translationStatusTool = defineTool({
  name: 'elabora_translation_status',
  readOnly: true,
  description: 'Translation readiness for one language, or all existing translations: counts and ids of missing, stale and removed units, broken text or schema constraints, word anchors to place, and translated-plan approval. ready means the texts are present, current, valid and anchored; editor counts apart the words only authors read (the charter\'s), which hold nothing back; course validation and human plan approval are separate. Use elabora_translation_table with todo to work on what remains, elabora_look with language to see it, then elabora_build with language to generate its package without changing servers or editing a generated copy.',
  inputSchema: objectSchema({ language: LANGUAGE }),
  handler: ({ language }, { root }) => textResult({ languages: translationStatus(loadProjectFromDir(root), { to: language }).map((status) => ({ ...status, ready: translationReady(status) })) })
});

export const translationTableTool = defineTool({
  name: 'elabora_translation_table',
  readOnly: true,
  description: 'A language of the course as a bilingual table: every text a learner (or the approver of the translated plan) reads, as a translation unit with its source, its translation and what it asks for: to-translate, to-review (a translation kept from a previous source, or not confirmed), stale (the source changed since: previousSource), translated; problem: what breaks the text (lost maths, links, code or placeholders, too long); anchors: a narration line\'s word anchors, as markers in its source and target, and the words of the translation each is placed on (null: to place). screen: only the texts that screen shows (the plan\'s validated texts and questions its blocks show included, with the block and field that show each). editor: true marks words only authors read (what the charter\'s styles and variants are for, its components\' names and settings, a free object\'s settings): translate them so the course reads in its language in the editor too; they hold nothing back. todo: only what asks for something. A language the course does not have yet lists every text to translate; elabora_translate_text starts it.',
  inputSchema: objectSchema({ language: LANGUAGE, screen: SLUG, todo: { type: 'boolean', default: false } }, ['language']),
  handler: ({ language, screen, todo }, { root }) => {
    const project = loadProjectFromDir(root);
    if (screen && !project.screens.has(screen)) return errorResult(`No screen "${screen}".`);
    const table = screen ? screenTranslation(project, { screen, language }) : translationTable(project, language);
    const all = table.rows as (TranslationRow & { field?: string | null })[];
    // Editor rows (words only authors read) hold nothing back: counted apart.
    const count = (status: TranslationRow['status']) => all.filter((row) => row.status === status && !row.editor).length;
    const rows = all.filter((row) => !todo || row.status !== 'translated' || row.problem !== null || row.anchors?.some((anchor) => !anchor.placed)).map((row) => ({
      unit: row.id, screen: row.screen, block: row.block, ...(row.field ? { field: row.field } : {}), source: row.sourceMarked ?? row.source, target: row.targetMarked !== undefined ? row.targetMarked : row.target, status: row.status,
      ...(row.anchors ? { anchors: row.anchors.map((anchor) => ({ id: anchor.id, word: anchor.word, placed: anchor.placed?.word ?? null })) } : {}),
      ...(row.previousSource !== null ? { previousSource: row.previousSource } : {}), format: row.format,
      ...(row.note ? { note: row.note } : {}), ...(row.maxLength ? { maxLength: row.maxLength } : {}), ...(row.problem ? { problem: row.problem } : {}), ...(row.editor ? { editor: true } : {})
    }));
    return textResult({
      language, source: table.source, exists: table.exists, ...(screen ? { screen } : {}),
      progress: { units: all.length, translated: count('translated'), toReview: count('to-review'), toTranslate: count('to-translate'), stale: count('stale'), editor: all.filter((row) => row.editor && row.status !== 'translated').length, broken: all.filter((row) => row.problem).length },
      rows
    });
  }
});

export const translateTextTool = defineTool({
  name: 'elabora_translate_text',
  description: 'Translate texts of the course into a language, in one undoable change (translations/<lang>.xlf; a language the course does not have yet starts here): texts, a list of { unit, target } with the unit ids of elabora_translation_table; target null or empty clears a translation. Keep the source\'s Markdown, maths, links, code and ICU placeholders, and stay under maxLength: a translation that breaks them is refused, with the whole call. A stale unit translated again takes the current source. state: translated (default; people review it in the app), reviewed or final (for a person\'s own review). Check elabora_translation_status, then elabora_build with language for its package. A narration line whose words time blocks or events (word anchors) shows them in its source as markers, <mrk id="w-imprimante">imprimante</mrk>: put each marker around the words of the translation that say the same thing (<mrk id="w-imprimante">printer</mrk>), so the translated course anchors there and its voice gives them their times; or name the words in anchors: [{ id, word }]. A marker id the source does not have is refused; one left out is an anchor to place (elabora_translation_status), at the start of its line in a draft.',
  inputSchema: objectSchema({
    language: LANGUAGE,
    texts: { type: 'array', minItems: 1, items: { type: 'object', properties: { unit: { type: 'string', minLength: 1 }, target: { type: ['string', 'null'] }, anchors: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', pattern: '^w-' }, word: { type: 'string', minLength: 1 }, occurrence: { type: 'integer', minimum: 1 } }, required: ['id', 'word'], additionalProperties: false } } }, required: ['unit', 'target'], additionalProperties: false } },
    state: { enum: ['translated', 'reviewed', 'final'], default: 'translated' }
  }, ['language', 'texts']),
  handler: ({ language, texts, state }, { root, author }) => editResult(edit.translateText(root, { language, texts: texts.map((text) => ({ unit: text.unit, target: text.target, ...(text.anchors ? { anchors: text.anchors } : {}), ...(state ? { state } : {}) })) }, { author }))
});

export const updateCourse = defineTool({
  name: 'elabora_update_course',
  description: 'Update course settings: title, description, version, theme (tokens), navigation, completion (reportAs, masteryScore), tracking, delivery (mediaQuality: high, medium or low, the media preset of the package), ui labels, sections, speakers (id and name; voices chosen with elabora_voice_set), pronunciations (by language: text and say), narration (default advance and seek), presentation (mode scroll or slides, fit).',
  inputSchema: objectSchema({ title: { type: 'string' }, description: { type: 'string' }, version: { type: 'string' }, theme: formatValue<Theme>()({ type: 'object' }), navigation: formatValue<Course['navigation']>()({ type: 'object' }), completion: formatValue<Course['completion']>()({ type: 'object' }), tracking: formatValue<Course['tracking']>()({ type: 'object' }), delivery: formatValue<Course['delivery']>()({ type: 'object' }), ui: formatValue<Course['ui']>()({ type: 'object' }), sections: formatValue<CourseSection[]>()({ type: 'array' }), presentation: formatValue<Course['presentation']>()({ type: 'object' }), speakers: formatValue<Course['speakers']>()({ type: 'array' }), pronunciations: formatValue<Course['pronunciations']>()({ type: 'object' }), narration: formatValue<Course['narration']>()({ type: 'object' }) }),
  handler: (args, { root, author }) => editResult(edit.updateCourseSettings(root, args, { author }))
});
