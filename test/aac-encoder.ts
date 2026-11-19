import * as esbuild from 'esbuild';
import { ROOT } from './helpers.ts';

// The AAC encoder in wasm as a host serves it to the media Worker for tests (D107): its 'mediabunny'
// is the Worker's own (globalThis.ElaboraMediabunny). Never part of a published package or the app.
export async function aacEncoderModule(): Promise<string> {
  const result = await esbuild.build({
    stdin: { contents: "export { registerAacEncoder } from '@mediabunny/aac-encoder';", resolveDir: ROOT, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome120', logLevel: 'silent',
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
