import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { addSources, listSources, makeSourcesReadable, readSource, removeSource, resolveSource, sourceName } from '@elabora/node/sources/index';
import { freeName, nameKey } from '@elabora/node/sources/names';
import { frameTimes, transcriptParagraphs } from '@elabora/node/sources/recording';
import { parseXml } from '@elabora/node/sources/xml';
import { imageSize, smallPicture } from '@elabora/node/sources/image-size';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { validateProject } from '@elabora/core/validate/index';
import { build } from '@elabora/node/build';
import { readZip } from '@elabora/node/zip';
import { createVersion, listVersions, restore } from '@elabora/node/backups/index';
import { duplicateProject, exportProject, getProject, importArchive, importFolder, inspectArchive, listProjects } from '@elabora/node/library/index';
import { TRANSCRIBER_MODELS, disposeTranscriber } from '@elabora/node/transcribe/index';
import { ROOT, codes, copyExample, readJSON, writeJSON } from '../helpers.ts';
import { hasFfmpeg, FFMPEG } from '../narration.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '@elabora/cli/mcp';
import { briefDocx, png, textPdf, workshopPptx } from '../sources-fixtures.ts';

// The author's sources (docs/decisions.md D49): files added to sources/ and their readable versions,
// made from synthetic files (test/sources-fixtures.ts); sources/ outside every package, backup and
// snapshot; carried by a module's copy, an import from a folder and, when asked, its archive.
// Recordings are heard by the tests' transcriber (ELABORA_TRANSCRIBER_FAKE), never the model. No
// program of the machine is used by any reader: what the tests read is what any computer reads.

const NO_FFMPEG = !hasFfmpeg() && 'ffmpeg is not installed';
let temp: string;
const made: string[] = [];
const clients: Client[] = [];
const savedEnvironment = { ...process.env };
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sources-'));
  made.push(temp);
  delete process.env.ELABORA_DATA_DIR;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await disposeTranscriber();
  for (const dir of made.splice(0).reverse()) fs.rmSync(dir, { recursive: true, force: true });
  for (const name of ['ELABORA_DATA_DIR', 'ELABORA_LIBRARY']) {
    if (savedEnvironment[name] === undefined) delete process.env[name]; else process.env[name] = savedEnvironment[name];
  }
});

