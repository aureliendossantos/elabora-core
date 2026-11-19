import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { objectBuildOptions, objectPlugins } from '@elabora/core/objects/bundle';
import type { ObjectLibraries } from '@elabora/core/objects/bundle';
import { BASE_LAYER } from '@elabora/core/render/styles';
import nodePackage from '../package.json' with { type: 'json' };
import { fieldOf, errorMessage } from './util/values.ts';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.resolve('@elabora/player/package.json'))), 'src');
export const ELABORA_VERSION: string = nodePackage.version;

const cache = new Map<string, string>();
async function bundle(entry: string, { minify = true }: { minify?: boolean } = {}): Promise<string> {
  const key = `${entry}|${minify}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'iife', target: 'es2020', minify, write: false,
    legalComments: 'none', logLevel: 'error', charset: 'utf8',
    alias: { '@elabora/player/object-host': path.join(RUNTIME, 'object-host.ts') }
  });
  const text = result.outputFiles[0].text;
  cache.set(key, text);
  return text;
}

// An entry point of the player package bundled for the browser (canvas.ts: the editor canvas).
export function runtimeBundle(entry: string, { minify = true }: { minify?: boolean } = {}): Promise<string> {
  return bundle(path.join(RUNTIME, entry), { minify });
}

// Also shipped as a source entry in desktop builds: no workspace symlinks are needed at runtime.
export function objectTestHostBundle(): Promise<string> {
  return bundle(path.join(PACKAGE_ROOT, 'src/objects/test-host.ts'), { minify: false });
}

// The charts' stylesheets (packages/player/src/charts/*.css), shared ones first, in a fixed order.
function chartStyles(): string[] {
  const files = fs.readdirSync(path.join(RUNTIME, 'charts')).filter((file) => file.endsWith('.css')).sort();
  return ['charts.css', ...files.filter((file) => file !== 'charts.css')].map((file) => `charts/${file}`);
}

// The player files of every package, by path in the package.
export async function runtimeFiles({ debug = false }: { debug?: boolean } = {}): Promise<Record<string, string>> {
  const banner = `/* Elabora player ${ELABORA_VERSION} — Apache-2.0 */\n`;
  return {
    'elabora/player.js': banner + await bundle(path.join(RUNTIME, 'player.ts'), { minify: !debug }),
    'elabora/object-frame.js': banner + await bundle(path.join(RUNTIME, 'object-frame.ts'), { minify: !debug }),
    // The player stylesheet sits in the first cascade layer: the course's theme, component
    // stylesheets and overrides follow in the order of the course's cascade (elabora/theme.css).
    // Charts' styles (D60) come with it: charts.css, then each type's; then dialogue characters' and dialogues' (D61).
    'elabora/player.css': `${BASE_LAYER}\n@layer elabora.base {\n${['player.css', ...chartStyles(), 'character/character.css', 'dialogue/dialogue.css'].map((file) => fs.readFileSync(path.join(RUNTIME, file), 'utf8')).join('\n')}\n}\n`
  };
}

// elabora/lms.js (lms-boot.ts): the start of a cmi5 or xAPI package, which connects to the LMS
// before it starts the player. Packages in other formats keep their bytes without it.
export async function lmsBootFile({ debug = false }: { debug?: boolean } = {}): Promise<Record<string, string>> {
  return { 'elabora/lms.js': `/* Elabora player ${ELABORA_VERSION} — Apache-2.0 */\n` + await bundle(path.join(RUNTIME, 'lms-boot.ts'), { minify: !debug }) };
}

// The player's interface sounds (packages/player/src/interface-sounds/, D67), by their path in the package
// (elabora/sounds/<role>.m4a): a package ships those its course data names.
export function playerSoundFile(name: string): Buffer {
  const file = /^elabora\/sounds\/([a-z]+\.m4a)$/.exec(name)?.[1];
  if (!file) throw new Error(`Not a player sound: ${name}`);
  return fs.readFileSync(path.join(RUNTIME, 'interface-sounds', file));
}

// The review bridge (review.ts, docs/review-bridge.md): in review builds only, after player.js.
export async function reviewFiles({ debug = false }: { debug?: boolean } = {}): Promise<Record<string, string>> {
  return { 'elabora/review.js': `/* Elabora review bridge ${ELABORA_VERSION} — Apache-2.0 */\n` + await bundle(path.join(RUNTIME, 'review.ts'), { minify: !debug }) };
}

export function vendorThree(): Record<string, Buffer> {
  const file = path.join(PACKAGE_ROOT, 'vendor/three-r186.js');
  if (!fs.existsSync(file)) throw new Error('vendor/three-r186.js missing: run `pnpm run vendor` in the Elabora package.');
  return { 'elabora/vendor/three-r186.js': fs.readFileSync(file), 'elabora/vendor/three-LICENSE.txt': fs.readFileSync(path.join(PACKAGE_ROOT, 'vendor/three-LICENSE.txt')) };
}

// The native bundler's libraries: D3 (ISC; its notice goes with the code) from its package, and the chart
// kit from the player's sources, both found on this disk.
const D3_ENTRY = fileURLToPath(import.meta.resolve('d3'));
const D3_VERSION = (JSON.parse(fs.readFileSync(path.join(path.dirname(D3_ENTRY), '..', 'package.json'), 'utf8')) as { version: string }).version;
const D3_NOTICE = `/*! D3 ${D3_VERSION} (https://d3js.org) | ISC License | Copyright 2010-2023 Mike Bostock */`;
const CHART_KIT = path.join(RUNTIME, 'charts', 'kit.ts');
const diskLibraries: ObjectLibraries = {
  d3: { contents: `${D3_NOTICE}\nexport * from ${JSON.stringify(D3_ENTRY)};\n`, resolveDir: path.dirname(D3_ENTRY) },
  charts: { path: CHART_KIT }
};

// object.js of an object's folder, bundled by the native esbuild.
export async function compileObjectCode(objectDir: string, { minify = true }: { minify?: boolean } = {}): Promise<string> {
  const result = await esbuild.build({ ...objectBuildOptions({ minify }), entryPoints: [path.join(objectDir, 'object.js')], plugins: objectPlugins(diskLibraries) as esbuild.Plugin[] });
  return result.outputFiles[0].text;
}

// D3 and the chart kit as the source of two ES modules, for a host without this disk (a browser's
// worker bundling objects with esbuild-wasm, given them as ObjectLibraries): each bundled whole,
// unminified, so that an object's own bundle shakes and minifies them as it does from the disk.
export async function objectLibrarySources(): Promise<{ d3: string; charts: string }> {
  const one = async (entry: string, banner: string) => (await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', target: 'es2020', write: false, legalComments: 'inline', logLevel: 'silent', charset: 'utf8', banner: { js: banner } })).outputFiles[0].text;
  return { d3: await one(D3_ENTRY, D3_NOTICE), charts: await one(CHART_KIT, '') };
}

// What esbuild reports when a bundle fails (its messages), or the error's message.
export function bundleErrorMessage(error: unknown): string {
  const messages = fieldOf(error, 'errors');
  const texts = Array.isArray(messages) ? messages.map((message) => fieldOf(message, 'text')).filter((text) => typeof text === 'string') : [];
  return texts.join('; ') || errorMessage(error);
}

// The canvas page. It sits where the root of a package sits, so that the paths of the course data resolve as in a
// package. Its connector is the Node host's event stream (a script this host serves), or the relay page's script
// (the web app's canvas host: its files and the relay are static there).
export function canvasPageHtml(connector: 'events' | 'relay' = 'events'): string {
  const script = connector === 'events' ? '<script src="elabora/canvas-connect.js"></script>' : '<script src="/relay-page.js" data-relay-role="canvas"></script>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Elabora canvas</title>
<link rel="stylesheet" href="elabora/player.css">
</head>
<body>
<div id="elabora-app"></div>
<script src="elabora/canvas.js"></script>
${script}
</body>
</html>
`;
}

