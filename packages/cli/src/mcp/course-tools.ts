import { describePlanVersions, planDiffBetween, planVersionsView, versionNumber } from '@elabora/core/project/plan-versions';
import type { PlanRef } from '@elabora/core/project/plan-versions';
import { projectMarkdown } from '@elabora/core/project/markdown';
import { getRegistry } from '@elabora/core/components/registry';
import { getSchema as getFormatSchema, derefSchema } from '@elabora/format/schemas';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { exportPlanDocument } from '@elabora/node/plan-document';
import { withCourseLanguage } from '@elabora/node/translate';
import { changeSeq, keptEdits } from '../commands/history.ts';
import { validateProject } from '@elabora/core/validate/index';
import type { PatchOperation } from '@elabora/format';
import { agentFindings, defineTool, editResult, errorResult, formatValue, objectSchema, textResult, LANGUAGE, PROFILES, SLUG } from './tool.ts';

// Reading the course, validating it, writing the plan, and the history of edits.

export const overview = defineTool({
  name: 'elabora_overview',
  readOnly: true,
  description: 'Markdown map of the course: plan objectives, sections, screens with their blocks (ids, types, plan references), events; plus the validation summary. Start here. audience "client" gives the review version.',
  inputSchema: objectSchema({ audience: { enum: ['agent', 'client'], default: 'agent' }, screen: { ...SLUG, description: 'Only this screen.' } }),
  handler(args, { root }) {
    const project = loadProjectFromDir(root);
    const { summary, context: { budget } } = validateProject(project);
    return textResult(`${projectMarkdown(project, { audience: args.audience || 'agent', screen: args.screen })}\n---\nValidation: ${summary.errors} error(s), ${summary.warnings} warning(s). suspend_data worst case ${budget?.worstCase}/${budget?.limit}. Plan: ${describePlanVersions(planVersionsView(project))}.`);
  }
});

export const getPlan = defineTool({
  name: 'elabora_get_plan',
  readOnly: true,
  description: 'The plan (the contract layer, plan.json: the working copy): objectives, ordered items, validated texts (lockedTexts; verbatim: kept « à l\'identique », which you never change), validated questions, sources; and its versions (V1, V2…: frozen copies the author made, sent and had validated), with how many changes the working copy has since the validated version and since the latest one. You write the plan with elabora_write_plan; making and validating versions is the author\'s.',
  inputSchema: objectSchema({}),
  handler(_args, { root }) {
    const project = loadProjectFromDir(root);
    const view = planVersionsView(project);
    return textResult({ versions: { summary: describePlanVersions(view), state: view.state, latest: view.latest, validated: view.validated, sinceValidated: view.current.sinceValidated, unversioned: view.current.unversioned, verbatimChanged: view.verbatimChanged }, plan: project.plan });
  }
});

// from / to: a version (V2), validated, latest or current.
const planRef = (value: unknown, fallback: PlanRef): PlanRef | null => {
  if (value === undefined) return fallback;
  if (value === 'validated' || value === 'latest' || value === 'current') return value;
  return typeof value === 'string' || typeof value === 'number' ? versionNumber(value) : null;
};

export const planDiffTool = defineTool({
  name: 'elabora_plan_diff',
  readOnly: true,
  description: 'What changed in the plan, element by element and matched by plan ids: items, objectives, texts, questions and sources added, removed, moved (from which position) or changed (each field, texts word by word), an item\'s part changed. By default since the validated version (what the client will read as changes) to the working copy; from: "latest" for what is in no version yet. Each change has a key (item:ITEM-3) and verbatim: true for a text kept « à l\'identique ».',
  inputSchema: objectSchema({ from: { type: 'string', description: 'V2, validated (default), latest or current.' }, to: { type: 'string', description: 'V3 or current (default).' } }),
  handler(args, { root }) {
    const from = planRef(args.from, 'validated');
    const to = planRef(args.to, 'current');
    if (from === null || to === null) return errorResult('from and to are a version (V2), validated, latest or current.');
    try { return textResult(planDiffBetween(loadProjectFromDir(root), { from, to })); } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
  }
});

export const getScreen = defineTool({
  name: 'elabora_get_screen',
  readOnly: true,
  description: 'Full JSON of one screen (blocks, layers, events).',
  inputSchema: objectSchema({ id: SLUG }, ['id']),
  handler({ id }, { root }) {
    const screen = loadProjectFromDir(root).screens.get(id);
    if (!screen) return errorResult(`No screen "${id}"`);
    return textResult(screen.data);
  }
});

