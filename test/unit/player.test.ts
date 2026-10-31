import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, copyExample as copyCourse, readJSON, writeJSON, codes } from '../helpers.ts';
import * as edit from '@elabora/node/edit';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { renderMarkdown } from '@elabora/core/compile/markdown';
import { extractUnits } from '@elabora/core/i18n/units';
import { DEFAULT_PLAYER, SPEEDS, playerConfig } from '@elabora/core/player/config';
import { playerReport } from '../../packages/cli/src/mcp/player-tools.ts';
import type { CourseData, PlayerBarData } from '@elabora/player/course-data';

// The learner's player (docs/decisions/D58.md): course.json player, its items and what they show.

// The sample has a logo, resources, a glossary and credits (the test fixture has none).
const copyExample = () => copyCourse(path.join(ROOT, 'examples/diagnostic-reseau'));

const compiled = (dir: string, options: Partial<Parameters<typeof compileCourseData>[2]> = {}): CourseData => {
  const project = loadProjectFromDir(dir);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  return compileCourseData(project, keys, { buildId: 'test', ...options });
};
const ids = (bar: PlayerBarData | null) => bar?.items.map((item) => item.id) ?? null;

test('the player: the items that show, in the author\'s order; a bar with nothing to show is removed', () => {
  const dir = copyExample();
  let data = compiled(dir);
  assert.deepEqual(ids(data.player.top), ['logo', 'title', 'progress', 'spacer', 'resources', 'glossary', 'credits', 'exit']);
  assert.deepEqual(ids(data.player.bottom), ['outline', 'controls', 'spacer', 'previous', 'next']);
  assert.deepEqual(data.player.top!.items[0], { id: 'logo', src: 'assets/images/logo-helios.svg', alt: 'Hélios', plate: false });
  assert.deepEqual(data.resources?.map((resource) => resource.kind === 'file' ? [resource.id, resource.type, resource.src] : [resource.id, resource.url]), [['fiche-reflexe', 'pdf', 'assets/resources/fiche-reflexe-impression.pdf'], ['equipements', 'csv', 'assets/resources/equipements-siege.csv']]);
  assert.ok(data.resources!.every((resource) => resource.kind === 'file' && resource.bytes > 0));
  // Narrated screens bring the controls, with their options and the speeds offered.
  assert.deepEqual(data.player.bottom!.items[1], { id: 'controls', seekBar: true, captionsByDefault: false, volume: true, transcript: true, speeds: [...SPEEDS['0.75-2']] });
  // Every bottom item disabled: the bar goes, the screen takes its room.
  const course = readJSON(dir, 'course.json');
  course.player.bottom.items = course.player.bottom.items.map((item: { id: string }) => ({ ...item, enabled: false }));
  course.player.top.position = 'page';
  writeJSON(dir, 'course.json', course);
  data = compiled(dir);
  assert.equal(data.player.bottom, null);
  assert.equal(data.player.top?.position, 'page');
});

test('the player\'s defaults: a course without player gets the bars of a new course; Quit is never on the web, and free navigation shows the outline', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  delete course.player;
  writeJSON(dir, 'course.json', course);
  assert.deepEqual(playerConfig(course).top.items.map((item) => item.id), DEFAULT_PLAYER.top.items.map((item) => item.id));
  let data = compiled(dir);
  // The logo waits for an image.
  assert.deepEqual(ids(data.player.top), ['title', 'progress', 'spacer', 'resources', 'glossary', 'credits', 'exit']);
  data = compiled(dir, { delivery: { target: 'web', progress: 'local', navigation: 'authored' } });
  assert.deepEqual(ids(data.player.top), ['title', 'progress', 'spacer', 'resources', 'glossary', 'credits']);
  // The outline disabled by the author comes back with the web target's free navigation (D41).
  course.player = { top: { items: [{ id: 'title' }] }, bottom: { items: [{ id: 'outline', enabled: false }, { id: 'next' }] } };
  writeJSON(dir, 'course.json', course);
  assert.deepEqual(ids(compiled(dir).player.bottom), ['next']);
  assert.deepEqual(ids(compiled(dir, { delivery: { target: 'web', progress: 'local', navigation: 'free' } }).player.bottom), ['outline', 'next']);
});

test('settings that moved into course.json player are refused with where they went', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.navigation.showMenu = false;
  course.navigation.footer = 'end';
  course.narration = { seek: 'none' };
  writeJSON(dir, 'course.json', course);
  const moved = validateDir(dir).diagnostics.filter((d) => d.code === 'E_PLAYER_SETTING_MOVED');
  assert.deepEqual(moved.map((d) => d.path).sort(), ['/narration/seek', '/navigation/footer', '/navigation/showMenu']);
  assert.match(moved.find((d) => d.path === '/navigation/showMenu')!.message, /outline/);
  assert.match(moved.find((d) => d.path === '/narration/seek')!.message, /seekBar/);
});