// The web app's relay (D118, D119): its service worker (/relay.js, one script for the canvas host and the
// frames host, whose Worker writes its policy before it), the script of the relay pages (/relay-page.js),
// the frames host's page (/relay.html) and the canvas page for the relay. The script's version changes
// with it.
export async function relayFiles({ debug = false }: { debug?: boolean } = {}): Promise<Record<string, string>> {
  const build = async (entry: string, define: Record<string, string> = {}) => (await esbuild.build({ entryPoints: [path.join(RUNTIME, entry)], bundle: true, format: 'iife', target: 'es2020', minify: !debug, write: false, legalComments: 'none', logLevel: 'error', charset: 'utf8', define })).outputFiles[0].text;
  const unversioned = await build('worker/relay.ts');
  const version = `${ELABORA_VERSION}-${crypto.createHash('sha256').update(unversioned).digest('hex').slice(0, 12)}`;
  return {
    'relay.js': await build('worker/relay.ts', { __RELAY_VERSION__: JSON.stringify(version) }),
    'relay-page.js': await build('relay-page.ts'),
    'relay.html': '<!doctype html>\n<meta charset="utf-8">\n<title>Elabora relay</title>\n<script src="/relay-page.js" data-relay-role="frames"></script>\n',
    'canvas/index.html': canvasPageHtml('relay')
  };
}
