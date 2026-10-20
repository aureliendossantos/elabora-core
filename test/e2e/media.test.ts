import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Frame } from 'playwright-core';
import { build } from '@elabora/node/build';
import { startServer } from '@elabora/node/emulator/server';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { probeMedia } from '@elabora/node/media/probe';
import { findMediaTools } from '@elabora/node/media/tools';
import { NO_MEDIA_CODECS, ROOT, playsMedia } from '../helpers.ts';
import type { PlayerWindow } from '../helpers.ts';

const tools = await findMediaTools().catch(() => null);

// The large course of scripts/make-large-course.ts (about 80 screens and 300 MB of video with
// ELABORA_E2E_FULL=1; by default 20 screens and two videos of 15 s, so that encoding the renditions
// takes seconds), built at the low media quality, then played in the LMS emulator: the rendition
// is in the package, plays, and seeks (range requests).
test('a large course built at the low media quality plays and seeks its videos in the LMS emulator', { timeout: 600000 }, async (t) => {
  if (!tools) return t.skip('ffmpeg and ffprobe not found');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-e2e-media-'));
  const dir = path.join(work, 'course');
  const size = process.env.ELABORA_E2E_FULL ? [] : ['--screens', '20', '--video-mb', '30', '--videos', '2'];
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-large-course.ts'), dir, ...size], { stdio: 'ignore' });

  const built = await build(dir, { profiles: ['moodle'], emit: 'both', out: path.join(work, 'out'), mediaQuality: 'low' });
  assert.ok(built.ok && built.dirPath && built.zipPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error')));
  assert.equal(built.report.media?.quality, 'low');
  assert.ok(built.report.media?.files.every((file) => file.rendition));
  const shipped = await probeMedia(path.join(built.dirPath, 'assets/video/lecture-1.mp4'), { tools });
  assert.deepEqual([shipped.videoCodec, shipped.width, shipped.height, shipped.faststart], ['h264', 854, 480, true]);
  assert.ok(shipped.size < fs.statSync(path.join(dir, 'assets/video/lecture-1.mp4')).size / 3, 'the rendition is much lighter than the master');

  const server = await startServer();
  server.addPackage('large', built.dirPath);
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage();
    const videoStatuses: number[] = [];
    page.on('response', (response) => { if (response.url().endsWith('.mp4')) videoStatuses.push(response.status()); });
    await page.goto(`${server.base}/lms/launch.html?pkg=large&profile=moodle&mode=iframe&reg=media`);
    const frame = await contentFrame(page.frames.bind(page), () => page.waitForTimeout(100));
    if (!(await playsMedia(frame))) return t.skip(NO_MEDIA_CODECS);
    // Screens are open in order: the ones before count as seen, as previews do.
    await frame.evaluate(() => {
      const elabora = (window as PlayerWindow).__elabora;
      for (const screen of elabora.engine.screens) { elabora.engine.st.visited.add(screen.key); elabora.engine.st.completed.add(screen.key); }
      elabora.go('lecture-1-screen');
    });
    const played = await frame.evaluate(async () => {
      let video: HTMLVideoElement | null = null;
      for (let i = 0; i < 100 && !video; i++) {
        video = document.querySelector('video');
        if (!video) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!video) throw new Error(`no video on the screen (${(window as PlayerWindow).__elabora.screen})`);
      video.muted = true;
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 1) return resolve();
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error(`video error ${video.error?.code}`)), { once: true });
      });
      await video.play();
      // Playing: the position moves (a loaded machine may take a while to start).
      for (let i = 0; i < 100 && video.currentTime === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      const playing = video.currentTime;
      const target = Math.floor(video.duration * 0.6);
      video.currentTime = target;
      await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, playing, target, after: video.currentTime, error: video.error?.code ?? null };
    });
    assert.deepEqual([played.width, played.height, played.error], [854, 480, null]);
    assert.ok(played.playing > 0, `the video played (${played.playing} s)`);
    assert.ok(played.after >= played.target, `seeked to ${played.target} s, at ${played.after} s`);
    assert.ok(videoStatuses.includes(206), `range requests answered (statuses ${videoStatuses.join(', ')})`);
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

async function contentFrame(frames: () => Frame[], pause: () => Promise<void>): Promise<Frame> {
  for (let i = 0; i < 150; i++) {
    for (const frame of frames()) {
      if (!/\/pkg\//.test(frame.url())) continue;
      if (await frame.evaluate(() => typeof (window as Partial<PlayerWindow>).__elabora === 'object').catch(() => false)) return frame;
    }
    await pause();
  }
  throw new Error('content frame not found');
}
