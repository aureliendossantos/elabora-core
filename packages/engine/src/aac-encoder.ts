import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

// The AAC encoder in wasm that a host serves to a browser's media Worker, for a browser without its own
// (Chromium and Firefox under Linux; D107, D135), and what its licence asks the host to serve with it.
// Mediabunny's @mediabunny/aac-encoder: its JavaScript under the MPL-2.0, its wasm built from FFmpeg's
// libavcodec, under the LGPL v2.1 or later.

// The package's folder, from its entry (it exports no package.json).
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@mediabunny/aac-encoder'))), '../..');

// The module at the address the host gives the media Worker (aacEncoder): one file, the encoder and
// its wasm, whose 'mediabunny' is the Worker's own copy (globalThis.ElaboraMediabunny, encoders.ts),
// so that it registers into the Mediabunny that encodes.
export async function aacEncoderModule(): Promise<string> {
  const result = await esbuild.build({
    stdin: { contents: "export { registerAacEncoder } from '@mediabunny/aac-encoder';", resolveDir: PACKAGE, loader: 'js' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome120', logLevel: 'silent', legalComments: 'inline',
    plugins: [{
      name: 'worker-mediabunny',
      setup(build) {
        build.onResolve({ filter: /^mediabunny$/ }, () => ({ path: 'mediabunny', namespace: 'worker' }));
        build.onLoad({ filter: /.*/, namespace: 'worker' }, () => ({ contents: 'export const { CustomAudioEncoder, EncodedPacket, Logging, registerEncoder } = globalThis.ElaboraMediabunny;', loader: 'js' }));
      }
    }]
  });
  return result.outputFiles[0]!.text;
}

// Where the wasm comes from, as the package's README says it (test/unit/aac-encoder.test.ts reads it
// again at each upgrade): FFmpeg unmodified at this commit, built by Emscripten with the package's
// bridge.c and the README's commands.
export const AAC_ENCODER = {
  package: '@mediabunny/aac-encoder',
  version: '1.66.0',
  ffmpeg: { commit: '60a2818f76dcd1fee3155b1791304af104a0fc1b', describe: 'n9.1-dev-2902-g60a2818f76d', licence: 'LGPL-2.1-or-later' },
  emscripten: '4.0.21',
  wasmSha256: '023cd419e4cf6d95ca3342f0d5b5e0ee3678bef3c393bc1bf7a8fa94f2a33b0f',
  // Where the host takes, once, the corresponding source it serves beside the module (D135).
  sources: {
    ffmpeg: 'https://github.com/FFmpeg/FFmpeg/archive/60a2818f76dcd1fee3155b1791304af104a0fc1b.tar.gz',
    mediabunny: 'https://github.com/Vanilagy/mediabunny/tree/v1.66.0/packages/aac-encoder'
  }
} as const;

// The files the host serves beside the module, by the name it serves them under and where they are:
// the notice and the build (README.md, with its provenance), the LGPL's text and FFmpeg's licence
// file, the package's own licence (MPL-2.0) and the glue the wasm was built with (bridge.c).
export function aacEncoderLicenceFiles(): { name: string; file: string }[] {
  return [
    { name: 'README.md', file: 'README.md' },
    { name: 'COPYING.LGPLv2.1', file: 'licenses/ffmpeg/COPYING.LGPLv2.1' },
    { name: 'FFMPEG-LICENSE.md', file: 'licenses/ffmpeg/LICENSE.md' },
    { name: 'LICENSE-MPL-2.0', file: 'LICENSE' },
    { name: 'bridge.c', file: 'src/bridge.c' }
  ].map(({ name, file }) => ({ name, file: path.join(PACKAGE, file) }));
}
