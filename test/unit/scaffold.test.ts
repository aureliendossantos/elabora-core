import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '@elabora/node/scaffold';
import { createProject } from '@elabora/node/library/index';
import { validateDir } from '@elabora/node/project-reader';
import { agentRulesState } from '@elabora/node/agent-rules';
import { readJSON } from '../helpers.ts';

// A new course starts with texts to replace, written in the course language.

delete process.env.ELABORA_DATA_DIR;
const temporary: string[] = [];
after(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-scaffold-'));
  temporary.push(dir);
  return dir;
};

// Every text of the new course a person reads: section and plan titles, the objective, the intro.
function starterTexts(dir: string): string[] {
  const course = readJSON(dir, 'course.json');
  const plan = readJSON(dir, 'plan.json');
  const intro = readJSON(dir, 'screens/intro.json');
  return [
    ...course.sections.map((section: { title: string }) => section.title),
    ...plan.objectives.map((objective: { statement: string }) => objective.statement),
    ...plan.items.map((item: { title: string }) => item.title),
    ...intro.blocks.map((block: { props: { markdown: string } }) => block.props.markdown)
  ];
}

test('scaffold: the texts to replace follow the course language', () => {
  const french = initProject(tempDir(), { id: 'premiers-secours', title: 'Premiers secours', language: 'fr' }).dir;
  const texts = starterTexts(french);
  assert.ok(texts.some((text) => text.startsWith('À remplacer par')), texts.join(' | '));
  assert.ok(texts.every((text) => !/Replace with|__[A-Z_]+__/.test(text)), texts.join(' | '));
  assert.equal(readJSON(french, 'screens/intro.json').blocks[0].props.markdown, 'À remplacer par l\'introduction validée dans le storyboard.');

  const english = initProject(tempDir(), { id: 'first-aid', title: 'First aid', language: 'en' }).dir;
  assert.equal(readJSON(english, 'screens/intro.json').blocks[0].props.markdown, 'Replace with the introduction validated in the storyboard.');
  assert.ok(starterTexts(english).every((text) => !/À remplacer|__[A-Z_]+__/.test(text)));

  // A regional variant takes its language's texts; a language without them gets English.
  assert.deepEqual(starterTexts(initProject(tempDir(), { id: 'quebec', title: 'Québec', language: 'fr-CA' }).dir), texts);
  assert.deepEqual(starterTexts(initProject(tempDir(), { id: 'erste-hilfe', title: 'Erste Hilfe', language: 'de' }).dir), starterTexts(english));
  // The default language is French.
  assert.deepEqual(starterTexts(initProject(tempDir(), { id: 'defaut', title: 'Défaut' }).dir), texts);

  // The same findings whatever the language (the practice item waits for its screen).
  const findings = (dir: string) => validateDir(dir).diagnostics.map((d) => `${d.code} ${d.file}`);
  assert.deepEqual(findings(french), findings(english));
  assert.ok(findings(french).includes('E_PLAN_ITEM_UNCOVERED plan.json'));
});

test('scaffold: a course created in the library in French starts with French texts', async () => {
  process.env.ELABORA_LIBRARY = path.join(tempDir(), 'Library');
  const project = await createProject({ id: 'gestes', title: 'Gestes « qui sauvent »', language: 'fr' });
  const texts = starterTexts(project.path);
  assert.ok(texts.every((text) => !/Replace with/.test(text)), texts.join(' | '));
  assert.equal(readJSON(project.path, 'plan.json').objectives[0].statement, 'À remplacer par un comportement observable : verbe d\'action, condition, critère.');
  assert.equal(readJSON(project.path, 'course.json').title, 'Gestes « qui sauvent »');
});

