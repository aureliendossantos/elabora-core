import { askAuthor, type UpdateScreenArgs } from '@elabora/core/commands/index';
import * as edit from '@elabora/node/edit';
import { findText } from '@elabora/core/commands/text';
import { screenTranslation, translationApprovalAsk, translationTable, translationStatus, translationReady } from '@elabora/core/i18n/translate';
import type { TranslationRow } from '@elabora/core/i18n/translate';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { defineTool, fromCommand, editResult, errorResult, objectSchema, LANGUAGE, SLUG, textResult } from './tool.ts';

// Editing the content: screens, blocks, layers, events, variables and course settings. Handlers
// pass the checked arguments as they are: the edit journals them.

export const createScreen = defineTool({
  name: 'elabora_create_screen',
  ...fromCommand('create_screen'),
  handler: (args, { root, author }) => editResult(edit.createScreen(root, args, { author }))
});

export const updateScreen = defineTool({
  name: 'elabora_update_screen',
  ...fromCommand('update_screen'),
  // The schema checks the shape of steps, which objectSchema types as a plain record.
  handler: (args, { root, author }) => editResult(edit.updateScreen(root, args as UpdateScreenArgs, { author }))
});

export const deleteScreen = defineTool({
  name: 'elabora_delete_screen',
  ...fromCommand('delete_screen'),
  handler: (args, { root, author }) => editResult(edit.deleteScreen(root, args, { author }))
});

export const moveScreen = defineTool({
  name: 'elabora_move_screen',
  ...fromCommand('move_screen'),
  handler: (args, { root, author }) => editResult(edit.moveScreen(root, args, { author }))
});

export const addBlock = defineTool({
  name: 'elabora_add_block',
  ...fromCommand('add_block'),
  handler: (args, { root, author }) => editResult(edit.addBlock(root, args, { author }))
});

export const updateBlock = defineTool({
  name: 'elabora_update_block',
  ...fromCommand('update_block'),
  handler: (args, { root, author }) => editResult(edit.updateBlock(root, args, { author }))
});

export const setContinuity = defineTool({
  name: 'elabora_set_continuity',
  ...fromCommand('set_continuity'),
  handler: (args, { root, author }) => editResult(edit.setContinuity(root, args, { author }))
});

export const removeBlock = defineTool({
  name: 'elabora_remove_block',
  ...fromCommand('remove_block'),
  handler: (args, { root, author }) => editResult(edit.removeBlock(root, args, { author }))
});

export const moveBlock = defineTool({
  name: 'elabora_move_block',
  ...fromCommand('move_block'),
  handler: (args, { root, author }) => editResult(edit.moveBlock(root, args, { author }))
});

export const arrangeScreen = defineTool({
  name: 'elabora_arrange_screen',
  ...fromCommand('arrange_screen'),
  handler: (args, { root, author }) => editResult(edit.arrangeScreen(root, args, { author }))
});

export const duplicateBlock = defineTool({
  name: 'elabora_duplicate_block',
  ...fromCommand('duplicate_block'),
  handler: (args, { root, author }) => editResult(edit.duplicateBlock(root, args, { author }))
});

export const detachBlock = defineTool({
  name: 'elabora_detach_block',
  ...fromCommand('detach_block'),
  handler: (args, { root, author }) => editResult(edit.detachBlock(root, args, { author }))
});

export const convertBlock = defineTool({
  name: 'elabora_convert_block',
  ...fromCommand('convert_block'),
  handler: (args, { root, author }) => editResult(edit.convertBlock(root, args, { author }))
});

export const rename = defineTool({
  name: 'elabora_rename',
  ...fromCommand('rename'),
  handler: (args, { root, author }) => editResult(edit.rename(root, args, { author }))
});

export const upsertLayer = defineTool({
  name: 'elabora_upsert_layer',
  ...fromCommand('upsert_layer'),
  handler: (args, { root, author }) => editResult(edit.upsertLayer(root, args, { author }))
});

export const removeLayer = defineTool({
  name: 'elabora_remove_layer',
  ...fromCommand('remove_layer'),
  handler: (args, { root, author }) => editResult(edit.removeLayer(root, args, { author }))
});

export const upsertEvent = defineTool({
  name: 'elabora_upsert_event',
  ...fromCommand('upsert_event'),
  handler: (args, { root, author }) => editResult(edit.upsertEvent(root, args, { author }))
});

