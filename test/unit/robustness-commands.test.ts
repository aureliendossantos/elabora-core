import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readProjectFiles } from '@elabora/node/project-reader';
import type { ProjectFiles, SourceFile } from '@elabora/core/project/files';
import { loadProject, screenBlocks } from '@elabora/core/project/load';
import * as commands from '@elabora/core/commands/index';
import type { CommandContext, CommandOutput, ObjectTemplates } from '@elabora/core/commands/index';
import { applyOps, invertOps, diffFiles, OpError } from '@elabora/core/ops/index';
import type { Files } from '@elabora/core/ops/index';
import { ROOT, copyExample } from '../helpers.ts';
import { seededRandom, mutate } from '../mutations.ts';
import type { Random } from '../mutations.ts';

// Commands run on projects agents have broken: each one does its work or refuses (CommandError, or
// OpError when its operations do not apply), never anything else. The operations between a project
// and its broken version apply and invert.
const MUTATIONS = 240;
const SEED = 20261007;
const NOW = new Date('2026-10-07T12:00:00Z');

// Two snapshots hold the same documents (JSON compared parsed: operations rewrite its formatting).
function sameFiles(a: Files, b: Files): boolean {
  if (a.size !== b.size) return false;
  for (const [file, x] of a) {
    const y = b.get(file);
    if (!y || x.kind !== y.kind) return false;
    if (x.kind === 'text' && y.kind === 'text' && x.text !== y.text) {
      try { if (JSON.stringify(JSON.parse(x.text)) !== JSON.stringify(JSON.parse(y.text))) return false; } catch { return false; }
    }
  }
  return true;
}

// What an agent would name: the ids of the project before it was broken.
function idsOf(files: ProjectFiles) {
  const project = loadProject(files);
  const blocks: string[] = [];
  const instances: string[] = [];
  const layers: [string, string][] = [];
  const events: [string, string][] = [];
  for (const [screen, { data }] of project.screens) {
    for (const layer of data.layers ?? []) layers.push([screen, layer.id]);
    for (const event of data.events ?? []) events.push([screen, event.id]);
    for (const { block } of screenBlocks(data)) {
      blocks.push(block.id);
      if (project.components.has(block.type)) instances.push(block.id);
    }
  }
  return {
    screens: [...project.screens.keys()], blocks, instances, layers, events, components: [...project.components.keys()], objects: [...project.objects.keys()],
    sections: (project.course?.sections ?? []).map((section) => section.id), items: (project.plan?.items ?? []).map((item) => item.id),
    texts: (project.plan?.items ?? []).flatMap((entry) => entry?.lockedTexts ?? []).map((text) => text?.id)
  };
}

type Run = (context: CommandContext) => CommandOutput<unknown> | unknown;