test('scaffold: AGENTS.md says where the Elabora app carries the command line when elabora is not in the PATH', () => {
  const agents = fs.readFileSync(path.join(initProject(tempDir(), { id: 'cli', title: 'Command line' }).dir, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('/Applications/Elabora.app/Contents/Resources/bin/elabora'), 'macOS');
  assert.ok(agents.includes('%LOCALAPPDATA%\\Programs\\elabora\\resources\\bin\\elabora.cmd'), 'Windows');
});

test('scaffold: what the author said as they created the course goes into the plan, course.json and the notes of AGENTS.md (D51)', async () => {
  const notes = 'Choix de l\'auteur à la création :\n- Ton : direct, au vouvoiement.\n- Laissé à l\'IA : la 3D, les quiz.';
  const dir = initProject(tempDir(), { id: 'incident', title: 'Nouveau module', language: 'fr', brief: {
    audience: '  Techniciens support, niveau 1 ', businessGoal: 'Moins de tickets transférés au niveau 2', duration: { min: 10, max: 20 },
    presentation: 'slides', lms: ['moodle', 'moodle'], notes
  } }).dir;
  const plan = readJSON(dir, 'plan.json');
  assert.equal(plan.audience.role, 'Techniciens support, niveau 1');
  assert.equal(plan.audience.priorKnowledge, 'low', 'the template\'s other fields are kept');
  assert.equal(plan.businessGoal, 'Moins de tickets transférés au niveau 2');
  assert.deepEqual(plan.duration, { min: 10, max: 20 });
  assert.equal(plan.status, undefined, 'the plan\'s state is its versions\', and it has none');
  const course = readJSON(dir, 'course.json');
  assert.deepEqual(course.presentation, { mode: 'slides' });
  assert.deepEqual(course.delivery, { lms: ['moodle'] });
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(agents.endsWith(`-->\n\n${notes}\n`), agents.slice(-300));
  // The notes are the author's: the rules above them are still Elabora's, current and unedited.
  assert.equal(agentRulesState(agents).status, 'current');
  // Nothing new for the validator: the plan is a draft with its audience and goal.
  const findings = validateDir(dir).diagnostics.map((d) => d.code);
  assert.ok(!findings.includes('W_BUSINESS_GOAL_MISSING') && !findings.some((code) => code.startsWith('E_SCHEMA')), findings.join(' '));

  // A title with a backslash or a quote stays a JSON string.
  const quoted = initProject(tempDir(), { id: 'quoted', title: 'C:\\Formations « "Sécurité" »', brief: { audience: 'Tous' } }).dir;
  assert.equal(readJSON(quoted, 'course.json').title, 'C:\\Formations « "Sécurité" »');
  assert.equal(readJSON(quoted, 'plan.json').title, 'C:\\Formations « "Sécurité" »');
  // A floor alone, and nothing written when the brief is refused.
  assert.deepEqual(readJSON(initProject(tempDir(), { id: 'long', title: 'Long', brief: { duration: { min: 30 } } }).dir, 'plan.json').duration, { min: 30 });
  for (const [brief, words] of [
    [{ duration: { min: 20, max: 10 } }, /brief\.duration/],
    [{ duration: {} }, /brief\.duration/],
    [{ duration: { min: 2.5 } }, /brief\.duration/],
    [{ lms: ['blackboard'] }, /Unknown LMS profile "blackboard"/],
    [{ audience: 'x'.repeat(201) }, /brief\.audience/],
    [{ presentation: 'pages' as 'slides' }, /brief\.presentation/]
  ] as const) {
    const target = path.join(tempDir(), 'course');
    assert.throws(() => initProject(target, { id: 'refuse', title: 'Refusé', brief }), words);
    assert.equal(fs.existsSync(target), false);
  }

  // Through the library as through elabora init.
  process.env.ELABORA_LIBRARY = path.join(tempDir(), 'Library');
  const project = await createProject({ id: 'incident', title: 'Nouveau module', language: 'fr', brief: { audience: 'Techniciens', notes: '- Ton : chaleureux.' } });
  assert.equal(readJSON(project.path, 'plan.json').audience.role, 'Techniciens');
  assert.ok(fs.readFileSync(path.join(project.path, 'AGENTS.md'), 'utf8').endsWith('\n- Ton : chaleureux.\n'));
  // Without a brief, the course is as before.
  const plain = initProject(tempDir(), { id: 'plain', title: 'Plain' }).dir;
  assert.equal(readJSON(plain, 'plan.json').duration, undefined);
  assert.equal(readJSON(plain, 'course.json').presentation, undefined);
  assert.equal(agentRulesState(fs.readFileSync(path.join(plain, 'AGENTS.md'), 'utf8')).status, 'current');
});