test('the player\'s checks: the way back, the end reachable without Next, Quit, an item twice, resources and glossary links', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.player.bottom.items = [{ id: 'controls' }];
  course.player.top.items = course.player.top.items.filter((item: { id: string }) => item.id !== 'exit').concat([{ id: 'title' }]);
  course.resources.push({ id: 'fiche-reflexe', title: 'Encore', asset: 'resources/absente.pages' });
  writeJSON(dir, 'course.json', course);
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.blocks[0].props.markdown += ' Voir le [proxy](glossary:proxy).';
  writeJSON(dir, 'screens/chemin.json', screen);
  const found = validateDir(dir).diagnostics;
  const has = (code: string) => found.filter((d) => d.code === code);
  assert.equal(has('W_PLAYER_NO_WAY_BACK').length, 1);
  const end = has('W_PLAYER_END_UNREACHABLE');
  assert.equal(end.length, 1);
  assert.equal((end[0].details as { screens: { screen: string }[] }).screens[0].screen, 'accueil', 'the first screen has no way forward');
  assert.equal(has('W_PLAYER_EXIT_HIDDEN').length, 1);
  assert.equal(has('E_PLAYER_ITEM_DUPLICATE')[0].path, '/player/top/items/7');
  assert.deepEqual(has('E_DUPLICATE_ENTRY').map((d) => d.path), ['/resources/2/id']);
  assert.deepEqual(has('E_ASSET_MISSING').map((d) => d.path), ['/resources/2/asset']);
  assert.deepEqual(has('W_RESOURCE_TYPE').map((d) => d.target), ['fiche-reflexe']);
  assert.match(has('E_GLOSSARY_TERM_UNKNOWN')[0].message, /glossary:proxy/);
  // A go-to event on every screen to the next one: the end is reachable again.
  for (const file of fs.readdirSync(path.join(dir, 'screens'))) {
    const data = readJSON(dir, `screens/${file}`);
    data.blocks.push({ id: `${data.id}-suite`, type: 'button', props: { label: 'Suite' } });
    data.events = [...(data.events ?? []), { id: 'suite', on: { type: 'click', target: `${data.id}-suite` }, do: [{ type: 'go-to', screen: 'next' }] }];
    writeJSON(dir, `screens/${file}`, data);
  }
  assert.ok(!codes(validateDir(dir).diagnostics).includes('W_PLAYER_END_UNREACHABLE'));
});

test('the end without Next: go-to buttons count where learners reach them, narrations that go on by themselves do not', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.presentation = { mode: 'slides' };
  course.player.bottom.items = course.player.bottom.items.filter((item: { id: string }) => item.id !== 'next');
  writeJSON(dir, 'course.json', course);
  const files = fs.readdirSync(path.join(dir, 'screens'));
  const suite = (stepOnReflexe?: number) => {
    for (const file of files) {
      const data = readJSON(dir, `screens/${file}`);
      data.blocks = data.blocks.filter((block: { id: string }) => !block.id.endsWith('-suite') && block.id !== 'reflexe-plus');
      data.events = (data.events ?? []).filter((event: { id: string }) => event.id !== 'suite');
      const button: Record<string, unknown> = { id: `${data.id}-suite`, type: 'button', props: { label: 'Suite' } };
      if (data.id === 'premier-reflexe') {
        // A later step that opens with Next, which is hidden.
        data.blocks.push({ id: 'reflexe-plus', type: 'text', step: 2, props: { markdown: 'Ensuite, on vérifie le câble.' } });
        if (stepOnReflexe) button.step = stepOnReflexe;
      }
      data.blocks.splice(1, 0, button);
      data.events.push({ id: 'suite', on: { type: 'click', target: `${data.id}-suite` }, do: [{ type: 'go-to', screen: 'next' }] });
      writeJSON(dir, `screens/${file}`, data);
    }
  };
  const ends = () => validateDir(dir).diagnostics.filter((d) => d.code === 'W_PLAYER_END_UNREACHABLE');
  // « Suite » in the first step of a slide whose later step waits for Next: still a way on.
  suite();
  assert.deepEqual(ends(), []);
  // « Suite » in that later step: the slide is a dead end.
  suite(2);
  const found = ends();
  assert.equal(found.length, 1);
  assert.deepEqual((found[0].details as { screens: { screen: string; why: string }[] }).screens, [{ screen: 'premier-reflexe', why: 'shows its steps with Next' }]);
  // A narration that goes to the next screen by itself is not a way on (phones, « M'arrêter à chaque étape »).
  suite();
  const first = readJSON(dir, 'screens/accueil.json');
  first.events = first.events.filter((event: { id: string }) => event.id !== 'suite');
  first.narration.advance = 'next-screen';
  writeJSON(dir, 'screens/accueil.json', first);
  assert.deepEqual((ends()[0]?.details as { screens: { screen: string }[] } | undefined)?.screens.map((entry) => entry.screen), ['accueil']);
});

