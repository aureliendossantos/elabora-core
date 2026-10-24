import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openProject } from '@elabora/engine';
import { planDocument } from '@elabora/core/plan-document/model';
import { localDay } from '@elabora/core/util/local-day';
import { commandContext } from '@elabora/core/commands/context';
import { createPlanVersion } from '@elabora/core/commands/plan';
import type { PlanDocument, PlanSection } from '@elabora/core/plan-document/model';
import { planDocumentHtml } from '@elabora/core/plan-document/html';
import { planDocumentDocx, planIdOfBookmark, wordBookmarkName } from '@elabora/core/plan-document/docx';
import { diffRich, parseRich, plainOf } from '@elabora/core/plan-document/rich';
import { finishPlanPdf } from '@elabora/core/plan-document/pdf';
import { planDocumentPage, planDocumentWord, readPlanDocument } from '@elabora/node/plan-document';
import { readZip } from '@elabora/node/zip';
import { planDiffBetween, planVersionsView } from '@elabora/core/project/plan-versions';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { iterateBlocks } from '@elabora/core/project/load';
import * as edit from '@elabora/node/edit';
import { createMcpServer } from '@elabora/cli/mcp';
import { ROOT, readJSON, writeJSON } from '../helpers.ts';

import { resources } from '../resources.ts';

// The plan's document (docs/decisions.md D48, D52): one model, read by the Word, HTML and PDF exports
// and by the app. What the client reads and signs: a version of the plan or its working copy, the
// versions before it, its sections, the changes since the validated version in place and the notes
// for the client; never who wrote it. The .docx is checked as a package (parts, relationships, styles,
// well-formed XML, bookmarks, revisions) and, when they are installed, opened by python-docx and
// read back by pandoc.

const GEARS = path.join(ROOT, 'examples/planetary-gearset');
const NETWORK = path.join(ROOT, 'examples/diagnostic-reseau'); // V1 sent, V2 validated, two changes since
const PERSON = { author: { kind: 'human' as const, name: 'Aurélien' } };
const AGENT = { author: { kind: 'agent' as const, name: 'claude-code' } };
const DATE = '2026-10-15';
const documentOf = (dir: string, version?: number | 'current'): PlanDocument => planDocument(loadProjectFromDir(dir), { date: DATE, ...(version !== undefined ? { version } : {}) })!;
const section = <Kind extends PlanSection['kind']>(doc: PlanDocument, kind: Kind) => doc.sections.find((entry) => entry.kind === kind) as Extract<PlanSection, { kind: Kind }>;
const docxText = (doc: PlanDocument) => [...planDocumentDocx(doc).values()].join('\n');