export const getSchema = defineTool({
  name: 'elabora_get_schema',
  readOnly: true,
  description: 'JSON Schema of the props of a block type (built-in like "quiz" or a course component id), or of a file/element: "screen", "event", "course", "plan", "component", "object-manifest", "object-tests". Read it before writing that element.',
  inputSchema: objectSchema({ name: { type: 'string' } }, ['name']),
  handler({ name }, { root }) {
    const registry = getRegistry(loadProjectFromDir(root));
    const component = registry.get(name);
    if (component) return textResult(component.schema);
    const schema = getFormatSchema(name);
    if (!schema) return errorResult(`Unknown schema "${name}". Use a block type (${[...registry.keys()].join(', ')}) or screen, event, course, plan, component, object-manifest, object-tests.`);
    return textResult(derefSchema(schema));
  }
});

export const validate = defineTool({
  name: 'elabora_validate',
  readOnly: true,
  description: 'Run every check (format, plan conformity, pedagogy, accessibility, events, free objects, suspend_data budget against LMS profiles). Returns diagnostics with stable codes, location (file + JSON pointer) and a fix. Warnings the author ignored in the editor (course.json ignored, for example a word a voice almost swallows as a native speaker would) are left out and counted in summary.ignored: leave them alone; includeIgnored lists them, marked ignored.',
  inputSchema: objectSchema({ profiles: PROFILES, release: { type: 'boolean', description: 'Client delivery: the plan needs a validated version.' }, includeInfo: { type: 'boolean' }, includeIgnored: { type: 'boolean' }, language: { ...LANGUAGE, description: 'Check this translation, regenerated from the source; omit for the source language.' }, allowMissing: { type: 'boolean', description: 'With language: check a draft with missing/stale texts kept in the source language and unplaced anchors at line starts.' } }),
  handler(args, { root }) {
    return withCourseLanguage(root, args, (dir, translation) => {
      const result = validateProject(loadProjectFromDir(dir), { profiles: args.profiles, release: args.release });
      return textResult({ ok: result.ok, ...(translation ? { translation: { language: translation.language, untranslated: translation.untranslated, unplaced: translation.unplaced, plan: translation.plan } } : {}), summary: result.summary, budget: result.context.budget, diagnostics: result.diagnostics.filter((d) => (args.includeInfo || d.severity !== 'info') && (args.includeIgnored || !d.ignored)) });
    });
  }
});

export const ignoreFinding = defineTool({
  name: 'elabora_ignore_finding',
  description: 'Ignore a warning that has a key (Diagnostic.key), as the author\'s « Ignorer » in the editor does (course.json ignored, docs D31), or bring it back (ignored: false). Only when the author asked for it or agreed, after you told them what the warning says and why it may not apply (a quoted maxim whose negation is the author\'s, a dense screen that is a primary text to read): never to silence a finding yourself. It stays ignored until what it found changes (the text, the take), then comes back. Errors are never ignored; a client\'s exception to a pedagogical rule is a plan waiver, which the author decides with the client. Undo with elabora_undo.',
  inputSchema: objectSchema({ code: { type: 'string', pattern: '^[WI]_[A-Z0-9_]+$' }, key: { type: 'string', minLength: 1, maxLength: 300 }, ignored: { type: 'boolean', default: true } }, ['code', 'key']),
  handler: (args, { root, author }) => editResult(edit.ignoreFindings(root, { findings: [{ code: args.code, key: args.key }], ignored: args.ignored !== false }, { author }))
});

