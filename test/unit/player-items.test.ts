import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, copyExample as copyCourse, readJSON, writeJSON } from '../helpers.ts';
import * as edit from '@elabora/node/edit';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { build } from '@elabora/node/build';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { renderScreen } from '@elabora/core/render/screen';
import { Renderer } from '@elabora/engine/render';
import { extractUnits } from '@elabora/core/i18n/units';
import { DEFAULT_PLAYER, packageLanguages, playerConfig } from '@elabora/core/player/config';
import { svgLogoContrast, svgPaints } from '@elabora/core/player/logo';
import { unlinkText } from '@elabora/core/commands/glossary-links';
import { decodeState, emptyState, encodeState, worstCaseLength } from '@elabora/player/state-codec';
import type { StateModel } from '@elabora/player/state-codec';
import { playerReport } from '../../packages/cli/src/mcp/player-tools.ts';
import type { CourseData, PlayerBarData } from '@elabora/player/course-data';

// The player's items as the founder decided them on Lin 44 (docs/decisions/D58.md, revised on
// 20 Oct 2026, and D59): the spacer, links among the resources, linking the glossary's terms to the
// screens, the logo's plate and its check, the display and language items.

const copyExample = (name = 'diagnostic-reseau') => copyCourse(path.join(ROOT, 'examples', name));
const compiled = (dir: string): CourseData => {
  const project = loadProjectFromDir(dir);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  return compileCourseData(project, keys, { buildId: 'test' });
};
const ids = (bar: PlayerBarData | null) => bar?.items.map((item) => item.id) ?? null;
const listed = (dir: string, bar: 'top' | 'bottom') => (readJSON(dir, 'course.json').player[bar].items as { id: string }[]).map((item) => item.id);

test('the spacer: one per bar, always on, moved within its bar; a bar of only a spacer is removed', () => {
  assert.deepEqual(DEFAULT_PLAYER.top.items.map((item) => item.id), ['logo', 'title', 'progress', 'spacer', 'resources', 'glossary', 'credits', 'exit']);
  assert.deepEqual(DEFAULT_PLAYER.bottom.items.map((item) => item.id), ['outline', 'controls', 'spacer', 'previous', 'next']);
  const dir = copyExample();
  // A course written before the spacer keeps the implicit rule: no spacer is added.
  const course = readJSON(dir, 'course.json');
  for (const bar of ['top', 'bottom'] as const) course.player[bar].items = course.player[bar].items.filter((item: { id: string }) => item.id !== 'spacer');
  writeJSON(dir, 'course.json', course);
  assert.deepEqual(ids(compiled(dir).player.top), ['logo', 'title', 'progress', 'resources', 'glossary', 'credits', 'exit']);
  // Enabled, each bar gets its own back at its place.
  edit.updatePlayer(dir, { enable: ['spacer'] });
  assert.deepEqual(listed(dir, 'top'), ['logo', 'title', 'progress', 'spacer', 'resources', 'glossary', 'credits', 'exit']);
  assert.deepEqual(listed(dir, 'bottom'), ['outline', 'controls', 'spacer', 'previous', 'next']);
  assert.throws(() => edit.updatePlayer(dir, { disable: ['spacer'] }), /always on/);
  // Moved, it stays in its bar: the other bar's spacer does not move.
  edit.updatePlayer(dir, { move: [{ item: 'spacer', bar: 'bottom', index: 0 }] });
  assert.deepEqual(listed(dir, 'bottom'), ['spacer', 'outline', 'controls', 'previous', 'next']);
  assert.deepEqual(listed(dir, 'top'), ['logo', 'title', 'progress', 'spacer', 'resources', 'glossary', 'credits', 'exit']);
  // Two in a bar: the first counts, the second is flagged; one in each bar is fine.
  const twice = readJSON(dir, 'course.json');
  twice.player.top.items.push({ id: 'spacer' });
  writeJSON(dir, 'course.json', twice);
  assert.equal(playerConfig(twice).top.items.filter((item) => item.id === 'spacer').length, 1);
  assert.deepEqual(validateDir(dir).diagnostics.filter((d) => d.code === 'E_PLAYER_ITEM_DUPLICATE').map((d) => d.path), ['/player/top/items/8']);
  // A bar left with its spacer alone goes.
  twice.player.top.items.pop();
  twice.player.bottom.items = [{ id: 'spacer' }, { id: 'next', enabled: false }];
  writeJSON(dir, 'course.json', twice);
  assert.equal(compiled(dir).player.bottom, null);
  assert.equal(playerReport(dir).bottom.shown, false);
});

