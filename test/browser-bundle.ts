import { builtinModules } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { ROOT } from './helpers.ts';

// Code bundled for a browser (a Worker, a page) as esbuild bundles it there: platform browser, and an
// import of Node (a node: module, a built-in by its bare name, @elabora/node) fails the build, naming
// it and the file that imports it. What builds runs without Node.

const BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('_')));

const noNode: esbuild.Plugin = {
  name: 'no-node',
  setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path: spec, importer }) => {
      const bare = spec.replace(/^node:/, '').split('/')[0]!;
      if (spec.startsWith('node:') || BUILTINS.has(bare) || spec === '@elabora/node' || spec.startsWith('@elabora/node/')) {
        return { errors: [{ text: `Node in a browser's bundle: ${spec}, imported by ${path.relative(ROOT, importer) || importer}` }] };
      }
      return undefined;
    });
  }
};

export interface BrowserBundle {
  code: string;
  // The files it holds, relative to the repository.
  inputs: string[];
}

// entry: a file of the repository, or source code (resolved from the repository's root).
export async function bundleForBrowser(entry: { file: string } | { source: string }): Promise<BrowserBundle> {
  const result = await esbuild.build({
    ...('file' in entry ? { entryPoints: [path.resolve(ROOT, entry.file)] } : { stdin: { contents: entry.source, resolveDir: ROOT, loader: 'ts', sourcefile: 'entry.ts' } }),
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome120', metafile: true, logLevel: 'silent', plugins: [noNode]
  });
  return { code: result.outputFiles[0]!.text, inputs: Object.keys(result.metafile.inputs) };
}
