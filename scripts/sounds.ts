// Refreshes the sound files the core ships (docs/decisions.md D67) from their sources:
//   pnpm run sounds                  download the packs and files that packages/player/src/interface-sounds/sources.json
//                                   names, check each original against its SHA-256 and write the
//                                   player's interface sounds, <role>.m4a (AAC, mono, 96 kb/s)
//   pnpm run sounds -- --from <dir>  take the packs from <dir>/<pack id>/ (unzipped) instead
// and writes the library's catalogue.json and README.md (packages/node/sounds/) from its sources.json and
// files, which were taken once by hand (CC0 and public domain only).
// Needs network access (or --from) and ffmpeg; nothing else does: courses, the CLI and the app read
// the files offline. The sounds were chosen by ear, once: this script only makes them again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZip } from '@elabora/node/zip';
import { findMediaTools } from '@elabora/node/media/tools';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTERFACE = path.join(ROOT, 'packages/player/src/interface-sounds');
const CACHE = path.join(os.tmpdir(), 'elabora-sounds-cache');
const AGENT = 'Mozilla/5.0 (compatible; ElaboraSounds/1.0; +https://elabora.studio)';

interface Pack { title: string; author: string; page: string; license: string; licenseUrl: string; checked: string }
interface Source { pack: string; file: string; sha256: string }
interface Sources { packs: Record<string, Pack>; roles: Record<string, Source> }

const fromIndex = process.argv.indexOf('--from');
const from = fromIndex > 0 ? path.resolve(process.argv[fromIndex + 1] ?? '') : null;
const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

// A Kenney pack: its page gives a download id, which a session cookie turns into a signed link.
async function kenneyZip(page: string): Promise<Buffer> {
  const pageResponse = await fetch(page, { headers: { 'user-agent': AGENT } });
  const cookie = (pageResponse.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ');
  const id = /data-download-id='([0-9a-f]+)'/.exec(await pageResponse.text())?.[1];
  if (!id) throw new Error(`${page}: no download id on the page`);
  const link = await fetch(`https://kenney.nl/download-link/${id}`, { headers: { 'user-agent': AGENT, cookie, referer: page } }).then((response) => response.json()) as { url?: string };
  if (!link.url) throw new Error(`${page}: no download link`);
  const zip = await fetch(link.url, { headers: { 'user-agent': AGENT, cookie, referer: page } });
  if (!zip.ok) throw new Error(`${page}: download failed (${zip.status})`);
  return Buffer.from(await zip.arrayBuffer());
}

const packs = new Map<string, Map<string, Buffer>>();
async function original(sources: Sources, source: Source): Promise<Buffer> {
  if (from) return fs.readFileSync(path.join(from, source.pack, source.file));
  let files = packs.get(source.pack);
  if (!files) {
    const pack = sources.packs[source.pack];
    if (!pack) throw new Error(`Unknown pack ${source.pack}`);
    const cached = path.join(CACHE, `${source.pack}.zip`);
    if (!fs.existsSync(cached)) {
      fs.mkdirSync(CACHE, { recursive: true });
      if (!pack.page.startsWith('https://kenney.nl/')) throw new Error(`${source.pack}: only Kenney's packs are downloaded by this script`);
      fs.writeFileSync(cached, await kenneyZip(pack.page));
    }
    files = readZip(fs.readFileSync(cached)).files;
    packs.set(source.pack, files);
  }
  const bytes = files.get(source.file);
  if (!bytes) throw new Error(`${source.pack}: ${source.file} is not in the pack`);
  return bytes;
}

const tools = await findMediaTools();
const sources = JSON.parse(fs.readFileSync(path.join(INTERFACE, 'sources.json'), 'utf8')) as Sources;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sounds-'));
try {
  for (const [role, source] of Object.entries(sources.roles)) {
    const bytes = await original(sources, source);
    const actual = sha256(bytes);
    if (actual !== source.sha256) throw new Error(`${role}: ${source.file} has SHA-256 ${actual}, not ${source.sha256}`);
    const input = path.join(work, `${role}${path.extname(source.file)}`);
    fs.writeFileSync(input, bytes);
    const output = path.join(INTERFACE, `${role}.m4a`);
    execFileSync(tools.ffmpeg, ['-v', 'error', '-y', '-i', input, '-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart', output]);
    console.log(`${role}.m4a  ${fs.statSync(output).size} bytes  (${source.file})`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

// ── The library, « Sons courants » ──
const LIBRARY = path.join(ROOT, 'packages/node/sounds');
interface LibrarySource { id: string; title: { en: string; fr: string }; category: string; kind: 'effect' | 'ambience'; source: string; url: string; author: string; license: string; licenseUrl: string; checked: string; caption?: Record<string, string>; tags?: string[]; processing?: Record<string, unknown> }
const library = JSON.parse(fs.readFileSync(path.join(LIBRARY, 'sources.json'), 'utf8')) as { sounds: LibrarySource[] };
const files = fs.readdirSync(path.join(LIBRARY, 'files'));
const entries = library.sounds.map((sound) => {
  const file = files.find((name) => name.startsWith(`${sound.id}.`));
  if (!file) throw new Error(`library: no file for ${sound.id}`);
  const bytes = fs.readFileSync(path.join(LIBRARY, 'files', file));
  const probe = JSON.parse(execFileSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', path.join(LIBRARY, 'files', file)], { encoding: 'utf8' })) as { streams: { codec_name: string; sample_rate: string; channels: number }[]; format: { duration: string } };
  const stream = probe.streams[0];
  return {
    id: sound.id, title: sound.title, category: sound.category, kind: sound.kind, file: `files/${file}`, format: stream.codec_name, channels: stream.channels, sampleRate: Number(stream.sample_rate),
    duration: Math.round(Number(probe.format.duration) * 1000) / 1000, bytes: bytes.length, hash: `sha256:${sha256(bytes)}`,
    source: sound.source, url: sound.url, author: sound.author, license: sound.license, licenseUrl: sound.licenseUrl, checked: sound.checked,
    ...(sound.caption && Object.keys(sound.caption).length ? { caption: sound.caption } : {}), tags: sound.tags ?? []
  };
});
const extra = files.filter((name) => !entries.some((entry) => entry.file === `files/${name}`));
if (extra.length) throw new Error(`library: files without a source: ${extra.join(', ')}`);
fs.writeFileSync(path.join(LIBRARY, 'catalogue.json'), `${JSON.stringify({ sounds: entries }, null, 2)}\n`);
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
const rows = entries.map((entry) => `| \`${entry.id}\` | ${entry.title.fr} | ${entry.category} | ${entry.duration.toFixed(1)} s | ${entry.format} | ${entry.license} | [${entry.author}](${entry.url}) |`);
fs.writeFileSync(path.join(LIBRARY, 'README.md'), `# « Sons courants »: the library of sounds\n\nWritten by \`pnpm run sounds\` from sources.json and files/: do not edit. ${entries.length} sounds, ${mb(total)} (effects as FLAC, ambiences as AAC 256 kb/s: docs/decisions/D67.md). CC0 or public domain only: no credit is owed, the sources are kept here.\n\n| Id | Titre | Category | Length | Format | Licence | Source |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
console.log(`library: ${entries.length} sounds, ${mb(total)}`);
