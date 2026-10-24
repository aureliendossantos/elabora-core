import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readProjectFiles } from '@elabora/node/project-reader';
import type { SourceFile } from '@elabora/core/project/files';
import { textFile } from '@elabora/core/project/files';
import { loadProject } from '@elabora/core/project/load';
import type { Project } from '@elabora/core/project/model';
import { validateProject, validateScreen, validateProjectChecks, createValidationContext } from '@elabora/core/validate/index';
import { readLock, assignKeys, buildStateModel, syncComponentVersions } from '@elabora/core/compile/state-model';
import { compileCourseData, compileScreen, createCompileContext } from '@elabora/core/compile/course-data';
import { scorm12Manifest } from '@elabora/core/compile/scorm12-manifest';
import { projectMarkdown } from '@elabora/core/project/markdown';
import { extractUnits } from '@elabora/core/i18n/units';
import { translationStatus } from '@elabora/core/i18n/translate';
import { lessonMdExport } from '@elabora/core/interop/lesson-md';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { RenderContext } from '@elabora/core/render/screen';
import type { Diagnostic } from '@elabora/core/diagnostics/index';
import { ROOT } from '../helpers.ts';
import { seededRandom, mutate } from '../mutations.ts';
import { resources } from '../resources.ts';

// Agents write broken JSON and the engine loads files being written: loading, validating, compiling
// and the other readers of a project never throw on a project that parses but breaks its schema;
// the validator reports it. Each mutation is checked against every entry point.
const MUTATIONS = 250;
const SEED = 20261006;

const findings = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => JSON.stringify(d)).sort();

// shared: the render context of the project before the mutation (the engine keeps it while a
// screen is edited; the mutation may have broken any file since).
function readEverything(project: Project, shared: RenderContext): void {
  const options = { profiles: ['moodle', 'successfactors'] };
  const full = validateProject(project, options).diagnostics;
  // The project checks and the checks of every screen give the findings of the whole validation.
  const context = createValidationContext(project, options);
  const parts = [...validateProjectChecks(context), ...[...project.screens.keys()].flatMap((id) => validateScreen(context, id))];
  assert.deepEqual(findings(parts), findings(full), 'validateProjectChecks + validateScreen = validateProject');

  const lock = readLock(project);
  const { keys } = assignKeys(project, lock, { dryRun: true });
  buildStateModel(project, keys);
  syncComponentVersions(project, structuredClone(lock));
  if (project.course) {
    compileCourseData(project, keys, { buildId: 'test' });
    const compileContext = createCompileContext(project, keys);
    for (const id of project.screens.keys()) compileScreen(project, id, compileContext);
    scorm12Manifest(project.course, ['index.html']);
    const renderContext = createRenderContext(project);
    for (const id of project.screens.keys()) {
      renderScreen(project, id, {}, renderContext);
      renderScreen(project, id, { state: 'answered', step: 1, layer: 'none' }, shared);
    }
  }
  projectMarkdown(project, { audience: 'agent' });
  projectMarkdown(project, { audience: 'client' });
  extractUnits(project);
  translationStatus(project);
  lessonMdExport(project);
}

test('every reader of a project survives documents that break their schema', (t) => {
  const { copyExample } = resources(t);
  const samples = ['diagnostic-reseau', 'planetary-gearset', 'orbital-rendezvous'].map((name) => readProjectFiles(copyExample(path.join(ROOT, 'examples', name))));
  const contexts = samples.map((sample) => createRenderContext(loadProject(sample.files, { root: sample.root, artefacts: sample.artefacts })));
  const random = seededRandom(SEED);
  for (let i = 0; i < MUTATIONS; i++) {
    const sample = samples[i % samples.length];
    const shared = contexts[i % samples.length];
    const files = new Map<string, SourceFile>(sample.files);
    const log = mutate(files, random);
    try {
      readEverything(loadProject(files, { root: sample.root, artefacts: sample.artefacts }), shared);
    } catch (error) {
      assert.fail(`seed ${SEED}, mutation ${i} of ${path.basename(sample.root)} (${log.join('; ')}): ${error instanceof Error ? error.stack : String(error)}`);
    }
  }
});

test('a sidecar whose words are not a list (or hold a word that is not one) is read as untimed, never thrown on', (t) => {
  const { copyExample } = resources(t);
  const sample = readProjectFiles(copyExample(path.join(ROOT, 'examples', 'diagnostic-reseau')));
  const files = new Map<string, SourceFile>(sample.files);
  const broken = (rel: string, words: unknown) => {
    const file = files.get(rel);
    assert.ok(file?.kind === 'text', rel);
    files.set(rel, textFile(JSON.stringify({ ...JSON.parse(file.text), words })));
  };
  broken('assets/narration/fr/premier-reflexe/marc-intranet.json', 'not words');
  broken('assets/narration/fr/accueil/marc-appel.json', [null, { text: 'Bonjour', start: 0, end: 0.4, score: 0.1 }]);
  const project = loadProject(files, { root: sample.root, artefacts: sample.artefacts });
  const result = validateProject(project);
  assert.ok(!result.diagnostics.some((d: Diagnostic) => d.code === 'E_INTERNAL'), JSON.stringify(result.diagnostics.filter((d: Diagnostic) => d.severity === 'error')));
});
