import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFiles } from '@elabora/node/project-reader';
import { loadProject } from '@elabora/core/project/load';
import { BrowserAlign } from '@elabora/engine/browser/models/align';
import { memoryCopy } from '@elabora/engine/browser/store';
import { NETWORK_SAMPLE } from '../helpers.ts';

// When a browser's align service says no, before any model is downloaded or any line read: on a
// phone (no aligner offered, an alignment not here), and a model on a computer with too little memory
// for it (the French one, 1.6 GB at its peak, under 8 GB as the browser says it).

const { files } = readProjectFiles(NETWORK_SAMPLE);
const project = loadProject(files, { root: 'network' });
const asked: string[] = [];
const never = { ask: async () => { asked.push('asked'); return { id: 0, answer: { error: 'not here' } }; }, forget() {}, close() {} };
const service = () => new BrowserAlign(never as never, never as never, {
  files: () => files, project: () => project, store: memoryCopy({ link: { team: 't', project: 'p', client: 'c', person: { id: 'a', name: 'A' }, head: 0, epoch: null, waiting: [], journal: 0 }, confirmed: files }),
  base: 'https://models.elabora.test', setNarrationWords: async () => null, progress: () => {}
});

const navigator = globalThis.navigator as Navigator & { deviceMemory?: number };
const as = (agent: string, memory?: number) => {
  Object.defineProperty(navigator, 'userAgent', { value: agent, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { value: memory, configurable: true });
};
afterEach(() => {
  delete (navigator as { userAgent?: string }).userAgent;
  delete navigator.deviceMemory;
});

test('a browser\'s align service on a phone: no aligner, an alignment not here', async () => {
  as('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Mobile Safari/537.36');
  assert.deepEqual(await service().aligners('fr'), []);
  await assert.rejects(service().alignNarration({ screen: 'chemin', force: true }), (error: { kind?: string; code?: string }) => error.kind === 'not-available' && error.code === 'E_LOCAL_AI_PLATFORM');
  assert.deepEqual(asked, [], 'nothing read, nothing asked of the Workers');
});

test('a browser\'s align service with too little memory for a language\'s model: not here, said why', async () => {
  as('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36', 4);
  await assert.rejects(service().alignNarration({ screen: 'chemin', force: true }), (error: { kind?: string; code?: string; message?: string }) => error.kind === 'not-available' && error.code === 'E_LOCAL_AI_MEMORY' && /8 GB/.test(error.message ?? ''));
  assert.deepEqual(asked, []);
});
