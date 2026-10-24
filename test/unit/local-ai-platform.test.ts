import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localAiSupported } from '@elabora/node/models/platform';

test('local AI support excludes Mac Intel, while preserving Apple Silicon and Windows x64', () => {
  assert.equal(localAiSupported('darwin', 'x64'), false);
  assert.equal(localAiSupported('darwin', 'arm64'), true);
  assert.equal(localAiSupported('win32', 'x64'), true);
});

test('Intel lists removable models, offers no local transcription/alignment and refuses installation before fetching', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-intel-test-'));
  try {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    globalThis.fetch = () => { throw new Error('Must not fetch'); };
    const { optionalDownloads, installDownload, uninstallDownload } = await import('@elabora/node/downloads/index');
    const { aligners, alignsAtOnce, alignAudio } = await import('@elabora/node/align/index');
    const { transcribers } = await import('@elabora/node/transcribe/index');
    const { pocketProvider } = await import('@elabora/node/voice/pocket/index');
    const { localVoices } = await import('@elabora/node/voice/index');
    const { loadOrt } = await import('@elabora/node/voice/pocket/runtime');
    const views = optionalDownloads();
    assert.ok(views.length > 0);
    assert.ok(views.every(v => v.supported === false));
    for (const view of views) {
      await assert.rejects(installDownload(view.id), e => e.code === 'E_LOCAL_AI_PLATFORM');
      await assert.rejects(installDownload(view.id, { force: true }), e => e.code === 'E_LOCAL_AI_PLATFORM');
      await uninstallDownload(view.id);
    }
    assert.deepEqual(aligners('fr'), []);
    assert.equal(alignsAtOnce('fr'), null);
    assert.equal(transcribers('fr').local, null);
    assert.equal(pocketProvider.status('fr').supported, false);
    assert.ok(localVoices().every(v => v.supported === false));
    await assert.rejects(pocketProvider.install('fr'), e => e.code === 'E_LOCAL_AI_PLATFORM');
    await assert.rejects(alignAudio('absent.wav', 'Bonjour', 'fr'), e => e.code === 'E_LOCAL_AI_PLATFORM');
    assert.throws(() => loadOrt(), e => e.code === 'E_LOCAL_AI_PLATFORM');
  `], { cwd: import.meta.dirname + '/../..', env: { ...process.env,
    ELABORA_LOCAL_DATA_DIR: temp, ELABORA_VOICE_MODELS_DIR: path.join(temp, 'voices'),
    ELABORA_ALIGNER_MODELS_DIR: path.join(temp, 'aligners'), ELABORA_TRANSCRIBER_MODELS_DIR: path.join(temp, 'transcribers')
  }, stdio: 'pipe' });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