test('the document of a validated version: its properties, then the six sections, in the module\'s language', (t) => {
  const { copyExample: course } = resources(t);
  const doc = documentOf(course());
  assert.equal(doc.format, 'elabora/plan-document/2');
  assert.equal(doc.words, 'fr');
  assert.equal(doc.kicker, 'Plan validé');
  assert.equal(doc.title, 'Diagnostiquer une panne d\'impression réseau');
  assert.deepEqual(doc.status, { state: 'approved', label: 'Bon pour production' });
  assert.deepEqual(doc.shows, { version: 1, label: 'V1', current: false });
  assert.deepEqual(doc.properties.map((property) => [property.key, property.label]), [['status', 'Statut'], ['version', 'Version'], ['approvedBy', 'Validé par'], ['module', 'Module'], ['history', 'Historique']]);
  assert.equal(doc.properties[1]!.value, 'V1');
  assert.match(doc.properties[2]!.value, /^Claire Martin, .*, le 5 octobre 2026 \(V1\)$/);
  assert.equal(doc.properties[3]!.value, '15 min · SCORM 1.2');
  assert.deepEqual(doc.history, [{ version: 'V1', line: 'V1 validée par Claire Martin, Hélios Énergie (client fictif) le 5 octobre 2026 (Storyboard v3 validé par courriel)' }]);
  assert.equal(doc.marks, null);
  assert.deepEqual(doc.sections.map((entry) => entry.title), ['Cadrage', 'Objectifs', 'Séquence', 'Textes validés', 'Évaluations', 'Sources']);
  assert.deepEqual(section(doc, 'objectives').objectives.map((objective) => [objective.id, objective.heading]), [['OBJ-1', 'Objectif 1'], ['OBJ-2', 'Objectif 2']]);
  const items = section(doc, 'sequence').items;
  assert.deepEqual(items.map((item) => item.number), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(items[4]!.objectives.map((objective) => objective.number), ['1', '2']);
  assert.deepEqual(section(doc, 'texts').groups.flatMap((group) => group.texts.map((text) => [text.id, text.number])), [['TXT-1', '1.1'], ['TXT-2', '2.1']]);
  const questions = section(doc, 'assessments').groups.flatMap((group) => group.questions);
  assert.deepEqual(questions.map((question) => [question.id, question.heading, question.options.filter((option) => option.correct).map((option) => option.letter).join()]), [['Q-1', 'Question 5.1', 'B'], ['Q-2', 'Question 5.2', 'B']]);
  assert.equal(section(doc, 'sources').sources[0]!.title, 'Procédure interne SUP-NET-04 : diagnostic des pannes d\'impression');
  assert.match(doc.colophon, /^Plan PLAN-HELIOS-NET-V1, V1, empreinte sha256:[0-9a-f]{64}\. Document établi le 15 octobre 2026\.$/);
  // Rich text: the plan's Markdown as data.
  assert.deepEqual(section(doc, 'texts').groups[1]!.texts[0]!.text.blocks[0]!.type, 'paragraph');
  assert.ok(JSON.stringify(section(doc, 'texts').groups[1]!.texts[0]!.text.blocks).includes('"bold":true'));
});

// The day of a document, of an approval, is the author's: 00:30 in Paris is still yesterday in UTC.
test('the document is dated the author\'s day, not UTC\'s: the time and the zone are fixed', (t) => {
  const { copyExample: course } = resources(t);
  const zone = process.env.TZ;
  const dir = course();
  try {
    // 22:30 UTC on the 15th is 00:30 on the 16th in Paris (UTC+2 in October), and 18:30 on the 15th in New York.
    const now = new Date('2026-10-15T22:30:00Z');
    process.env.TZ = 'Europe/Paris';
    assert.equal(localDay(now), '2026-10-16');
    const paris = planDocument(loadProjectFromDir(dir), { now })!;
    assert.equal(paris.date, '2026-10-16');
    assert.match(paris.colophon, /Document établi le 16 octobre 2026\.$/);
    assert.match(planDocumentPage(paris), /16 octobre 2026/);
    // A version is made on the author's day too.
    const files = new Map([...loadProjectFromDir(dir).files].filter(([name]) => !name.startsWith('plan-versions/')));
    const made = createPlanVersion(commandContext(files, { now, author: { kind: 'human' } })).files!;
    assert.equal(JSON.parse((made.get('plan-versions/V1.json') as { text: string }).text).date, '2026-10-16');
    process.env.TZ = 'America/New_York';
    assert.equal(planDocument(loadProjectFromDir(dir), { now })!.date, '2026-10-15');
    // A date given wins over the clock, as `elabora plan export --date` does.
    assert.equal(planDocument(loadProjectFromDir(dir), { now, date: '2026-01-02' })!.date, '2026-01-02');
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});

test('English words for an English module; a numeric question and maths', (t) => {
  const { copyExample: course } = resources(t);
  const doc = documentOf(course(GEARS));
  assert.equal(doc.words, 'en');
  assert.equal(doc.status.label, 'Approved for production');
  assert.deepEqual(doc.sections.map((entry) => entry.title), ['Scope', 'Objectives', 'Sequence', 'Approved texts', 'Assessments', 'Sources']);
  assert.equal(doc.properties.find((property) => property.key === 'history')!.value, 'V1 approved by Sample approver (fictional), Kestrel Drives on October 5, 2026 (elabora-core sample course, CR-001, not a real client approval)');
  assert.deepEqual(doc.facts.approval, { version: 'V1', by: 'Sample approver (fictional), Kestrel Drives', date: '2026-10-05', reference: 'elabora-core sample course, CR-001, not a real client approval' });
  const numeric = section(doc, 'assessments').groups.flatMap((group) => group.questions).find((question) => question.id === 'Q-2')!;
  assert.equal(numeric.mode, 'numeric');
  assert.deepEqual([numeric.numeric!.answer, numeric.numeric!.tolerance], ['500 rpm', 'within 2 rpm']);
  assert.deepEqual(numeric.numeric!.misconceptions.map((entry) => entry.label), ['Answer 666.67 rpm', 'Answer -666.67 rpm', 'Answer 8,000 rpm']);
  const willis = section(doc, 'texts').groups.flatMap((group) => group.texts).find((text) => text.id === 'TXT-2')!;
  assert.ok(willis.text.blocks.some((block) => block.type === 'math'));
});

test('the status follows the versions: a draft without one, a version to approve, changes since the validated version', (t) => {
  const { copyExample: course } = resources(t);
  const dir = course();
  fs.rmSync(path.join(dir, 'plan-versions'), { recursive: true });
  let doc = documentOf(dir);
  assert.deepEqual([doc.status, doc.shows], [{ state: 'draft', label: 'Brouillon' }, { version: null, label: 'Pas encore de version', current: true }]);
  assert.equal(doc.kicker, 'Plan du module');
  assert.equal(doc.properties.find((property) => property.key === 'approvedBy')!.value, 'Pas encore validé');
  assert.equal(doc.properties.find((property) => property.key === 'history'), undefined, 'no version to list');
  edit.createPlanVersion(dir, {}, PERSON);
  doc = documentOf(dir);
  assert.deepEqual(doc.status, { state: 'draft', label: 'À valider' });
  assert.match(doc.properties.find((property) => property.key === 'history')!.value, /^V1 créée le \d+ \S+ \d{4}$/);

  // The working copy changed since V2, validated: the marks start there; V2 itself reads « Bon pour production ».
  const network = course(NETWORK);
  doc = documentOf(network, 'current');
  assert.deepEqual([doc.status, doc.shows, doc.marks], [{ state: 'modified', label: 'Modifié depuis la V2 validée' }, { version: null, label: 'V2, et 2 modifications depuis', current: true }, { since: 'V2', changes: 2 }]);
  assert.equal(doc.kicker, 'Plan du module');
  assert.equal(doc.properties.find((property) => property.key === 'history')!.value, 'V1 envoyée le 1 octobre 2026\nV2 validée par Claire Martin, Hélios Énergie (client fictif) le 5 octobre 2026 (Storyboard v3 validé par courriel)');
  assert.deepEqual(documentOf(network).status, { state: 'approved', label: 'Bon pour production' }, 'an export shows the latest version by default');
  // V1 was sent, never validated: nothing before it to mark changes from.
  assert.deepEqual([documentOf(network, 1).status, documentOf(network, 1).marks], [{ state: 'draft', label: 'À valider' }, null]);
  assert.throws(() => documentOf(network, 3), /The plan has no version V3 \(it has V1, V2\)/);
});

test('the changes since the validated version read in place: words deleted and inserted, elements marked, the notes for the client', (t) => {
  const { copyExample: course } = resources(t);
  const dir = course(NETWORK);
  let doc = documentOf(dir, 'current');
  const text = section(doc, 'texts').groups[1]!.texts[0]!;
  assert.deepEqual(text.mark, { status: 'changed', summary: 'Modifié', note: 'Formulation plus directe ; la règle ne change pas.', verbatim: false });
  const parts = text.text.blocks[0]!.type === 'paragraph' ? text.text.blocks[0].content : [];
  assert.deepEqual(parts.filter((part) => part.change).map((part) => [part.change, part.type === 'text' ? part.text : '']), [
    ['del', 'Ne '], ['ins', 'N\'en '], ['del', 'si vous pensez connaître la cause.'], ['ins', 'quand la cause vous paraît évidente.']
  ]);
  assert.match(text.text.markdown, /N'en sautez aucune étape/, 'the text is the plan\'s wording now');
  const item = section(doc, 'sequence').items[2]!;
  assert.deepEqual([item.id, item.mark?.summary], ['ITEM-3', 'Modifié']);
  // V2's notes explain V2's changes since V1: in V2's document, nothing is marked.
  assert.equal(section(documentOf(dir), 'sequence').items[5]!.mark, null);

  // Elements added, removed, moved; fields not read in place said in the mark.
  const plan = readJSON(dir, 'plan.json');
  const [removed] = plan.items.splice(3, 1);
  plan.items.splice(1, 0, plan.items.splice(4, 1)[0]); // ITEM-6 after ITEM-1
  plan.items.push({ id: 'ITEM-7', kind: 'summary', title: 'Pour aller plus loin', objectives: [] });
  plan.items[0].kind = 'exposition';
  plan.objectives[0].statement = 'Nommer le rôle des cinq équipements du chemin d\'impression.';
  writeJSON(dir, 'plan.json', plan);
  doc = documentOf(dir, 'current');
  const items = section(doc, 'sequence').items;
  assert.deepEqual(items.map((entry) => [entry.id, entry.number, entry.mark?.status ?? null]), [
    ['ITEM-1', '1', 'changed'], ['ITEM-6', '2', 'changed'], ['ITEM-2', '3', null], ['ITEM-3', '4', 'changed'], ['ITEM-4', '', 'removed'], ['ITEM-5', '5', null], ['ITEM-7', '6', 'added']
  ]);
  assert.equal(items[0]!.mark!.summary, 'Modifié · modifié\u202f: nature');
  assert.equal(items[1]!.mark!.summary, 'Modifié · déplacé, c’était le point 6');
  assert.equal(items[4]!.heading, 'Le point 4');
  assert.equal(items[4]!.title, removed.title);
  assert.ok(items[4]!.titleChange!.every((part) => part.change === 'del'));
  assert.ok(items[6]!.titleChange!.every((part) => part.change === 'ins'));
  assert.ok(section(doc, 'objectives').objectives[0]!.statement.blocks.some((block) => JSON.stringify(block).includes('"change":"del"')));
  // The page marks them; Word too, as tracked changes and a comment.
  const html = planDocumentHtml(doc);
  assert.match(html, /<article class="entry marked marked-removed" id="ITEM-4">/);
  assert.match(html, /<aside class="client-note"><span class="label">Note pour le client<\/span> Formulation plus directe/);
  const parts2 = checkDocx(planDocumentWord(doc), doc);
  assert.match(parts2.get('word/document.xml')!, /<w:del w:id="\d+" w:author="Depuis la V2 validée">/);
  assert.match(parts2.get('word/comments.xml')!, /<w:comment w:id="\d+" w:author="Note pour le client" w:initials="NPLC">.*Formulation plus directe/);
});

test('the document never says who wrote the plan or a change', (t) => {
  const { copyExample: course } = resources(t);
  const dir = course(GEARS);
  edit.setPlanText(dir, { block: readBlockWithText(dir, 'TXT-1'), markdown: 'A planetary gearset fits in the space of a single gear.' }, AGENT);
  edit.writePlan(dir, { patch: [{ op: 'replace', path: '/items/0/title', value: 'One gearset' }] }, AGENT);
  edit.setPlanNote(dir, { target: 'item:ITEM-1', text: 'Shorter.' }, AGENT);
  const doc = documentOf(dir, 'current');
  assert.ok(doc.marks);
  const outputs = { model: JSON.stringify(doc), html: planDocumentHtml(doc), docx: docxText(doc) };
  for (const [name, output] of Object.entries(outputs)) {
    assert.doesNotMatch(output, /agent|claude|\bAI\b|\bIA\b|intelligence|written by|écrit par/i, name);
  }
});

function readBlockWithText(dir: string, ref: string): string {
  const project = loadProjectFromDir(dir);
  for (const { block } of iterateBlocks(project)) if ((block.props as { textRef?: unknown } | undefined)?.textRef === ref) return block.id;
  throw new Error(`no block shows ${ref}`);
}

test('rich text: Markdown as data, and a change word by word or as a whole', () => {
  assert.deepEqual(parseRich('Un **gras**, un *italique*, `code` et $x^2$.\n\n- a\n- b'), [
    { type: 'paragraph', content: [{ type: 'text', text: 'Un ' }, { type: 'text', text: 'gras', bold: true }, { type: 'text', text: ', un ' }, { type: 'text', text: 'italique', italic: true }, { type: 'text', text: ', ' }, { type: 'text', text: 'code', code: true }, { type: 'text', text: ' et ' }, { type: 'math', tex: 'x^2' }, { type: 'text', text: '.' }] },
    { type: 'list', ordered: false, items: [[{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }], [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }]] }
  ]);
  const [paragraph] = diffRich(parseRich('puis l\'heure de leur apparition.'), parseRich('puis l\'heure du premier symptôme.'));
  assert.deepEqual(paragraph, { type: 'paragraph', content: [{ type: 'text', text: 'puis l\'heure ' }, { type: 'text', text: 'de leur apparition.', change: 'del' }, { type: 'text', text: 'du premier symptôme.', change: 'ins' }] });
  // Another shape: the whole text deleted, the whole retouch inserted.
  const whole = diffRich(parseRich('Un.\n\nDeux.'), parseRich('- Un'));
  assert.deepEqual(whole.map((block) => [block.type, block.change]), [['paragraph', 'del'], ['paragraph', 'del'], ['list', 'ins']]);
});

test('Word bookmarks are named after the plan\'s ids and read back', () => {
  for (const [id, name] of [['OBJ-2', 'el_OBJ_2'], ['ITEM-12', 'el_ITEM_12'], ['RULE_A', 'el_RULE_uA'], ['A-_B', 'el_A__uB'], ['Q1', 'el_Q1']]) {
    assert.equal(wordBookmarkName(id), name);
    assert.equal(planIdOfBookmark(name), id);
  }
  assert.equal(planIdOfBookmark('_GoBack'), null);
  assert.equal(planIdOfBookmark('Title'), null);
  assert.ok(wordBookmarkName('ABCDEFGHIJKLMNOPQRSTUVWXYZ-12345').length <= 40);
});

// ── the .docx as a package ──

// Well-formed XML (tags balanced, attributes quoted and not repeated, entities known) whose prefixes
// are declared: enough to catch what a hand-written writer gets wrong.
function checkXml(name: string, text: string): void {
  const stack: string[] = [];
  const declared = new Set(['xml', ...[...text.matchAll(/xmlns:([\w-]+)=/g)].map((match) => match[1]!)]);
  const entity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  const body = text.replace(/^<\?xml[^?]*\?>\s*/, '');
  const token = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  for (let match = token.exec(body); match; match = token.exec(body)) {
    const [, closing, tag, attributes, empty, textPart, stray] = match;
    assert.equal(stray, undefined, `${name}: a stray « < » at ${match.index}`);
    if (textPart !== undefined) { assert.doesNotMatch(textPart, entity, `${name}: a bare « & »`); continue; }
    const prefix = tag!.includes(':') ? tag!.split(':')[0]! : null;
    if (prefix) assert.ok(declared.has(prefix), `${name}: prefix ${prefix} not declared`);
    const names = [...attributes!.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)].map((attribute) => { assert.doesNotMatch(attribute[2]!, entity, `${name}: a bare « & » in ${attribute[1]}`); return attribute[1]!; });
    assert.equal(new Set(names).size, names.length, `${name}: an attribute twice on <${tag}>`);
    if (closing) assert.equal(stack.pop(), tag, `${name}: </${tag}> closes something else`);
    else if (!empty) stack.push(tag!);
  }
  assert.deepEqual(stack, [], `${name}: elements left open`);
}