function commandsFor(files: ProjectFiles, random: Random, templates: ObjectTemplates): [string, Run][] {
  const ids = idsOf(files);
  const pick = <T>(list: readonly T[], fallback: T): T => (list.length ? list[Math.floor(random() * list.length)] : fallback);
  const screen = pick(ids.screens, 'none'), other = pick(ids.screens, 'none'), block = pick(ids.blocks, 'none'), section = pick(ids.sections, 'none');
  const instance = pick(ids.instances, block), item = pick(ids.items, 'none'), lockedText = pick(ids.texts, 'TXT-1');
  const component = pick(ids.components, 'quiz'), object = pick(ids.objects, 'none');
  const [layerScreen, layer] = pick(ids.layers, [screen, 'none']);
  const [eventScreen, event] = pick(ids.events, [screen, 'none']);
  const text = { id: 'new-block', type: 'text', props: { markdown: 'New' } };
  const library = { library: 'lib', component, files: new Map([...files].filter(([file]) => file.startsWith(`components/${component}/`)).map(([file, content]) => [file.slice(`components/${component}/`.length), content])) };
  return [
    ['create_screen', (c) => commands.createScreen(c, { id: 'new-screen', title: 'New', covers: [item], section, after: other })],
    ['update_screen', (c) => commands.updateScreen(c, { id: screen, title: 'Renamed', layout: null })],
    ['delete_screen', (c) => commands.deleteScreen(c, { id: screen })],
    ['move_screen', (c) => commands.moveScreen(c, { id: screen, section })],
    ['move_screen after', (c) => commands.moveScreen(c, { id: screen, after: other })],
    ['add_block', (c) => commands.addBlock(c, { screen, block: text, after: block })],
    ['add_block layer', (c) => commands.addBlock(c, { screen: layerScreen, layer, block: text })],
    ['add_block parent', (c) => commands.addBlock(c, { screen, parent: instance, block: text })],
    ['update_block', (c) => commands.updateBlock(c, { block, props: { markdown: 'Changed', title: null }, hidden: true, slot: null })],
    ['remove_block', (c) => commands.removeBlock(c, { block })],
    ['move_block', (c) => commands.moveBlock(c, { block, position: 0 })],
    ['move_block screen', (c) => commands.moveBlock(c, { block, screen: other })],
    ['move_block layer', (c) => commands.moveBlock(c, { block, screen: layerScreen, layer })],
    ['move_block parent', (c) => commands.moveBlock(c, { block, parent: instance, slot: 'body' })],
    ['duplicate_block', (c) => commands.duplicateBlock(c, { block })],
    ['duplicate_block screen', (c) => commands.duplicateBlock(c, { block, screen: other, position: 1 })],
    ['detach_block', (c) => commands.detachBlock(c, { block: instance })],
    ['upsert_layer', (c) => commands.upsertLayer(c, { screen, layer: { id: layer, title: 'Layer', blocks: [] } })],
    ['remove_layer', (c) => commands.removeLayer(c, { screen: layerScreen, id: layer })],
    ['upsert_event', (c) => commands.upsertEvent(c, { screen: eventScreen, event: { id: event, on: { type: 'screen.enter' }, do: [] } })],
    ['remove_event', (c) => commands.removeEvent(c, { screen: eventScreen, id: event })],
    ['upsert_variable', (c) => commands.upsertVariable(c, { variable: { id: 'seen', type: 'boolean', default: false } })],
    ['update_course', (c) => commands.updateCourseSettings(c, { title: 'Title', navigation: { mode: 'free' } })],
    ['write_plan', (c) => commands.writePlan(c, { patch: [{ op: 'replace', path: '/title', value: 'New title' }] })],
    ['set_plan_text', (c) => commands.setPlanText(c, { text: lockedText, markdown: 'New words.' })],
    ['set_plan_text block', (c) => commands.setPlanText(c, { block, markdown: 'New words.' })],
    ['revert_plan_change', (c) => commands.revertPlanChange(c, { key: `item:${item}` })],
    ['set_plan_note', (c) => commands.setPlanNote(c, { target: `item:${item}`, text: 'Why' })],
    ['create_plan_version', (c) => commands.createPlanVersion(c, { note: 'Sent' })],
    ['approve_plan', (c) => commands.approvePlan(c, { by: 'Reviewer', date: '2026-10-07' })],
    ['record_plan_send', (c) => commands.recordPlanSend(c, { version: 'V1', format: 'docx' })],
    ['create_component', (c) => commands.createComponent(c, { id: 'new-card' })],
    ['fork_component', (c) => commands.forkComponent(c, { component, id: 'new-fork', copyCss: true })],
    ['write_component_file', (c) => commands.writeComponentFile(c, { component, file: 'template.html', content: '<div></div>' })],
    ['migration plans', (c) => commands.migrationPlans(c.project())],
    ['migrate_components', (c) => commands.migrateComponents(c, { component, from: '0.0.1' }, new Map([[component, { '1.0.0': (props) => props }]]))],
    ['add library component', (c) => commands.addLibraryComponent(c, { component, upgrade: true, force: true }, library)],
    ['publish component', (c) => commands.publishComponent(c, { component, library: 'lib' })],
    ['create_object', (c) => commands.createObject(c, { id: 'new-object', title: 'Object' }, templates)],
    ['write_object_file', (c) => commands.writeObjectFile(c, { object, file: 'object.js', content: 'export function mount() {}\n' })],
    ['write_object_file manifest', (c) => { const manifest = c.files.get(`objects/${object}/object.manifest.json`); return commands.writeObjectFile(c, { object, file: 'object.manifest.json', content: manifest?.kind === 'text' ? manifest.text : '{}' }); }],
    ['write_design_file', (c) => commands.writeDesignFile(c, { file: 'theme/extra.css', content: 'a { color: var(--t-primary); }\n' })],
    ...(['block', 'screen', 'layer', 'event', 'section'] as const).map((kind): [string, Run] => [`rename ${kind}`, (c) => commands.renameId(c, { from: { block, screen, layer, event, section }[kind], to: `renamed-${kind}` })]),
    ['schema problems', (c) => commands.schemaProblems(c.files, [...c.files.keys()])]
  ];
}

// Runs a command and applies what it returns: its operations, or the operations between the files
// before and after it.
function runCommand(files: ProjectFiles, run: Run): void {
  const output = run(commands.commandContext(files, { root: '/course', now: NOW }));
  if (!output || typeof output !== 'object') return;
  if ('ops' in output && Array.isArray(output.ops)) applyOps(files, output.ops);
  if ('files' in output && output.files instanceof Map) {
    const after: ProjectFiles = output.files;
    assert.ok(sameFiles(applyOps(files, diffFiles(files, after)), after), 'the operations of a command give its files');
  }
}

test('commands refuse to edit what agents broke, never throw anything else', () => {
  const samples = ['diagnostic-reseau', 'planetary-gearset', 'orbital-rendezvous'].map((name) => readProjectFiles(copyExample(path.join(ROOT, 'examples', name))));
  const templateDir = path.join(ROOT, 'packages/node/templates/object');
  const templates: ObjectTemplates = Object.fromEntries(commands.OBJECT_FILES.map((file) => [file, fs.readFileSync(path.join(templateDir, file), 'utf8')])) as Record<commands.ObjectFile, string>;
  const random = seededRandom(SEED);
  let refused = 0;
  for (let i = 0; i < MUTATIONS; i++) {
    const sample = samples[i % samples.length];
    const files = new Map<string, SourceFile>(sample.files);
    const log = mutate(files, random);
    const where = `mutation ${i} of ${path.basename(sample.root)} (${log.join('; ')})`;
    // The broken files as operations on the project, and back.
    const ops = diffFiles(sample.files, files);
    assert.ok(sameFiles(applyOps(sample.files, ops), files), `${where}: diffFiles then applyOps`);
    assert.ok(sameFiles(applyOps(files, invertOps(sample.files, ops)), sample.files), `${where}: invertOps`);
    for (const [name, run] of commandsFor(sample.files, random, templates)) {
      try {
        runCommand(files, run);
      } catch (error) {
        if (error instanceof commands.CommandError || error instanceof OpError) { refused++; continue; }
        assert.fail(`${name} on ${where}: ${error instanceof Error ? error.stack : String(error)}`);
      }
    }
  }
  assert.ok(refused > 0, 'some commands refuse broken projects');
});