test('display and language: off in a new module, put back where Lin 44 draws them; language shows with more than one language', () => {
  const dir = copyExample();
  const report = playerReport(dir);
  assert.deepEqual(report.unused, ['language', 'display']);
  assert.deepEqual(report.content.languages, ['fr']);
  assert.deepEqual(report.navigation, { mode: 'linear', lockUntilComplete: true });
  edit.updatePlayer(dir, { enable: ['language', 'display'] });
  assert.deepEqual(listed(dir, 'top'), ['logo', 'title', 'progress', 'spacer', 'language', 'resources', 'glossary', 'credits', 'exit']);
  assert.deepEqual(listed(dir, 'bottom'), ['outline', 'controls', 'spacer', 'display', 'previous', 'next']);
  const after = playerReport(dir);
  assert.deepEqual(after.top.items.find((item) => item.id === 'language'), { id: 'language', enabled: true, shows: false, why: 'one language in the package', options: {} });
  assert.equal(after.bottom.items.find((item) => item.id === 'display')?.shows, true);
  assert.deepEqual(ids(compiled(dir).player.bottom), ['outline', 'controls', 'spacer', 'display', 'previous', 'next']);
  // The orbital sample has an approved French translation: a package of every language holds two.
  assert.deepEqual(packageLanguages(loadProjectFromDir(path.join(ROOT, 'examples/orbital-rendezvous'))), ['en', 'fr']);
});

test('resources: https links beside files, images among the files; refused when they would only be flagged', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  const resources = [...course.resources, { id: 'charte', title: 'Charte informatique', description: 'Sur l\'intranet.', url: 'https://intranet.example.com/charte?v=2#impression' }, { id: 'schema', title: 'Schéma du réseau', asset: 'images/logo-helios.svg' }];
  edit.updatePlayer(dir, { resources });
  const data = compiled(dir).resources!;
  assert.deepEqual(data.find((resource) => resource.id === 'charte'), { id: 'charte', kind: 'link', title: 'Charte informatique', description: 'Sur l\'intranet.', url: 'https://intranet.example.com/charte?v=2#impression' });
  assert.equal(data.find((resource) => resource.id === 'schema')?.kind, 'file');
  assert.throws(() => edit.updatePlayer(dir, { resources: [{ id: 'web', title: 'Site', url: 'http://example.com' }] }), /https:\/\//);
  assert.throws(() => edit.updatePlayer(dir, { resources: [{ id: 'both', title: 'Les deux', url: 'https://example.com', asset: 'images/logo-helios.svg' }] }), /one of the two/);
  // Written by hand: flagged, and left out of the package.
  const written = readJSON(dir, 'course.json');
  written.resources.push({ id: 'ftp', title: 'Serveur', url: 'javascript:alert(1)' });
  writeJSON(dir, 'course.json', written);
  assert.deepEqual(validateDir(dir).diagnostics.filter((d) => d.code === 'E_RESOURCE_URL').map((d) => d.target), ['ftp']);
  assert.equal(compiled(dir).resources!.some((resource) => resource.id === 'ftp'), false);
});

