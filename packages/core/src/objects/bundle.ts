// How a free object's code is bundled, apart from the machine that does it: the options, the plugins
// (three and its add-ons as globals, D3 and the chart kit as libraries) and the resolution of an
// object's own files in a table of files, for any host that has esbuild: @elabora/node with the
// native one from a folder, a browser's worker with esbuild-wasm from a project's files. Nothing here
// reads a disk or imports esbuild; the host gives it the build function and the libraries.
//
// Free objects are authored as ES modules (import * as THREE from 'three'). The build turns them
// into a classic script: classic scripts load inside an opaque-origin sandbox without CORS, while
// module scripts would need CORS headers that LMS servers do not send.

import type { ObjectManifest } from '@elabora/format';
import type { ProjectFiles } from '../project/files.ts';
import { escapeHtml } from '../util/html.ts';

// The part of esbuild's plugin API these plugins use (declared with methods, so that esbuild's own
// types and esbuild-wasm's both take them).
export interface BundlePlugin {
  name: string;
  setup(build: {
    onResolve(options: { filter: RegExp; namespace?: string }, callback: (args: { path: string; importer: string }) => { path: string; namespace?: string } | undefined): void;
    onLoad(options: { filter: RegExp; namespace?: string }, callback: (args: { path: string }) => { contents?: string; loader?: 'js' | 'json'; resolveDir?: string; errors?: { text: string }[] } | undefined): void;
  }): void;
}

// Where D3 and the chart kit come from: the source of an ES module, or the path of one that the
// bundler finds itself (a host with a disk).
export type ObjectLibrary = { contents: string; resolveDir?: string } | { path: string };
export interface ObjectLibraries {
  // `import … from 'd3'`
  d3: ObjectLibrary;
  // `import … from '@elabora/charts'`
  charts: ObjectLibrary;
}

// The add-ons of three an object may import (`three/addons/…`): the ones the player ships.
export const ALLOWED_THREE_ADDONS = ['loaders/GLTFLoader.js', 'controls/OrbitControls.js'];
export const OBJECT_GLOBAL = '__elaboraObject';

// Legal comments (/*! … */, @license, @preserve) go to the end of the script: an object that
// includes code from elsewhere ships its notice in every package (docs/free-object-contract.md).
export function objectBuildOptions({ minify = true }: { minify?: boolean } = {}) {
  return { bundle: true, format: 'iife', globalName: OBJECT_GLOBAL, target: 'es2020', minify, write: false, legalComments: 'eof', logLevel: 'silent', charset: 'utf8' } as const;
}

const threeGlobals: BundlePlugin = {
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
function chartLibraries({ d3, charts }: ObjectLibraries): BundlePlugin {
  return {
    name: 'elabora-chart-libraries',
    setup(build) {
      for (const [filter, name, library] of [[/^d3$/, 'd3', d3], [/^@elabora\/charts$/, 'charts', charts]] as const) {
        if ('path' in library) { build.onResolve({ filter }, () => ({ path: library.path })); continue; }
        build.onResolve({ filter }, () => ({ path: name, namespace: `elabora-${name}` }));
        build.onLoad({ filter: /.*/, namespace: `elabora-${name}` }, () => ({ contents: library.contents, loader: 'js', ...(library.resolveDir ? { resolveDir: library.resolveDir } : {}) }));
      }
    }
  };
}

// The plugins of every object build: three as globals, the libraries.
export function objectPlugins(libraries: ObjectLibraries): BundlePlugin[] {
  return [threeGlobals, chartLibraries(libraries)];
}

// A path as an import writes it (./a, ../b/c.js, /d), from the folder `base` of the importer (ends with /).
function resolvePath(base: string, wanted: string): string {
  const parts = (wanted.startsWith('/') ? wanted : base + wanted).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '' && part !== '.') out.push(part);
  }
  return `/${out.join('/')}`;
}

// An object's own files (the entry, what it imports by a relative path) read from a table of files
// instead of a disk: the paths of the table are the project's (objects/<id>/object.js), rooted at /.
function objectFiles(files: ProjectFiles): BundlePlugin {
  return {
    name: 'elabora-project-files',
    setup(build) {
      build.onResolve({ filter: /^\.{0,2}\// }, (args) => {
        const base = args.importer ? args.importer.slice(0, args.importer.lastIndexOf('/') + 1) : '/';
        return { path: resolvePath(base, args.path), namespace: 'elabora-project' };
      });
      build.onLoad({ filter: /.*/, namespace: 'elabora-project' }, (args) => {
        const file = files.get(args.path.slice(1));
        if (!file || file.kind !== 'text') return { errors: [{ text: `No text file ${args.path}` }] };
        return { contents: file.text, loader: args.path.endsWith('.json') ? 'json' : 'js' };
      });
    }
  };
}

// esbuild's build function as far as it is used here.
export interface ObjectBundler {
  build(options: ReturnType<typeof objectBuildOptions> & { entryPoints: string[]; plugins: BundlePlugin[] }): Promise<{ outputFiles?: readonly { text: string }[] }>;
}

// object.js of an object of the project, bundled from its files: the same code, byte for byte, as the
// native bundler gives from the object's folder (test/unit/object-bundle.test.ts).
export async function compileObjectFromFiles(bundler: ObjectBundler, files: ProjectFiles, objectId: string, libraries: ObjectLibraries, { minify = true }: { minify?: boolean } = {}): Promise<string> {
  const result = await bundler.build({ ...objectBuildOptions({ minify }), entryPoints: [`/objects/${objectId}/object.js`], plugins: [objectFiles(files), ...objectPlugins(libraries)] });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error(`The bundle of objects/${objectId}/object.js has no output`);
  return output.text;
}

// The page of an object's frame (frame.html, next to its object.js): no network at all, scripts from
// the package only.
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
