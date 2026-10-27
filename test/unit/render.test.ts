import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { loadProject } from '@elabora/core/project/load';
import { createProjectFiles, textFile } from '@elabora/core/project/files';
import type { Project, Screen, Block } from '@elabora/core/project/model';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { translatedCourse } from '@elabora/core/i18n/translate';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { RenderedScreen } from '@elabora/core/render/screen';
import { rebaseUrls } from '@elabora/core/render/styles';
import type { CourseData } from '@elabora/player/course-data';
import { ROOT } from '../helpers.ts';
import { build } from '@elabora/node/build';

const EXAMPLES = ['diagnostic-reseau', 'planetary-gearset', 'orbital-rendezvous', 'coffee-in-brief'];
const COURSE_FIELDS = ['format', 'id', 'title', 'language', 'version', 'ui', 'navigation', 'completion', 'tracking', 'tokens', 'presentation', 'fonts', 'backdrop', 'variables'] as const;

// A screen file of a project replaced in memory (an edit the engine would apply).
function withScreen(project: Project, id: string, edit: (screen: Screen) => void): Project {
  const file = `screens/${id}.json`;
  const screen = structuredClone(project.screens.get(id)!.data);
  edit(screen);
  const files = createProjectFiles([...project.files].map(([name, content]) => [name, name === file ? textFile(`${JSON.stringify(screen, null, 2)}\n`) : content] as const));
  return loadProject(files, { root: project.root });
}

const screenOf = (render: RenderedScreen) => render.course.screens[0];

test('renderScreen gives each screen as the course data holds it, with the course fields the player needs', () => {
  for (const example of EXAMPLES) {
    const project = loadProjectFromDir(path.join(ROOT, 'examples', example));
    const { keys } = assignKeys(project, readLock(project), { dryRun: true });
    const data: CourseData = compileCourseData(project, keys, { buildId: 'test' });
    const context = createRenderContext(project);
    for (const screen of data.screens) {
      const render = renderScreen(project, screen.id, {}, context);
      assert.equal(render.screen, screen.id);
      assert.deepEqual(render.course.screens, [screen], `${example}/${screen.id}`);
      for (const field of COURSE_FIELDS) assert.deepEqual(render.course[field], data[field], `${example}/${screen.id}: ${field}`);
      const section = data.sections.find((candidate) => candidate.id === screen.section);
      assert.deepEqual(render.course.sections, [{ ...section, screens: [screen.id] }]);
      // The free objects the screen places (and the backdrop's), as the course data defines them.
      for (const [id, definition] of Object.entries(render.course.objects)) assert.deepEqual(definition, data.objects[id], `${example}/${screen.id}: object ${id}`);
      const placed = JSON.stringify(screen).match(/"object":"[^"]+"/g)?.map((match) => match.slice(10, -1)) || [];
      for (const id of placed) assert.ok(render.course.objects[id], `${example}/${screen.id}: ${id} defined`);
      assert.deepEqual(render.view, { state: 'initial', step: null, layer: null });
      // Without a context, the same result.
      assert.deepEqual(renderScreen(project, screen.id), render);
    }
  }
  const project = loadProjectFromDir(path.join(ROOT, 'examples', 'planetary-gearset'));
  assert.deepEqual(renderScreen(project, 'lab', { state: 'answered', step: 2, layer: 'lab-debrief' }).view, { state: 'answered', step: 2, layer: 'lab-debrief' });
  assert.throws(() => renderScreen(project, 'nowhere'), /Screen "nowhere" not found/);
});