test('default bars: a bar without its own items has the defaults, an item the author placed wins, and update_player keeps both', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  // A top bar that only says where it is, and resources placed in the bottom bar.
  course.player = { top: { position: 'page' }, bottom: { items: [{ id: 'outline' }, { id: 'resources' }, { id: 'controls' }, { id: 'previous' }, { id: 'next' }] } };
  writeJSON(dir, 'course.json', course);
  const config = playerConfig(course);
  assert.deepEqual(config.top.items.map((item) => item.id), DEFAULT_PLAYER.top.items.map((item) => item.id).filter((id) => id !== 'resources'));
  assert.equal(config.top.position, 'page');
  assert.ok(config.bottom.items.some((item) => item.id === 'resources'), 'the author\'s place wins over the default');
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_PLAYER_ITEM_DUPLICATE'));
  // A change of one token writes both bars in full, as the player reads them.
  edit.updatePlayer(dir, { tokens: { 'player.accent': '#0B5394' } });
  const written = readJSON(dir, 'course.json').player;
  assert.deepEqual(written.top.items.map((item: { id: string }) => item.id), config.top.items.map((item) => item.id));
  assert.equal(written.top.position, 'page');
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_PLAYER_ITEM_DUPLICATE'));
  // An index that is not a whole number from 0, and content that would only be flagged once written, are refused.
  assert.throws(() => edit.updatePlayer(dir, { move: [{ item: 'next', bar: 'top', index: Number.NaN }] }), /whole number/);
  assert.throws(() => edit.updatePlayer(dir, { glossary: [{ id: 'a', term: 'A', definition: 'Un.' }, { id: 'a', term: 'B', definition: 'Deux.' }] }), /two entries have the id "a"/);
  assert.throws(() => edit.updatePlayer(dir, { resources: [{ id: 'r', title: 'R', asset: 'resources/absente.pdf' }] }), /not in the course/);
});

test('regulation and accessibility: a generated voice with « IA et crédits » hidden, narration without controls or transcript', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.player.top.items = course.player.top.items.map((item: { id: string }) => (item.id === 'credits' ? { id: 'credits', enabled: false } : item));
  course.player.bottom.items = course.player.bottom.items.map((item: { id: string }) => (item.id === 'controls' ? { id: 'controls', options: { transcript: false, speeds: 'none' } } : item));
  writeJSON(dir, 'course.json', course);
  let found = validateDir(dir).diagnostics;
  const ai = found.find((d) => d.code === 'W_PLAYER_AI_MENTION_HIDDEN');
  assert.match(ai?.message ?? '', /article 50\(4\) and \(5\)/);
  assert.ok(found.some((d) => d.code === 'W_PLAYER_TRANSCRIPT_HIDDEN' && /1\.2\.1/.test(d.message)));
  assert.ok(found.some((d) => d.code === 'I_PLAYER_SPEEDS_NONE'));
  // The controls disabled: pause, captions and the transcript go with them.
  course.player.bottom.items = course.player.bottom.items.map((item: { id: string }) => (item.id === 'controls' ? { id: 'controls', enabled: false } : item));
  writeJSON(dir, 'course.json', course);
  found = validateDir(dir).diagnostics;
  assert.ok(found.some((d) => d.code === 'W_PLAYER_CONTROLS_HIDDEN' && /2\.2\.2/.test(d.message) && /RGAA/.test(d.message)));
  assert.ok(!found.some((d) => d.code === 'W_PLAYER_TRANSCRIPT_HIDDEN'));
  // « IA et crédits » says who speaks with a generated voice.
  course.player.top.items = course.player.top.items.map((item: { id: string }) => (item.id === 'credits' ? { id: 'credits' } : item));
  writeJSON(dir, 'course.json', course);
  assert.deepEqual(compiled(dir).about?.ai, { voices: ['Marc', 'Claire, votre guide', 'Leïla'] });
});