const course = () => { const dir = copyExample(); made.push(dir); return dir; };
const write = (name: string, data: Buffer | string) => { const file = path.join(fs.mkdtempSync(path.join(temp, 'input-')), name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
const text = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  return run().finally(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}

// The tests' transcriber: a made-up model installed as a download leaves it, answering from a file.
function transcriberEnv(texts: Record<string, string>): Record<string, string> {
  const fakeModels = path.join(temp, 'transcribers');
  const body = Buffer.from('not a mod.');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(temp, 'transcribers.json'), JSON.stringify({ [TRANSCRIBER_MODELS[0].id]: [{ name: 'model.bin', url: 'x/model.bin', size: body.length, sha256 }] }));
  const dir = path.join(fakeModels, TRANSCRIBER_MODELS[0].id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.bin'), body);
  fs.writeFileSync(path.join(dir, 'verified.json'), JSON.stringify({ 'model.bin': sha256 }));
  fs.writeFileSync(path.join(temp, 'heard.json'), JSON.stringify(texts));
  return { ELABORA_TRANSCRIBER_MODELS_DIR: fakeModels, ELABORA_TRANSCRIBER_MODELS_MANIFEST: path.join(temp, 'transcribers.json'), ELABORA_TRANSCRIBER_FAKE: path.join(temp, 'heard.json') };
}

test('the fixtures of test/fixtures/sources are the ones the builders make (npm run fixtures:sources)', () => {
  assert.deepEqual(fs.readFileSync(path.join(ROOT, 'test/fixtures/sources/brief-client.docx')), briefDocx());
  assert.deepEqual(fs.readFileSync(path.join(ROOT, 'test/fixtures/sources/atelier.pptx')), workshopPptx());
});

test('names: kept as the author knows them, made safe on Windows and macOS, never taken twice nor by a readable version', () => {
  assert.equal(sourceName('Brief client – V2 (final).docx'), 'Brief client – V2 (final).docx');
  assert.equal(sourceName(' Rapport: "final" v2?.docx '), 'Rapport- -final- v2-.docx');
  assert.equal(sourceName('notes.\u0007txt'), 'notes.txt');
  assert.equal(sourceName('..cache.pdf'), 'cache.pdf');
  assert.equal(sourceName('-rf.txt'), 'rf.txt');
  assert.equal(sourceName('CON.docx'), 'CON_.docx');
  assert.equal(sourceName('trailing dots... '), 'trailing dots');
  assert.equal(sourceName('.docx'), 'docx');
  assert.equal(sourceName('e\u0301te\u0301.pdf'), 'été.pdf', 'macOS decomposed accents, composed');
  assert.ok([...sourceName(`${'a'.repeat(300)}.pptx`)].length <= 120 && sourceName(`${'a'.repeat(300)}.pptx`).endsWith('.pptx'));
  const taken = new Set(['brief.docx', 'brief (2).docx', 'deck.pptx.md'].map(nameKey));
  assert.equal(freeName('Brief.docx', (key) => taken.has(key)), 'Brief (3).docx', 'without case');
  assert.equal(freeName('deck.pptx', (key) => taken.has(key)), 'deck (2).pptx', 'a readable version\'s name is taken');
  taken.add(nameKey('notes.txt'));
  assert.equal(freeName('notes.txt.md', (key) => taken.has(key)), 'notes.txt (2).md', 'the name of a source\'s readable version');
});

test('the XML reader resolves namespaces to Office\'s prefixes, decodes entities, skips a DOCTYPE and never expands anything else', () => {
  const root = parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY big "boom">]><x:doc xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:t a="&lt;1&gt;">A &amp; B &#233;&#x20AC; &big;</x:t><![CDATA[<raw>]]></x:doc>');
  assert.equal(root.name, 'w:doc');
  const t = root.children[0] as { name: string; attributes: Record<string, string>; children: string[] };
  assert.equal(t.name, 'w:t');
  assert.equal(t.attributes.a, '<1>');
  assert.equal(t.children[0], 'A & B é€ &big;');
  assert.equal(root.children[1], '<raw>');
  assert.throws(() => parseXml('<a><b></a>'), /does not close/);
});

test('adding sources: copied, a duplicate by content not copied twice, a name taken numbered, folders brought whole, hidden files left', async () => {
  const dir = course();
  const brief = write('brief-client.docx', briefDocx());
  const folder = path.join(temp, 'envoi-client');
  fs.mkdirSync(path.join(folder, 'annexes'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'annexes', 'brief-client.docx'), 'another brief');
  fs.writeFileSync(path.join(folder, '.DS_Store'), 'x');
  // A name Windows refuses can only be made elsewhere; there, one that starts like an option.
  const odd = process.platform === 'win32' ? ['-Plan étage.txt', 'Plan étage.txt'] : ['Plan: étage?.txt', 'Plan- étage-.txt'];
  fs.writeFileSync(path.join(folder, odd[0]), 'Étage 2');
  const added = await addSources(dir, [brief, brief, folder]);
  // Folder enumeration order differs across filesystems.
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  assert.deepEqual(added.map(({ name, status, renamed }) => ({ name, status, renamed })).sort(byName), [
    { name: 'brief-client.docx', status: 'added', renamed: false },
    { name: 'brief-client.docx', status: 'already-there', renamed: false },
    { name: 'brief-client (2).docx', status: 'added', renamed: true },
    { name: odd[1], status: 'added', renamed: true },
  ].sort(byName));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')).sort(), [odd[1], 'brief-client (2).docx', 'brief-client.docx'].sort());
  // A file of sources/ itself is there already; a missing file is said.
  assert.deepEqual((await addSources(dir, [path.join(dir, 'sources', 'brief-client.docx')])).map((entry) => entry.status), ['already-there']);
  await assert.rejects(addSources(dir, [path.join(temp, 'nowhere.pdf')]), { code: 'E_SOURCE_NOT_FOUND' });
  await assert.rejects(addSources(temp, [brief]), { code: 'E_NOT_A_COURSE' });
  const listed = await listSources(dir);
  assert.deepEqual(listed.map((entry) => [entry.name, entry.kind, entry.readable.status]), [
    ['brief-client (2).docx', 'word', 'missing'], ['brief-client.docx', 'word', 'missing'], [odd[1], 'text', 'native'],
  ]);
});

test('a Word brief\'s readable version: headings, lists, a table, an image, a footnote, a link, comments with their reply and tracked changes', async () => {
  const dir = course();
  await addSources(dir, [write('brief-client.docx', briefDocx())]);
  const [entry] = await makeSourcesReadable(dir);
  assert.equal(entry.readable.status, 'ready');
  assert.equal(entry.readable.path, 'sources/brief-client.docx.md');
  assert.deepEqual(entry.readable.parts, ['sources/brief-client.docx.files/image-01.png']);
  const markdown = text(dir, 'sources/brief-client.docx.md');
  assert.match(markdown, /^<!-- elabora:readable \{.*"reader":"docx\/1".*\} -->\n# brief-client\.docx\n\n> The readable version of `sources\/brief-client\.docx` \(Word document\)/);
  assert.match(markdown, /a client's brief may hold personal data/);
  assert.match(markdown, /\n## Brief : formation sécurité incendie\n\n## Contexte\n/);
  assert.match(markdown, /Le client forme 300 collaborateurs \{>>c0 Marie Dupont: Chiffre à vérifier avec les RH\.<<\} répartis sur deux sites\{\+\+ dès janvier 2027\+\+\}\.\{-- Budget à confirmer\.--\}/);
  assert.match(markdown, /Voir la norme\[\^1\] et le \[site du client\]\(https:\/\/example\.com\/securite\)\./);
  assert.match(markdown, /### Objectifs pédagogiques\n\n- Reconnaître une alarme\n {2}- Distinguer les deux signaux sonores\n- Évacuer par l’issue la plus proche\n/, 'a heading by its style\'s name, a list by its numbering');
  assert.match(markdown, /1\. Donner l’alerte\n2\. Fermer les portes\n3\. Rejoindre le point de rassemblement/);
  assert.match(markdown, /\| Public \| Durée \| Format \|\n\| --- \| --- \| --- \|\n\| Agents \\\| accueil \| 20 min \| E-learning \|\n\| Encadrants \| 35 min \| {2}\|/);
  assert.match(markdown, /\nPage 2\n/, 'a field\'s result, not its instruction');
  assert.doesNotMatch(markdown, /PAGE/);
  assert.equal(markdown.match(/Encadré : rappeler le numéro 18/g)?.length, 1, 'a text box once, not its fallback too');
  assert.match(markdown, /!\[Plan d'évacuation du bâtiment A\]\(brief-client\.docx\.files\/image-01\.png\)/);
  assert.match(markdown, /\[\^1\]: Norme NF S 61-938\./);
  assert.match(markdown, /- c0, Marie Dupont, 2026-10-01 on « 300 collaborateurs »: Chiffre à vérifier avec les RH\.\n- ↳ reply c1, Paul Martin, 2026-10-02: Confirmé : 312 en tout\./);
  assert.match(markdown, /Paul Martin \(1 insertion, 1 deletion\)/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'sources/brief-client.docx.files/image-01.png')).subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test('a PowerPoint deck\'s readable version: slides in the presentation\'s order, texts in reading order, notes, a comment, a table, a group, a hidden slide, the pictures the slides place and the thumbnail', async () => {
  const dir = course();
  await addSources(dir, [write('atelier.pptx', workshopPptx())]);
  const reading = await readSource(dir, 'atelier.pptx');
  assert.equal(reading.source.readable.status, 'ready');
  const markdown = reading.text ?? '';
  assert.deepEqual([...markdown.matchAll(/^## (Slide .*)$/gm)].map((match) => match[1]), ['Slide 1 — Sécurité incendie', 'Slide 2 — Pourquoi évacuer ?', 'Slide 3 — Les deux signaux', 'Slide 4 — Annexe : contacts']);
  assert.match(markdown, /## Slide 1 — Sécurité incendie\n\nAtelier de lancement\n\n## Slide 2/, 'no slide number');
  // The title first, then from top to bottom: the bullets (placed by the layout), the picture, the note at the bottom drawn first.
  // The bullet and the rule drawn as pictures at the top are left out.
  assert.match(markdown, /## Slide 2 — Pourquoi évacuer \?\n\n- Le feu se propage vite\n {2}- Une pièce s’embrase en 3 minutes\n- La fumée tue avant les flammes\n\n!\[Pictogramme sortie de secours\]\(atelier\.pptx\.files\/image-01\.png\)\n\nDurée : 20 minutes\n\n\*\*Speaker's notes:\*\*\n\nInsister sur la fumée\.\n\nDemander qui connaît son serre-file\./);
  // A shape filled with a picture stands where it is on the slide, beside the table; the pictogram again, as a 0.8 cm logo, is not.
  assert.match(markdown, /\| Signal \| Conduite \|\n\| --- \| --- \|\n\| Sonnerie continue \| Évacuer \|\n\n!\[Extincteur à eau\]\(atelier\.pptx\.files\/image-02\.png\)\n\nSerre-file : badge orange\n\nPoint de rassemblement : parking B\n\n\*\*Comments:\*\*\n\n- Léa Bernard, 2026-10-03: Ajouter le plan du site B \?/);
  assert.equal(markdown.match(/Logo/g), null);
  // A background, and a picture linked to a file outside the deck, which is named, not kept.
  assert.match(markdown, /## Slide 4 — Annexe : contacts\n\n\*\(hidden in the slide show\)\*\n\n!\[Slide 4, background\]\(atelier\.pptx\.files\/image-03\.png\)\n\nService sécurité : poste 4400\n\n\*\(Plan du site B: linked to plan-site-B\.png outside the deck, not kept in it\)\*/);
  assert.deepEqual(reading.source.readable.parts, ['sources/atelier.pptx.files/image-01.png', 'sources/atelier.pptx.files/image-02.png', 'sources/atelier.pptx.files/image-03.png', 'sources/atelier.pptx.files/thumbnail.png']);
  const notes = reading.source.readable.notes;
  assert.equal(notes.length, 3);
  assert.match(notes[0], /^Elabora does not draw slides.*save the deck as a PDF from PowerPoint and add the PDF/);
  assert.match(notes[1], /The file's own thumbnail of the first slide: atelier\.pptx\.files\/thumbnail\.png/);
  assert.match(notes[2], /^3 pictures too small to matter \(an icon, a bullet, a rule: 32 px or less on its longest side, under 8 px on its shortest, or placed no larger than 3% of the slide's width\) are left out\./);
  assert.match(markdown, /^> Elabora does not draw slides/m, 'the readable version says it at its head');
  assert.doesNotMatch(markdown, /LibreOffice|poppler|pdftoppm|slides\.pdf/);
  // The pictures extracted are the ones placed: the kept ones, not the bullet, the rule or the logo's second place.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources', 'atelier.pptx.files')).sort(), ['image-01.png', 'image-02.png', 'image-03.png', 'thumbnail.png']);
  assert.equal(imageSize(fs.readFileSync(path.join(dir, 'sources/atelier.pptx.files/image-02.png')))?.width, 300);
});

test('a picture is judged at each place it is put: left out as a dot in a corner, kept where it fills the slide', () => {
  const slide = { slideCx: 12192000, slideCy: 6858000 };
  const cm = 360000;
  assert.equal(smallPicture({ width: 96, height: 96 }, { ...slide, cx: 6 * cm, cy: 6 * cm }), null);
  assert.match(smallPicture({ width: 96, height: 96 }, { ...slide, cx: 0.8 * cm, cy: 0.8 * cm }) ?? '', /a dot on the slide/);
  assert.match(smallPicture({ width: 32, height: 20 }, { ...slide, cx: 6 * cm, cy: 4 * cm }) ?? '', /32×20 px/, 'an icon, however large it is shown');
  assert.equal(smallPicture({ width: 33, height: 33 }, null), null, 'one pixel over the icons');
  assert.match(smallPicture({ width: 1200, height: 4 }, null) ?? '', /a rule/, 'a rule drawn as a picture');
  assert.match(smallPicture({ width: 800, height: 600 }, { ...slide, cx: 20 * cm, cy: 0.1 * cm }) ?? '', /a rule on the slide/, 'squeezed to a line');
  assert.equal(smallPicture(null, { ...slide, cx: 6 * cm, cy: 6 * cm }), null, 'a size unknown (an SVG) is judged by its box alone');
  assert.equal(smallPicture(null, null), null);
  assert.equal(smallPicture({ width: 1086, height: 1448 }, { ...slide, cx: 4292906, cy: 6858000 }), null, 'a real deck\'s portrait on the cover');
});

test('the size of a picture is read from its header: PNG, GIF, JPEG after its EXIF block, the three kinds of WebP; nothing else', () => {
  assert.deepEqual(imageSize(png(7, 5, [0, 0, 0])), { width: 7, height: 5 });
  assert.deepEqual(imageSize(Buffer.from('474946383961' + '0a00' + '1400' + '00'.repeat(8), 'hex')), { width: 10, height: 20 }, 'GIF89a');
  // SOI, an APP1 block of 40 bytes, a DHT table (not a frame), then SOF0: height 600, width 800.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x2a]), Buffer.alloc(40), Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]), Buffer.alloc(9)]);
  assert.deepEqual(imageSize(jpeg), { width: 800, height: 600 });
  assert.equal(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00]), Buffer.alloc(20)])), null, 'a scan before any frame');
  const riff = (kind: string, body: Buffer) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(kind), Buffer.from([0, 0, 0, 0]), body]);
  const x = Buffer.alloc(18);
  x.writeUIntLE(639, 4, 3);
  x.writeUIntLE(479, 7, 3);
  assert.deepEqual(imageSize(riff('VP8X', x)), { width: 640, height: 480 }, 'extended');
  const lossless = Buffer.alloc(16);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE(((299 << 14) | 399) >>> 0, 1);
  assert.deepEqual(imageSize(riff('VP8L', lossless)), { width: 400, height: 300 }, 'lossless');
  const lossy = Buffer.alloc(20);
  lossy.set([0x9d, 0x01, 0x2a], 3);
  lossy.writeUInt16LE(321, 6);
  lossy.writeUInt16LE(241, 8);
  assert.deepEqual(imageSize(riff('VP8 ', lossy)), { width: 321, height: 241 }, 'lossy');
  assert.equal(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')), null);
  assert.equal(imageSize(Buffer.from([0x89, 0x50, 0x4e])), null, 'cut short');
});

test('older office formats are not read: the notes say to save the file as .docx or .pptx, or as a PDF; nothing is written beside them', async () => {
  const dir = course();
  const files = ['ancien.doc', 'modele.rtf', 'notes.odt', 'cours.ppt', 'projection.pps', 'atelier.odp', 'Planification.key'];
  await addSources(dir, files.map((name) => write(name, `not really ${name}`)));
  for (const entries of [await listSources(dir), await makeSourcesReadable(dir, { force: true }), await makeSourcesReadable(dir)]) {
    assert.deepEqual(entries.map((entry) => [entry.name, entry.readable.status, entry.readable.path]), files.map((name) => [name, 'unsupported', null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  }
  const listed = await listSources(dir);
  const doc = listed.find((entry) => entry.name === 'ancien.doc')!;
  const ppt = listed.find((entry) => entry.name === 'cours.ppt')!;
  assert.deepEqual(doc.readable.notes, ['DOC is an older word-processing format that Elabora does not read: save the file as .docx (or as a PDF) from the application that made it, and add that file to the sources.']);
  assert.deepEqual(ppt.readable.notes, ['PPT is an older presentation format that Elabora does not read: save the file as .pptx (or as a PDF) from the application that made it, and add that file to the sources.']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')).sort(), [...files].sort(), 'no readable version, no folder of parts');
  const reading = await readSource(dir, 'ancien.doc');
  assert.equal(reading.text, null);
  assert.equal(reading.file, null);
  assert.equal(reading.source.readable.status, 'unsupported');
  // A modern file under the same names is read: the notes are about the format, not the kind.
  await addSources(dir, [write('brief.docx', briefDocx())]);
  assert.equal((await readSource(dir, 'brief.docx')).source.readable.status, 'ready');
});

test('no program of the machine is looked for or run: the variables that named them change nothing', { skip: process.platform === 'win32' && 'the stand-in programs are shell scripts' }, async () => {
  const dir = course();
  await addSources(dir, [write('atelier.pptx', workshopPptx()), write('consignes.pdf', textPdf(['Consignes page un']))]);
  const before = (await makeSourcesReadable(dir)).map((entry) => [entry.name, entry.readable.status, entry.readable.notes]);
  const bin = path.join(temp, 'fake-bin');
  fs.mkdirSync(bin);
  const marker = path.join(temp, 'was-run');
  for (const name of ['soffice', 'libreoffice', 'pdftoppm', 'pdftotext']) {
    const program = path.join(bin, name);
    fs.writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  }
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELABORA_SOFFICE: path.join(bin, 'soffice'), ELABORA_PDFTOPPM: path.join(bin, 'pdftoppm'), ELABORA_PDFTOTEXT: path.join(bin, 'pdftotext') };
  const after = await withEnv(env, async () => (await makeSourcesReadable(dir, { force: true })).map((entry) => [entry.name, entry.readable.status, entry.readable.notes]));
  assert.deepEqual(after, before);
  assert.equal(fs.existsSync(marker), false);
});

test('a readable version is written again when its source changes, not when the same file is copied or touched; partial ones once they can be finished', async () => {
  const dir = course();
  const [{ name }] = await addSources(dir, [write('brief.docx', briefDocx())]);
  await makeSourcesReadable(dir);
  const file = path.join(dir, 'sources', name);
  const madeAt = (await listSources(dir))[0].readable.madeAt;
  // Touched: the same content, a new time.
  const later = new Date(fs.statSync(file).mtimeMs + 60_000);
  fs.utimesSync(file, later, later);
  const touched = await listSources(dir);
  assert.equal(touched[0].readable.status, 'ready');
  assert.equal((await makeSourcesReadable(dir))[0].readable.madeAt, madeAt, 'not written again');
  // Changed.
  fs.writeFileSync(file, workshopPptx().subarray(0, 10));
  assert.equal((await listSources(dir))[0].readable.status, 'stale');
  const read = await readSource(dir, 'BRIEF.docx');
  assert.equal(read.source.readable.status, 'failed', 'written again, from a file that is not a Word document any more');
  assert.match(read.text ?? '', /could not read this file/);
  // refresh: false reads what is there.
  fs.writeFileSync(file, briefDocx());
  assert.equal((await readSource(dir, name, { refresh: false })).source.readable.status, 'stale');
  assert.equal((await readSource(dir, `sources/${name}.md`)).source.readable.status, 'ready', 'by its readable version\'s name');
});

test('a PDF is read as it is: agents read PDFs themselves, and Elabora makes no text of its own from one', async () => {
  const dir = course();
  await addSources(dir, [write('consignes.pdf', textPdf(['Consignes page un', 'Plan page deux']))]);
  const [entry] = await makeSourcesReadable(dir, { force: true });
  assert.equal(entry.readable.status, 'native');
  assert.equal(entry.readable.path, 'sources/consignes.pdf');
  assert.match(entry.readable.notes[0], /Read the PDF itself/);
  const reading = await readSource(dir, 'consignes.pdf');
  assert.equal(reading.source.readable.status, 'native');
  assert.equal(reading.file, path.join(dir, 'sources', 'consignes.pdf'));
  assert.equal(reading.text, null);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')), ['consignes.pdf']);
});

test('recordings: a transcript in timed paragraphs, a video\'s frames where they are; without the transcriber, partial until it is here', { skip: NO_FFMPEG }, async () => {
  const dir = course();
  const video = path.join(temp, 'entretien.mp4');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=70', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=70', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', video]);
  const audio = path.join(temp, 'memo.m4a');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'aac', audio]);
  await addSources(dir, [video, audio]);
  const said = 'Bonjour, je suis responsable de la sécurité. Nous avons deux sites. Le premier compte deux cents personnes. Le second en compte cent. Les exercices ont lieu deux fois par an. Merci.';
  // No transcriber here: the frames, and a transcript to come.
  const empty = path.join(temp, 'no-model');
  const partial = await withEnv({ ELABORA_TRANSCRIBER_MODELS_DIR: empty, ELABORA_TRANSCRIBER_MODELS_MANIFEST: undefined, ELABORA_TRANSCRIBER_FAKE: undefined }, () => makeSourcesReadable(dir));
  assert.deepEqual(partial.map((entry) => [entry.name, entry.kind, entry.readable.status]), [['entretien.mp4', 'video', 'partial'], ['memo.m4a', 'audio', 'partial']]);
  assert.equal(partial[0].readable.parts.length, 3, 'three frames');
  assert.match(text(dir, 'sources/entretien.mp4.md'), /No transcript yet: the transcription model .* is not here/);
  // The transcriber installed: finished at the next read, without asking.
  await withEnv(transcriberEnv({ 'entretien.mp4': said, 'memo.m4a': 'Penser au plan du site B.' }), async () => {
    const reading = await readSource(dir, 'entretien.mp4');
    assert.equal(reading.source.readable.status, 'ready');
    const markdown = reading.text ?? '';
    assert.match(markdown, /Video, 1 min 10 s, 320×240\./);
    // A paragraph at the end of a sentence once 30 s are said; each frame between the paragraphs it falls between.
    assert.match(markdown, /## Transcript\n\n\*\*\[00:00\]\*\* Bonjour, je suis responsable de la sécurité\. Nous avons deux sites\. Le premier compte deux cents personnes\.\n\n!\[Frame at 00:11\]\(entretien\.mp4\.files\/frame-00-11\.jpg\)\n\n!\[Frame at 00:35\]\(entretien\.mp4\.files\/frame-00-35\.jpg\)\n\n\*\*\[00:38\]\*\* Le second en compte cent\. Les exercices ont lieu deux fois par an\. Merci\.\n\n!\[Frame at 00:58\]/);
    assert.match(markdown, /Transcribed on this computer by fake/);
    const memo = await readSource(dir, 'memo.m4a');
    assert.match(memo.text ?? '', /Audio, 4 s\.\n\n## Transcript\n\n\*\*\[00:00\]\*\* Penser au plan du site B\./);
    assert.deepEqual(memo.source.readable.parts, []);
  });
});

test('frames and paragraphs of a recording', () => {
  assert.deepEqual(frameTimes(10), [5]);
  assert.deepEqual(frameTimes(60), [10, 30, 50]);
  assert.equal(frameTimes(3600).length, 12);
  const words = Array.from({ length: 40 }, (_, i) => ({ text: `w${i}`, start: i * 3, end: i * 3 + 3 }));
  const transcript = { text: words.map((word, i) => `${word.text}${i % 5 === 4 ? '.' : ''}`).join(' '), words };
  const paragraphs = transcriptParagraphs(transcript);
  assert.deepEqual(paragraphs.map((paragraph) => paragraph.start), [0, 45, 90]);
  assert.ok(paragraphs[0].text.endsWith('w14.'));
});

test('removing a source deletes it and its readable version, nothing else; a name is resolved without case', async () => {
  const dir = course();
  await addSources(dir, [write('brief.docx', briefDocx()), write('notes.md', '# Mes notes\n')]);
  await makeSourcesReadable(dir);
  assert.equal(resolveSource(dir, 'Brief.DOCX').name, 'brief.docx');
  assert.throws(() => resolveSource(dir, 'absent.pdf'), (error: Error & { code?: string; details?: { sources?: string[] } }) => error.code === 'E_SOURCE_NOT_FOUND' && /there are: brief\.docx, notes\.md/.test(error.message));
  assert.deepEqual(await removeSource(dir, 'brief.docx'), { removed: ['sources/brief.docx', 'sources/brief.docx.md', 'sources/brief.docx.files'] });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sources')), ['notes.md']);
  // The author's own Markdown is a source, read as it is, and never taken for a readable version.
  const [notes] = await listSources(dir);
  assert.deepEqual([notes.name, notes.readable.status], ['notes.md', 'native']);
  assert.equal((await readSource(dir, 'notes.md')).text, '# Mes notes\n');
});

// ── never published, never in a backup ──

async function withSources(): Promise<string> {
  const dir = course();
  await addSources(dir, [write('brief-client.docx', briefDocx()), write('atelier.pptx', workshopPptx()), write('photo.png', png(8, 8, [30, 60, 90]))]);
  await makeSourcesReadable(dir);
  return dir;
}

test('sources/ is not the course: no snapshot, no finding; what points into it is E_SOURCE_REFERENCED', async () => {
  const plain = course();
  const dir = await withSources();
  const project = loadProjectFromDir(dir);
  assert.deepEqual([...project.files.keys()].filter((key) => key.startsWith('sources')), []);
  assert.deepEqual(codes(validateProject(project).diagnostics), codes(validateProject(loadProjectFromDir(plain)).diagnostics));
  // An image block, a theme's url() and the share image that would publish a source.
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.find((block: { id: string }) => block.id === 'accueil-illustration').props.asset = '../sources/photo.png';
  writeJSON(dir, 'screens/accueil.json', screen);
  fs.mkdirSync(path.join(dir, 'theme'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme', 'course.css'), '.screen { background: url(../sources/photo.png); }\n');
  const course_ = readJSON(dir, 'course.json');
  writeJSON(dir, 'course.json', { ...course_, theme: { ...course_.theme, stylesheet: 'theme/course.css' } });
  const findings = validateProject(loadProjectFromDir(dir)).diagnostics.filter((d) => d.code === 'E_SOURCE_REFERENCED');
  assert.deepEqual(findings.map((d) => d.file).sort(), ['screens/accueil.json', 'theme/course.css']);
  assert.match(findings.find((d) => d.file === 'screens/accueil.json')?.message ?? '', /elabora media import \. sources\/photo\.png/);
  const refused = await build(dir, { out: fs.mkdtempSync(path.join(temp, 'out-')) });
  assert.equal(refused.ok, false);
});

test('a package is the same, byte for byte, with sources or without: SCORM, web and review builds carry nothing of sources/', async () => {
  const plain = course();
  const dir = await withSources();
  const out = () => fs.mkdtempSync(path.join(temp, 'build-'));
  for (const options of [{}, { target: 'web' as const }, { target: 'web' as const, web: { review: { origins: ['https://revue.elabora.studio'] } } }]) {
    const [a, b] = [await build(plain, { ...options, out: out() }), await build(dir, { ...options, out: out() })];
    assert.ok(a.ok && b.ok && a.zipPath && b.zipPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error')));
    assert.equal(b.report.package.sha256, a.report.package.sha256, JSON.stringify(options));
    assert.deepEqual([...readZip(fs.readFileSync(b.zipPath)).files.keys()].filter((name) => /sources|\.md$|brief|atelier/.test(name)), []);
  }
  const shared = await build(dir, { target: 'web', web: { image: 'sources/photo.png' }, out: out() });
  assert.equal(shared.ok, false);
  assert.deepEqual(shared.diagnostics.filter((d) => d.code === 'E_SOURCE_REFERENCED').map((d) => d.target), ['sources/photo.png']);
});

test('backups never hold sources, and a restore leaves them as they are', async () => {
  const dir = await withSources();
  const version = await createVersion(dir, { reason: 'manual', author: null });
  assert.ok(version);
  assert.deepEqual(Object.keys(version.files).filter((file) => file.startsWith('sources')), []);
  fs.writeFileSync(path.join(dir, 'sources', 'nouveau.txt'), 'arrivé après');
  await restore(dir, (await listVersions(dir))[0].id);
  assert.ok(fs.existsSync(path.join(dir, 'sources', 'nouveau.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'sources', 'brief-client.docx.md')));
});

test('library: a module\'s copy and its import from a folder carry its sources; its archive only with sources: true, and a replacement keeps them', async () => {
  process.env.ELABORA_LIBRARY = path.join(fs.mkdtempSync(path.join(temp, 'library-')), 'Library');
  const dir = await withSources();
  const imported = await importFolder(dir);
  const files = (root: string) => fs.readdirSync(path.join(root, 'sources')).sort();
  assert.deepEqual(files(imported.project.path), files(dir));
  assert.equal(imported.project.sourcesSize, fs.readdirSync(path.join(dir, 'sources'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).reduce((sum, entry) => sum + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0));
  const copy = await duplicateProject(imported.project.id);
  assert.deepEqual(files(copy.path), files(dir));
  assert.equal((await listSources(copy.path)).find((entry) => entry.name === 'brief-client.docx')?.readable.status, 'ready', 'the copy\'s readable versions hold');

  const without = path.join(temp, 'without.elabora');
  const result = await exportProject(imported.project.path, without);
  assert.equal(result.sources, null);
  assert.deepEqual((await inspectArchive(without)).archive.sources, { files: 0, bytes: 0 });
  const withSourcesFile = path.join(temp, 'with.elabora');
  const exported = await exportProject(imported.project.path, withSourcesFile, { sources: true });
  assert.ok(exported.sources && exported.sources.files >= 6, JSON.stringify(exported.sources));
  assert.equal(exported.files, result.files, 'the course\'s files are counted apart');
  const { archive } = await inspectArchive(withSourcesFile);
  assert.deepEqual(archive.sources, exported.sources);
  const fromArchive = await importArchive(withSourcesFile, { onExisting: 'copy' });
  assert.equal(fromArchive.status, 'imported');
  if (fromArchive.status !== 'imported') return;
  assert.deepEqual(files(fromArchive.project.path), files(dir));
  // Replaced by an archive without sources: the module keeps its own.
  const replaced = await importArchive(without, { replace: fromArchive.project.id });
  assert.equal(replaced.status, 'imported');
  assert.deepEqual(files(getProject(fromArchive.project.id).path), files(dir));
  assert.ok(listProjects().every((project) => project.error === null), JSON.stringify(listProjects().map((project) => project.error)));
});

// ── the command line ──

function elabora(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('elabora sources add, list, read, refresh and remove', async () => {
  const dir = course();
  const brief = write('brief-client.docx', briefDocx());
  const added = await elabora(['sources', 'add', dir, brief, '--json']);
  assert.equal(added.status, 0, added.stderr);
  const answer = JSON.parse(added.stdout);
  assert.deepEqual(answer.added.map((entry: { name: string; status: string; source: { readable: { status: string } } }) => [entry.name, entry.status, entry.source.readable.status]), [['brief-client.docx', 'added', 'ready']]);
  const listed = await elabora(['sources', 'list', dir]);
  assert.match(listed.stdout, /^ {2}brief-client\.docx {2}word, 5 kB · readable → sources\/brief-client\.docx\.md \(\+1 image\)\n$/);
  const read = await elabora(['sources', 'read', dir, 'brief-client.docx']);
  assert.equal(read.status, 0);
  assert.match(read.stdout, /^<!-- elabora:readable /);
  assert.match(read.stdout, /## Contexte/);
  const again = await elabora(['sources', 'add', dir, brief]);
  assert.match(again.stdout, /already there as sources\/brief-client\.docx · readable/);
  const refreshed = await elabora(['sources', 'refresh', dir, '--force', '--json']);
  assert.equal(JSON.parse(refreshed.stdout).sources[0].readable.status, 'ready');
  const missing = await elabora(['sources', 'read', dir, 'absent.pdf']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No source "absent\.pdf" in sources\/ \(there are: brief-client\.docx\)/);
  const removed = await elabora(['sources', 'remove', dir, 'brief-client.docx']);
  assert.match(removed.stdout, /Deleted for good: sources\/brief-client\.docx, sources\/brief-client\.docx\.md, sources\/brief-client\.docx\.files\./);
  assert.match((await elabora(['sources', 'list', dir])).stdout, /No sources/);
  assert.equal((await elabora(['sources'])).status, 2);
});

test('MCP: elabora_source_add, elabora_sources and elabora_source_read (in parts, with its pictures), also in read-only mode', async () => {
  const dir = course();
  const connect = async (readOnly: boolean) => {
    const server = createMcpServer(dir, { readOnly });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test-agent', version: '1' });
    clients.push(client);
    await client.connect(clientSide);
    return client;
  };
  const client = await connect(false);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; mimeType?: string }[] };
  const added = await call('elabora_source_add', { files: [write('atelier.pptx', workshopPptx())] });
  assert.equal(JSON.parse(added.content[0].text ?? '').sources[0].readable.status, 'ready');
  const listed = JSON.parse((await call('elabora_sources', {})).content[0].text ?? '');
  assert.deepEqual(listed.sources.map((entry: { name: string }) => entry.name), ['atelier.pptx']);
  const read = await call('elabora_source_read', { file: 'atelier.pptx', images: true });
  const meta = JSON.parse(read.content[0].text ?? '');
  assert.deepEqual([meta.source, meta.status, meta.offset, meta.next], ['atelier.pptx', 'ready', 0, null]);
  assert.match(read.content[1].text ?? '', /## Slide 2 — Pourquoi évacuer \?/);
  assert.deepEqual(read.content.slice(2).map((part) => [part.type, part.mimeType]), [['image', 'image/png'], ['image', 'image/png'], ['image', 'image/png'], ['image', 'image/png']]);
  const page = await call('elabora_source_read', { file: 'atelier.pptx', offset: 100 });
  assert.equal(page.content[1].text, read.content[1].text?.slice(100));
  assert.equal((await call('elabora_source_read', { file: 'absent.docx' })).isError, true);
  const reader = await connect(true);
  const names = (await reader.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('elabora_sources') && names.includes('elabora_source_read') && !names.includes('elabora_source_add'), names.join(' '));
});
