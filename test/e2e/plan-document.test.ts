import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exportPlanDocument, printPlanDocument, readPlanDocument } from '@elabora/node/plan-document';
import * as edit from '@elabora/node/edit';
import { copyExample } from '../helpers.ts';

// The plan's document printed to PDF by Chromium (docs/decisions.md D48, D52): A4, tagged, with an outline
// from its headings, its title and the document's day as its dates, and the same bytes when the same
// Chromium prints the same page twice. The app prints the same page with Electron's printToPDF.

test('the plan\'s document prints to a tagged A4 PDF with an outline, the same twice', async () => {
  const dir = copyExample();
  try {
    // The working copy, a text changed since V1 validated: its words deleted and inserted print too.
    edit.setPlanText(dir, { block: 'chemin-regle', markdown: 'Suivez toujours le chemin dans l\'ordre. N\'en sautez aucune étape.' }, { author: { kind: 'human' } });
    const doc = readPlanDocument(dir, { date: '2026-10-15', version: 'current' });
    const first = await printPlanDocument(doc);
    const second = await printPlanDocument(doc);
    const text = Buffer.from(first.pdf).toString('latin1');
    assert.match(text, /^%PDF-1\.\d/);
    const title = /\/Title <FEFF([0-9A-F]+)>/.exec(text)?.[1] ?? '';
    assert.equal(Buffer.from(title, 'hex').swap16().toString('utf16le'), 'Diagnostiquer une panne d\'impression réseau · Plan du module');
    assert.match(text, /\/CreationDate \(D:20261015120000/);
    assert.match(text, /\/ModDate \(D:20261015120000/);
    assert.match(text, /\/StructTreeRoot/, 'tagged');
    assert.match(text, /\/Outlines/, 'an outline from the headings');
    assert.match(text, /\/MediaBox \[0 0 594\.9\d* 841\.9\d*\]/, 'A4');
    assert.ok((text.match(/\/Type \/Page\b/g) ?? []).length >= 2, 'several pages');
    assert.deepEqual(Buffer.from(second.pdf), Buffer.from(first.pdf), 'the same page, the same Chromium: the same bytes');
    const out = path.join(dir, 'dist', 'plan.pdf');
    const exported = await exportPlanDocument(dir, { format: 'pdf', out, date: '2026-10-15', version: 'current' });
    assert.deepEqual([exported.file, exported.version, exported.sent], [out, null, false]);
    assert.deepEqual(fs.readFileSync(out), Buffer.from(first.pdf));
    assert.ok(exported.browser?.version);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// With Elabora's Electron (ELABORA_ELECTRON_EXECUTABLE, and ELABORA_ELECTRON_ENTRY for a development
// worker: the app's try:plan-document gives both), the page is printed by webContents.printToPDF in a
// worker, as the app prints it: Electron's DevTools protocol has no Page.printToPDF.
test('with Elabora\'s Electron, the plan\'s document prints through Electron\'s own printToPDF, the same twice', { skip: !process.env.ELABORA_ELECTRON_EXECUTABLE && 'no Electron (ELABORA_ELECTRON_EXECUTABLE)' }, async () => {
  const dir = copyExample();
  try {
    const doc = readPlanDocument(dir, { date: '2026-10-16' });
    const first = await printPlanDocument(doc);
    const second = await printPlanDocument(doc);
    assert.equal(first.browser.engine, 'electron');
    const text = Buffer.from(first.pdf).toString('latin1');
    assert.match(text, /\/CreationDate \(D:20261016120000/);
    assert.match(text, /\/StructTreeRoot/, 'tagged');
    assert.match(text, /\/Outlines/, 'an outline from the headings');
    assert.match(text, /\/MediaBox \[0 0 594\.9\d* 841\.9\d*\]/, 'A4');
    assert.deepEqual(Buffer.from(second.pdf), Buffer.from(first.pdf));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
