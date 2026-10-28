import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { ALLOWED_THREE_ADDONS } from '@elabora/core/validate/objects';
import { BASE_LAYER } from '@elabora/core/render/styles';
import { escapeHtml } from '@elabora/core/util/html';
import type { ObjectManifest } from '@elabora/format';
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
  if (!fs.existsSync(file)) throw new Error('vendor/three-r186.js missing: run `npm run vendor` in the Elabora package.');
  return { 'elabora/vendor/three-r186.js': fs.readFileSync(file), 'elabora/vendor/three-LICENSE.txt': fs.readFileSync(path.join(PACKAGE_ROOT, 'vendor/three-LICENSE.txt')) };
}

// Free objects are authored as ES modules (import * as THREE from 'three'). The build turns them
// into a classic script: classic scripts load inside an opaque-origin sandbox without CORS, while
// module scripts would need CORS headers that LMS servers do not send.
const threeGlobals: esbuild.Plugin = {
  name: 'elabora-three-globals',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: 'three', namespace: 'elabora-global' }));
    build.onResolve({ filter: /^three\/addons\// }, (args) => ({ path: args.path, namespace: 'elabora-global' }));
    build.onLoad({ filter: /.*/, namespace: 'elabora-global' }, (args) => {
      if (args.path === 'three') return { contents: 'module.exports = self.ELABORA_THREE.THREE;', loader: 'js' };
      const addon = args.path.slice('three/addons/'.length);
      if (!ALLOWED_THREE_ADDONS.includes(addon)) return { errors: [{ text: `three addon "${addon}" is not vendored (allowed: ${ALLOWED_THREE_ADDONS.join(', ')})` }] };
      return { contents: `module.exports = self.ELABORA_THREE.addons[${JSON.stringify(addon)}];`, loader: 'js' };
    });
  }
};

// Charts in free objects (D60): `import * as d3 from 'd3'` bundles D3 (ISC; its notice goes with the
// code) and `import { … } from '@elabora/charts'` the kit Elabora's own charts move with.
const D3_ENTRY = fileURLToPath(import.meta.resolve('d3'));
const D3_VERSION = (JSON.parse(fs.readFileSync(path.join(path.dirname(D3_ENTRY), '..', 'package.json'), 'utf8')) as { version: string }).version;
const chartLibraries: esbuild.Plugin = {
  name: 'elabora-chart-libraries',
  setup(build) {
    build.onResolve({ filter: /^d3$/ }, () => ({ path: 'd3', namespace: 'elabora-d3' }));
    build.onLoad({ filter: /.*/, namespace: 'elabora-d3' }, () => ({
      contents: `/*! D3 ${D3_VERSION} (https://d3js.org) | ISC License | Copyright 2010-2023 Mike Bostock */\nexport * from ${JSON.stringify(D3_ENTRY)};\n`,
      loader: 'js', resolveDir: path.dirname(D3_ENTRY)
    }));
    build.onResolve({ filter: /^@elabora\/charts$/ }, () => ({ path: path.join(RUNTIME, 'charts', 'kit.ts') }));
  }
};

// Legal comments (/*! … */, @license, @preserve) go to the end of the script: an object that
// includes code from elsewhere ships its notice in every package (docs/free-object-contract.md).
export async function compileObjectCode(objectDir: string, { minify = true }: { minify?: boolean } = {}): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.join(objectDir, 'object.js')], bundle: true, format: 'iife', globalName: '__elaboraObject',
    target: 'es2020', minify, write: false, legalComments: 'eof', logLevel: 'silent', plugins: [threeGlobals, chartLibraries], charset: 'utf8'
  });
  return result.outputFiles[0].text;
}

// What esbuild reports when a bundle fails (its messages), or the error's message.
export function bundleErrorMessage(error: unknown): string {
  const messages = fieldOf(error, 'errors');
  const texts = Array.isArray(messages) ? messages.map((message) => fieldOf(message, 'text')).filter((text) => typeof text === 'string') : [];
  return texts.join('; ') || errorMessage(error);
}

export function objectFrameHtml(manifest: Pick<ObjectManifest, 'title' | 'requires'>, { language = 'en' }: { language?: string } = {}): string {
  const scripts: string[] = [];
  if (manifest.requires?.three) scripts.push('../../elabora/vendor/three-r186.js');
  scripts.push('object.js', '../../elabora/object-frame.js');
  // Content-Security-Policy of the frame: no network at all, scripts from the package only.
  const csp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'none'; worker-src blob:";
  return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(manifest.title)}</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#root{position:absolute;inset:0}</style>
</head>
<body>
<div id="root"></div>
${scripts.map((script) => `<script src="${script}"></script>`).join('\n')}
</body>
</html>
`;
}