test('renderScreen: stylesheets and files match the build', async () => {
  for (const example of EXAMPLES) {
    const source = path.join(ROOT, 'examples', example);
    const built = await build(source, { emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-render-')), writeLock: false });
    assert.ok(built.ok && built.dirPath, example);
    const dirPath = built.dirPath;
    const packaged = (name: string) => fs.readFileSync(path.join(dirPath, name), 'utf8');
    const project = loadProjectFromDir(source);
    const context = createRenderContext(project);
    const render = renderScreen(project, project.course!.sections[0].screens[0], {}, context);
    const sheets = new Map(render.styles.sheets.map((sheet) => [sheet.id, sheet.css]));
    // elabora/theme.css: the layer order, one @import per stylesheet in its layer, the font faces.
    const theme = fs.existsSync(path.join(dirPath, 'elabora/theme.css')) ? packaged('elabora/theme.css') : '';
    const lines = theme.split('\n').filter(Boolean);
    const expected: string[] = [];
    for (const line of lines) {
      const imported = /^@import url\("\.\.\/([^"]+)"\) layer\(([a-z.]+)\);$/.exec(line);
      if (line.startsWith('@layer ')) { expected.push('layers'); assert.equal(sheets.get('layers'), line); }
      else if (imported) {
        expected.push(imported[1]);
        assert.equal(sheets.get(imported[1]), `@layer ${imported[2]} {\n${rebaseUrls(packaged(imported[1]), imported[1])}\n}`, `${example}: ${imported[1]}`);
      } else if (line.startsWith('@font-face')) {
        if (!expected.includes('fonts')) expected.push('fonts');
        assert.ok(sheets.get('fonts')?.split('\n').includes(line.replaceAll('url("../', 'url("')), `${example}: ${line}`);
      } else assert.fail(`${example}: unexpected line of theme.css: ${line}`);
    }
    // index.html: the token variables, unlayered, last.
    const root = /<style>(:root\{[^<]*\})<\/style>/.exec(packaged('index.html'))?.[1];
    assert.deepEqual([...sheets.keys()], [...expected, 'root'], example);
    assert.equal(sheets.get('root'), root, example);
    // The files the canvas asks for are those of the package (object code and frames generated).
    for (const id of project.course!.sections.flatMap((section) => section.screens)) {
      for (const file of renderScreen(project, id, {}, context).files) assert.ok(fs.existsSync(path.join(dirPath, file.path)), `${example}/${id}: ${file.path} (${file.kind})`);
    }
  }
});

test('renderScreen: url() of stylesheets are rebased on the package root, comments and strings kept', () => {
  const css = '/* url(a.png) */ .a { background: url(img/a.png?v=1#x); content: "url(b.png)"; } .b { mask: url("../assets/m.svg#m"), url(data:image/png;base64,AA), url(#f), url(/abs.png), url(https://x.test/y.png); } .c { background: url(../../out.png) }';
  assert.equal(rebaseUrls(css, 'theme/theme.css'),
    '/* url(a.png) */ .a { background: url("theme/img/a.png?v=1#x"); content: "url(b.png)"; } .b { mask: url("assets/m.svg#m"), url(data:image/png;base64,AA), url(#f), url(/abs.png), url(https://x.test/y.png); } .c { background: url(../../out.png) }');
});

test('renderScreen: a screen edited since the context was made renders as with a fresh context', () => {
  const project = loadProjectFromDir(path.join(ROOT, 'examples', 'planetary-gearset'));
  const context = createRenderContext(project);
  const fresh = (edited: Project, id: string) => renderScreen(edited, id, {}, createRenderContext(edited));
  const firstText = (screen: Screen): Block => screen.blocks.find((block) => block.type === 'text')!;
  const typed = withScreen(project, 'anatomy', (screen) => { firstText(screen).props.markdown = 'Typed **now**.'; });
  const render = renderScreen(typed, 'anatomy', {}, context);
  assert.match(JSON.stringify(screenOf(render)), /Typed <strong>now<\/strong>\./);
  assert.deepEqual(render, fresh(typed, 'anatomy'));
  // A new activity gets the key the next build would give it; existing keys stay.
  const keysBefore = new Set(Object.values(assignKeys(project, readLock(project), { dryRun: true }).keys));
  const quiz = withScreen(project, 'anatomy', (screen) => {
    screen.blocks.push({ id: 'anatomy-new-quiz', type: 'quiz', props: { stem: 'Which part turns?', options: [{ id: 'a', text: 'Sun', correct: true }, { id: 'b', text: 'Ring' }] } });
    screen.events = [...(screen.events || []), { id: 'anatomy-new-event', on: { type: 'quiz.submitted', target: 'anatomy-new-quiz' }, do: [{ type: 'show-block', block: 'anatomy-new-quiz' }] }];
  });
  const added = renderScreen(quiz, 'anatomy', {}, context);
  const block = screenOf(added).blocks.find((candidate) => candidate.id === 'anatomy-new-quiz');
  assert.ok(block && 'key' in block && block.key && !keysBefore.has(block.key), 'a provisional key');
  assert.ok(block.vkey && !keysBefore.has(block.vkey) && block.vkey !== block.key, 'a provisional visibility key');
  assert.deepEqual(added, fresh(quiz, 'anatomy'));
  // A component the course did not use yet brings its stylesheet.
  const card = withScreen(project, 'intro', (screen) => { screen.blocks = screen.blocks.filter((candidate) => candidate.type !== 'ratio-card'); });
  const without = createRenderContext(card);
  assert.ok(!without.design.components.includes('ratio-card'));
  const back = withScreen(card, 'intro', (screen) => { screen.blocks.push({ id: 'intro-card', type: 'ratio-card', props: { label: 'Reduce', value: '3.6', body: 'Ring held.' } }); });
  const styled = renderScreen(back, 'intro', {}, without);
  assert.ok(styled.styles.sheets.some((sheet) => sheet.id === 'components/ratio-card/component.css'));
  assert.notEqual(styled.styles.hash, without.styles.hash);
});

test('renderScreen in another language: the translation applied, the design kept', () => {
  const project = loadProjectFromDir(path.join(ROOT, 'examples', 'orbital-rendezvous'));
  const translated = translatedCourse(project, { to: 'fr', allowMissing: true }).files;
  const context = createRenderContext(project, { language: 'fr' });
  for (const id of project.course!.sections.flatMap((section) => section.screens)) {
    const render = renderScreen(project, id, { language: 'fr' }, context);
    assert.equal(render.course.language, 'fr');
    const screen = translated.get(`screens/${id}.json`);
    if (screen && 'title' in screen) assert.equal(screenOf(render).title, screen.title, id);
    assert.deepEqual(render.styles, renderScreen(project, id).styles, `${id}: same design`);
  }
  assert.notEqual(renderScreen(project, 'intro', { language: 'fr' }).course.screens[0].title, renderScreen(project, 'intro').course.screens[0].title);
});
