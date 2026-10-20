import { loadProjectFromDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { defineTool, editResult, errorResult, imageResult, objectSchema, textResult, PLAN_ID, SLUG } from './tool.ts';

// Free objects: reading, scaffolding, writing their files and running their gates.

export const getObject = defineTool({
  name: 'elabora_get_object',
  readOnly: true,
  description: 'A free object: manifest, tests, notes and code.',
  inputSchema: objectSchema({ id: SLUG }, ['id']),
  handler({ id }, { root }) {
    const object = loadProjectFromDir(root).objects.get(id);
    if (!object) return errorResult(`No free object "${id}"`);
    return textResult({ manifest: object.manifest, tests: object.tests, notes: object.notes, code: object.code });
  }
});

export const createObject = defineTool({
  name: 'elabora_create_object',
  description: 'Scaffold a free object (objects/<id>/: manifest, code, tests, notes) serving given plan objectives. Only when no native block can do the job.',
  inputSchema: objectSchema({ id: SLUG, title: { type: 'string' }, objectives: { type: 'array', items: PLAN_ID, minItems: 1 }, items: { type: 'array', items: PLAN_ID } }, ['id', 'title', 'objectives']),
  handler: (args, { root, author }) => editResult(edit.createObject(root, args, { author }))
});

export const writeObjectFile = defineTool({
  name: 'elabora_write_object_file',
  description: 'Write one file of a free object: object.manifest.json, object.js, object.tests.json or object.notes.md. Then run elabora_test_object.',
  inputSchema: objectSchema({ object: SLUG, file: { enum: ['object.manifest.json', 'object.js', 'object.tests.json', 'object.notes.md'] }, content: { type: 'string' } }, ['object', 'file', 'content']),
  handler: (args, { root, author }) => editResult(edit.writeObjectFile(root, args, { author }))
});

export const replayObject = defineTool({
  name: 'elabora_replay_object',
  readOnly: true,
  description: 'Replay one behaviour test of a free object (object.tests.json) inside the built course: on the page that places it, scrolled into view, in real time, with the course around it. Returns a contact sheet of its snapshot steps and the end, and the expectations that failed. To see how the object looks and behaves where learners meet it; the gates stay elabora_test_object.',
  inputSchema: objectSchema({ id: SLUG, test: { type: 'string', description: 'A test whose name contains this text (default: the first one).' }, block: { ...SLUG, description: 'The free-object block to use when several place the object.' }, width: { type: 'integer', minimum: 320, maximum: 2560, default: 1600 }, height: { type: 'integer', minimum: 400, maximum: 2000, default: 900 } }, ['id']),
  async handler(args, { root }) {
    const { replayObject: replay } = await import('@elabora/node/preview');
    const result = await replay(root, args.id, { test: args.test, block: args.block, width: args.width || 1600, height: args.height || 900 });
    if (result.error !== undefined) return errorResult({ error: result.error, diagnostics: result.diagnostics?.filter((d) => d.severity === 'error') });
    const note = `"${result.test}" replayed on ${result.screen} (${result.block}), ${result.frames.length} frame(s): ${result.failures.length ? `failed expectations: ${result.failures.join(' | ')}` : 'every expectation held'}.${result.skipped.length ? ` Skipped: ${result.skipped.join(' | ')}.` : ''}${result.consoleErrors.length ? ` Console errors: ${result.consoleErrors.join(' | ')}` : ''}`;
    return imageResult(result.png, note);
  }
});

export const testObject = defineTool({
  name: 'elabora_test_object',
  description: 'Run the automated gates of a free object in a browser: smoke, behaviour tests, budgets, visual snapshots, accessibility. Slow (tens of seconds). A full run is recorded in object.gates.json for the proof dossier.',
  inputSchema: objectSchema({ id: SLUG, updateSnapshots: { type: 'boolean', description: 'Accept new visual baselines (only when the visual change is intended).' }, only: { type: 'string', description: 'Run only the behaviour tests whose name contains this text (not recorded).' } }, ['id']),
  async handler(args, { root }) {
    const objectTests = await import('@elabora/node/objects/test');
    const result = await objectTests.testObject(root, args.id, { updateSnapshots: !!args.updateSnapshots, only: args.only || null });
    return textResult({ ok: result.ok, browser: result.browser, gates: result.gates, diagnostics: result.diagnostics });
  }
});
