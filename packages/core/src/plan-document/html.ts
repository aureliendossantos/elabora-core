import { renderTex } from '../compile/markdown.ts';
import { escapeHtml } from '../util/html.ts';
import type { PlanDocument, PlanSection, TextEntry, QuestionEntry, ItemRef, EntryMark } from './model.ts';
import type { RichBlock, RichInline, RichText } from './rich.ts';

// The plan's document as one HTML page that holds everything it needs (docs/decisions.md D48): read
// in a browser, its sections fold; printed (the PDF: Chromium's print, by the app or by the command
// line), it is A4 with the module's title and the page number at the foot of each page. Fonts come
// from the caller as @font-face rules (data URIs): the same page prints the same everywhere.

export interface PlanHtmlOptions {
  // @font-face rules for the families below, their files inline; without them the system's fonts
  // stand in (the print then depends on the computer).
  fontFaces?: string;
}

export const PLAN_DOCUMENT_FONT = 'Inter';

export function planDocumentHtml(doc: PlanDocument, options: PlanHtmlOptions = {}): string {
  const head = [
    '<!doctype html>',
    `<html lang="${escapeHtml(doc.language)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    // Nothing to fetch: its style and fonts are inline, and it runs no script.
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:; img-src data:">',
    '<meta name="generator" content="Elabora">',
    `<title>${escapeHtml(`${doc.title} · ${doc.kicker}`)}</title>`,
    `<style>${options.fontFaces ?? ''}\n${css(doc)}</style>`,
    '</head>'
  ].join('\n');
  const props = doc.properties.map((property) => `<div class="prop prop-${property.key}"><dt>${escapeHtml(property.label)}</dt><dd>${property.key === 'status' ? `<span class="pill">${escapeHtml(property.value)}</span>` : property.value.split('\n').map(escapeHtml).join('<br>')}</dd></div>`).join('\n');
  const notes = doc.notes.length ? `<aside class="head-notes"><p class="label">${escapeHtml(doc.labels.notesHeading)}</p>${doc.notes.map((note) => `<p class="client-note"><span class="label">${escapeHtml(note.label)}</span> ${escapeHtml(note.text)}</p>`).join('')}</aside>` : '';
  const body = [
    `<body class="state-${doc.status.state}">`,
    '<header class="doc-head">',
    `<p class="kicker">${escapeHtml(doc.kicker)}</p>`,
    `<h1>${escapeHtml(doc.title)}</h1>`,
    `<dl class="props">\n${props}\n</dl>`,
    notes,
    '</header>',
    '<main>',
    ...doc.sections.map((section) => sectionHtml(doc, section)),
    '</main>',
    `<footer class="colophon"><p>${escapeHtml(doc.colophon)}</p></footer>`,
    '</body>',
    '</html>'
  ].join('\n');
  return `${head}\n${body}\n`;
}

function sectionHtml(doc: PlanDocument, section: PlanSection): string {
  const content = section.empty ? `<p class="empty">${escapeHtml(section.empty)}</p>` : sectionContent(doc, section);
  return `<details class="section section-${section.kind}" id="section-${section.kind}" open>\n<summary><h2>${escapeHtml(section.title)}</h2></summary>\n<div class="section-body">\n${content}\n</div>\n</details>`;
}

function sectionContent(doc: PlanDocument, section: PlanSection): string {
  const L = doc.labels;
  const meta = (parts: (string | null)[]) => {
    const kept = parts.filter((part): part is string => !!part);
    return kept.length ? `<p class="meta">${kept.join(' · ')}</p>` : '';
  };
  const labelled = (label: string, value: string) => `${escapeHtml(label)}${escapeHtml(L.colon)}${value}`;
  switch (section.kind) {
    case 'framing': return [
      section.entries.length ? `<dl class="fields">${section.entries.map((entry) => `<div class="field${entry.mark ? ` marked marked-${entry.mark.status}` : ''}"><dt>${escapeHtml(entry.label)}</dt><dd>${markHtml(doc, entry.mark)}${rich(entry.text)}${noteHtml(doc, entry.mark)}</dd></div>`).join('\n')}</dl>` : '',
      section.waivers.length ? `<h3 class="sub">${escapeHtml(section.waiversLabel)}</h3>\n${section.waivers.map((waiver) => `<div class="waiver"><p class="meta">${escapeHtml(waiver.summary)}</p>${rich(waiver.reason)}</div>`).join('\n')}` : ''
    ].join('\n');
    case 'objectives': return section.objectives.map((objective) => entry(objective.id, objective.number, [
      markHtml(doc, objective.mark),
      rich(objective.statement),
      meta([
        objective.bloom ? escapeHtml(objective.bloom) : null,
        objective.criterion ? labelled(L.criterion, escapeHtml(objective.criterion)) : null,
        objective.sources.length ? labelled(L.sources, escapeHtml(objective.sources.map((source) => source.title).join(', '))) : null
      ]),
      noteHtml(doc, objective.mark)
    ], '', objective.mark)).join('\n');
    case 'sequence': return section.items.map((item) => entry(item.id, item.number, [
      markHtml(doc, item.mark),
      `<h3>${item.titleChange ? inline(item.titleChange) : escapeHtml(item.title)}</h3>`,
      meta([escapeHtml(item.kind), labelled(L.objectives, escapeHtml(item.objectives.map((objective) => objective.number).join(', ') || L.noObjective))]),
      item.description ? rich(item.description) : '',
      item.voiceover.length ? `<div class="voiceover"><p class="label">${escapeHtml(L.voiceover)}</p>${item.voiceover.map((line) => `<div class="line">${line.speaker ? `<span class="speaker">${escapeHtml(line.speaker)}</span>` : ''}${rich(line.text)}</div>`).join('\n')}</div>` : '',
      item.sources.length ? meta([labelled(L.sources, escapeHtml(item.sources.map((source) => source.title).join(', ')))]) : '',
      noteHtml(doc, item.mark)
    ], '', item.mark)).join('\n');
    case 'texts': return section.groups.map((group) => `${groupHeading(group.item)}\n${group.texts.map((text) => textEntry(doc, text)).join('\n')}`).join('\n');
    case 'assessments': return section.groups.map((group) => `${groupHeading(group.item)}\n${group.questions.map((question) => questionEntry(doc, question)).join('\n')}`).join('\n');
    case 'sources': return section.sources.map((source) => entry(source.id, '', [
      markHtml(doc, source.mark),
      `<p class="source-title">${source.titleChange ? inline(source.titleChange) : escapeHtml(source.title)}</p>`,
      meta([source.type ? labelled(L.sourceType, escapeHtml(source.type)) : null, source.version ? labelled(L.sourceVersion, escapeHtml(source.version)) : null]),
      noteHtml(doc, source.mark)
    ], 'source', source.mark)).join('\n');
  }
}

const groupHeading = (item: ItemRef) => `<h3 class="group"><span class="num">${escapeHtml(item.number)}</span>${escapeHtml(item.title)}</h3>`;

function entry(id: string, number: string, parts: string[], kind = '', mark: EntryMark | null = null): string {
  const marked = mark ? ` marked marked-${mark.status}${mark.verbatim ? ' marked-verbatim' : ''}` : '';
  return `<article class="entry${kind ? ` entry-${kind}` : ''}${marked}" id="${escapeHtml(id)}"><span class="num">${escapeHtml(number)}</span><div class="body">${parts.filter(Boolean).join('\n')}</div></article>`;
}

// What changed in an element since the validated version, above it; the author's note for the
// client in the margin (below it when printed).
function markHtml(_doc: PlanDocument, mark: EntryMark | null): string {
  return mark ? `<p class="change">${escapeHtml(mark.summary)}</p>` : '';
}

function noteHtml(doc: PlanDocument, mark: EntryMark | null): string {
  return mark?.note ? `<aside class="client-note"><span class="label">${escapeHtml(doc.labels.noteAuthor)}</span> ${escapeHtml(mark.note)}</aside>` : '';
}

function textEntry(doc: PlanDocument, text: TextEntry): string {
  const parts: string[] = [markHtml(doc, text.mark)];
  if (text.verbatim) parts.push(`<p class="tag">${escapeHtml(doc.labels.verbatim)}</p>`);
  parts.push(`<div class="${text.mark ? 'changed-text' : 'text'}">${rich(text.text)}</div>`, noteHtml(doc, text.mark));
  return entry(text.id, text.number, parts, '', text.mark);
}

function questionEntry(doc: PlanDocument, question: QuestionEntry): string {
  const L = doc.labels;
  const meta = [question.modeLabel, question.objectives.length ? `${L.objectives}${L.colon}${question.objectives.map((objective) => objective.number).join(', ')}` : null, question.bloom].filter(Boolean).join(' · ');
  const parts = [markHtml(doc, question.mark), rich(question.stem), `<p class="meta">${escapeHtml(meta)}</p>`];
  if (question.options.length) {
    parts.push(`<ol class="options">${question.options.map((option) => `<li class="${[option.correct ? 'correct' : '', option.change ? `option-${option.change}` : ''].filter(Boolean).join(' ')}"><span class="letter">${escapeHtml(option.letter)}</span><div>${rich(option.text)}${option.correct ? `<p class="mark">✓ ${escapeHtml(L.correct)}</p>` : ''}${option.feedback ? `<div class="feedback">${rich(option.feedback)}</div>` : ''}</div></li>`).join('\n')}</ol>`);
  }
  const numeric = question.numeric;
  if (numeric) {
    parts.push(`<p class="answer"><span class="label">${escapeHtml(L.answer)}${escapeHtml(L.colon)}</span><strong>${escapeHtml(numeric.answer)}</strong>${numeric.tolerance ? ` <span class="meta-inline">(${escapeHtml(numeric.tolerance)})</span>` : ''}</p>`);
    parts.push(`<dl class="fields compact"><div class="field"><dt>${escapeHtml(L.feedbackCorrect)}</dt><dd>${rich(numeric.correct)}</dd></div><div class="field"><dt>${escapeHtml(L.feedbackIncorrect)}</dt><dd>${rich(numeric.incorrect)}</dd></div></dl>`);
    if (numeric.misconceptions.length) parts.push(`<p class="label">${escapeHtml(L.misconceptions)}</p><dl class="fields compact">${numeric.misconceptions.map((entry) => `<div class="field"><dt>${escapeHtml(entry.label)}</dt><dd>${rich(entry.feedback)}</dd></div>`).join('')}</dl>`);
  }
  parts.push(noteHtml(doc, question.mark));
  return entry(question.id, question.number, parts, 'question', question.mark);
}

// ── rich text ──

function rich(text: RichText): string {
  return blocks(text.blocks);
}

function blocks(list: readonly RichBlock[]): string {
  return list.map(block).join('\n');
}

function changed(html: string, change: 'ins' | 'del' | undefined): string {
  return change ? `<${change}>${html}</${change}>` : html;
}

function block(item: RichBlock): string {
  switch (item.type) {
    case 'paragraph': return `<p>${inline(item.content)}</p>`;
    case 'heading': return `<p class="strong">${inline(item.content)}</p>`;
    case 'list': {
      const tag = item.ordered ? 'ol' : 'ul';
      return `<${tag}${item.start ? ` start="${item.start}"` : ''}>${item.items.map((child) => `<li>${blocks(child)}</li>`).join('')}</${tag}>`;
    }
    case 'quote': return `<blockquote>${blocks(item.blocks)}</blockquote>`;
    case 'code': return changed(`<pre><code>${escapeHtml(item.text)}</code></pre>`, item.change);
    case 'math': return changed(`<div class="math">${renderTex(item.tex, true)}</div>`, item.change);
    case 'table': return `<table class="md"><thead><tr>${item.header.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${item.rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'rule': return '<hr>';
  }
}

function inline(content: readonly RichInline[]): string {
  return content.map((part) => {
    let html = part.type === 'text' ? escapeHtml(part.text) : part.type === 'math' ? renderTex(part.tex, false) : '<br>';
    if (part.code) html = `<code>${html}</code>`;
    if (part.italic) html = `<em>${html}</em>`;
    if (part.bold) html = `<strong>${html}</strong>`;
    if (part.strike) html = `<s>${html}</s>`;
    if (part.href !== undefined) html = `<a href="${escapeHtml(part.href)}">${html}</a>`;
    return changed(html, part.change);
  }).join('');
}

// ── style ──

// A CSS string inside <style>: quotes and backslashes escaped, and « < » too, so that a title
// holding « </style> » cannot end the style sheet.
const cssString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3C ').replace(/[\r\n]+/g, ' ')}"`;

function css(doc: PlanDocument): string {
  return `
:root { --text: #1d2125; --muted: #5f6870; --faint: #8a939b; --line: #dde1e4; --soft: #f3f4f5; --ok: #1f6f43; --ok-soft: #e4f2ea; --draft: #8a5a00; --draft-soft: #fbf0d9; --ins: #1d5fbf; --ins-soft: #e6effb; --del: #a23b2a; }
* { box-sizing: border-box; }
html { background: #fff; color: var(--text); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0 auto; max-width: 46rem; padding: 3rem 1.5rem 4rem; font: 10.5pt/1.55 ${PLAN_DOCUMENT_FONT}, "Helvetica Neue", Arial, sans-serif; font-feature-settings: "cv11", "ss01"; font-variant-numeric: tabular-nums; hyphens: manual; }
h1, h2, h3, p, dl, dd, ol, ul, blockquote, pre { margin: 0; }
.kicker { color: var(--muted); font-size: 9.5pt; }
h1 { font-size: 22pt; line-height: 1.2; font-weight: 600; letter-spacing: -0.01em; margin-top: 0.15rem; text-wrap: balance; }
.props { margin-top: 1.1rem; display: grid; gap: 0.3rem; }
.prop { display: grid; grid-template-columns: 8.5rem 1fr; gap: 0.75rem; align-items: baseline; }
.prop dt { color: var(--muted); }
.pill { display: inline-block; padding: 0.05rem 0.55rem; border-radius: 999px; font-weight: 500; background: var(--soft); }
.state-approved .pill { background: var(--ok-soft); color: var(--ok); }
.state-draft .pill, .state-modified .pill { background: var(--draft-soft); color: var(--draft); }
main { margin-top: 1.8rem; }
.section { border-top: 1px solid var(--line); }
.section:last-child { border-bottom: 1px solid var(--line); }
summary { list-style: none; cursor: pointer; padding: 0.7rem 0; display: flex; align-items: center; gap: 0.5rem; }
summary::-webkit-details-marker { display: none; }
summary::before { content: ""; width: 0.45rem; height: 0.45rem; border-right: 1.5px solid var(--faint); border-bottom: 1.5px solid var(--faint); transform: rotate(-45deg); transition: transform 0.15s; flex: none; margin-right: 0.2rem; }
details[open] > summary::before { transform: rotate(45deg); }
h2 { font-size: 13pt; font-weight: 600; }
.section-body { padding: 0 0 1.1rem 1.15rem; }
h3 { font-size: 10.5pt; font-weight: 600; }
h3.group { margin: 0.9rem 0 0.2rem; color: var(--muted); font-weight: 500; font-size: 9.5pt; display: flex; gap: 0.5rem; }
h3.group .num { min-width: 2.2rem; }
h3.sub { margin: 0.9rem 0 0.3rem; color: var(--muted); font-weight: 500; font-size: 9.5pt; }
.entry { display: grid; grid-template-columns: 2.2rem 1fr; gap: 0.5rem; padding: 0.6rem 0; break-inside: avoid; }
.entry + .entry { border-top: 1px solid var(--line); }
.entry > .num { color: var(--muted); }
.entry-source { grid-template-columns: 0 1fr; gap: 0; }
.entry-question { break-inside: auto; }
.body > * + * { margin-top: 0.35rem; }
.meta, .label, .meta-inline { color: var(--muted); font-size: 9pt; }
.label { font-weight: 500; }
.tag { display: inline-block; font-size: 8.5pt; font-weight: 500; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 0.35rem; }
.fields { display: grid; gap: 0.5rem; }
.field { display: grid; grid-template-columns: 11rem 1fr; gap: 0.75rem; }
.fields.compact .field { grid-template-columns: 9.5rem 1fr; }
.field dt { color: var(--muted); }
.field dd > * + * { margin-top: 0.3rem; }
.voiceover { border-left: 2px solid var(--line); padding-left: 0.75rem; }
.voiceover .line { display: flex; gap: 0.5rem; }
.voiceover .speaker { color: var(--muted); flex: none; }
.voiceover .speaker::after { content: ${cssString(doc.labels.colon.trim() ? doc.labels.colon.replace(/\s+$/, '') : ':')}; }
.marked { box-shadow: inset 2px 0 0 var(--ins); }
.entry.marked { padding-left: 0.5rem; margin-left: -0.5rem; }
.marked-verbatim { box-shadow: inset 2px 0 0 var(--draft); }
.change { color: var(--ins); font-size: 9pt; font-weight: 500; }
.marked-verbatim .change { color: var(--draft); }
.marked-removed .body > :not(.change):not(.client-note) { opacity: 0.85; }
.client-note { border-left: 2px solid var(--draft); background: var(--draft-soft); padding: 0.3rem 0.6rem; border-radius: 0 6px 6px 0; font-size: 9.5pt; }
.client-note .label { color: var(--draft); margin-right: 0.25rem; }
.head-notes { margin-top: 1rem; display: grid; gap: 0.35rem; }
@media screen and (min-width: 72rem) { .entry { position: relative; } .entry > .body > .client-note { position: absolute; left: calc(100% + 1.5rem); top: 0.6rem; width: 13rem; } }
ol.options li.option-removed .letter::before { content: "–"; }
ins { color: var(--ins); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; background: var(--ins-soft); }
del { color: var(--del); text-decoration: line-through; }
ol.options { list-style: none; padding: 0; display: grid; gap: 0.35rem; }
ol.options li { display: grid; grid-template-columns: 1.4rem 1fr; gap: 0.35rem; }
ol.options .letter { color: var(--muted); }
ol.options li.correct .letter { color: var(--ok); font-weight: 600; }
.mark { color: var(--ok); font-size: 9pt; font-weight: 500; }
.feedback { color: var(--muted); font-size: 9.5pt; }
ul, ol { padding-left: 1.2rem; }
blockquote { border-left: 2px solid var(--line); padding-left: 0.75rem; color: var(--muted); }
code, pre { font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 0.92em; }
pre { white-space: pre-wrap; background: var(--soft); padding: 0.5rem 0.65rem; border-radius: 6px; }
table.md { border-collapse: collapse; font-size: 9.5pt; }
table.md th, table.md td { border: 1px solid var(--line); padding: 0.2rem 0.45rem; text-align: left; vertical-align: top; }
.math { margin: 0.3rem 0; }
math { font-size: 1.05em; }
a { color: inherit; }
.empty { color: var(--muted); }
.strong { font-weight: 600; }
.colophon { margin-top: 1.4rem; color: var(--faint); font-size: 8.5pt; overflow-wrap: anywhere; }
@page {
  size: A4;
  margin: 20mm 18mm 22mm;
  @bottom-left { content: ${cssString(doc.title)}; font: 8pt ${PLAN_DOCUMENT_FONT}, Arial, sans-serif; color: #8a939b; }
  @bottom-right { content: ${cssString(doc.labels.page)} " " counter(page) " / " counter(pages); font: 8pt ${PLAN_DOCUMENT_FONT}, Arial, sans-serif; color: #8a939b; }
}
@media print {
  body { max-width: none; padding: 0; }
  summary { cursor: default; }
  summary::before { display: none; }
  .section-body { padding-left: 0; }
  .section { break-before: auto; }
  h2, h3, summary { break-after: avoid; }
  .entry:not(.entry-question), .field, ol.options li { break-inside: avoid; }
}`;
}
