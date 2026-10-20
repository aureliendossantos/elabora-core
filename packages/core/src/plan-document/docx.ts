import type { PlanDocument, PlanSection, TextEntry, QuestionEntry, ItemRef, EntryMark } from './model.ts';
import type { Change, RichBlock, RichInline, RichText } from './rich.ts';
import { MATH_NS, texToOmml } from './omml.ts';

// The plan's document as a Word file (docs/decisions.md D48), written by hand in WordprocessingML:
// the parts of the .docx, which @elabora/node puts in a deterministic ZIP (D8). It is made to be
// commented: Word's own styles (Title, Heading 1 to 3: the navigation pane), named styles of its
// own for the rest and no direct formatting, tables only for the properties and the plan's own
// tables, what changed since the validated version as tracked changes (Word shows the validated
// wording deleted and the new one inserted, by « Depuis la V2 validée »), the author's notes for the
// client as comments, and a bookmark around every objective, item, validated text, question and source,
// named after its id in the plan (wordBookmarkName): a comment the client leaves in Word can later
// be tied to the element it is on (planIdOfBookmark).

// ── bookmarks ──

// Word's bookmark names: a letter first, then letters, digits and « _ », 40 characters at most. A
// plan's ids are capitals, digits, « - » and « _ » (^[A-Z][A-Z0-9_-]{0,31}$): « - » becomes « _ »
// and « _ » becomes « _u », and the name starts with « el_ ». Plan ids have no lower case, so the
// name reads back without ambiguity: el_OBJ_2 is OBJ-2, el_RULE_uA is RULE_A.
export function wordBookmarkName(id: string): string {
  return `el_${id.replace(/_/g, '_u').replace(/-/g, '_')}`;
}

export function planIdOfBookmark(name: string): string | null {
  const match = /^el_([A-Z][A-Za-z0-9_]*)$/.exec(name);
  if (!match) return null;
  return match[1]!.replace(/_u|_/g, (found) => (found === '_u' ? '_' : '-'));
}

// ── XML ──

