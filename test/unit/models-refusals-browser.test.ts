import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFiles } from '@elabora/node/project-reader';
import { loadProject } from '@elabora/core/project/load';
import { BrowserAlign } from '@elabora/engine/browser/models/align';
import { BrowserPocket } from '@elabora/engine/browser/voices/pocket';
import { memoryCopy } from '@elabora/engine/browser/store';
import { NETWORK_SAMPLE } from '../helpers.ts';

// When a browser's models say no, before any is downloaded or any line read or said: on a phone (no
// aligner offered, an alignment not here, a local voice not installed), and a language's models on a
// computer with too little memory for them (the French ones, 1.6 and 2.3 GB at their peak, under 8 GB
// as the browser says it).

const { files } = readProjectFiles(NETWORK_SAMPLE);
const project = loadProject(files, { root: 'network' });
const asked: string[] = [];
const never = { ask: async () => { asked.push('asked'); return { id: 0, answer: { error: 'not here' } }; }, forget() {}, close() {} };
const service = () => new BrowserAlign(never as never, never as never, {
  files: () => files, project: () => project, store: memoryCopy({ link: { team: 't', project: 'p', client: 'c', person: { id: 'a', name: 'A' }, head: 0, epoch: null, waiting: [], journal: 0 }, confirmed: files }),
  base: 'https://models.elabora.test', setNarrationWords: async () => null, progress: () => {}
});

const pocket = () => new BrowserPocket(never as never, { catalogue: 'https://app.elabora.test/voices/', models: 'https://models.elabora.test' });

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

test('a browser\'s local voices on a phone, and the French one with too little memory: not here, said why', async () => {
  as('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1');
  await assert.rejects(pocket().install('en'), (error: { code?: string }) => error.code === 'E_LOCAL_AI_PLATFORM');
  await assert.rejects(pocket().hold('en'), (error: { code?: string }) => error.code === 'E_LOCAL_AI_PLATFORM');
  as('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36', 4);
  await assert.rejects(pocket().install('fr'), (error: { code?: string; message?: string }) => error.code === 'E_LOCAL_AI_MEMORY' && /8 GB/.test(error.message ?? ''));
  assert.deepEqual(asked, [], 'nothing asked of the models Worker');
});