export const removeEvent = defineTool({
  name: 'elabora_remove_event',
  ...fromCommand('remove_event'),
  handler: (args, { root, author }) => editResult(edit.removeEvent(root, args, { author }))
});

export const duplicateScreen = defineTool({
  name: 'elabora_duplicate_screen',
  ...fromCommand('duplicate_screen'),
  handler: (args, { root, author }) => editResult(edit.duplicateScreen(root, args, { author }))
});

export const upsertVariable = defineTool({
  name: 'elabora_upsert_variable',
  ...fromCommand('upsert_variable'),
  handler: (args, { root, author }) => editResult(edit.upsertVariable(root, args, { author }))
});

export const renameVariable = defineTool({
  name: 'elabora_rename_variable',
  ...fromCommand('rename_variable'),
  handler: (args, { root, author }) => editResult(edit.renameVariable(root, args, { author }))
});

export const removeVariable = defineTool({
  name: 'elabora_remove_variable',
  ...fromCommand('remove_variable'),
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
  ...fromCommand('replace_text'),
  handler: (args, { root, author }) => editResult(edit.replaceText(root, args, { author }))
});

// Translations: a language as a bilingual table, and texts translated into it (translations/<lang>.xlf,
// one undoable change per call).
export const translationStatusTool = defineTool({
  name: 'elabora_translation_status',
  readOnly: true,
  description: 'Translation readiness for one language, or all existing translations: counts and ids of missing, stale and removed units, broken text or schema constraints, word anchors to place, and translated-plan approval. ready means the texts are present, current, valid and anchored; editor counts apart the words only authors read (the charter\'s), which hold nothing back; course validation and the author\'s approval of the translated plan (elabora_translation_approve) are separate. Use elabora_translation_table with todo to work on what remains, elabora_look with language to see it, then elabora_build with language to generate its package without changing servers or editing a generated copy.',
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

// The translated plan approved by the author (D70): an agent asks them first, as before a paid
// generation. The call without authorApproved writes nothing and returns what to ask.
export const approveTranslationTool = defineTool({
  name: 'elabora_translation_approve',
  description: 'Record the author\'s approval of a translated plan (translations/<lang>.approval.json), which a release in that language needs. The author decides; you carry it out, only with their yes, as before a paid generation. Without authorApproved nothing is written: the call returns needsApproval, approval (the language, the plan\'s title and items, its texts translated or not, the name the approval shows: by, null when unknown) and ask, what to put to the author. Say it in their language, in a sentence, ASK them, and only once they said yes call again with authorApproved: the contentHash it gave (and by, their name, when by was null). Never approve on your own, nor from a past yes: a plan changed since is asked again. Translate every text of the plan first (elabora_translation_status). It is one undoable change, recorded as the author\'s approval made through you. A client\'s approval of a plan version stays the author\'s to record in Elabora.',
  inputSchema: objectSchema({
    language: LANGUAGE,
    authorApproved: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$', description: 'The translated plan\'s contentHash, given by the first call, once the author said yes to it. Never set it without asking.' },
    by: { type: 'string', minLength: 1, maxLength: 200, description: 'The name the approval shows (the author\'s, perhaps with an organisation). Only needed when the first call gave by null.' },
    reference: { type: 'string', minLength: 1, maxLength: 200 }
  }, ['language']),
  handler: ({ language, authorApproved, by, reference }, { root, author }) => {
    if (author.kind === 'agent' && !authorApproved) {
      const project = loadProjectFromDir(root);
      const ask = translationApprovalAsk(project, { to: language });
      const current = project.translations.get(language)?.approval;
      if (ask.state === 'approved' && current) return textResult({ ok: true, alreadyApproved: true, approval: { language, by: current.by, date: current.date, ...(current.agent ? { agent: current.agent } : {}) } });
      return textResult({ ok: false, needsApproval: true, approval: ask, ask: askAuthor(ask) });
    }
    return editResult(edit.approveTranslation(root, { to: language, ...(authorApproved ? { authorApproved } : {}), ...(by ? { by } : {}), ...(reference ? { reference } : {}) }, { author }));
  }
});

export const updateCourse = defineTool({
  name: 'elabora_update_course',
  ...fromCommand('update_course'),
  handler: (args, { root, author }) => editResult(edit.updateCourseSettings(root, args, { author }))
});