// Characters XML 1.0 forbids are dropped; the rest escaped.
const xml = (value: string): string => value
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// The Word language of a module's language: fr → fr-FR, en → en-US, fr-CA as it is.
function wordLanguage(language: string): string {
  if (/^[a-z]{2,3}-[A-Za-z]{2}$/.test(language)) return language;
  return ({ fr: 'fr-FR', en: 'en-US', de: 'de-DE', es: 'es-ES', it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL' } as Record<string, string>)[language] ?? language;
}

// ── writer ──

interface Context {
  ids: number; // annotation ids (bookmarks, revisions, comments)
  rels: string[]; // hyperlinks: rId10 onwards
  lists: number[]; // the numbering instances of ordered lists (their numId)
  author: string; // of the tracked changes
  bookmarks: Set<string>; // the names given so far
  comments: { id: number; text: string }[]; // the notes for the client
  noteAuthor: string;
}

export function planDocumentDocx(doc: PlanDocument): Map<string, string> {
  const context: Context = { ids: 0, rels: [], lists: [], author: doc.labels.changeAuthor, bookmarks: new Set(), comments: [], noteAuthor: doc.labels.noteAuthor };
  const body: string[] = [];
  body.push(paragraph('ElaboraKicker', runs(doc.kicker)));
  body.push(paragraph('Title', runs(doc.title)));
  body.push(propertiesTable(doc));
  if (doc.notes.length) {
    body.push(paragraph('ElaboraFieldName', runs(doc.labels.notesHeading)));
    for (const note of doc.notes) body.push(paragraph('ElaboraNote', `${runs(note.label, 'ElaboraLabel')}${runs(` ${note.text}`)}`));
  }
  for (const section of doc.sections) body.push(...sectionXml(doc, section, context));
  body.push(paragraph('ElaboraColophon', runs(doc.colophon)));
  const document = `${HEADER}<w:document ${W_NS} ${MATH_NS}><w:body>${body.join('')}${sectionProperties()}</w:body></w:document>`;

  const hyperlinks = context.rels.map((target, index) => `<Relationship Id="rId${index + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(target)}" TargetMode="External"/>`).join('');
  const date = `${doc.date}T12:00:00Z`;
  const language = wordLanguage(doc.language);
  // The notes for the client, when there are some: Word's comments part.
  const comments = context.comments.length
    ? `${HEADER}<w:comments ${W_NS}>${context.comments.map((comment) => `<w:comment w:id="${comment.id}" w:author="${xml(context.noteAuthor)}" w:initials="${xml(initials(context.noteAuthor))}"><w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>${runs(comment.text)}</w:p></w:comment>`).join('')}</w:comments>`
    : null;
  const commentsType = comments ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : '';
  const commentsRel = comments ? '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' : '';
  return new Map<string, string>([
    ['[Content_Types].xml', `${HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${commentsType}<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ['_rels/.rels', `${HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ['docProps/core.xml', `${HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(doc.title)}</dc:title><dc:subject>${xml(doc.kicker)}</dc:subject><dc:identifier>${xml(doc.plan.id)}</dc:identifier><dc:language>${xml(language)}</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified></cp:coreProperties>`],
    ['docProps/app.xml', `${HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Elabora</Application></Properties>`],
    ['word/_rels/document.xml.rels', `${HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${commentsRel}${hyperlinks}</Relationships>`],
    ['word/document.xml', document],
    ['word/styles.xml', styles(language)],
    ['word/numbering.xml', numbering(context.lists)],
    ['word/settings.xml', `${HEADER}<w:settings ${W_NS}><w:zoom w:percent="100"/><w:defaultTabStop w:val="709"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><w:themeFontLang w:val="${xml(language)}"/></w:settings>`],
    ...(comments ? [['word/comments.xml', comments] as [string, string]] : []),
    ['word/footer1.xml', `${HEADER}<w:ftr ${W_NS}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>${runs(doc.title)}<w:r><w:tab/></w:r>${runs(`${doc.labels.page} `)}<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>${runs(' / ')}<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`]
  ]);
}

// A4, margins of 2 cm, the footer on every page.
function sectionProperties(): string {
  return '<w:sectPr><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
}

function paragraph(style: string, content: string, extra = ''): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr>${content}</w:p>`;
}

// Plain runs of a text (a style of characters if given), its line breaks kept.
function runs(text: string, characterStyle?: string): string {
  const props = characterStyle ? `<w:rPr><w:rStyle w:val="${characterStyle}"/></w:rPr>` : '';
  return text.split('\n').map((line, index) => `<w:r>${props}${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join('');
}

// « Note pour le client » → « NPLC »: Word shows a comment's initials beside it.
const initials = (name: string): string => name.split(/\s+/).filter(Boolean).map((word) => word[0]!.toLocaleUpperCase()).join('').slice(0, 9);

function propertiesTable(doc: PlanDocument): string {
  const rows = doc.properties.map((property) => {
    const value = property.key === 'status' ? runs(property.value, doc.status.state === 'approved' ? 'ElaboraStatusApproved' : 'ElaboraStatusDraft') : runs(property.value);
    return `<w:tr><w:tc><w:tcPr><w:tcW w:w="2268" w:type="dxa"/></w:tcPr>${paragraph('ElaboraPropertyName', runs(property.label))}</w:tc><w:tc><w:tcPr><w:tcW w:w="7370" w:type="dxa"/></w:tcPr>${paragraph('ElaboraPropertyValue', value)}</w:tc></w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="ElaboraProperties"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="2268"/><w:gridCol w:w="7370"/></w:tblGrid>${rows}</w:tbl>`;
}

// A bookmark around everything an element of the plan takes in the document, and the author's note
// for the client on its change as a comment on the same range.
function bookmarked(context: Context, id: string, paragraphs: string[], change: EntryMark | null = null): string[] {
  if (!paragraphs.length) return paragraphs;
  if (change?.note) paragraphs = commented(context, change.note, paragraphs);
  const mark = context.ids++;
  // A plan that breaks its schema may have an id Word would refuse as a name: it is cut to what Word
  // takes, and made unique.
  const base = wordBookmarkName(id).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
  let name = base;
  for (let index = 2; context.bookmarks.has(name); index++) name = `${base.slice(0, 40 - String(index).length - 1)}_${index}`;
  context.bookmarks.add(name);
  const first = paragraphs[0]!.replace(/<\/w:pPr>/, `</w:pPr><w:bookmarkStart w:id="${mark}" w:name="${xml(name)}"/>`);
  const lastIndex = paragraphs.length - 1;
  const closing = `<w:bookmarkEnd w:id="${mark}"/>`;
  const out = [first, ...paragraphs.slice(1)];
  // The end goes in the last paragraph (inside the last cell of a table that ends the element).
  const last = out[lastIndex]!;
  out[lastIndex] = last.endsWith('</w:p>') ? `${last.slice(0, -'</w:p>'.length)}${closing}</w:p>` : `${last}${paragraph('ElaboraBody', closing)}`;
  return out;
}

function sectionXml(doc: PlanDocument, section: PlanSection, context: Context): string[] {
  const out = [paragraph('Heading1', runs(section.title))];
  if (section.empty) { out.push(paragraph('ElaboraEmpty', runs(section.empty))); return out; }
  const L = doc.labels;
  const meta = (parts: (string | null)[]) => {
    const kept = parts.filter((part): part is string => !!part);
    return kept.length ? [paragraph('ElaboraMeta', runs(kept.join(' · ')))] : [];
  };
  switch (section.kind) {
    case 'framing':
      for (const entry of section.entries) {
        const paragraphs = [paragraph('ElaboraFieldName', runs(entry.label)), ...changeLine(entry.mark), ...rich(entry.text, context, 'ElaboraBody')];
        out.push(...(entry.mark?.note ? commented(context, entry.mark.note, paragraphs) : paragraphs));
      }
      if (section.waivers.length) {
        out.push(paragraph('Heading3', runs(section.waiversLabel)));
        for (const waiver of section.waivers) out.push(paragraph('ElaboraFieldName', runs(waiver.summary)), ...rich(waiver.reason, context, 'ElaboraBody'));
      }
      return out;
    case 'objectives':
      for (const objective of section.objectives) {
        out.push(...bookmarked(context, objective.id, [
          paragraph('ElaboraEntry', runs(objective.heading)),
          ...changeLine(objective.mark),
          ...rich(objective.statement, context, 'ElaboraBody'),
          ...meta([objective.bloom, objective.criterion ? `${L.criterion}${L.colon}${objective.criterion}` : null, objective.sources.length ? `${L.sources}${L.colon}${objective.sources.map((source) => source.title).join(', ')}` : null])
        ], objective.mark));
      }
      return out;
    case 'sequence':
      for (const item of section.items) {
        const voiceover = item.voiceover.length ? [paragraph('ElaboraFieldName', runs(L.voiceover)), ...item.voiceover.flatMap((line) => rich(line.text, context, 'ElaboraVoiceover', line.speaker ? `${runs(line.speaker, 'ElaboraSpeaker')}${runs(L.colon)}` : ''))] : [];
        out.push(...bookmarked(context, item.id, [
          paragraph('Heading2', item.titleChange ? `${runs(`${item.number}\t`)}${inline(item.titleChange, context, '')}` : runs(`${item.number}\t${item.title}`)),
          ...changeLine(item.mark),
          ...meta([item.kind, `${L.objectives}${L.colon}${item.objectives.map((objective) => objective.number).join(', ') || L.noObjective}`]),
          ...(item.description ? rich(item.description, context, 'ElaboraBody') : []),
          ...voiceover,
          ...(item.sources.length ? meta([`${L.sources}${L.colon}${item.sources.map((source) => source.title).join(', ')}`]) : [])
        ], item.mark));
      }
      return out;
    case 'texts':
      for (const group of section.groups) {
        out.push(groupHeading(group.item));
        for (const text of group.texts) out.push(...bookmarked(context, text.id, textEntry(doc, text, context), text.mark));
      }
      return out;
    case 'assessments':
      for (const group of section.groups) {
        out.push(groupHeading(group.item));
        for (const question of group.questions) out.push(...bookmarked(context, question.id, questionEntry(doc, question, context), question.mark));
      }
      return out;
    case 'sources':
      for (const source of section.sources) {
        out.push(...bookmarked(context, source.id, [
          paragraph('ElaboraEntry', source.titleChange ? inline(source.titleChange, context, '') : runs(source.title)),
          ...changeLine(source.mark),
          ...meta([source.type ? `${L.sourceType}${L.colon}${source.type}` : null, source.version ? `${L.sourceVersion}${L.colon}${source.version}` : null])
        ], source.mark));
      }
      return out;
  }
}

const groupHeading = (item: ItemRef) => paragraph('Heading2', runs(`${item.number}\t${item.title}`));

// A comment (a note for the client) on a run of paragraphs: its range from the first to the last,
// its reference at the end.
function commented(context: Context, note: string, paragraphs: string[]): string[] {
  const id = context.ids++;
  context.comments.push({ id, text: note });
  const out = [...paragraphs];
  out[0] = out[0]!.replace(/<\/w:pPr>/, `</w:pPr><w:commentRangeStart w:id="${id}"/>`);
  const last = out.length - 1;
  const end = `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;
  out[last] = out[last]!.endsWith('</w:p>') ? `${out[last]!.slice(0, -'</w:p>'.length)}${end}</w:p>` : `${out[last]}${paragraph('ElaboraBody', end)}`;
  return out;
}

// What changed in an element since the validated version, in a line above it.
const changeLine = (mark: EntryMark | null): string[] => (mark ? [paragraph(mark.verbatim ? 'ElaboraChangeVerbatim' : 'ElaboraChange', runs(mark.summary))] : []);

function textEntry(doc: PlanDocument, text: TextEntry, context: Context): string[] {
  return [
    paragraph('ElaboraEntry', `${runs(text.number)}${text.verbatim ? `${runs('\t')}${runs(doc.labels.verbatim, 'ElaboraTag')}` : ''}`),
    ...changeLine(text.mark),
    ...rich(text.text, context, 'ElaboraBody')
  ];
}

function questionEntry(doc: PlanDocument, question: QuestionEntry, context: Context): string[] {
  const L = doc.labels;
  const out = [
    paragraph('Heading3', runs(question.heading)),
    ...changeLine(question.mark),
    ...rich(question.stem, context, 'ElaboraBody'),
    paragraph('ElaboraMeta', runs([question.modeLabel, question.objectives.length ? `${L.objectives}${L.colon}${question.objectives.map((objective) => objective.number).join(', ')}` : null, question.bloom].filter(Boolean).join(' · ')))
  ];
  for (const option of question.options) {
    out.push(...rich(option.text, context, option.correct ? 'ElaboraOptionCorrect' : 'ElaboraOption', `${runs(option.letter, option.correct ? 'ElaboraCorrect' : undefined)}${runs('\t')}`));
    if (option.correct) out.push(paragraph('ElaboraFeedback', runs(`✓ ${L.correct}`, 'ElaboraCorrect')));
    if (option.feedback) out.push(...rich(option.feedback, context, 'ElaboraFeedback'));
  }
  const numeric = question.numeric;
  if (numeric) {
    out.push(paragraph('ElaboraBody', `${runs(`${L.answer}${L.colon}`, 'ElaboraLabel')}${runs(numeric.answer, 'Strong')}${numeric.tolerance ? runs(` (${numeric.tolerance})`) : ''}`));
    out.push(paragraph('ElaboraFieldName', runs(L.feedbackCorrect)), ...rich(numeric.correct, context, 'ElaboraBody'));
    out.push(paragraph('ElaboraFieldName', runs(L.feedbackIncorrect)), ...rich(numeric.incorrect, context, 'ElaboraBody'));
    if (numeric.misconceptions.length) {
      out.push(paragraph('ElaboraFieldName', runs(L.misconceptions)));
      for (const entry of numeric.misconceptions) out.push(...rich(entry.feedback, context, 'ElaboraFeedback', `${runs(entry.label, 'ElaboraLabel')}${runs(L.colon)}`));
    }
  }
  return out;
}

// ── rich text ──

function rich(text: RichText, context: Context, style: string, lead = ''): string[] {
  return blocks(text.blocks, context, style, lead, '');
}

// Paragraphs of blocks in a paragraph style; `lead` opens the first one (a number, a speaker), and
// `date` dates the tracked changes (none: the changes since a version have no day of their own).
function blocks(list: readonly RichBlock[], context: Context, style: string, lead: string, date: string): string[] {
  const out: string[] = [];
  let first = true;
  const take = () => { const value = first ? lead : ''; first = false; return value; };
  for (const block of list) out.push(...blockXml(block, context, style, take, date));
  if (first && lead) out.push(paragraph(style, lead));
  return out;
}

function markOf(change: Change | undefined, context: Context, date: string): string {
  if (!change) return '';
  return `<w:${change} w:id="${context.ids++}" w:author="${xml(context.author)}"${date ? ` w:date="${date}"` : ''}/>`;
}

function blockXml(block: RichBlock, context: Context, style: string, lead: () => string, date: string): string[] {
  // A paragraph inserted or deleted as a whole marks its paragraph mark too.
  const mark = block.change ? `<w:rPr>${markOf(block.change, context, date)}</w:rPr>` : '';
  switch (block.type) {
    case 'paragraph': return [paragraph(style, `${lead()}${inline(block.content, context, date)}`, mark)];
    case 'heading': return [paragraph(style, `${lead()}${inline(block.content.map((part) => ({ ...part, bold: true as const })), context, date)}`, mark)];
    case 'list': {
      let numId = 1;
      if (block.ordered) { context.lists.push(block.start ?? 1); numId = context.lists.length + 1; }
      const lead0 = lead();
      return block.items.flatMap((item, index) => item.flatMap((child, at) => {
        const content = child.type === 'paragraph' ? inline(child.content, context, date) : '';
        if (child.type !== 'paragraph') return blockXml(child, context, style, () => '', date);
        const numbering = at === 0 ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` : '<w:ind w:left="720"/>';
        return [paragraph('ListParagraph', `${index === 0 && at === 0 ? lead0 : ''}${content}`, `${numbering}${child.change ? `<w:rPr>${markOf(child.change, context, date)}</w:rPr>` : mark}`)];
      }));
    }
    case 'quote': return block.blocks.flatMap((child) => blockXml(child, context, 'Quote', lead, date));
    case 'code': return [paragraph('ElaboraCodeBlock', `${lead()}${inline([{ type: 'text', text: block.text, ...(block.change ? { change: block.change } : {}) }], context, date)}`, mark)];
    case 'math': {
      const prefix = lead();
      return [paragraph(style, `${prefix}${block.change ? inline([{ type: 'math', tex: block.tex, change: block.change }], context, date) : texToOmml(block.tex, true)}`, mark)];
    }
    case 'table': {
      const prefix = lead();
      const width = Math.max(1, block.header.length);
      const cell = (content: readonly RichInline[], header: boolean) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(5000 / width)}" w:type="pct"/></w:tcPr>${paragraph(header ? 'ElaboraTableHeading' : 'ElaboraTableText', inline(content, context, date))}</w:tc>`;
      const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${block.header.map((content) => cell(content, true)).join('')}</w:tr>`;
      const rows = block.rows.map((row) => `<w:tr>${row.map((content) => cell(content, false)).join('')}</w:tr>`).join('');
      const table = `<w:tbl><w:tblPr><w:tblStyle w:val="ElaboraTable"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="0020" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${block.header.map(() => `<w:gridCol w:w="${Math.floor(9638 / width)}"/>`).join('')}</w:tblGrid>${head}${rows}</w:tbl>`;
      return prefix ? [paragraph(style, prefix), table] : [table];
    }
    case 'rule': return [paragraph(style, lead(), `<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="DDE1E4"/></w:pBdr>`)];
  }
}

function inline(content: readonly RichInline[], context: Context, date: string): string {
  return content.map((part) => {
    const props: string[] = [];
    if (part.code) props.push('<w:rStyle w:val="ElaboraCode"/>');
    else if (part.href !== undefined) props.push('<w:rStyle w:val="Hyperlink"/>');
    if (part.bold) props.push('<w:b/>');
    if (part.italic) props.push('<w:i/>');
    if (part.strike) props.push('<w:strike/>');
    const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
    const deleted = part.change === 'del';
    let xmlRun: string;
    if (part.type === 'break') xmlRun = `<w:r>${rPr}<w:br/></w:r>`;
    else if (part.type === 'math' && !part.change) xmlRun = texToOmml(part.tex, false);
    else {
      const value = part.type === 'math' ? part.tex : part.text;
      const tag = deleted ? 'w:delText' : 'w:t';
      xmlRun = value.split('\n').map((line, index) => `<w:r>${rPr}${index ? '<w:br/>' : ''}<${tag} xml:space="preserve">${xml(line)}</${tag}></w:r>`).join('');
    }
    if (part.change) xmlRun = `<w:${part.change} w:id="${context.ids++}" w:author="${xml(context.author)}"${date ? ` w:date="${date}"` : ''}>${xmlRun}</w:${part.change}>`;
    if (part.href !== undefined && /^(https?:|mailto:)/i.test(part.href)) {
      context.rels.push(part.href);
      xmlRun = `<w:hyperlink r:id="rId${context.rels.length + 9}" w:history="1">${xmlRun}</w:hyperlink>`;
    }
    return xmlRun;
  }).join('');
}

// ── styles ──

const FONT = 'Calibri';
const MONO = 'Consolas';
const MUTED = '5F6870';

function styles(language: string): string {
  const paragraphStyle = (id: string, name: string, pPr: string, rPr: string, extra = '') => `<w:style w:type="paragraph" w:customStyle="${id.startsWith('Elabora') ? 1 : 0}" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="${id.startsWith('Heading') || id === 'Title' || id === 'ElaboraEntry' || id === 'ElaboraFieldName' ? 'ElaboraBody' : id}"/>${extra}<w:qFormat/><w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
  const characterStyle = (id: string, name: string, rPr: string) => `<w:style w:type="character" w:customStyle="${id.startsWith('Elabora') ? 1 : 0}" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr>${rPr}</w:rPr></w:style>`;
  const indent = '<w:ind w:left="567"/>';
  return `${HEADER}<w:styles ${W_NS}>`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/><w:color w:val="1D2125"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="${xml(language)}" w:eastAsia="${xml(language)}" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:semiHidden/></w:style>'
    + paragraphStyle('Title', 'Title', '<w:spacing w:before="0" w:after="240" w:line="240" w:lineRule="auto"/><w:contextualSpacing/>', '<w:b/><w:sz w:val="44"/><w:szCs w:val="44"/>')
    + paragraphStyle('Heading1', 'heading 1', '<w:keepNext/><w:keepLines/><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="DDE1E4"/></w:pBdr><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>', '<w:b/><w:sz w:val="30"/><w:szCs w:val="30"/>')
    + paragraphStyle('Heading2', 'heading 2', '<w:keepNext/><w:keepLines/><w:tabs><w:tab w:val="left" w:pos="567"/></w:tabs><w:spacing w:before="240" w:after="60"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="24"/><w:szCs w:val="24"/>')
    + paragraphStyle('Heading3', 'heading 3', `<w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="40"/>${indent}<w:outlineLvl w:val="2"/>`, '<w:b/><w:sz w:val="21"/><w:szCs w:val="21"/>')
    + paragraphStyle('ElaboraKicker', 'Elabora Kicker', '<w:spacing w:after="0"/>', `<w:color w:val="${MUTED}"/><w:sz w:val="20"/><w:szCs w:val="20"/>`)
    + paragraphStyle('ElaboraPropertyName', 'Elabora Property Name', '<w:spacing w:after="40"/>', `<w:color w:val="${MUTED}"/>`)
    + paragraphStyle('ElaboraPropertyValue', 'Elabora Property Value', '<w:spacing w:after="40"/>', '')
    + paragraphStyle('ElaboraBody', 'Elabora Body', indent, '')
    + paragraphStyle('ElaboraEntry', 'Elabora Entry', '<w:keepNext/><w:tabs><w:tab w:val="left" w:pos="1134"/></w:tabs><w:spacing w:before="160" w:after="40"/>', `<w:b/><w:color w:val="${MUTED}"/><w:sz w:val="19"/><w:szCs w:val="19"/>`)
    + paragraphStyle('ElaboraFieldName', 'Elabora Field Name', `<w:keepNext/><w:spacing w:before="120" w:after="20"/>${indent}`, `<w:color w:val="${MUTED}"/><w:sz w:val="19"/><w:szCs w:val="19"/>`)
    + paragraphStyle('ElaboraMeta', 'Elabora Meta', `<w:spacing w:after="80"/>${indent}`, `<w:color w:val="${MUTED}"/><w:sz w:val="18"/><w:szCs w:val="18"/>`)
    + paragraphStyle('ElaboraVoiceover', 'Elabora Voice-over', `<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="DDE1E4"/></w:pBdr><w:ind w:left="737"/>`, '')
    + paragraphStyle('ElaboraOption', 'Elabora Option', '<w:tabs><w:tab w:val="left" w:pos="907"/></w:tabs><w:spacing w:before="60" w:after="20"/><w:ind w:left="907" w:hanging="340"/>', '')
    + paragraphStyle('ElaboraOptionCorrect', 'Elabora Option (right answer)', '<w:tabs><w:tab w:val="left" w:pos="907"/></w:tabs><w:spacing w:before="60" w:after="20"/><w:ind w:left="907" w:hanging="340"/>', '')
    + paragraphStyle('ElaboraFeedback', 'Elabora Feedback', '<w:spacing w:after="40"/><w:ind w:left="907"/>', `<w:color w:val="${MUTED}"/><w:sz w:val="19"/><w:szCs w:val="19"/>`)
    + paragraphStyle('ElaboraChange', 'Elabora Change', `<w:keepNext/><w:spacing w:after="20"/>${indent}`, '<w:color w:val="1D5FBF"/><w:sz w:val="18"/><w:szCs w:val="18"/>')
    + paragraphStyle('ElaboraChangeVerbatim', 'Elabora Change (word for word)', `<w:keepNext/><w:spacing w:after="20"/>${indent}`, '<w:color w:val="8A5A00"/><w:sz w:val="18"/><w:szCs w:val="18"/>')
    + paragraphStyle('ElaboraNote', 'Elabora Note', `<w:spacing w:after="40"/>${indent}`, '<w:sz w:val="19"/><w:szCs w:val="19"/>')
    + paragraphStyle('CommentText', 'annotation text', '<w:spacing w:after="0"/>', '<w:sz w:val="20"/><w:szCs w:val="20"/>')
    + paragraphStyle('ElaboraEmpty', 'Elabora Empty Section', '', `<w:color w:val="${MUTED}"/>`)
    + paragraphStyle('ElaboraColophon', 'Elabora Colophon', '<w:spacing w:before="480"/>', `<w:color w:val="8A939B"/><w:sz w:val="16"/><w:szCs w:val="16"/>`)
    + paragraphStyle('ElaboraCodeBlock', 'Elabora Code', `<w:shd w:val="clear" w:color="auto" w:fill="F3F4F5"/>${indent}`, `<w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}" w:cs="${MONO}"/><w:sz w:val="19"/><w:szCs w:val="19"/>`)
    + paragraphStyle('ElaboraTableHeading', 'Elabora Table Heading', '<w:spacing w:after="0"/>', '<w:b/><w:sz w:val="19"/><w:szCs w:val="19"/>')
    + paragraphStyle('ElaboraTableText', 'Elabora Table Text', '<w:spacing w:after="0"/>', '<w:sz w:val="19"/><w:szCs w:val="19"/>')
    + paragraphStyle('ListParagraph', 'List Paragraph', '<w:ind w:left="1134"/><w:contextualSpacing/>', '')
    + paragraphStyle('Quote', 'Quote', `<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="DDE1E4"/></w:pBdr><w:ind w:left="737"/>`, `<w:color w:val="${MUTED}"/>`)
    + paragraphStyle('Footer', 'footer', '<w:tabs><w:tab w:val="right" w:pos="9638"/></w:tabs><w:spacing w:after="0"/>', `<w:color w:val="8A939B"/><w:sz w:val="16"/><w:szCs w:val="16"/>`)
    + characterStyle('Strong', 'Strong', '<w:b/>')
    + characterStyle('CommentReference', 'annotation reference', '<w:sz w:val="16"/><w:szCs w:val="16"/>')
    + characterStyle('Hyperlink', 'Hyperlink', '<w:color w:val="1D5FBF"/><w:u w:val="single"/>')
    + characterStyle('ElaboraCode', 'Elabora Code Characters', `<w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}" w:cs="${MONO}"/><w:sz w:val="19"/><w:szCs w:val="19"/>`)
    + characterStyle('ElaboraLabel', 'Elabora Label', `<w:color w:val="${MUTED}"/>`)
    + characterStyle('ElaboraSpeaker', 'Elabora Speaker', `<w:color w:val="${MUTED}"/>`)
    + characterStyle('ElaboraTag', 'Elabora Tag', `<w:b/><w:caps/><w:color w:val="${MUTED}"/><w:sz w:val="16"/><w:szCs w:val="16"/>`)
    + characterStyle('ElaboraCorrect', 'Elabora Right Answer', '<w:b/><w:color w:val="1F6F43"/>')
    + characterStyle('ElaboraStatusApproved', 'Elabora Status Approved', '<w:b/><w:color w:val="1F6F43"/>')
    + characterStyle('ElaboraStatusDraft', 'Elabora Status Draft', '<w:b/><w:color w:val="8A5A00"/>')
    + '<w:style w:type="table" w:customStyle="1" w:styleId="ElaboraProperties"><w:name w:val="Elabora Properties"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="113" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="table" w:customStyle="1" w:styleId="ElaboraTable"><w:name w:val="Elabora Table"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblInd w:w="567" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="DDE1E4"/><w:left w:val="single" w:sz="4" w:space="0" w:color="DDE1E4"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="DDE1E4"/><w:right w:val="single" w:sz="4" w:space="0" w:color="DDE1E4"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="DDE1E4"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="DDE1E4"/></w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="85" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="85" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '</w:styles>';
}

// Bullets (numId 1), and one numbering instance per ordered list, each from its own start.
function numbering(lists: readonly number[]): string {
  const level = (format: string, text: string) => `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1134" w:hanging="340"/></w:pPr></w:lvl>`;
  return `${HEADER}<w:numbering ${W_NS}>`
    + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${level('bullet', '•')}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${level('decimal', '%1.')}</w:abstractNum>`
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + lists.map((start, index) => `<w:num w:numId="${index + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`).join('')
    + '</w:numbering>';
}