test('the logo: its colours against the bar, the plate that lets it read', () => {
  const box = 'd="M0 0h10v10z"';
  assert.ok(svgLogoContrast(`<svg viewBox="0 0 10 10"><path ${box}/></svg>`, '#14161C')!.ratio < 3, 'unfilled shapes are black');
  assert.ok(svgLogoContrast(`<svg><path fill="#FFFFFF" ${box}/><path style="fill:#0B1F3A" ${box}/></svg>`, '#14161C')!.ratio > 10, 'the best colour counts');
  assert.ok(svgLogoContrast(`<svg><style>.a{fill:rgb(255, 204, 0)}</style><path class="a" ${box}/></svg>`, '#FFFFFF')!.ratio < 3);
  assert.equal(svgLogoContrast(`<svg><path fill="url(#g)" ${box}/></svg>`, '#FFFFFF'), null, 'a gradient is not measured');
  // Figma's export: a clip path whose white rectangle is not painted; the navy logo on a navy bar.
  const figma = '<svg width="120" height="32" viewBox="0 0 120 32" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_12_4)"><path d="M0 0h40v32H0z" fill="#0B1F3A"/><path d="M50 4h60v8H50z" fill="#0B1F3A"/></g><defs><clipPath id="clip0_12_4"><rect width="120" height="32" fill="white"/></clipPath></defs></svg>';
  assert.deepEqual(svgPaints(figma), ['#0B1F3A']);
  assert.ok(svgLogoContrast(figma, '#102A4C')!.ratio < 3);
  // An embedded image, clipped by a black rectangle; a raster fill through a pattern: unsure.
  assert.equal(svgPaints('<svg viewBox="0 0 120 32"><g clip-path="url(#c)"><image href="data:image/png;base64,AAAA" width="120" height="32"/></g><defs><clipPath id="c"><rect width="120" height="32" fill="#000"/></clipPath></defs></svg>'), null);
  assert.equal(svgPaints('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><rect width="120" height="32" fill="url(#pattern0)"/><defs><pattern id="pattern0"><use xlink:href="#image0"/></pattern><image id="image0" width="1" height="1"/></defs></svg>'), null);
  // currentColor is the SVG's own color (black unless it says another); either quote; CSS's names.
  assert.deepEqual(svgPaints(`<svg><path fill="currentColor" ${box}/></svg>`), ['#000000']);
  assert.deepEqual(svgPaints(`<svg color="#FFFFFF"><g style="color: lightgrey"><path fill="currentColor" ${box}/></g></svg>`), ['#D3D3D3']);
  assert.deepEqual(svgPaints(`<svg><path fill='#1B2430' d='M0 0h10v10z'/></svg>`), ['#1B2430']);
  assert.deepEqual(svgPaints(`<svg><path fill="MidnightBlue" ${box}/><circle r="4" fill="none" stroke="darkslategray"/></svg>`), ['#191970', '#2F4F4F']);
  assert.ok(svgLogoContrast(`<svg><path fill="darkblue" ${box}/></svg>`, '#000033')!.ratio < 3);
  // Inherited paint, the cascade (attribute < rule by specificity < style attribute), hidden shapes.
  assert.deepEqual(svgPaints(`<svg><style>/* charte */ .cls-1{fill:#1d1d1b;} path#marque{fill:#e30613} .x.y{fill:#00FF00}</style><g fill="#FFFFFF"><path class="cls-1" ${box}/><path id="marque" class="cls-1" fill="#0000FF" ${box}/><path class="x y" style="fill: #123456 !important" ${box}/></g></svg>`), ['#1D1D1B', '#E30613', '#123456']);
  assert.deepEqual(svgPaints(`<svg><g fill="#FFFFFF"><path ${box}/></g><rect width="10" height="10" fill="#FF0000" opacity="0"/><rect width="10" height="10" fill="#00FF00" display="none"/><g visibility="hidden"><path fill="#0000FF" ${box}/></g><path fill="#FFFF00" d=""/><rect height="10" fill="#FF00FF"/></svg>`), ['#FFFFFF']);
  // Text paints where it has characters: a tspan's own fill, not the text's around it.
  assert.deepEqual(svgPaints('<svg><text x="0" y="10" fill="#FFFFFF"><tspan fill="#0B1F3A">Hélios</tspan></text><text y="20">Groupe</text></svg>'), ['#0B1F3A', '#000000']);
  // Unsure: transparency, a mask or a filter on what paints, a rule it cannot match, a conditional
  // sheet, an animation, a broken file.
  for (const svg of [
    `<svg><path fill="#0B1F3A" opacity="0.5" ${box}/></svg>`,
    `<svg><path fill="rgba(11, 31, 58, 0.4)" ${box}/></svg>`,
    `<svg><g mask="url(#m)"><path fill="#0B1F3A" ${box}/></g><mask id="m"><rect width="10" height="10" fill="#fff"/></mask></svg>`,
    `<svg><path filter="url(#f)" fill="#0B1F3A" ${box}/></svg>`,
    `<svg><style>svg .a{fill:#fff}</style><path class="a" fill="#0B1F3A" ${box}/></svg>`,
    `<svg><style>@media (prefers-color-scheme: dark) { .a { fill: #fff } }</style><path class="a" fill="#0B1F3A" ${box}/></svg>`,
    `<svg><path fill="#0B1F3A" ${box}><animate attributeName="fill" to="#fff"/></path></svg>`,
    `<svg><path fill="var(--brand)" ${box}/></svg>`,
    '<svg><path fill="',
    '<!-- <svg><path d="M0 0h1v1z"/></svg>',
    '<html><path d="M0 0h1v1z"/></html>'
  ]) assert.equal(svgPaints(svg), null, svg);
  // An Illustrator file: XML declaration, DOCTYPE with entities, CDATA style.
  assert.deepEqual(svgPaints(`<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [\n<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n]>\n<svg xmlns="&ns_svg;"><style type="text/css"><![CDATA[\n\t.st0{fill:#E30613;}\n]]></style><polygon class="st0" points="0,0 10,0 5,8"/></svg>`), ['#E30613']);
  // Bounded: a file over 2 MB, thousands of unterminated comments, are not read.
  const started = performance.now();
  assert.equal(svgPaints(`<svg><path fill="#000" d="M${'0 '.repeat(1_100_000)}"/></svg>`), null);
  assert.equal(svgPaints(`<svg>${'<!--'.repeat(400_000)}</svg>`), null);
  assert.ok(performance.now() - started < 1000);
  const dir = copyExample();
  fs.writeFileSync(path.join(dir, 'assets/images/logo-sombre.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><path fill="#1B2430" d="M0 0h120v32H0z"/></svg>\n');
  edit.updatePlayer(dir, { options: { logo: { asset: 'images/logo-sombre.svg' } }, tokens: { 'player.top.background': '#101418', 'player.top.text': '#FFFFFF' } });
  const flagged = validateDir(dir).diagnostics.filter((d) => d.code === 'W_PLAYER_LOGO_CONTRAST');
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].message, /plate/);
  // The ratio and the bar as data (the app says them in its own words).
  assert.equal(flagged[0].measured, 1.18);
  assert.equal(flagged[0].limit, 3);
  assert.deepEqual(flagged[0].details, { bar: 'top', token: 'player.top.background', background: '#101418', ratio: 1.18, asset: 'assets/images/logo-sombre.svg' });
  edit.updatePlayer(dir, { options: { logo: { plate: true } } });
  assert.equal(validateDir(dir).diagnostics.some((d) => d.code === 'W_PLAYER_LOGO_CONTRAST'), false);
  assert.deepEqual(compiled(dir).player.top!.items[0], { id: 'logo', src: 'assets/images/logo-sombre.svg', alt: 'Hélios', plate: true });
});

