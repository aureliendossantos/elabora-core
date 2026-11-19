// The Node canvas host's answers to the relay's questions (D118), from the project folder: the same questions the
// browser engine answers from its copy. A file the pushed renders listed (or the narration and sounds the editor
// plays whatever the screen shown), an object's frame page and its bundled code; nothing else of the folder.
// A file is a Blob that reads the disk as it is used, so that a range is read, not the whole file.

import fs from 'node:fs';
import path from 'node:path';
import type { ObjectManifest } from '@elabora/format';
import type { RenderedFileKind } from '@elabora/core/render/screen';
import { projectPath } from '@elabora/core/project/files';
import { objectFrameHtml } from '@elabora/core/objects/bundle';
import type { RelayAnswer, RelaySource } from '@elabora/player/relay-protocol';
import { compileObjectCode, bundleErrorMessage } from '../bundles.ts';
import { mimeType } from '../http/files.ts';

// A narration line's audio (docs/decisions.md D24), which no render lists: the editor plays it.
const NARRATION_AUDIO = /^assets\/narration\/[^/]+\/[^/]+\/[^/]+\.m4a$/;
// A sound of the course (D67): the editor's sound browser and inspector play it on any screen, and a
// sound just added or made is in no render yet.
const COURSE_SOUND = /^assets\/sounds\/[^/]+\.(?:flac|m4a|mp3|ogg|oga|opus|wav)$/;

export interface FolderSourceOptions {
  // The project folder.
  root: string;
  // Unminified bundles (readable stacks in the app's developer tools).
  debug: boolean;
  // The project files the renders listed, by path: the only ones served.
  allowed: () => ReadonlyMap<string, RenderedFileKind>;
  // The language of the course shown, for an object's frame page.
  language: () => string;
}

export function folderRelaySource({ root, debug, allowed, language }: FolderSourceOptions): RelaySource {
  const folder = path.resolve(root);
  // object.js of an object, bundled again when a file of its folder changed.
  const objectCode = new Map<string, { signature: string; code: Promise<string> }>();
  const compiled = (id: string): Promise<string> => {
    const dir = path.join(folder, 'objects', id);
    const signature = folderSignature(dir);
    const cached = objectCode.get(id);
    if (cached && cached.signature === signature) return cached.code;
    const code = compileObjectCode(dir, { minify: !debug });
    objectCode.set(id, { signature, code });
    return code;
  };
  return {
    async get(request): Promise<RelayAnswer> {
      if (request.kind === 'file') {
        const rel = projectPath(request.path);
        const kind = rel === null ? undefined : allowed().get(rel) ?? (NARRATION_AUDIO.test(rel) || COURSE_SOUND.test(rel) ? 'asset' : undefined);
        // A frame's page and its code are made, never read as files.
        if (rel === null || !kind || kind === 'object-frame' || kind === 'object-code') return { status: 'not-found' };
        const file = path.join(folder, ...rel.split('/'));
        let stat: fs.Stats;
        try { stat = fs.statSync(file); } catch { return { status: 'not-found' }; }
        if (!stat.isFile()) return { status: 'not-found' };
        // Files change while the app runs (an agent writes them): the page revalidates them every time.
        return { status: 'ok', type: mimeType(rel), size: stat.size, etag: `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`, body: await fs.openAsBlob(file) };
      }
      const wanted = request.kind === 'object-frame' ? 'frame.html' : 'object.js';
      if (allowed().get(`objects/${request.object}/${wanted}`) !== request.kind) return { status: 'not-found' };
      if (request.kind === 'object-frame') {
        const manifest = readManifest(path.join(folder, 'objects', request.object, 'object.manifest.json'));
        if (!manifest) return { status: 'not-found', message: 'no object manifest' };
        const html = objectFrameHtml(manifest, { language: language() });
        return { status: 'ok', type: mimeType('frame.html'), size: Buffer.byteLength(html), body: html };
      }
      try {
        const code = await compiled(request.object);
        return { status: 'ok', type: mimeType('object.js'), size: Buffer.byteLength(code), body: code };
      } catch (error) {
        return { status: 'failed', message: `Build of objects/${request.object}/object.js failed: ${bundleErrorMessage(error)}` };
      }
    }
  };
}

function readManifest(file: string): ObjectManifest | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as ObjectManifest; } catch { return null; }
}

// Paths, sizes and modification times of the files of a folder: it changes when one of them does.
function folderSignature(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) { try { const stat = fs.statSync(file); parts.push(`${file}:${stat.size}:${stat.mtimeMs}`); } catch { /* removed meanwhile */ } }
    }
  };
  walk(dir);
  return parts.join('|');
}
