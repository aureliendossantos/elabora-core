import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MediaTools } from '@elabora/node/media/index';

// Media files as authors bring them, made by the native ffmpeg from its test sources: what the
// browser's probe and encoders are judged on against the desktop's. Short, so that a test makes them
// in a few seconds. Those an encoder this ffmpeg lacks would make are left out.

const run = promisify(execFile);

export interface MediaFixtures { dir: string; files: string[]; remove(): void }

// An APP1 EXIF segment: an orientation and a GPS latitude, as phones write them.
export function exifSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4 + 2 + 12 + 4 + 24);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8);
  const gpsIfd = 8 + 2 + 2 * 12 + 4;
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt16BE(0x8825, 22); tiff.writeUInt16BE(4, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt32BE(gpsIfd, 30);
  tiff.writeUInt16BE(1, gpsIfd);
  tiff.writeUInt16BE(0x0002, gpsIfd + 2); tiff.writeUInt16BE(5, gpsIfd + 4); tiff.writeUInt32BE(3, gpsIfd + 6); tiff.writeUInt32BE(gpsIfd + 18, gpsIfd + 10);
  for (let i = 0; i < 3; i++) { tiff.writeUInt32BE([48, 51, 30][i], gpsIfd + 18 + i * 8); tiff.writeUInt32BE(1, gpsIfd + 22 + i * 8); }
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

export async function makeMediaFixtures(tools: MediaTools): Promise<MediaFixtures> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-media-fixtures-'));
  const has = (encoder: string) => tools.encoders.has(encoder);
  const ffmpeg = (...args: string[]) => run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const picture = (size: string, seconds: number, rate = 30) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`];
  const tone = (seconds: number, rate = 48000) => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=${seconds}`];
  const x264 = (profile = 'high') => ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', profile, '-pix_fmt', 'yuv420p'];
  const out = (name: string) => path.join(dir, name);
  const made: Promise<unknown>[] = [
    // Pictures
    ffmpeg(...picture('640x320', 1), '-frames:v', '1', '-q:v', '3', out('plain.jpg')),
    ffmpeg(...picture('4000x3000', 1), '-frames:v', '1', '-q:v', '3', out('camera.jpg')),
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=300x200,format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=X', '-frames:v', '1', out('alpha.png')),
    ffmpeg(...picture('4000x2250', 1), '-frames:v', '1', out('large.png')),
    ffmpeg(...picture('160x90', 0.3, 10), '-f', 'gif', out('moving.gif')),
    ffmpeg(...picture('320x240', 1), '-frames:v', '1', '-update', '1', out('old.bmp')),
    ...(has('libwebp') ? [ffmpeg(...picture('800x600', 1), '-frames:v', '1', '-c:v', 'libwebp', out('still.webp'))] : []),
    ffmpeg(...picture('160x90', 0.3, 10), '-plays', '0', '-f', 'apng', out('moving.png')),
    ...(has('libwebp') ? [ffmpeg(...picture('400x300', 1), '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '1', out('lossless.webp'))] : []),
    ...(has('libaom-av1') ? [ffmpeg(...picture('640x480', 1), '-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1', '-cpu-used', '8', out('photo.avif'))] : []),
    ...(has('libwebp_anim') ? [ffmpeg(...picture('160x90', 0.3, 10), '-c:v', 'libwebp_anim', '-loop', '0', out('moving.webp'))] : []),
    // Videos
    ...(has('libx264') ? [
      ffmpeg(...picture('1280x720', 2), ...tone(2), '-shortest', ...x264(), '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', out('index-at-end.mp4')),
      ffmpeg(...picture('640x360', 2), ...tone(2), '-shortest', ...x264('baseline'), '-c:a', 'aac', '-movflags', '+faststart', out('web.mp4')),
      ffmpeg(...picture('640x360', 2), ...tone(2), '-shortest', ...x264('main'), '-c:a', 'pcm_s16le', out('camera.mov')),
      ffmpeg(...picture('640x360', 1), ...tone(1), '-shortest', ...x264(), '-c:a', 'aac', out('export.mkv')),
      ffmpeg(...picture('1920x1080', 1, 25), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuvj420p', out('full-range.mp4')),
      ffmpeg(...picture('1280x720', 1), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le', out('ten-bit.mp4'))
    ] : []),
    ...(has('libx265') ? [ffmpeg(...picture('1280x720', 1), '-an', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', out('hevc.mp4'))] : []),
    ...(has('libvpx-vp9') && has('libopus') ? [ffmpeg(...picture('640x360', 2), ...tone(2), '-af', 'adelay=250:all=1', '-shortest', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-b:v', '500k', '-c:a', 'libopus', out('screen.webm'))] : []),
    // Sounds
    ffmpeg(...tone(2, 44100), '-c:a', 'pcm_s16le', out('voice.wav')),
    ffmpeg(...tone(2), '-ac', '1', '-c:a', 'aac', '-b:a', '96k', out('voice.m4a')),
    ffmpeg(...tone(2), '-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out('line.m4a')),
    // A voice recorded by hand: a second of silence before it, most of one after, in stereo at 44.1 kHz.
    ffmpeg('-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,1\\,2.2)\\,0.3*sin(2*PI*220*t)*(1+sin(2*PI*3*t))/2\\,0)|if(between(t\\,1\\,2.2)\\,0.25*sin(2*PI*330*t)\\,0):s=44100:d=3', '-c:a', 'pcm_s16le', out('recording.wav')),
    ...(has('libmp3lame') ? [ffmpeg(...tone(2, 44100), '-c:a', 'libmp3lame', '-b:a', '128k', out('voice.mp3'))] : [])
  ];
  await Promise.all(made);
  // A phone held upright: its picture turned by the display matrix, its place in the metadata.
  if (has('libx264')) {
    const plain = out('phone-plain.mp4');
    await ffmpeg(...picture('1280x720', 2), ...tone(2), '-shortest', ...x264(), '-c:a', 'aac', plain);
    await ffmpeg('-display_rotation', '90', '-i', plain, '-c', 'copy', '-metadata', 'location=+48.8584+002.2945/', '-f', 'mov', out('phone.mov'));
    fs.rmSync(plain);
    // Upright and in the full range: re-encoded, turned in its pixels.
    const full = out('upright-plain.mp4');
    await ffmpeg(...picture('1280x720', 1), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuvj420p', full);
    await ffmpeg('-display_rotation', '90', '-i', full, '-c', 'copy', out('upright.mp4'));
    fs.rmSync(full);
  }
  // A song with its cover.
  if (has('libmp3lame')) await ffmpeg('-i', out('voice.mp3'), '-i', out('alpha.png'), '-map', '0', '-map', '1', '-c:a', 'copy', '-c:v', 'png', '-disposition:v', 'attached_pic', '-id3v2_version', '3', out('song.mp3'));
  // A phone's photo: turned, with its place, as EXIF says.
  for (const [from, to] of [['plain.jpg', 'photo.jpg'], ['camera.jpg', 'phone-photo.jpg']]) {
    const jpeg = fs.readFileSync(out(from));
    fs.writeFileSync(out(to), Buffer.concat([jpeg.subarray(0, 2), exifSegment(6), jpeg.subarray(2)]));
  }
  fs.rmSync(out('camera.jpg'));
  fs.writeFileSync(out('logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
  return { dir, files: fs.readdirSync(dir).sort(), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