test('« Relier les termes aux écrans »: the first time in each screen, deterministic, never in links, code or locked texts', () => {
  const dir = copyExample();
  const accueil = readJSON(dir, 'screens/accueil.json');
  const callout = accueil.blocks.find((block: { id: string }) => block.id === 'accueil-objectifs');
  callout.props.markdown = 'Le `routeur` en code, [le routeur](https://example.com) en lien, <span title="routeur">x</span>, puis le Routeur du siège et un autre routeur.';
  writeJSON(dir, 'screens/accueil.json', accueil);
  const before = readJSON(dir, 'screens/chemin.json');
  const first = edit.updatePlayer(dir, { linkTerms: ['routeur'] });
  const text = readJSON(dir, 'screens/accueil.json').blocks.find((block: { id: string }) => block.id === 'accueil-objectifs').props.markdown;
  assert.equal(text, 'Le `routeur` en code, [le routeur](https://example.com) en lien, <span title="routeur">x</span>, puis le [Routeur](glossary:routeur) du siège et un autre routeur.');
  assert.deepEqual(first.linked.find((link) => link.screen === 'accueil'), { screen: 'accueil', term: 'routeur', text: 'Routeur', unit: 'block.accueil-objectifs.markdown' });
  // Once per screen; a screen that already links the term is left as it is; the plan's locked text
  // (accueil-situation, textRef) is not the screen's to change.
  assert.equal(new Set(first.linked.map((link) => link.screen)).size, first.linked.length);
  assert.equal(readJSON(dir, 'screens/accueil.json').blocks[0].props.textRef, 'TXT-1');
  // Run again: nothing more to link.
  assert.deepEqual(edit.updatePlayer(dir, { linkTerms: ['routeur'] }).linked, []);
  // All the terms: every screen gets each term once, the existing links kept.
  const all = edit.updatePlayer(dir, { linkTerms: true });
  const chemin = JSON.stringify(readJSON(dir, 'screens/chemin.json'));
  assert.equal((chemin.match(/\]\(glossary:paquet\)/g) ?? []).length, (JSON.stringify(before).match(/\]\(glossary:paquet\)/g) ?? []).length, 'chemin already linked paquet');
  assert.ok(all.linked.length > 0);
  assert.ok(all.changed.some((change) => /^link terms \(\d+ links?\)$/.test(change)));
});

