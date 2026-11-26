// An image's master in a browser, by the desktop's plan (masterPlan of @elabora/core/media/conformance,
// docs/architecture/media.md, « In a browser »): copied as it is, rewritten without its metadata by
// the core's rule (the same bytes as the desktop's), or decoded and encoded again by the browser,
// WebP at the high preset's size and quality, JPEG or PNG where the browser cannot write WebP (D107).
// Runs in the media Worker (D106).

import { readAsync } from '@elabora/core/media/bytes';
import type { BytePiece } from '@elabora/core/media/bytes';
import { strippedImageSteps } from '@elabora/core/media/metadata';
import { imageExtension, masterPlan } from '@elabora/core/media/conformance';
import type { MediaInfo, MediaPlan } from '@elabora/core/media/conformance';
import { fitWithin, PRESETS } from '@elabora/core/media/presets';

// The file cannot be decoded in this browser (E_MEDIA_NOT_DECODABLE_HERE): a HEIF outside Safari, say.
export class MediaNotDecodable extends Error {
  readonly code = 'E_MEDIA_NOT_DECODABLE_HERE';
  readonly file: string;
  constructor(file: string, what: string) {
    super(`This browser cannot decode ${what} of ${file}.`);
    this.file = file;
  }
}

// What must be encoded cannot be here (E_MEDIA_ENCODER_MISSING): an animated image to WebP, say.
export class MediaEncoderMissing extends Error {
  readonly code = 'E_MEDIA_ENCODER_MISSING';
  readonly file: string;
  constructor(file: string, what: string) {
    super(`This browser cannot encode ${what} of ${file}.`);
    this.file = file;
  }
}

export interface ImageMaster {
  blob: Blob;
  // The master's extension: the input's when null (copied, or rewritten without its metadata).
  extension: string | null;
  action: MediaPlan['action'];
}

const TYPES: Readonly<Record<string, string>> = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png' };

let webp: Promise<boolean> | null = null;

// Whether the browser's canvas writes WebP: a browser that cannot gives a PNG instead.
export function canWriteWebp(): Promise<boolean> {
  webp ??= (async () => {
    const canvas = new OffscreenCanvas(1, 1);
    canvas.getContext('2d'); // a canvas without a context writes nothing
    return (await canvas.convertToBlob({ type: 'image/webp' })).type === 'image/webp';
  })().catch(() => false);
  return webp;
}

export async function imageMaster(file: Blob, name: string, info: MediaInfo): Promise<ImageMaster> {
  const webp = await canWriteWebp();
  const plan = masterPlan(info, { importing: true, webp });
  if (plan.action === 'copy') return { blob: file, extension: null, action: 'copy' };
  if (plan.action === 'remux' && (info.container === 'jpeg' || info.container === 'png' || info.container === 'webp')) {
    const pieces = await readAsync(strippedImageSteps(file.size, info.container), (position, length) => slice(file, position, length));
    if (pieces) return { blob: new Blob(pieces.map((piece) => partOf(file, piece)), { type: file.type }), extension: null, action: 'remux' };
  }
  // An animated image is not encoded here: the canvas writes one frame.
  if (info.animated) throw new MediaEncoderMissing(name, 'an animated image');
  // An image that cannot be rewritten without re-encoding keeps its extension, as at the desktop,
  // unless it is a WebP this browser cannot write.
  const own = `.${info.container === 'jpeg' ? 'jpg' : info.container}`;
  const extension = plan.action === 'encode' ? plan.extension ?? imageExtension(info, { webp }) : own === '.webp' && !webp ? imageExtension(info, { webp }) : own;
  return { blob: await encodeImage(file, name, info, extension), extension: extension === own && plan.action !== 'encode' ? null : extension, action: 'encode' };
}

const slice = async (file: Blob, position: number, length: number) => new Uint8Array(await file.slice(position, position + length).arrayBuffer());
const partOf = (file: Blob, piece: BytePiece): BlobPart => (piece instanceof Uint8Array ? new Uint8Array(piece) : file.slice(piece.position, piece.position + piece.length));

// Decoded as it shows (its EXIF orientation applied, as ffmpeg does), brought within the high
// preset's long side, encoded at its quality; no metadata is written.
async function encodeImage(file: Blob, name: string, info: MediaInfo, extension: string): Promise<Blob> {
  const preset = PRESETS.high.image;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new MediaNotDecodable(name, `the ${info.container.toUpperCase()} image`);
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, preset.maxLongSide, { even: false });
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: extension !== '.jpg' })!;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (extension === '.jpg') { context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); }
    context.drawImage(bitmap, 0, 0, width, height);
    const type = TYPES[extension] ?? 'image/webp';
    const blob = await canvas.convertToBlob({ type, quality: preset.quality / 100 });
    if (blob.type !== type) throw new Error(`This browser wrote ${blob.type || 'nothing'} for ${type}`);
    return blob;
  } finally {
    bitmap.close();
  }
}
