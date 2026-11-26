import fs from 'node:fs';
import { readSync } from '@elabora/core/media/bytes';
import type { BytePiece } from '@elabora/core/media/bytes';
import { imageMetadataSteps, strippedImageSteps } from '@elabora/core/media/metadata';
import type { ImageContainer, ImageMetadata } from '@elabora/core/media/metadata';

// Image metadata read and removed without re-encoding, by the rules of @elabora/core/media/metadata
// that a browser follows too. Reads are synchronous: the snapshot of a folder probes new images
// synchronously, and images worth stripping are at most a few megabytes.

export type { ImageContainer, ImageMetadata };

const CHUNK = 1024 * 1024;

export function readImageMetadata(file: string, container: ImageContainer): ImageMetadata {
  return withFile(file, (handle) => readSync(imageMetadataSteps(fs.fstatSync(handle).size, container), reader(handle)));
}

// Writes `output`: the image of `input` without its metadata. Returns false when the file cannot
// be parsed (the caller then re-encodes it instead).
export function stripImageMetadata(input: string, output: string, container: ImageContainer): boolean {
  return withFile(input, (source) => {
    const pieces = readSync(strippedImageSteps(fs.fstatSync(source).size, container), reader(source));
    if (!pieces) return false;
    writePieces(source, output, pieces);
    return true;
  });
}

export function withFile<T>(file: string, use: (handle: number) => T): T {
  const handle = fs.openSync(file, 'r');
  try {
    return use(handle);
  } finally {
    fs.closeSync(handle);
  }
}

// What a byte reader of the core asks of a file handle: its bytes at a position, fewer at the end.
export const reader = (handle: number) => (position: number, length: number): Uint8Array => {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(handle, buffer, 0, length, position);
  return bytesRead < length ? buffer.subarray(0, bytesRead) : buffer;
};

function writePieces(source: number, output: string, pieces: readonly BytePiece[]): void {
  const target = fs.openSync(output, 'w');
  try {
    for (const piece of pieces) {
      if (piece instanceof Uint8Array) write(target, piece);
      else copyRange(source, target, piece.position, piece.length);
    }
  } finally {
    fs.closeSync(target);
  }
}

function copyRange(source: number, target: number, start: number, length: number): void {
  const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, length)));
  let done = 0;
  while (done < length) {
    const bytesRead = fs.readSync(source, buffer, 0, Math.min(buffer.length, length - done), start + done);
    if (bytesRead === 0) throw new Error('Unexpected end of file');
    write(target, buffer, 0, bytesRead);
    done += bytesRead;
  }
}

function write(target: number, data: Uint8Array, offset = 0, length = data.length - offset): void {
  for (let done = 0; done < length;) done += fs.writeSync(target, data, offset + done, length - done);
}