test('linking runs when the option is turned on and for a term added while it is on; a link the author removed stays removed', () => {
  const dir = copyExample();
  edit.updatePlayer(dir, { options: { glossary: { linkTerms: false } } });
  const course = readJSON(dir, 'course.json');
  const imprimante = { id: 'imprimante', term: 'Imprimante', definition: 'Appareil qui imprime les documents envoyés par le serveur d\'impression.' };
  // Off: a term added is not linked.
  assert.deepEqual(edit.updatePlayer(dir, { glossary: [...course.glossary, imprimante] }).linked, []);
  // Turned on: every term.
  const on = edit.updatePlayer(dir, { options: { glossary: { linkTerms: null } } });
  assert.ok(on.linked.some((link) => link.term === 'imprimante'));
  assert.ok(on.linked.some((link) => link.term === 'routeur'));
  // The author removes one link; other changes leave it removed.
  const screen = on.linked.find((link) => link.term === 'imprimante')!.screen;
  const file = `screens/${screen}.json`;
  const unlinked = JSON.parse(JSON.stringify(readJSON(dir, file)).replace(/\[([^\]]+)\]\(glossary:imprimante\)/, '$1'));
  writeJSON(dir, file, unlinked);
  edit.updatePlayer(dir, { credits: ['Illustrations : Hélios'] });
  assert.doesNotMatch(JSON.stringify(readJSON(dir, file)), /glossary:imprimante/);
  // A term added while on: that term only.
  const added = edit.updatePlayer(dir, { glossary: [...readJSON(dir, 'course.json').glossary, { id: 'poste', term: 'Poste', definition: 'L\'ordinateur de l\'utilisateur.' }] });
  assert.ok(added.linked.length > 0);
  assert.ok(added.linked.every((link) => link.term === 'poste'));
  assert.doesNotMatch(JSON.stringify(readJSON(dir, file)), /glossary:imprimante/);
  assert.throws(() => edit.updatePlayer(dir, { linkTerms: ['absent'] }), /no entry "absent"/);
});

test('a glossary entry with translate: false keeps its term and variants in every language', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.glossary[0].translate = false;
  writeJSON(dir, 'course.json', course);
  const units = extractUnits(loadProjectFromDir(dir)).map((unit) => unit.id);
  assert.ok(!units.includes('course.glossary.commutateur.term'));
  assert.ok(!units.includes('course.glossary.commutateur.variant.1'));
  assert.ok(units.includes('course.glossary.commutateur.definition'));
  assert.ok(units.includes('course.glossary.routeur.term'));
});

test('a glossary entry says where its term was found: for the author, never in the package or a translation, and it follows a renamed screen', () => {
  const dir = copyExample();
  const glossary = readJSON(dir, 'course.json').glossary;
  glossary[0].source = { kind: 'source', id: 'brief-client.pdf', at: 'p. 4' };
  glossary[1].source = { kind: 'screen', id: 'chemin' };
  edit.updatePlayer(dir, { glossary });
  assert.deepEqual(readJSON(dir, 'course.json').glossary.slice(0, 2).map((entry: { source?: unknown }) => entry.source), [{ kind: 'source', id: 'brief-client.pdf', at: 'p. 4' }, { kind: 'screen', id: 'chemin' }]);
  assert.ok(!validateDir(dir).diagnostics.some((d) => d.severity === 'error'));
  // Learners never see it, translators never get it.
  assert.doesNotMatch(JSON.stringify(compiled(dir).glossary), /brief-client|p\. 4|"source"/);
  assert.ok(!extractUnits(loadProjectFromDir(dir)).some((unit) => /^course\.glossary\.[^.]+\.source/.test(unit.id) || /brief-client|p\. 4/.test(unit.text)));
  // A screen renamed: the entry names it under its new id.
  edit.rename(dir, { from: 'chemin', to: 'chemin-impression' });
  assert.deepEqual(readJSON(dir, 'course.json').glossary[1].source, { kind: 'screen', id: 'chemin-impression' });
  // Only a source or a screen.
  const course = readJSON(dir, 'course.json');
  course.glossary[0].source = { kind: 'web', id: 'https://example.com' };
  writeJSON(dir, 'course.json', course);
  assert.ok(validateDir(dir).diagnostics.some((d) => d.severity === 'error' && d.file === 'course.json' && String(d.path).startsWith('/glossary/0/source')));
});

