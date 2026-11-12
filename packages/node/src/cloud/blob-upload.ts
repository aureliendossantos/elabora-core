import fs from 'node:fs';
import { CloudError, type CloudClient } from './client.ts';

// Sending the blobs an upload lacks, for a publication and for a team's media alike (protocol « Send
// what is missing »): a few at a time, since each request waits about half a second on the network
// whatever its size (D88), whole up to the API's limit and in parts above it, read from disk as they
// go so that a large video is never held whole.

const BLOB_TIMEOUT = 15 * 60_000;
const PARALLEL = 4;

export interface MissingBlob { sha256: string; size: number }

export interface SendBlobsOptions {
  client: CloudClient;
  upload: string; // the upload's path, without /blobs: /v1/spaces/<space>/uploads/<id> or /v1/teams/<team>/uploads/<id>
  missing: readonly MissingBlob[];
  // Where a blob's bytes are on disk.
  fileOf: (blob: MissingBlob) => string;
  limit?: number; // singlePutMaxBytes
  // Each request through it (the account's guard, which forgets a session the server ended).
  guard?: <T>(call: () => Promise<T>) => Promise<T>;
  onProgress?: (sent: { sentBytes: number; totalBytes: number; file: string }) => void;
}

export async function readRange(file: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
      if (bytesRead === 0) throw new CloudError(0, 'E_CLOUD_FILE_CHANGED', `${file} changed while it was being sent: send it again.`);
      read += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

// Sends every missing blob; returns how many went in parts.
export async function sendBlobs({ client, upload, missing, fileOf, limit = 64 * 1024 * 1024, guard = (call) => call(), onProgress = () => {} }: SendBlobsOptions): Promise<{ sentBytes: number; multipartFiles: number }> {
  const totalBytes = missing.reduce((sum, blob) => sum + blob.size, 0);
  let sentBytes = 0;
  let multipartFiles = 0;
  const send = async (blob: MissingBlob) => {
    const file = fileOf(blob);
    const target = `${upload}/blobs/${blob.sha256}`;
    if (blob.size <= limit) {
      await guard(async () => client.request('PUT', target, { bytes: await readRange(file, 0, blob.size), timeoutMs: BLOB_TIMEOUT }));
    } else {
      multipartFiles++;
      const started = await guard(() => client.request<{ present: boolean; multipart?: string; partBytes?: number; parts?: number }>('POST', `${target}/multipart`));
      if (!started.present) {
        const multipart = `${target}/multipart/${encodeURIComponent(started.multipart ?? '')}`;
        const partBytes = started.partBytes ?? 0;
        const parts: { partNumber: number; etag: string }[] = [];
        for (let n = 1; n <= (started.parts ?? 0); n++) {
          const offset = (n - 1) * partBytes;
          const bytes = await readRange(file, offset, Math.min(partBytes, blob.size - offset));
          const part = await guard(() => client.request<{ partNumber: number; etag: string }>('PUT', `${multipart}/${n}`, { bytes, timeoutMs: BLOB_TIMEOUT }));
          parts.push({ partNumber: part.partNumber, etag: part.etag });
          onProgress({ file, sentBytes: sentBytes + offset + bytes.byteLength, totalBytes });
        }
        await guard(() => client.request('POST', `${multipart}/complete`, { json: { parts }, timeoutMs: BLOB_TIMEOUT }));
      }
    }
    sentBytes += blob.size;
    onProgress({ file, sentBytes, totalBytes });
  };
  // A few at a time: blobs are independent until the commit, which checks them all.
  const queue = [...missing];
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await send(next);
  }));
  return { sentBytes, multipartFiles };
}
