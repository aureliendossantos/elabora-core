import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { assetUses, shippedAssets } from '@elabora/node/packaging/assets';
import { createRenderContext, renderScreen } from '@elabora/core/render/screen';
import type { ObjectBlock } from '@elabora/player/course-data';
import { ROOT, copyExample, readJSON, writeJSON } from '../helpers.ts';

// An image setting of a free object (x-control "asset" in its manifest, a prop or a field of a list's
// items) names a file of the course's assets/, as a block's media does (the founder, 6 Nov 2026): the
// validator reports it missing, the editor's canvas serves it, the package ships it, and the compiled
// block says where the package has it, for host.asset(value). On the example diagnostic-reseau, its
// scene given a poster and a marker with a picture.

const SCENE = 'simulation-reseau';

function withImageSettings(poster = 'images/portrait-marc.svg', marker = 'images/logo-helios.svg'): string {
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau'));
  const manifestFile = 'objects/diagnostic-reseau/object.manifest.json';
  const manifest = readJSON(dir, manifestFile);
  Object.assign(manifest.props.properties, {
    poster: { type: 'string', default: '', title: 'Affiche', description: 'Une image montrée avant la scène.', 'x-control': 'asset' },
    markers: { type: 'array', default: [], minItems: 0, maxItems: 4, title: 'Repères', description: 'Des notes posées dans la scène.', 'x-control': 'list',
      items: { type: 'object', title: 'Repère', properties: { label: { type: 'string', title: 'Libellé', maxLength: 60 }, image: { type: 'string', title: 'Image', 'x-control': 'asset' } }, required: ['label'] } }
  });
  writeJSON(dir, manifestFile, manifest);
  const screen = readJSON(dir, 'screens/simulation.json');
  const block = screen.blocks.find((candidate: { id: string }) => candidate.id === SCENE);
  block.props.props = { ...block.props.props, poster, markers: [{ label: 'Le pare-feu bloque', image: marker }] };
  writeJSON(dir, 'screens/simulation.json', screen);
  return dir;
}

test('an image setting of a free object: checked, served on the canvas, shipped, located for host.asset', () => {
  const dir = withImageSettings();
  const codes = validateDir(dir).diagnostics.filter((d) => d.code === 'E_ASSET_MISSING' || d.code === 'E_OBJECT_PROP_VALUE');
  assert.deepEqual(codes, [], 'both files are in assets/');
  const project = loadProjectFromDir(dir);
  const render = renderScreen(project, 'simulation', {}, createRenderContext(project, { fields: true }));
  const served = render.files.map((file) => file.path);
  assert.ok(served.includes('assets/images/portrait-marc.svg') && served.includes('assets/images/logo-helios.svg'), served.join(', '));
  const block = render.course.screens[0]!.blocks.find((candidate) => candidate.id === SCENE) as ObjectBlock;
  assert.deepEqual(block.props.files, { 'images/portrait-marc.svg': 'assets/images/portrait-marc.svg', 'images/logo-helios.svg': 'assets/images/logo-helios.svg' });
  assert.ok(shippedAssets(project).includes('images/logo-helios.svg'));
  // The logo is the player's too: the scene is one more use of it.
  assert.deepEqual(assetUses(project).get('images/logo-helios.svg')?.find((use) => use.block === SCENE), { screen: 'simulation', block: SCENE });
});

test('an image setting naming a file that is not there: E_ASSET_MISSING at the setting', () => {
  const dir = withImageSettings('images/portrait-marc.svg', 'images/absent.svg');
  const missing = validateDir(dir).diagnostics.filter((d) => d.code === 'E_ASSET_MISSING');
  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.equal(missing[0]!.target, SCENE);
  assert.match(String(missing[0]!.path), /props\/props\/markers\/0\/image$/);
  assert.match(String(missing[0]!.message), /assets\/images\/absent\.svg/);
});