test('the language a learner chose is kept in suspend data, last, and costs its length in the worst case', () => {
  const state = emptyState();
  state.visited.add('s1');
  state.language = 'fr';
  const text = encodeState(state);
  assert.match(text, /,"g":"fr"\}$/);
  assert.equal(decodeState(text).language, 'fr');
  assert.equal(decodeState(text.replace('"fr"', '"<script>"')).language, undefined);
  const model: StateModel = { screens: ['s1', 's2'], quizzes: [], numerics: [], decisions: [], variables: [], objects: [], toggleableBlocks: [], steppedScreens: [], controls: [] };
  assert.equal(worstCaseLength({ ...model, languages: ['en', 'fr', 'pt-BR'] }) - worstCaseLength(model), ',"g":"pt-BR"'.length);
});

test('a package of every language (D59): the course data of each, the languages in the main one, the worst case counted', async () => {
  const dir = copyExample('orbital-rendezvous');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-languages-'));
  const one = await build(dir, { out: path.join(out, 'one'), emit: 'dir', target: 'web', writeLock: false });
  const all = await build(dir, { out: path.join(out, 'all'), emit: 'dir', target: 'web', writeLock: false, languages: 'all' });
  assert.ok(one.ok && all.ok);
  const files = (result: typeof all) => [...(result.ok ? result.files.keys() : [])].sort();
  assert.deepEqual(files(all).filter((file) => !files(one).includes(file)), ['elabora/course.fr.js']);
  const french = all.files.get('elabora/course.fr.js')!.toString('utf8');
  assert.match(french, /^\(window\.ELABORA_COURSES = window\.ELABORA_COURSES \|\| \{\}\)\["fr"\] = \{/);
  assert.match(french, /"language":"fr"/);
  assert.match(all.files.get('elabora/course.js')!.toString('utf8'), /"languages":\["en","fr"\]/);
  assert.doesNotMatch(one.files.get('elabora/course.js')!.toString('utf8'), /"languages"/);
  assert.equal(all.report.budget.suspendDataWorstCase - one.report.budget.suspendDataWorstCase, ',"g":"en"'.length);
  fs.rmSync(out, { recursive: true, force: true });
});

test('the canvas render data carries what the live bars need: the outline, the resources, « IA et crédits », their files, the languages', () => {
  const dir = copyExample();
  const render = renderScreen(loadProjectFromDir(dir), 'chemin', {});
  assert.deepEqual(render.outline?.sections.map((section) => section.screens.map((entry) => entry.id)), [['accueil', 'chemin'], ['premier-reflexe', 'simulation'], ['evaluation', 'bilan']]);
  assert.equal(render.outline?.sections[0].screens[1].title, 'Le chemin d\'une impression');
  assert.deepEqual(render.course.resources?.map((resource) => resource.id), ['fiche-reflexe', 'equipements']);
  assert.ok(render.course.about?.ai);
  // The host serves the logo and the resources' files (the preview, the downloads).
  const files = render.files.map((file) => file.path);
  for (const path of ['assets/images/logo-helios.svg', 'assets/resources/fiche-reflexe-impression.pdf', 'assets/resources/equipements-siege.csv']) assert.ok(files.includes(path), path);
  assert.equal(render.course.languages, undefined);
  // « Langue » enabled: the languages a package of every language would hold.
  const orbital = copyExample('orbital-rendezvous');
  edit.updatePlayer(orbital, { enable: ['language'] });
  assert.deepEqual(renderScreen(loadProjectFromDir(orbital), 'intro', {}).course.languages, ['en', 'fr']);
});

test('linking reads Markdown as the player does: case for acronyms, links, references, code, URLs; the longest term first, whatever the glossary\'s order', () => {
  const dir = copyExample();
  const accueil = readJSON(dir, 'screens/accueil.json');
  const callout = accueil.blocks.find((block: { id: string }) => block.id === 'accueil-objectifs');
  callout.props.markdown = 'Si vous êtes prêt, le SI répond. Voir [le guide][routeur], [un [routeur] imbriqué](https://example.com) et https://example.com/routeur/doc.\n\n    routeur dans un bloc de code\n\nPuis le réseau privé virtuel, et le réseau.';
  writeJSON(dir, 'screens/accueil.json', accueil);
  const course = readJSON(dir, 'course.json');
  const glossary = [
    ...course.glossary,
    { id: 'si', term: 'SI', definition: 'Le système d\'information.' },
    { id: 'reseau', term: 'réseau', definition: 'Des équipements reliés.' },
    { id: 'rpv', term: 'réseau privé virtuel', definition: 'Un tunnel chiffré.' }
  ];
  edit.updatePlayer(dir, { options: { glossary: { linkTerms: false } } });
  edit.updatePlayer(dir, { glossary });
  edit.updatePlayer(dir, { linkTerms: ['si', 'routeur', 'reseau', 'rpv'] });
  const text = readJSON(dir, 'screens/accueil.json').blocks.find((block: { id: string }) => block.id === 'accueil-objectifs').props.markdown;
  assert.equal(text, 'Si vous êtes prêt, le [SI](glossary:si) répond. Voir [le guide][routeur], [un [routeur] imbriqué](https://example.com) et https://example.com/routeur/doc.\n\n    routeur dans un bloc de code\n\nPuis le [réseau privé virtuel](glossary:rpv), et le [réseau](glossary:reseau).');
});

test('linking and translations: the same link where the term is in an up-to-date translation, else the text said stale; a language left out of the package is named', async () => {
  const dir = copyExample('orbital-rendezvous');
  const unit = 'block.burns-practice.options.a.feedback';
  const course = readJSON(dir, 'course.json');
  // A name kept in every language: the French text has it too, and takes the same link.
  const gemini = edit.updatePlayer(dir, { glossary: [...(course.glossary ?? []), { id: 'gemini', term: 'Gemini', definition: 'The NASA programme of two-person spacecraft (1965–1966).', translate: false }] });
  assert.ok(gemini.linked.some((link) => link.unit === unit));
  assert.deepEqual(gemini.translations, [{ language: 'fr', linked: [unit], stale: [] }]);
  const xlf = fs.readFileSync(path.join(dir, 'translations/fr.xlf'), 'utf8');
  assert.match(xlf, /<target>C’est l’instinct qu’a suivi \[Gemini\]\(glossary:gemini\) 4\./);
  // A term whose translation the French has not got: its texts are said stale.
  const client = edit.updatePlayer(dir, { glossary: [...readJSON(dir, 'course.json').glossary, { id: 'client', term: 'client', definition: 'The spacecraft to catch up with.' }] });
  const french = client.translations.find((translation) => translation.language === 'fr')!;
  assert.ok(french.stale.length > 0 && french.linked.length === 0, JSON.stringify(client.translations));
  // The package of every language leaves French out, and says why.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-left-out-'));
  const built = await build(dir, { out, emit: 'dir', target: 'web', writeLock: false, languages: 'all' });
  assert.ok(built.ok);
  const left = built.diagnostics.filter((d) => d.code === 'W_PACKAGE_LANGUAGE_LEFT_OUT');
  assert.equal(left.length, 1);
  assert.equal(left[0].target, 'fr');
  assert.match(left[0].message, /texts? to translate/);
  assert.match(left[0].message, /out of date/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('the links to an entry, as the player\'s Markdown reads them: inline, by reference, in nested brackets; never in code, an escape or an image', () => {
  const text = [
    'Le [routeur](glossary:routeur), le [**SI**](glossary:si "Système d\'information"), [la passerelle](<glossary:passerelle>),',
    '`[pas](glossary:routeur)` en code, \\[pas un lien\\](glossary:routeur), ![image](glossary:routeur),',
    '[autour [du routeur](glossary:routeur) encore], [par référence][r], [r][], [r] et [R].',
    '',
    '```',
    '[dans une clôture](glossary:routeur)',
    '```',
    '',
    '[r]: glossary:routeur',
    '[autre]: https://example.com'
  ].join('\n');
  const result = unlinkText(text, new Set(['routeur']));
  assert.equal(result.text, [
    'Le routeur, le [**SI**](glossary:si "Système d\'information"), [la passerelle](<glossary:passerelle>),',
    '`[pas](glossary:routeur)` en code, \\[pas un lien\\](glossary:routeur), ![image](glossary:routeur),',
    '[autour du routeur encore], par référence, r, r et R.',
    '',
    '```',
    '[dans une clôture](glossary:routeur)',
    '```',
    '',
    '[autre]: https://example.com'
  ].join('\n'));
  assert.deepEqual(result.removed.map((link) => link.words), ['routeur', 'du routeur', 'par référence', 'r', 'r', 'R']);
  assert.equal(unlinkText(result.text, new Set(['si', 'passerelle'])).text.split('\n')[0], 'Le routeur, le **SI**, la passerelle,');
});

test('a glossary entry removed takes its links: the words stay, placed or written by hand, in one change that undo takes back', () => {
  const dir = copyExample();
  edit.updatePlayer(dir, { linkTerms: true });
  // A link written by hand, by reference, in a screen that has the term linked already.
  const chemin = readJSON(dir, 'screens/chemin.json');
  const intro = chemin.blocks.find((block: { id: string }) => block.id === 'chemin-intro');
  intro.props.markdown = `${intro.props.markdown}\n\nVoir aussi [le routeur du siège][siege].\n\n[siege]: glossary:routeur`;
  writeJSON(dir, 'screens/chemin.json', chemin);
  const screens = () => fs.readdirSync(path.join(dir, 'screens')).map((name) => fs.readFileSync(path.join(dir, 'screens', name), 'utf8')).join('\n');
  const before = (screens().match(/glossary:routeur/g) ?? []).length;
  assert.ok(before >= 3, `${before} links to routeur`);
  const glossary = readJSON(dir, 'course.json').glossary.filter((entry: { id: string }) => entry.id !== 'routeur');
  const removed = edit.updatePlayer(dir, { glossary });
  assert.doesNotMatch(screens(), /glossary:routeur/);
  // The inline links, and the link by reference (its definition is the other mention).
  assert.equal(removed.unlinked.length, before, `${removed.unlinked.length} links, ${before} mentions`);
  assert.equal(removed.unlinked.filter((link) => link.text === 'le routeur du siège').length, 1);
  assert.ok(removed.unlinked.every((link) => link.term === 'routeur' && link.text.length > 0));
  assert.ok(removed.changed.includes(`unlink removed terms (${removed.unlinked.length} links)`), removed.changed.join(', '));
  assert.match(readJSON(dir, 'screens/chemin.json').blocks.find((block: { id: string }) => block.id === 'chemin-intro').props.markdown, /Voir aussi le routeur du siège\.$/);
  assert.equal(validateDir(dir).diagnostics.some((d) => d.code === 'E_GLOSSARY_TERM_UNKNOWN'), false);
  // One change: undone, the entry and its links come back.
  edit.undo(dir);
  assert.equal((screens().match(/glossary:routeur/g) ?? []).length, before);
  assert.ok(readJSON(dir, 'course.json').glossary.some((entry: { id: string }) => entry.id === 'routeur'));
});

test('a glossary entry removed: the translations that had its links up to date lose them and stay up to date', () => {
  const dir = copyExample('orbital-rendezvous');
  const unit = 'block.burns-practice.options.a.feedback';
  const course = readJSON(dir, 'course.json');
  edit.updatePlayer(dir, { glossary: [...(course.glossary ?? []), { id: 'gemini', term: 'Gemini', definition: 'The NASA programme of two-person spacecraft (1965–1966).', translate: false }] });
  assert.match(fs.readFileSync(path.join(dir, 'translations/fr.xlf'), 'utf8'), /\[Gemini\]\(glossary:gemini\)/);
  const removed = edit.updatePlayer(dir, { glossary: course.glossary ?? [] });
  assert.ok(removed.unlinked.some((link) => link.unit === unit && link.text === 'Gemini'));
  assert.deepEqual(removed.translations, [{ language: 'fr', linked: [], stale: [], unlinked: [...new Set(removed.unlinked.map((link) => link.unit))].filter((id) => id === unit) }]);
  const xlf = fs.readFileSync(path.join(dir, 'translations/fr.xlf'), 'utf8');
  assert.doesNotMatch(xlf, /glossary:gemini/);
  assert.match(xlf, /<target>C’est l’instinct qu’a suivi Gemini 4\./);
  // Still a package of every language: French is up to date.
  assert.deepEqual(packageLanguages(loadProjectFromDir(dir)), ['en', 'fr']);
});

test('the engine\'s renders carry the bars of the course as it is now: another screen renamed', () => {
  const dir = copyExample();
  const renderer = new Renderer();
  const outlineTitle = (render: { outline?: { sections: { screens: { id: string; title: string }[] }[] } }) => render.outline!.sections.flatMap((section) => section.screens).find((entry) => entry.id === 'chemin')?.title;
  assert.equal(outlineTitle(renderer.render(loadProjectFromDir(dir), { screen: 'accueil' })), 'Le chemin d\'une impression');
  const chemin = readJSON(dir, 'screens/chemin.json');
  chemin.title = 'Le trajet d\'une impression';
  writeJSON(dir, 'screens/chemin.json', chemin);
  renderer.invalidate(['screens/chemin.json']);
  assert.equal(outlineTitle(renderer.render(loadProjectFromDir(dir), { screen: 'accueil' })), 'Le trajet d\'une impression', 'the memoised render of accueil takes the new outline');
});