test('update_player: items enabled, moved and given options, tokens, content, in one undoable change', () => {
  const dir = copyExample();
  const before = fs.readFileSync(path.join(dir, 'course.json'), 'utf8');
  const result = edit.updatePlayer(dir, {
    disable: ['progress'], move: [{ item: 'outline', bar: 'top', index: 1 }],
    options: { controls: { speeds: '0.75-1.5', captionsByDefault: true }, outline: { label: 'section' } },
    position: { bottom: 'page' }, tokens: { 'player.accent': '#0B5394', 'player.density': 'compact' },
    glossary: [{ id: 'dns', term: 'DNS', definition: 'Le service qui traduit les noms en adresses.' }]
  });
  assert.equal(result.ok, true);
  const course = readJSON(dir, 'course.json');
  assert.deepEqual(course.player.top.items.slice(0, 3), [{ id: 'logo', options: { asset: 'images/logo-helios.svg', alt: 'Hélios' } }, { id: 'outline', options: { label: 'section' } }, { id: 'title' }]);
  assert.deepEqual(course.player.top.items.find((item: { id: string }) => item.id === 'progress'), { id: 'progress', enabled: false });
  assert.deepEqual(course.player.bottom.items.find((item: { id: string }) => item.id === 'controls').options, { captionsByDefault: true, speeds: '0.75-1.5' });
  assert.equal(course.player.bottom.position, 'page');
  assert.equal(course.theme.tokens['player.accent'], '#0B5394');
  assert.deepEqual(course.glossary.map((entry: { id: string }) => entry.id), ['dns']);
  // An unknown item or token is refused, and nothing is written.
  assert.throws(() => edit.updatePlayer(dir, { enable: ['sidebar' as 'title'] }), /sidebar/);
  assert.throws(() => edit.updatePlayer(dir, { tokens: { 'player.shadow': '1px' } }), /player\.shadow/);
  edit.undo(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'course.json'), 'utf8'), before);
});

test('the progress\'s options: in parts with its percentage by default, else one bar in one piece or no percentage; an unknown option is refused', () => {
  const dir = copyExample();
  const progress = (data: CourseData) => data.player.top!.items.find((item) => item.id === 'progress');
  assert.deepEqual(progress(compiled(dir)), { id: 'progress', parts: true, percent: true });
  assert.equal(edit.updatePlayer(dir, { options: { progress: { parts: false, percent: false } } }).ok, true);
  assert.deepEqual(readJSON(dir, 'course.json').player.top.items.find((item: { id: string }) => item.id === 'progress'), { id: 'progress', options: { parts: false, percent: false } });
  assert.deepEqual(progress(compiled(dir)), { id: 'progress', parts: false, percent: false });
  assert.ok(!codes(validateDir(dir).diagnostics).some((code) => code.startsWith('E_')));
  // null puts an option back to its default.
  edit.updatePlayer(dir, { options: { progress: { parts: null } } });
  assert.deepEqual(progress(compiled(dir)), { id: 'progress', parts: true, percent: false });
  const course = readJSON(dir, 'course.json');
  course.player.top.items.find((item: { id: string }) => item.id === 'progress').options.segments = 3;
  writeJSON(dir, 'course.json', course);
  assert.ok(codes(validateDir(dir).diagnostics).includes('E_SCHEMA'));
});

test('elabora_player reads the bars with what shows and why not, the tokens with their values, and the findings', () => {
  const dir = copyCourse(); // the test fixture: no narration, no player of its own
  const report = playerReport(dir);
  const controls = report.bottom.items.find((item) => item.id === 'controls')!;
  assert.deepEqual([controls.shows, controls.why], [false, 'no narrated screen']);
  assert.equal(report.top.items.find((item) => item.id === 'exit')!.shows, true);
  assert.equal(playerReport(dir, 'web').top.items.find((item) => item.id === 'exit')!.why, 'web target');
  assert.deepEqual(Object.keys(report.tokens).sort(), ['player.accent', 'player.bottom.background', 'player.bottom.text', 'player.density', 'player.onAccent', 'player.progress', 'player.radius', 'player.tooltip.background', 'player.tooltip.text', 'player.top.background', 'player.top.text']);
  assert.ok(Object.values(report.tokens).every((token) => token.value !== '' && token.set === false), 'defaults come from the charter');
});

test('glossary links compile to the entry, and the player\'s content is translated', () => {
  assert.equal(renderMarkdown('Le [switch](glossary:commutateur) relie les postes.'), '<p>Le <a href="#t-glossary-commutateur" class="t-term" data-term="commutateur">switch</a> relie les postes.</p>');
  const units = extractUnits(loadProjectFromDir(copyExample()));
  const keys = units.map((unit) => unit.id);
  for (const key of ['course.glossary.commutateur.term', 'course.glossary.commutateur.definition', 'course.glossary.commutateur.variant.1', 'course.resource.fiche-reflexe.title', 'course.resource.fiche-reflexe.description', 'course.credit.1', 'course.logo.alt']) {
    assert.ok(keys.includes(key), key);
  }
});