export const history = defineTool({
  name: 'elabora_history',
  readOnly: true,
  description: 'Recent changes grouped by batch, oldest first. A batch is one piece of AI work (labelled with the request that started it, when the app marked it) or one human change: its authors, change ids and sequence numbers, files, and whether it is undone. Undo a change or a batch with elabora_undo.',
  inputSchema: objectSchema({ limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Number of batches (default 20).' } }),
  handler: (args, { root }) => textResult(edit.historyBatches(root, args.limit ?? 20))
});

export const writePlan = defineTool({
  name: 'elabora_write_plan',
  description: 'Write the plan (plan.json, the working copy) at any time: the whole plan (plan) or a JSON Patch (RFC 6902) of it. Checked against the plan\'s schema before anything is written, refused with why. Before its first validation, draft it whole from what the author gave you (sources, objectives, the client\'s brief): the items grouped by part (items[].part), each objective with a short name of three to five words (objectives[].short), decided and question (D51). Once a version was validated, write the changes all the same and tell the author what you changed: the app marks them, and the author makes the next version and sends it. Refused when it would change a text kept « à l\'identique » (lockedTexts[].verbatim): ask the author. Rewording a validated text is writing it here: every block with its textRef follows. Items moved (a move, a part changed) take the screens that cover them along in the same change (moved says which).',
  inputSchema: objectSchema({ plan: { type: 'object', description: 'The whole plan.json (id, title, objectives, items…).' }, patch: { type: 'array', items: formatValue<PatchOperation>()({ type: 'object' }), minItems: 1, description: 'A JSON Patch of the plan as it is.' } }),
  handler: (args, { root, author }) => editResult(edit.writePlan(root, { ...(args.plan ? { plan: args.plan } : {}), ...(args.patch ? { patch: args.patch } : {}) }, { author }))
});

export const setPlanVoiceover = defineTool({
  name: 'elabora_set_plan_voiceover',
  description: 'The voice-over of a plan item (a storyboard\'s voice-over column), line by line, written in the plan. A screen that covers the item then takes it as its narration script (elabora narration from-plan). lines: [{ speaker, text }], speaker a course.json speaker id (default: the first); null removes the voice-over. It is translated with the plan, and not kept word for word in the module (the script can be reworded).',
  inputSchema: objectSchema({ item: { type: 'string', minLength: 1, description: 'A plan item id (ITEM-3).' }, lines: { type: ['array', 'null'], minItems: 1, maxItems: 60, items: { type: 'object', properties: { speaker: SLUG, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['text'], additionalProperties: false } } }, ['item', 'lines']),
  handler: (args, { root, author }) => editResult(edit.setPlanVoiceover(root, { item: args.item, lines: args.lines }, { author }))
});

export const exportPlanDocumentTool = defineTool({
  name: 'elabora_export_plan_document',
  description: 'Write the plan\'s document, what the client reads, comments and signs, to dist/<course>-plan.<format>: docx (Word, for clients who comment in Word: its headings, a bookmark per objective, item, text and question named after its id, the changes since the validated version as tracked changes, the author\'s notes as comments), pdf (the « Bon pour production » to attach to a purchase order; needs a Chromium: Elabora\'s or Google Chrome) or html (one page to read or print). It shows the latest version of the plan (version: V2, or current for the working copy; the working copy when there is no version) and records that it was sent; it never makes a version. For when the author asks to send the plan: when the plan changed since the latest version, say so to the author, who makes the next one first or sends this one. The document says the version\'s state and never who wrote it.',
  inputSchema: objectSchema({ format: { enum: ['docx', 'pdf', 'html'], description: 'docx, pdf or html.' }, version: { type: 'string', description: 'V2, or current (the working copy). Default: the latest version.' } }, ['format']),
  async handler(args, { root, author }) {
    const version = args.version === undefined || args.version === 'current' ? args.version : versionNumber(args.version);
    if (version === null) return errorResult(`"${args.version}" is not a version of the plan: V1, V2… or current.`);
    try {
      return textResult(await exportPlanDocument(root, { format: args.format, ...(version !== undefined ? { version } : {}), author }));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
});

export const undo = defineTool({
  name: 'elabora_undo',
  description: 'Undo the last change made through Elabora tools or by an agent; or one change (change: its id or seq from elabora_history or a write result; an undo too, which redoes it); or a batch of AI work (batch: its id, or true for the last one). What was edited since is kept and listed in skipped.',
  inputSchema: objectSchema({ change: { type: ['string', 'integer'], description: 'Id or seq of the change to undo.' }, batch: { type: ['string', 'boolean'], description: 'Id of the batch to undo, or true for the last batch of AI work.' } }),
  handler(args, { root, author }) {
    if (args.change !== undefined && args.batch !== undefined) return errorResult('Give change or batch, not both.');
    const result = args.batch !== undefined && args.batch !== false
      ? edit.undoBatch(root, args.batch === true ? undefined : args.batch, { author })
      : edit.undo(root, args.change === undefined ? undefined : changeSeq(root, String(args.change)), { author });
    return textResult({
      ok: true, undone: result.undone, ...('batch' in result ? { batch: result.batch } : {}), change: result.change, files: result.files,
      skipped: keptEdits(result.skipped), diagnostics: agentFindings(result.diagnostics)
    });
  }
});
