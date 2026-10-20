// Builds a large course for performance work: the planetary-gearset sample repeated to about 80
// screens, with real H.264 videos (300 MB in total by default), the size of a typical module.
// Usage: node scripts/make-large-course.ts <out-dir> [--screens 80] [--video-mb 300] [--videos 6]
// The videos are encoded once with ffmpeg and cached in the system temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { schemaId } from '@elabora/format';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(ROOT, 'examples/planetary-gearset');

const args = process.argv.slice(2);
const out = args[0];
const option = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
if (!out) {
  console.error('Usage: node scripts/make-large-course.ts <out-dir> [--screens 80] [--video-mb 300] [--videos 6]');
  process.exit(1);
}
const targetScreens = option('screens', 80);
const videoMB = option('video-mb', 300);
const videoCount = option('videos', 6);

const readJSON = (file: string): JsonObject => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file: string, value: Json) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

// Every id of a screen (screen, blocks, layers, events) gets the copy's suffix, and so does every
// string equal to one of those ids (event targets, layer references), so copies stay consistent.
function collectIds(value: Json, ids: Set<string>) {
  if (Array.isArray(value)) value.forEach((v) => collectIds(v, ids));
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && ('type' in value || 'blocks' in value || 'on' in value || 'covers' in value)) ids.add(value.id);
    for (const v of Object.values(value)) collectIds(v, ids);
  }
}
const NOT_IDS = new Set(['type', 'layout', 'slot', 'style', 'object', 'behavior', 'backdrop']);
function renameIds(value: Json, ids: Set<string>, suffix: string): Json {
  if (typeof value === 'string') return ids.has(value) ? `${value}${suffix}` : value;
  if (Array.isArray(value)) return value.map((v) => renameIds(v, ids, suffix));
  // Keys that name component types, layouts, slots, styles or objects, never node ids.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, NOT_IDS.has(k) ? v : renameIds(v, ids, suffix)]));
  return value;
}

function cachedVideo(seconds: number, index: number): string {
  const file = path.join(os.tmpdir(), `elabora-large-video-${seconds}s-${index}.mp4`);
  if (fs.existsSync(file)) return file;
  // testsrc2 with noise keeps the bitrate near the target (8 Mb/s: the high preset's ceiling).
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${300 + index * 40}:duration=${seconds}`, '-vf', 'noise=alls=12:allf=t',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', `${file}.tmp.mp4`]);
  fs.renameSync(`${file}.tmp.mp4`, file);
  return file;
}

fs.cpSync(SAMPLE, out, { recursive: true, filter: (src) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(src.slice(SAMPLE.length)) });
const course = readJSON(path.join(out, 'course.json'));
const sections = course.sections as JsonObject[];
const originals = sections.flatMap((s) => s.screens as string[]);
let copy = 1;
while (sections.reduce((n, s) => n + (s.screens as string[]).length, 0) < targetScreens) {
  copy++;
  const suffix = `-copy${copy}`;
  const screens: string[] = [];
  for (const id of originals) {
    const screen = readJSON(path.join(SAMPLE, 'screens', `${id}.json`));
    const ids = new Set<string>();
    collectIds(screen, ids);
    writeJSON(path.join(out, 'screens', `${id}${suffix}.json`), renameIds(screen, ids, suffix));
    screens.push(`${id}${suffix}`);
  }
  sections.push({ id: `part${suffix}`, title: `Part ${copy}`, screens });
}

// Videos: one screen per section, after the section's first screen, covering the same plan items.
const seconds = Math.max(1, Math.round((videoMB * 8) / 8.2 / videoCount));
fs.mkdirSync(path.join(out, 'assets/video'), { recursive: true });
for (let i = 0; i < Math.min(videoCount, sections.length); i++) {
  const name = `lecture-${i + 1}`;
  fs.copyFileSync(cachedVideo(seconds, i), path.join(out, 'assets/video', `${name}.mp4`));
  fs.writeFileSync(path.join(out, 'assets/video', `${name}.vtt`), `WEBVTT\n\n00:00.000 --> 00:05.000\nLecture ${i + 1}: how a planetary gearset works.\n`);
  const screenIds = sections[i].screens as string[];
  const first = readJSON(path.join(out, 'screens', `${screenIds[0]}.json`));
  const id = `${name}-screen`;
  writeJSON(path.join(out, 'screens', `${id}.json`), {
    $schema: schemaId('screen'), id, title: `Lecture ${i + 1}`, covers: first.covers,
    blocks: [
      { id: `${id}-intro`, type: 'text', props: { markdown: `Watch lecture ${i + 1} before the next screen.` } },
      { id: `${id}-video`, type: 'video', props: { asset: `video/${name}.mp4`, captions: `video/${name}.vtt`, title: `Lecture ${i + 1}`, transcript: `Lecture ${i + 1}: how a planetary gearset works.` } }
    ]
  });
  screenIds.splice(1, 0, id);
}
writeJSON(path.join(out, 'course.json'), course);
const total = sections.reduce((n, s) => n + (s.screens as string[]).length, 0);
console.log(`${out}: ${total} screens, ${Math.min(videoCount, sections.length)} videos of ${seconds} s`);
