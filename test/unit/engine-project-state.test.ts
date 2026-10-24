import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectState } from '@elabora/engine';
import { readProjectFiles } from '@elabora/node/project-reader';
import { loadProject } from '@elabora/core/project/load';
import { textFile, binaryFile } from '@elabora/core/project/files';
import type { SourceFile } from '@elabora/core/project/files';
import { validateProject } from '@elabora/core/validate/index';
import type { Diagnostic } from '@elabora/core/diagnostics/index';
import path from 'node:path';
import { EXAMPLE, ROOT } from '../helpers.ts';

// The project and findings a session keeps up to date change by change must be those of loading and
// validating the same files from scratch, whatever the order of the edits.

const json = (value: unknown) => textFile(`${JSON.stringify(value, null, 2)}\n`);
const key = (d: Diagnostic) => JSON.stringify([d.code, d.severity, d.file ?? '', d.path ?? '', d.target ?? '', d.message]);

function assertSame(state: ProjectState, step: string): string[] {
  const fresh = loadProject(state.files, { root: state.root });
  assert.deepEqual([...state.project.screens.keys()], [...fresh.screens.keys()], `${step}: screens in file order`);
  for (const [id, entry] of fresh.screens) assert.deepEqual(state.project.screens.get(id), entry, `${step}: screen ${id}`);
  assert.deepEqual(state.project.loadErrors.map((error) => JSON.stringify(error)).sort(), fresh.loadErrors.map((error) => JSON.stringify(error)).sort(), `${step}: load errors`);
  state.validate();
  const { screens, project } = state.diagnostics();
  const kept = [...project, ...[...screens.values()].flat()].map(key).sort();
  const result = validateProject(fresh).diagnostics;
  const expected = result.map(key).sort();
  assert.deepEqual(kept, expected, `${step}: findings`);
  return result.filter((d) => !d.waived).map((d) => d.code);
}

test('the project and findings kept incrementally equal a full load and validation', () => {
  const { files, artefacts } = readProjectFiles(EXAMPLE);
  const state = new ProjectState(EXAMPLE, files, artefacts);
  const screen = (id: string) => structuredClone(state.project.screens.get(id)?.data) as unknown as Record<string, any>;
  const update = (entries: [string, SourceFile | null][], step: string, expect: string[] = [], gone: string[] = []) => {
    state.update(entries);
    const codes = assertSame(state, step);
    for (const code of expect) assert.ok(codes.includes(code), `${step}: ${code} expected in ${codes.join(', ')}`);
    for (const code of gone) assert.ok(!codes.includes(code), `${step}: ${code} not expected`);
  };
  assertSame(state, 'open');

  const chemin = screen('chemin');
  chemin.blocks.push({ id: 'accueil-situation', type: 'text', props: { markdown: 'Même id qu\'un bloc de l\'accueil' } });
  update([['screens/chemin.json', json(chemin)]], 'a block id of another screen', ['E_DUPLICATE_ID']);

  const accueil = screen('accueil');
  accueil.blocks.push({ id: 'accueil-schema', type: 'image', props: { asset: 'images/nouveau.svg', alt: 'Nouveau schéma' } });
  update([['screens/accueil.json', json(accueil)]], 'an asset that does not exist yet', ['E_ASSET_MISSING']);
  update([['assets/images/nouveau.svg', textFile('<svg xmlns="http://www.w3.org/2000/svg"/>')]], 'the asset added', [], ['E_ASSET_MISSING']);

  const reflexe = screen('premier-reflexe');
  reflexe.events = [...(reflexe.events ?? []), { id: 'vu-accueil', on: { type: 'screen.enter' }, if: [{ visited: 'accueil-objectifs' }], do: [{ type: 'complete-screen' }] }];
  update([['screens/premier-reflexe.json', json(reflexe)]], 'a visited condition on a block of another screen');
  const accueilAgain = screen('accueil');
  accueilAgain.blocks = accueilAgain.blocks.filter((block: { id: string }) => block.id !== 'accueil-objectifs');
  update([['screens/accueil.json', json(accueilAgain)]], 'the block it names removed', ['E_UNKNOWN_REFERENCE']);

  update([['screens/extra.json', json({ id: 'extra', title: 'Hors plan', covers: ['ITEM-1'], blocks: [] })]], 'a screen file no section lists');
  update([['screens/bilan.json', null]], 'a listed screen file deleted');
  update([['screens/extra.json', textFile('{ "id": "extra", ')]], 'a screen file that does not parse', ['E_JSON_PARSE']);
  update([['assets/data.bin', binaryFile(3, { hash: 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' })], ['screens/extra.json', null]], 'a binary file, a screen removed');

  const course = JSON.parse((state.files.get('course.json') as { text: string }).text);
  course.sections[0].screens.push('extra-listed');
  update([['course.json', json(course)], ['screens/extra-listed.json', json({ id: 'extra-listed', title: 'Listée', covers: ['ITEM-1'], blocks: [] })]], 'course.json and a screen together');
  const components = structuredClone(state.project.components);
  update([['screens/chemin.json', json(screen('chemin'))]], 'a screen saved again');
  assert.deepEqual(state.project.components, components);
});

test('the same on a course with components, free objects and generators', () => {
  const { files, artefacts } = readProjectFiles(path.join(ROOT, 'examples/planetary-gearset'));
  const state = new ProjectState('planetary', files, artefacts);
  assertSame(state, 'open');
  const ids = [...state.project.screens.keys()];
  const data = (id: string) => structuredClone(state.project.screens.get(id)?.data) as unknown as Record<string, any>;
  // Every screen edited in turn: a title, then a block of the next screen copied in (a duplicate id).
  ids.forEach((id, index) => {
    const screen = data(id);
    screen.title = `${screen.title} (revu)`;
    const other = data(ids[(index + 1) % ids.length]);
    if (other.blocks?.length) screen.blocks = [...(screen.blocks ?? []), structuredClone(other.blocks[0])];
    state.update([[`screens/${id}.json`, json(screen)]]);
    assertSame(state, `screen ${id}`);
  });
  // Then copies removed again, two screens at once.
  state.update(ids.slice(0, 2).map((id) => [`screens/${id}.json`, json({ ...data(id), blocks: data(id).blocks.slice(0, -1) })] as [string, SourceFile]));
  assertSame(state, 'two screens');
});
