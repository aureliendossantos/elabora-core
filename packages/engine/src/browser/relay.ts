import type { Project } from '@elabora/core/project/model';
import type { ProjectFiles } from '@elabora/core/project/files';
import { compileObjectFromFiles, objectFrameHtml, type ObjectBundler, type ObjectLibraries } from '@elabora/core/objects/bundle';
import { mediaTypeOf } from '@elabora/core/util/media-types';
import { servedFileKind } from '@elabora/core/render/screen';
import type { RenderedFileKind } from '@elabora/core/render/screen';
import { resolveRange } from '@elabora/player/relay-protocol';
import type { RelayAnswer, RelayHost, RelayRequest, RelaySource } from '@elabora/player/relay-protocol';

// What the browser engine answers its relay (D118, D105): the open module's files from the copy, a free
// object's frame page and its code compiled in the browser (D117). What each host may ask is the
// protocol's rule (hostMayAsk, which serveRelayPort applies before the source); the source keeps one
// refusal of its own: an object is the frames host's, never the canvas's.

// How the host compiles a free object: esbuild-wasm and the libraries objects may import.
export interface ObjectCompiler {
  bundler: ObjectBundler;
  libraries: ObjectLibraries;
}

export interface RelayFrom {
  files(): ProjectFiles;
  project(): Project;
  // A medium's bytes, kept or taken from the team's (null: not kept, and the project cannot be reached).
  medium(hash: string): Promise<Blob | null>;
  // A part of a medium, without taking it whole (a long video the page plays by ranges).
  part?(hash: string, start: number, end: number): Promise<Blob | null>;
  objects?: () => Promise<ObjectCompiler>;
  // The files the canvas's renders named so far, by path (the canvas host serves only those).
  named?: () => ReadonlyMap<string, RenderedFileKind>;
}

const ENCODER = new TextEncoder();

export function relaySource(host: RelayHost, from: RelayFrom): RelaySource {
  // Compiled code by object and by the text of its files: compiled again only when they change.
  const compiled = new Map<string, { key: string; code: Promise<string> }>();
  return {
    async get(request: RelayRequest): Promise<RelayAnswer> {
      if (request.kind === 'file') {
        // The canvas host gets only what a render named, as the desktop's local server (servedFileKind).
        if (host === 'canvas' && !servedFileKind(from.named?.() ?? new Map(), request.path)) return { status: 'not-found' };
        const file = from.files().get(request.path);
        if (!file) return { status: 'not-found' };
        const type = mediaTypeOf(request.path);
        if (file.kind === 'text') return { status: 'ok', type, size: ENCODER.encode(file.text).length, body: file.text };
        if (!file.hash) return { status: 'unavailable', message: `${request.path} has no content kept` };
        // A range of a medium the copy knows the size of: that part alone (C103, the relay's part).
        const range = request.range && from.part && file.size ? resolveRange(request.range, file.size) : null;
        if (range && range !== 'unsatisfiable') {
          const part = await from.part!(file.hash, range.start, range.end);
          if (part) return { status: 'ok', type, size: file.size!, hash: file.hash, body: new Blob([part], { type }), part: range };
        }
        const medium = await from.medium(file.hash);
        if (!medium) return { status: 'unavailable', message: `${request.path} is not kept in this browser, and the project cannot be reached` };
        return { status: 'ok', type, size: medium.size, hash: file.hash, body: new Blob([medium], { type }) };
      }
      if (host !== 'frames') return { status: 'refused', message: 'An object\'s frame is served by the frames host' };
      const object = from.project().objects.get(request.object);
      if (!object?.manifest) return { status: 'not-found' };
      if (request.kind === 'object-frame') {
        const page = objectFrameHtml(object.manifest, { language: from.project().course?.language || 'en' });
        return { status: 'ok', type: 'text/html; charset=utf-8', size: ENCODER.encode(page).length, body: page };
      }
      if (!from.objects) return { status: 'unavailable', message: 'Free objects are not compiled here' };
      const files = from.files();
      const key = [...files].filter(([rel]) => rel.startsWith(`objects/${request.object}/`)).map(([rel, file]) => `${rel}\n${file.kind === 'text' ? file.text : file.hash}`).join('\n');
      let entry = compiled.get(request.object);
      if (!entry || entry.key !== key) {
        const objects = from.objects;
        entry = { key, code: objects().then(({ bundler, libraries }) => compileObjectFromFiles(bundler, files, request.object, libraries)) };
        compiled.set(request.object, entry);
      }
      try {
        const code = await entry.code;
        return { status: 'ok', type: 'text/javascript; charset=utf-8', size: ENCODER.encode(code).length, body: code };
      } catch (error) {
        compiled.delete(request.object);
        return { status: 'failed', message: `objects/${request.object}/object.js did not compile: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  };
}