function checkDocx(bytes: Buffer, doc: PlanDocument): Map<string, string> {
  const { files } = readZip(bytes);
  const parts = new Map([...files].map(([name, content]) => [name, content.toString('utf8')]));
  for (const [name, content] of parts) checkXml(name, content);
  const types = parts.get('[Content_Types].xml')!;
  for (const name of parts.keys()) {
    if (name.endsWith('.rels') || name === '[Content_Types].xml') continue;
    assert.ok(types.includes(`PartName="/${name}"`), `${name} has a content type`);
  }
  for (const [name, content] of parts) {
    if (!name.endsWith('.rels')) continue;
    const base = path.posix.dirname(path.posix.dirname(name));
    for (const relation of content.matchAll(/<Relationship [^>]*Target="([^"]+)"[^>]*\/>/g)) {
      if (relation[0].includes('TargetMode="External"')) continue;
      assert.ok(parts.has(path.posix.normalize(path.posix.join(base === '.' ? '' : base, relation[1]!))), `${name} points to ${relation[1]}`);
    }
  }
  const document = parts.get('word/document.xml')!;
  const styles = parts.get('word/styles.xml')!;
  const defined = new Set([...styles.matchAll(/w:styleId="([^"]+)"/g)].map((match) => match[1]));
  for (const used of document.matchAll(/<w:(?:pStyle|rStyle|tblStyle) w:val="([^"]+)"/g)) assert.ok(defined.has(used[1]), `style ${used[1]} is defined`);
  const numbers = new Set([...parts.get('word/numbering.xml')!.matchAll(/<w:num w:numId="(\d+)"/g)].map((match) => match[1]));
  for (const used of document.matchAll(/<w:numId w:val="(\d+)"/g)) assert.ok(numbers.has(used[1]), `numbering ${used[1]} is defined`);
  // Annotations: unique ids; every bookmark closed; revisions hold the right kind of text.
  const ids = [...document.matchAll(/<w:(?:bookmarkStart|ins|del) w:id="(\d+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'annotation ids are unique');
  const starts = [...document.matchAll(/<w:bookmarkStart w:id="(\d+)" w:name="([^"]+)"\/>/g)];
  for (const [, id] of starts) assert.ok(document.includes(`<w:bookmarkEnd w:id="${id}"/>`), `bookmark ${id} ends`);
  const names = starts.map((match) => match[2]!);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.ok(/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name), name);
  const elements = [
    ...section(doc, 'objectives').objectives, ...section(doc, 'sequence').items, ...section(doc, 'texts').groups.flatMap((group) => group.texts),
    ...section(doc, 'assessments').groups.flatMap((group) => group.questions), ...section(doc, 'sources').sources
  ].map((element) => element.id);
  assert.deepEqual(names.map(planIdOfBookmark).sort(), [...elements].sort(), 'one bookmark per element of the plan');
  for (const deletion of document.matchAll(/<w:del [^>]*>(.*?)<\/w:del>/g)) assert.doesNotMatch(deletion[1]!, /<w:t[ >]/);
  for (const insertion of document.matchAll(/<w:ins [^>]*>(.*?)<\/w:ins>/g)) assert.doesNotMatch(insertion[1]!, /<w:delText/);
  return parts;
}

test('the .docx is a valid package: parts, relationships, styles, bookmarks, tracked changes; Word\'s headings', (t) => {
  const { copyExample: course } = resources(t);
  const dir = course(GEARS);
  edit.setPlanText(dir, { block: readBlockWithText(dir, 'TXT-1'), markdown: 'A planetary gearset fits in the space of a single gear, yet it can **reduce** speed.' }, AGENT);
  const doc = documentOf(dir, 'current');
  const parts = checkDocx(planDocumentWord(doc), doc);
  const document = parts.get('word/document.xml')!;
  assert.deepEqual([...document.matchAll(/<w:pStyle w:val="(Title|Heading1)"\/><\/w:pPr>(?:<w:bookmarkStart[^>]*>)?<w:r><w:t xml:space="preserve">([^<]*)</g)].map((match) => match[2]), ['Planetary gearsets: one gearset, many ratios', 'Scope', 'Objectives', 'Sequence', 'Approved texts', 'Assessments', 'Sources']);
  // The changes since the validated version have no day of their own: no w:date.
  assert.match(document, /<w:del w:id="\d+" w:author="Since approved V1">/);
  assert.match(document, /<w:ins w:id="\d+" w:author="Since approved V1">/);
  assert.doesNotMatch(document, /w:date=/);
  assert.ok(!parts.has('word/comments.xml'), 'no note, no comments part');
  assert.match(document, /<m:oMathPara><m:oMath><m:sSub>/, 'display maths as a Word equation');
  assert.match(parts.get('word/styles.xml')!, /<w:style w:type="paragraph" w:customStyle="0" w:styleId="Heading2"><w:name w:val="heading 2"\/>/);
  assert.match(parts.get('docProps/core.xml')!, /<dc:language>en-US<\/dc:language><dcterms:created xsi:type="dcterms:W3CDTF">2026-10-15T12:00:00Z/);
  // The same project and day give the same bytes (D8); another day, another document.
  assert.deepEqual(planDocumentWord(doc), planDocumentWord(documentOf(dir, 'current')));
  assert.notDeepEqual(planDocumentWord(doc), planDocumentWord(planDocument(loadProjectFromDir(dir), { date: '2026-10-16', version: 'current' })!));
  const draft = documentOf(course());
  checkDocx(planDocumentWord(draft), draft);
});

test('python-docx opens the .docx and pandoc reads its maths and tracked changes back (when they are installed)', (t) => {
  const { copyExample: course, tempDir } = resources(t);
  const dir = course(GEARS);
  edit.setPlanText(dir, { block: readBlockWithText(dir, 'TXT-1'), markdown: 'A planetary gearset fits in the space of one gear.' }, AGENT);
  edit.setPlanNote(dir, { target: 'text:TXT-1', text: 'Shorter.' }, PERSON);
  const file = path.join(tempDir('elabora-docx-'), 'plan.docx');
  fs.writeFileSync(file, planDocumentWord(documentOf(dir, 'current')));
  const python = spawnSync('python3', ['-I', '-c', 'import sys, docx\nd = docx.Document(sys.argv[1])\nprint("|".join(p.style.name for p in d.paragraphs if p.style.name.startswith("Heading")))', file], { encoding: 'utf8' });
  if (python.error || /No module named/.test(python.stderr)) t.diagnostic('python-docx is not installed: skipped');
  else {
    assert.equal(python.status, 0, python.stderr);
    assert.equal(python.stdout.trim(), ['Heading 1', 'Heading 1', 'Heading 1', ...new Array(6).fill('Heading 2'), 'Heading 1', 'Heading 2', 'Heading 2', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 3', 'Heading 3', 'Heading 1'].join('|'));
  }
  const pandoc = spawnSync('pandoc', [file, '--track-changes=all', '-t', 'markdown'], { encoding: 'utf8' });
  if (pandoc.error) { t.diagnostic('pandoc is not installed: skipped'); return; }
  assert.equal(pandoc.status, 0, pandoc.stderr);
  assert.match(pandoc.stdout, /\$\$Z_\{s\}\\, n_\{s\} \+ Z_\{r\}\\, n_\{r\} = \(Z_\{s\} \+ Z_\{r\}\)\\, n_\{c\}\$\$/);
  assert.match(pandoc.stdout, /\{\.deletion\s+author="Since approved V1"/);
  assert.match(pandoc.stdout, /\{\.insertion\s+author="Since approved V1"/);
  // The comment's text and its author, in either shape pandoc writes it: the text after the
  // attributes, or inside the brackets before them (pandoc 3.1.3, Ubuntu 24.04's).
  assert.match(pandoc.stdout, /\{\.comment-start[^}]*author="Note for the client"[^}]*\}Shorter\.|\[Shorter\.\]\{\.comment-start[^}]*author="Note for the client"[^}]*\}/);
});

test('the HTML page holds its fonts, its anchors and its print rules; it is the same for the same day', (t) => {
  const { copyExample: course } = resources(t);
  const dir = course();
  const doc = documentOf(dir);
  const html = planDocumentPage(doc);
  assert.match(html, /^<!doctype html>\n<html lang="fr">/);
  assert.match(html, /@font-face \{ font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: block; src: url\(data:font\/woff2;base64,/);
  assert.match(html, /<title>Diagnostiquer une panne d&#39;impression réseau · Plan validé<\/title>/);
  for (const id of ['OBJ-1', 'ITEM-6', 'TXT-2', 'Q-2', 'SRC-1']) assert.ok(html.includes(` id="${id}"`), id);
  assert.match(html, /@page \{\n  size: A4;/);
  assert.match(html, /@bottom-right \{ content: "Page" " " counter\(page\) " \/ " counter\(pages\)/);
  assert.match(html, /<span class="pill">Bon pour production<\/span>/);
  assert.equal(html, planDocumentPage(documentOf(dir)));
  assert.doesNotMatch(html, /<script/i, 'nothing runs in the page');
  // A title is text everywhere, in the style sheet's footer too.
  const odd = course();
  writeJSON(odd, 'course.json', { ...readJSON(odd, 'course.json'), title: 'Un "titre" </style><script>alert(1)</script> \\ fin' });
  const escaped = planDocumentHtml(documentOf(odd));
  assert.doesNotMatch(escaped, /<script/i);
  assert.match(escaped, /@bottom-left \{ content: "Un \\"titre\\" \\3C \/style>\\3C script>alert\(1\)\\3C \/script> \\\\ fin";/);
});

test('the PDF\'s dates become the document\'s day, bytes and offsets kept', () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<</Title (x) /CreationDate (D:20261015145446+00'00') /ModDate (D:20261015145447+00'00')>>\nendobj\n", 'latin1');
  const finished = Buffer.from(finishPlanPdf(pdf, '2026-10-20'));
  assert.equal(finished.length, pdf.length);
  assert.equal(finished.toString('latin1'), pdf.toString('latin1').replace('20261015145446', '20261020120000').replace('20261015145447', '20261020120000'));
  assert.deepEqual(Buffer.from(finishPlanPdf(pdf, 'today')), pdf);
});

// ── interfaces ──

function elabora(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd: ROOT, env: { ...process.env, ELABORA_AUTHOR: 'human' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('elabora plan export writes Word and HTML where asked, in dist/ by default; a wrong format is a usage error', async (t) => {
  const { copyExample: course } = resources(t);
  const dir = course();
  const out = path.join(dir, 'out', 'plan.docx');
  const word = await elabora(['plan', 'export', dir, '--format', 'docx', '--out', out, '--date', DATE]);
  assert.deepEqual([word.status, word.stderr], [0, '']);
  assert.match(word.stdout, /^✔ Word written: .*plan\.docx \(\d+ KB\), showing V1, recorded as sent\.\n$/);
  assert.deepEqual(readJSON(dir, 'plan-versions/V1.json').sends, [{ date: DATE, format: 'docx' }]);
  assert.deepEqual(fs.readFileSync(out), planDocumentWord(documentOf(dir)));
  const page = await elabora(['plan', 'export', dir, '--format', 'html', '--date', DATE, '--json']);
  assert.equal(page.status, 0, page.stderr);
  const result = JSON.parse(page.stdout);
  assert.deepEqual([result.file, result.format, result.state, result.version, result.sent], [path.join(dir, 'dist', 'diagnostic-reseau-plan.html'), 'html', 'approved', 'V1', true]);
  assert.equal(fs.readFileSync(result.file, 'utf8'), planDocumentPage(documentOf(dir)));
  const wrong = await elabora(['plan', 'export', dir, '--format', 'odt']);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /^Usage: elabora plan export \[dir\] \[--version <Vn\|current>\] \[--format pdf\|docx\|html\]/);
  // Exporting never makes a version: without one, the working copy, recorded nowhere.
  const draft = course();
  fs.rmSync(path.join(draft, 'plan-versions'), { recursive: true });
  assert.match((await elabora(['plan', 'export', draft, '--format', 'docx'])).stdout, /showing the working copy \(no version yet: elabora plan version makes V1\)\. No version is validated yet: the document says so\.\n$/);
  assert.ok(!fs.existsSync(path.join(draft, 'plan-versions')));
  // The working copy of a plan changed since its latest version, said.
  const network = course(NETWORK);
  assert.match((await elabora(['plan', 'export', network, '--format', 'html', '--date', DATE])).stdout, /showing V2, recorded as sent\. The plan changed since: 2 change\(s\) are in no version/);
  assert.match((await elabora(['plan', 'export', network, '--version', 'current', '--format', 'html', '--date', DATE])).stdout, /showing the working copy\. It shows its changes since the validated version\.\n$/);
});

test('MCP elabora_export_plan_document writes into dist/; the engine gives the model, the page and the files', async (t) => {
  const { copyExample: course, tempDir, own } = resources(t);
  const dir = course();
  const server = own(createMcpServer(dir), value => value.close());
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = own(new Client({ name: 'test', version: '1' }), value => value.close());
  await client.connect(clientSide);
  const result = await client.callTool({ name: 'elabora_export_plan_document', arguments: { format: 'docx' } });
  const body = JSON.parse((result.content as { text: string }[])[0]!.text);
  assert.deepEqual([body.file, body.version, body.sent], [path.join(dir, 'dist', 'diagnostic-reseau-plan.docx'), 'V1', true]);
  assert.ok(fs.existsSync(body.file));
  assert.equal(readJSON(dir, 'plan-versions/V1.json').sends.length, 1, 'the send recorded, by the agent the author asked');

  const session = own(await openProject(dir), value => value.close());
  const ask = async (type: string, params: unknown) => {
    const response = await session.handle({ kind: 'request', id: type, type, params });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { kind: response.error.kind });
    return response.result as any;
  };
  const doc = await ask('planDocument', { date: DATE });
  assert.deepEqual(doc, documentOf(dir));
  assert.deepEqual(session.planDocument(DATE), doc);
  const page = await ask('planDocumentPage', { date: DATE });
  assert.deepEqual([page.date, page.title, page.html, page.version], [DATE, doc.title, planDocumentPage(doc), 'V1']);
  assert.equal((await ask('planDocumentPage', { date: DATE, version: 'current' })).version, 'V1', 'the working copy that is V1 reads as V1');
  const file = path.join(dir, 'dist', 'exported.docx');
  const exported = await ask('exportPlanDocument', { format: 'docx', file, date: DATE });
  assert.deepEqual([exported.file, exported.format, exported.state, exported.version, exported.sent], [file, 'docx', 'approved', 'V1', true]);
  assert.deepEqual(fs.readFileSync(file), planDocumentWord(doc));
  assert.equal((await ask('planVersions', {})).versions[0].sends.length, 2);
  // The versions and the diff for the app; the working copy changed through the engine.
  await ask('run', { command: 'write_plan', args: { patch: [{ op: 'replace', path: '/items/0/title', value: 'Le ticket' }] } });
  const versions = await ask('planVersions', {});
  assert.deepEqual([versions.state, versions.current.sinceValidated, versions.current.unversioned, versions.export], ['modified', 1, 1, { shows: 1, changesSince: 1 }]);
  assert.deepEqual((await ask('planDiff', {})).changes.map((change: { key: string }) => change.key), ['item:ITEM-1']);
  assert.deepEqual((await ask('summary', {})).plan, { state: 'modified', objectives: 2, items: 6, latest: 1, validated: 1, sinceValidated: 1, unversioned: 1 });
  assert.equal((await ask('planDocument', { date: DATE, version: 'current' })).status.state, 'modified');
  await ask('run', { command: 'create_plan_version', args: {} });
  assert.equal((await ask('planVersions', {})).latest, 2);
  await assert.rejects(ask('run', { command: 'create_plan_version', args: {}, author: { kind: 'agent', name: 'assistant' } }), /Only a person makes a version/);
  await assert.rejects(ask('planDiff', { from: 'V2' }), (error: Error & { kind?: string }) => error.kind === 'bad-request');
  await assert.rejects(ask('planDocument', { version: 7 }), (error: Error & { kind?: string }) => error.kind === 'not-found');
  await assert.rejects(ask('exportPlanDocument', { format: 'odt', file }), (error: Error & { kind?: string }) => error.kind === 'bad-request' && /takes a format/.test(error.message));
  await assert.rejects(ask('exportPlanDocument', { format: 'docx', file: 'plan.docx' }), /absolute path/);
  assert.throws(() => readPlanDocument(loadProjectFromDir(tempDir('elabora-empty-'))), /No readable plan\.json/);
});

// A plan without parts takes them from the course's sections, and the app writes them into the plan
// the first time its author drags an item (D50): the patch moves the item and gives every item the
// part it was shown in. That is one item moved, not six whose part changed (D52).
test('a plan that writes its parts down when one item is dragged changed that item only: counts, document, Word, HTML, the command line and the engine', async (t) => {
  const { copyExample: course, own } = resources(t);
  const dir = course(); // V1, validated, the working copy as it is; no part anywhere; sections Découvrir (1, 2), Pratiquer (3, 4), Valider (5, 6)
  assert.ok(readJSON(dir, 'plan.json').items.every((item: { part?: string }) => item.part === undefined));
  // ITEM-6 dragged up among the items of Pratiquer, as the app writes it: a move, then each item's part.
  const order = ['ITEM-1', 'ITEM-2', 'ITEM-3', 'ITEM-6', 'ITEM-4', 'ITEM-5'];
  const shown = new Map([['ITEM-1', 'Découvrir'], ['ITEM-2', 'Découvrir'], ['ITEM-3', 'Pratiquer'], ['ITEM-6', 'Pratiquer'], ['ITEM-4', 'Pratiquer'], ['ITEM-5', 'Valider']]);
  const written = edit.writePlan(dir, { patch: [{ op: 'move', from: '/items/5', path: '/items/3' }, ...order.map((id, at) => ({ op: 'add' as const, path: `/items/${at}/part`, value: shown.get(id) }))] }, PERSON);
  assert.deepEqual(written.moved?.screens, ['bilan'], 'the dragged item took its screen with it');
  assert.deepEqual(readJSON(dir, 'plan.json').items.map((item: { id: string; part: string }) => [item.id, item.part]), order.map((id) => [id, shown.get(id)]));

  const project = loadProjectFromDir(dir);
  // Only the dragged item changed, and what it says it moved from is its place in the version.
  const only = (changes: { key: string; status: string; moved?: unknown; part?: unknown; fields: unknown[] }[]) => {
    assert.deepEqual(changes.map((change) => [change.key, change.status, change.moved, change.part, change.fields]), [['item:ITEM-6', 'changed', { from: 6, to: 4 }, undefined, []]]);
  };
  // The counts: the pill, the panel, the export's warning.
  only(planDiffBetween(project).changes);
  const view = planVersionsView(project);
  assert.deepEqual([view.state, view.current.sinceValidated, view.current.unversioned, view.export, view.versions.map((version) => version.changes)], ['modified', 1, 1, { shows: 1, changesSince: 1 }, [0]]);
  // The document: one mark, in the page and in Word.
  const doc = documentOf(dir, 'current');
  assert.deepEqual(doc.marks, { since: 'V1', changes: 1 });
  const items = section(doc, 'sequence').items;
  assert.deepEqual(items.filter((entry) => entry.mark).map((entry) => [entry.id, entry.mark!.status, entry.mark!.summary]), [['ITEM-6', 'changed', 'Modifié · déplacé, c’était le point 6']]);
  const html = planDocumentHtml(doc);
  assert.equal(html.match(/<article class="entry marked /g)?.length, 1);
  assert.doesNotMatch(html, /dans la partie/);
  const word = docxText(doc);
  assert.equal(word.match(/Modifié · déplacé/g)?.length, 1);
  assert.doesNotMatch(word, /dans la partie/);
  // The command line and the engine say the same.
  const line = await elabora(['plan', 'diff', dir]);
  assert.equal(line.status, 0, line.stderr);
  assert.match(line.stdout, /^From V1 to the working copy: 1 change\(s\): 0 added, 0 removed, 1 changed\.\n  item:ITEM-6  changed « .* » \(moved from 6 to 4\)\n$/);
  only(JSON.parse((await elabora(['plan', 'diff', dir, '--json'])).stdout).changes);
  const session = own(await openProject(dir), value => value.close());
  const ask = async (type: string) => {
    const response = await session.handle({ kind: 'request', id: type, type, params: {} });
    if (!response.ok) throw new Error(response.error.message);
    return response.result as any;
  };
  only((await ask('planDiff')).changes);
  const versions = await ask('planVersions');
  assert.deepEqual([versions.current.sinceValidated, versions.current.unversioned, versions.export.changesSince], [1, 1, 1]);
  assert.deepEqual((await ask('summary')).plan, { state: 'modified', objectives: 2, items: 6, latest: 1, validated: 1, sinceValidated: 1, unversioned: 1 });

  // A part really given to an item is still a change: ITEM-5 called « Évaluer » by hand, the course
  // left as it is, changed from the part its section gave it.
  const plan = readJSON(dir, 'plan.json');
  plan.items.at(-1).part = 'Évaluer';
  writeJSON(dir, 'plan.json', plan);
  assert.deepEqual(planDiffBetween(loadProjectFromDir(dir)).changes.map((change) => [change.key, change.moved ?? null, change.part ?? null]), [
    ['item:ITEM-6', { from: 6, to: 4 }, null],
    ['item:ITEM-5', null, { from: 'Valider', to: 'Évaluer' }]
  ]);
});
