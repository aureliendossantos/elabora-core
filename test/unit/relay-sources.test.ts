import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as wasm from 'esbuild-wasm';
import { readProjectFiles } from '@elabora/node/project-reader';
import { objectLibrarySources } from '@elabora/node/bundles';
import { folderRelaySource } from '@elabora/node/canvas/source';
import { relaySource } from '@elabora/engine/browser/relay';
import { loadProject } from '@elabora/core/project/load';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { RenderedFileKind } from '@elabora/core/render/screen';
import type { RelayAnswer, RelayRequest } from '@elabora/player/relay-protocol';
import { GEARSET } from '../helpers.ts';

// The desktop's local server answers the relay's questions from the project's folder, the browser's engine from
// its copy: the same question gets the same answer from both (the file, its type and size, an object's frame page
// and its code), apart from what the folder has that the module does not.
const bytesOf = async (answer: RelayAnswer): Promise<Buffer> => {
  assert.equal(answer.status, 'ok');
  if (answer.status !== 'ok') throw new Error('unreachable');
  return Buffer.from(typeof answer.body === 'string' ? new TextEncoder().encode(answer.body) : new Uint8Array(await answer.body.arrayBuffer()));
};

test('relay sources: the folder and the browser engine answer a file, an object\'s frame page and its code the same', { timeout: 120000 }, async () => {
  // Out of this repository: esbuild reads the nearest package.json of an object's folder (see object-bundle.test.ts).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-relay-sources-'));
  fs.cpSync(GEARSET, root, { recursive: true });
  try {
    await wasm.initialize({});
    const sources = await objectLibrarySources();
    const { files } = readProjectFiles(root);
    const project = loadProject(files, { root });
    const screen = [...project.screens.keys()].find((id) => renderScreen(project, id, {}, createRenderContext(project)).files.some((file) => file.kind === 'object-frame'))!;
    const listed = new Map<string, RenderedFileKind>(renderScreen(project, screen, {}, createRenderContext(project)).files.map((file) => [file.path, file.kind]));
    assert.ok([...listed.values()].includes('object-code'));
    const folder = folderRelaySource({ root, debug: false, allowed: () => listed, language: () => project.course?.language ?? 'en' });
    const medium = async (hash: string): Promise<Blob | null> => {
      const found = [...files].find(([, file]) => file.kind === 'binary' && file.hash === hash);
      return found ? new Blob([fs.readFileSync(path.join(root, found[0]))]) : null;
    };
    const frames = relaySource('frames', { files: () => files, project: () => project, medium, objects: async () => ({ bundler: wasm, libraries: { d3: { contents: sources.d3 }, charts: { contents: sources.charts } } }) });
    const canvas = relaySource('canvas', { files: () => files, project: () => project, medium });

    // Every file a render listed that is a file.
    const asked: string[] = [];
    for (const [file, kind] of listed) {
      if (kind === 'object-frame' || kind === 'object-code') continue;
      const request: RelayRequest = { kind: 'file', path: file };
      const [a, b] = [await folder.get(request), await canvas.get(request)];
      assert.equal(a.status, 'ok', file);
      assert.equal(b.status, 'ok', file);
      if (a.status !== 'ok' || b.status !== 'ok') continue;
      assert.equal(a.type, b.type, file);
      assert.equal(a.size, b.size, file);
      assert.ok((await bytesOf(a)).equals(await bytesOf(b)), file);
      asked.push(file);
    }
    assert.ok(asked.length > 0, 'files compared');
    // The frame page and the code of each object a render listed.
    for (const [file, kind] of listed) {
      if (kind !== 'object-frame' && kind !== 'object-code') continue;
      const request: RelayRequest = { kind, object: file.split('/')[1]! };
      const [a, b] = [await folder.get(request), await frames.get(request)];
      assert.equal(a.status, 'ok', file);
      assert.equal(b.status, 'ok', file);
      if (a.status !== 'ok' || b.status !== 'ok') continue;
      assert.equal(a.type, b.type, file);
      assert.ok((await bytesOf(a)).equals(await bytesOf(b)), `${file}: the same bytes`);
    }
    // Not the same: a file no render listed is the folder's to refuse (it holds more than the module), and what
    // neither has is nobody's.
    assert.equal((await folder.get({ kind: 'file', path: 'course.json' })).status, 'not-found');
    assert.equal((await canvas.get({ kind: 'file', path: 'course.json' })).status, 'ok');
    for (const source of [folder, canvas]) assert.equal((await source.get({ kind: 'file', path: 'assets/none.png' })).status, 'not-found');
    assert.equal((await folder.get({ kind: 'object-code', object: 'unlisted' })).status, 'not-found');
    // A file is read as it is asked: a range of a folder's file is the bytes of the range.
    const [first] = [...listed].filter(([, kind]) => kind === 'object' || kind === 'font');
    if (first) {
      const answer = await folder.get({ kind: 'file', path: first[0] });
      if (answer.status === 'ok' && typeof answer.body !== 'string') assert.equal(await answer.body.slice(1, 3).text(), (await answer.body.text()).slice(1, 3));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
