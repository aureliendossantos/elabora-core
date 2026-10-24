import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { moduleUrl } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pdfTitle, pdfTitleOf } from '@elabora/node/sources/pdf-title';
import { textPdf } from '../sources-fixtures.ts';

// A PDF's own title (docs/decisions.md D58), read for the app to name a dropped file: the XMP
// metadata's dc:title, else the information dictionary's /Title, packed in an object stream or not.

// A PDF of these objects (numbered from 1), with this trailer; an object given as a Buffer is a
// stream's raw bytes after its dictionary.
function pdf(objects: (string | [string, Buffer])[], trailer: string): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const body = typeof object === 'string'
      ? Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${index + 1} 0 obj\n${object[0]}\nstream\n`, 'latin1'), object[1], Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(body);
    length += body.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
const pages = '<< /Type /Pages /Kids [] /Count 0 >>';

test('the title of the information dictionary: literal strings with escapes, UTF-16 in hex, PDFDocEncoding', () => {
  assert.equal(pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, '<< /Title (Brief \\(v2\\) du client\\051 \\223a) /Producer (Word) >>'], '/Root 1 0 R /Info 3 0 R')), 'Brief (v2) du client) ﬁa');
  const utf16 = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Sécurité réseau 网络', 'utf16le').swap16()]).toString('hex');
  assert.equal(pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, `<< /Title <${utf16}> >>`], '/Root 1 0 R /Info 3 0 R')), 'Sécurité réseau 网络');
  // An edited PDF appends a new information dictionary and trailer: the last one counts.
  const edited = Buffer.concat([
    pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, '<< /Title (Old title) >>'], '/Root 1 0 R /Info 3 0 R'),
    Buffer.from('4 0 obj\n<< /Title (New title) >>\nendobj\ntrailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R >>\n%%EOF\n', 'latin1')
  ]);
  assert.equal(pdfTitleOf(edited), 'New title');
});

test('the XMP title comes first, its x-default language, even compressed', () => {
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="fr-FR">Titre français</rdf:li><rdf:li xml:lang="x-default">Onboarding &amp; sécurité</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const plain = Buffer.from(xmp, 'utf8');
  assert.equal(pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R /Metadata 3 0 R >>', pages, [`<< /Type /Metadata /Subtype /XML /Length ${plain.length} >>`, plain], '<< /Title (Info title) >>'], '/Root 1 0 R /Info 4 0 R')), 'Onboarding & sécurité');
  const packed = zlib.deflateSync(plain);
  assert.equal(pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R /Metadata 3 0 R >>', pages, [`<< /Type /Metadata /Subtype /XML /Filter /FlateDecode /Length ${packed.length} >>`, packed]], '/Root 1 0 R')), 'Onboarding & sécurité');
  // An image's own XMP is not the document's.
  assert.equal(pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, [`<< /Type /Metadata /Subtype /XML /Length ${plain.length} >>`, plain]], '/Root 1 0 R')), null);
});

test('the information dictionary packed in a compressed object stream (PDF 1.5)', () => {
  // Objects 4 (the catalog) and 5 (the information dictionary) packed in object 1.
  const inside = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Title (Packed title) /Author (A) >>'];
  const header = `4 0 5 ${inside[0].length + 1} `;
  const stream = zlib.deflateSync(Buffer.from(`${header}${inside.join(' ')}`, 'latin1'));
  const rebuilt = pdf([[`<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${stream.length} >>`, stream], pages], '/Root 4 0 R /Info 5 0 R');
  assert.equal(pdfTitleOf(rebuilt), 'Packed title');
});

test('no title: none said, one a program wrote, encrypted, not a PDF', () => {
  assert.equal(pdfTitleOf(textPdf(['Page one'])), null);
  for (const title of ['Microsoft Word - brief client.docx', 'Untitled', 'Présentation PowerPoint', 'Document1', 'brief_client_v3', '   ', 'scan.pdf', '0141', 'FIT010W']) {
    assert.equal(pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, `<< /Title (${title}) >>`], '/Root 1 0 R /Info 3 0 R')), null, title);
  }
  assert.equal(pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, '<< /Title (Microsoft Word - Plan de formation) >>'], '/Root 1 0 R /Info 3 0 R')), 'Plan de formation');
  assert.equal(pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, '<< /Title (\x8f\x12\xaa) >>', '<< /Filter /Standard /V 2 >>'], '/Root 1 0 R /Info 3 0 R /Encrypt 4 0 R')), null);
  assert.equal(pdfTitleOf(Buffer.from('PK\x03\x04 not a pdf /Title (Nope)', 'latin1')), null);
});

test('a file on disk, read at both ends when it is large', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-pdf-title-'));
  try {
    const small = path.join(dir, 'small.pdf');
    fs.writeFileSync(small, pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, '<< /Title (Le plan de la formation) >>'], '/Root 1 0 R /Info 3 0 R'));
    assert.equal(await pdfTitle(small), 'Le plan de la formation');
    // 40 MB of pages between the header and the objects at the end.
    const large = path.join(dir, 'large.pdf');
    const end = pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, '<< /Title (A large handbook) >>'], '/Root 1 0 R /Info 3 0 R');
    fs.writeFileSync(large, Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(40 * 1024 * 1024, 0x20), end.subarray(9)]));
    assert.equal(await pdfTitle(large), 'A large handbook');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a PDF made to hurt: bounded, never throws, null when in doubt', () => {
  const bounded = (bytes: Buffer) => {
    const script = `import fs from 'node:fs'; import { pdfTitleOf } from ${JSON.stringify(moduleUrl('packages/node/src/sources/pdf-title.ts'))}; console.log(JSON.stringify(pdfTitleOf(fs.readFileSync(0))));`;
    const run = spawnSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], { input: bytes, encoding: 'utf8', timeout: 15_000 });
    assert.equal(run.status, 0, run.error?.message ?? run.stderr);
    return JSON.parse(run.stdout);
  };
  // A character reference that names no character.
  const xmp = Buffer.from('<x:xmpmeta><dc:title><rdf:Alt><rdf:li xml:lang="x-default">A &#x110000; B&#xD800;</rdf:li></rdf:Alt></dc:title></x:xmpmeta>', 'utf8');
  assert.equal(pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R /Metadata 3 0 R >>', pages, [`<< /Length ${xmp.length} >>`, xmp]], '/Root 1 0 R')), 'A B');
  // A long run of digits where objects are looked for (Root not at the top level).
  const digits = bounded(Buffer.from(`%PDF-1.7\n${'1'.repeat(1024 * 1024)}\ntrailer << /Root 5 0 R /Info 6 0 R >>`, 'latin1'));
  assert.equal(digits, null);
  // A stream that inflates to a gigabyte: read up to the bound only.
  const bomb = zlib.deflateSync(Buffer.alloc(256 * 1024 * 1024));
  const inflated = bounded(pdf([[`<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${bomb.length} >>`, bomb], '<< /Type /Catalog /Metadata 1 0 R >>'], '/Root 2 0 R /Info 3 0 R'));
  assert.equal(inflated, null);
  // Hundreds of object streams in a large file, the Info dictionary in none of them.
  const many = Array.from({ length: 500 }, (_, index) => `${index + 10} 0 obj\n<< /Type /ObjStm /N 0 /First 0 /Length 4 >>\nstream\nxxxx\nendstream\nendobj\n${'%'.repeat(60000)}\n`).join('');
  const streams = bounded(Buffer.from(`%PDF-1.7\n${many}trailer << /Root 1 0 R /Info 2 0 R >>`, 'latin1'));
  assert.equal(streams, null);
  // A title longer than a resource's title may be: cut at a word.
  const long = pdfTitleOf(pdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, `<< /Title (${'Procédure de diagnostic '.repeat(8)}) >>`], '/Root 1 0 R /Info 3 0 R'))!;
  assert.ok(long.length <= 120 && long.endsWith('…') && long.startsWith('Procédure de diagnostic'), long);
});
