// Writes the synthetic sources of the tests (test/sources-fixtures.ts: a Word brief and a PowerPoint
// deck, made byte by byte, no one's document) to test/fixtures/sources/, to open them in Word,
// PowerPoint, or to give them to an agent. A unit test checks the files there are the
// ones the builders make. docs/decisions.md D49.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefDocx, workshopPptx } from '../test/sources-fixtures.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test/fixtures/sources');

if (import.meta.main) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'brief-client.docx'), briefDocx());
  fs.writeFileSync(path.join(OUT, 'atelier.pptx'), workshopPptx());
  console.log(`Wrote ${path.relative(ROOT, OUT)}/brief-client.docx and atelier.pptx.`);
}
