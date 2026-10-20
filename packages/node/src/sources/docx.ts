import path from 'node:path';
import { OfficePackage, OfficeFileError, coreProperties } from './ooxml.ts';
import type { Relationship } from './ooxml.ts';
import { child, contentOf, elements, find, findAll, isElement } from './xml.ts';
import type { XmlElement, XmlNode } from './xml.ts';
import { escapeLineStart, joinBlocks, table } from './markdown.ts';
import { SourceParts } from './reader.ts';
import type { ReaderContext, ReaderResult } from './reader.ts';

// A Word document (.docx) as Markdown (docs/decisions.md D49): its headings, paragraphs, lists and
// tables in order, its images, footnotes, comments and tracked changes. Agencies' briefs are full of
// comments and revisions: they are kept where they are, insertions as {++…++}, deletions as {--…--}
// and comments as {>>…<<} (CriticMarkup), and listed at the end with the text they are about.

export const DOCX_READER = 'docx/1';

interface Style { name: string; basedOn?: string; outline?: number; numId?: string; ilvl?: number }
interface Comment { id: string; author: string; date: string; text: string; parent?: string; done?: boolean; quoted: string }
type Mode = 'normal' | 'ins' | 'del';

const W = (name: string) => `w:${name}`;
const attr = (element: XmlElement | undefined, name: string): string | undefined => element?.attributes[W(name)] ?? element?.attributes[name];
const textOf = (element: XmlElement): string => element.children.map((node) => (typeof node === 'string' ? node : '')).join('');

export async function readDocx(file: string, context: ReaderContext): Promise<ReaderResult> {
  const pkg = await OfficePackage.open(file);
  try {
    return await new DocxReader(pkg, context).read();
  } finally {
    await pkg.close();
  }
}

class DocxReader {
  readonly #pkg: OfficePackage;
  readonly #context: ReaderContext;
  readonly #parts: SourceParts;
  #main = 'word/document.xml';
  #rels = new Map<string, Relationship>();
  #styles = new Map<string, Style>();
  #numberFormats = new Map<string, Map<number, string>>(); // numId → level → format
  #counters = new Map<string, number[]>();
  #comments = new Map<string, Comment>();
  #open = new Map<string, string[]>(); // comment ranges open in the text: id → their text so far
  #notes: { kind: 'footnote' | 'endnote'; id: string; label: string }[] = [];
  #noteTexts = new Map<string, string>();
  #changes = new Map<string, { ins: number; del: number }>();
  #floating: string[] = []; // text boxes of the paragraph being read, said after it

  constructor(pkg: OfficePackage, context: ReaderContext) {
    this.#pkg = pkg;
    this.#context = context;
    this.#parts = new SourceParts(context);
  }

  async read(): Promise<ReaderResult> {
    const officeDocument = [...(await this.#pkg.relationships('')).values()].find((rel) => rel.type === 'officeDocument' && !rel.external);
    if (officeDocument) this.#main = officeDocument.target;
    const document = await this.#pkg.xml(this.#main);
    if (!document) throw new OfficeFileError('E_SOURCE_UNREADABLE', `${this.#context.source} has no document part: it is not a Word document.`);
    this.#rels = await this.#pkg.relationships(this.#main);
    const related = (type: string) => [...this.#rels.values()].find((rel) => rel.type === type && !rel.external)?.target;
    await this.#readStyles(related('styles'));
    await this.#readNumbering(related('numbering'));
    await this.#readComments(related('comments'), related('commentsExtended'));
    await this.#readNotes(related('footnotes'), 'footnote');
    await this.#readNotes(related('endnotes'), 'endnote');

    const body = child(document, W('body'));
    const blocks = body ? await this.#blocks(body) : [];
    const properties = await coreProperties(this.#pkg);
    const out: string[] = [];
    if (properties.title) out.push(`Title: ${properties.title}`);
    if (blocks.length) out.push(joinBlocks(blocks));
    if (this.#notes.length) {
      out.push('## Notes');
      for (const note of this.#notes) out.push(`[^${note.label}]: ${this.#noteTexts.get(`${note.kind}:${note.id}`) ?? ''}`);
    }
    const comments = [...this.#comments.values()].filter((comment) => comment.text || comment.quoted);
    if (comments.length) {
      out.push('## Comments');
      out.push(comments.map((comment) => {
        const about = comment.quoted.trim() ? ` on « ${comment.quoted.trim().replace(/\s+/g, ' ').slice(0, 300)} »` : '';
        return `- ${comment.parent ? '↳ reply ' : ''}c${comment.id}, ${comment.author || 'unknown'}${comment.date ? `, ${comment.date.slice(0, 10)}` : ''}${comment.done ? ' (resolved)' : ''}${comment.parent ? '' : about}: ${comment.text}`;
      }).join('\n'));
    }
    if (this.#changes.size) {
      const authors = [...this.#changes.entries()].map(([author, count]) => `${author} (${count.ins} insertion${count.ins === 1 ? '' : 's'}, ${count.del} deletion${count.del === 1 ? '' : 's'})`);
      out.push(`## Tracked changes\nNot accepted yet, shown in the text as {++inserted++} and {--deleted--}: ${authors.join('; ')}.`);
    }
    const notes: string[] = [];
    if (this.#comments.size) notes.push('Comments are shown where they are anchored, as {>>c<n> author: text<<}, and listed at the end with the text they are about.');
    if (this.#changes.size) notes.push('The document has tracked changes nobody accepted yet: {++inserted++}, {--deleted--}.');
    return { markdown: out.join('\n\n'), complete: true, notes, parts: this.#parts.written };
  }

  async #readStyles(part: string | undefined): Promise<void> {
    const root = part ? await this.#pkg.xml(part) : null;
    if (!root) return;
    for (const style of elements(root, W('style'))) {
      const id = attr(style, 'styleId');
      if (!id) continue;
      const pPr = child(style, W('pPr'));
      const numPr = child(pPr, W('numPr'));
      const outline = attr(child(pPr, W('outlineLvl')), 'val');
      this.#styles.set(id, {
        name: (attr(child(style, W('name')), 'val') ?? id).toLowerCase(),
        basedOn: attr(child(style, W('basedOn')), 'val'),
        ...(outline !== undefined ? { outline: Number(outline) } : {}),
        ...(numPr ? { numId: attr(child(numPr, W('numId')), 'val'), ilvl: Number(attr(child(numPr, W('ilvl')), 'val') ?? 0) } : {})
      });
    }
  }

  // A style's value, from it or the styles it is based on.
  #inherited<K extends keyof Style>(styleId: string | undefined, key: K): Style[K] | undefined {
    const seen = new Set<string>();
    for (let id = styleId; id && !seen.has(id); id = this.#styles.get(id)?.basedOn) {
      seen.add(id);
      const value = this.#styles.get(id)?.[key];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  #headingLevel(styleId: string | undefined, pPr: XmlElement | undefined): number | null {
    const name = styleId ? this.#styles.get(styleId)?.name ?? styleId.toLowerCase() : '';
    if (name === 'title') return 1;
    if (name === 'subtitle') return null;
    const heading = /^heading\s*(\d)$/.exec(name);
    if (heading) return Number(heading[1]);
    const outline = attr(child(pPr, W('outlineLvl')), 'val') ?? this.#inherited(styleId, 'outline');
    const level = outline === undefined ? NaN : Number(outline);
    return Number.isInteger(level) && level >= 0 && level < 9 ? level + 1 : null;
  }

  async #readNumbering(part: string | undefined): Promise<void> {
    const root = part ? await this.#pkg.xml(part) : null;
    if (!root) return;
    const abstract = new Map<string, Map<number, string>>();
    for (const definition of elements(root, W('abstractNum'))) {
      const levels = new Map<number, string>();
      for (const level of elements(definition, W('lvl'))) levels.set(Number(attr(level, 'ilvl') ?? 0), attr(child(level, W('numFmt')), 'val') ?? 'decimal');
      abstract.set(attr(definition, 'abstractNumId') ?? '', levels);
    }
    for (const num of elements(root, W('num'))) {
      const levels = abstract.get(attr(child(num, W('abstractNumId')), 'val') ?? '');
      if (levels) this.#numberFormats.set(attr(num, 'numId') ?? '', levels);
    }
  }

  async #readComments(part: string | undefined, extendedPart: string | undefined): Promise<void> {
    const root = part ? await this.#pkg.xml(part) : null;
    if (!root) return;
    // Replies and resolved comments (Word 2013+): by the id of each comment's last paragraph.
    const extended = extendedPart ? await this.#pkg.xml(extendedPart) : null;
    const byParagraph = new Map<string, { parent?: string; done: boolean }>();
    for (const entry of findAll(extended ?? undefined, 'w15:commentEx')) {
      byParagraph.set(entry.attributes['w15:paraId'] ?? '', { parent: entry.attributes['w15:paraIdParent'], done: entry.attributes['w15:done'] === '1' });
    }
    const commentOfParagraph = new Map<string, string>();
    for (const comment of elements(root, W('comment'))) {
      const id = attr(comment, 'id') ?? '';
      const paragraphs = findAll(comment, W('p'));
      const text = (await Promise.all(paragraphs.map((p) => this.#inline(p.children, { plain: true })))).map((line) => line.trim()).filter(Boolean).join(' ');
      const last = paragraphs.at(-1)?.attributes['w14:paraId'];
      if (last) commentOfParagraph.set(last, id);
      const ex = last ? byParagraph.get(last) : undefined;
      this.#comments.set(id, { id, author: attr(comment, 'author') ?? '', date: attr(comment, 'date') ?? '', text, quoted: '', done: ex?.done, parent: ex?.parent });
    }
    for (const comment of this.#comments.values()) if (comment.parent) comment.parent = commentOfParagraph.get(comment.parent);
  }

  async #readNotes(part: string | undefined, kind: 'footnote' | 'endnote'): Promise<void> {
    const root = part ? await this.#pkg.xml(part) : null;
    if (!root) return;
    for (const note of elements(root, W(kind))) {
      const type = attr(note, 'type');
      if (type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice') continue;
      const text = (await Promise.all(findAll(note, W('p')).map((p) => this.#inline(p.children, { plain: true })))).map((line) => line.trim()).filter(Boolean).join(' ');
      this.#noteTexts.set(`${kind}:${attr(note, 'id')}`, text);
    }
  }

  // The body's blocks (or a table cell's, a text box's) as Markdown blocks.
  async #blocks(container: XmlElement): Promise<string[]> {
    const out: string[] = [];
    for (const node of contentOf(container)) {
      if (!isElement(node)) continue;
      if (node.name === W('p')) {
        const block = await this.#paragraph(node);
        if (block) out.push(block);
        if (this.#floating.length) out.push(...this.#floating.splice(0));
      } else if (node.name === W('tbl')) {
        const rendered = await this.#table(node);
        if (rendered) out.push(rendered);
      } else if (node.name === W('sdt')) {
        const content = child(node, W('sdtContent'));
        if (content) out.push(...(await this.#blocks(content)));
      } else if (node.name === W('customXml') || node.name === W('ins') || node.name === W('moveTo')) {
        out.push(...(await this.#blocks(node)));
      }
    }
    return out;
  }

  async #paragraph(p: XmlElement): Promise<string> {
    const pPr = child(p, W('pPr'));
    const styleId = attr(child(pPr, W('pStyle')), 'val');
    const text = (await this.#inline(p.children)).replace(/[ \t]+\n/g, '\n').trim();
    if (!text) return '';
    const level = this.#headingLevel(styleId, pPr);
    if (level !== null) return `${'#'.repeat(Math.min(6, level + 1))} ${text.replace(/\s*\n\s*/g, ' ')}`;
    const numPr = child(pPr, W('numPr'));
    const numId = numPr ? attr(child(numPr, W('numId')), 'val') : this.#inherited(styleId, 'numId');
    if (numId && numId !== '0') {
      const ilvl = Number((numPr ? attr(child(numPr, W('ilvl')), 'val') : undefined) ?? this.#inherited(styleId, 'ilvl') ?? 0);
      const format = this.#numberFormats.get(numId)?.get(ilvl) ?? 'bullet';
      const indent = '  '.repeat(Math.max(0, Math.min(8, ilvl)));
      let marker = '-';
      if (format !== 'bullet' && format !== 'none') {
        const counters = this.#counters.get(numId) ?? [];
        counters[ilvl] = (counters[ilvl] ?? 0) + 1;
        counters.length = ilvl + 1;
        this.#counters.set(numId, counters);
        marker = `${counters[ilvl]}.`;
      }
      return `${indent}${marker} ${text.replace(/\n/g, `\n${indent}  `)}`;
    }
    return escapeLineStart(text);
  }

  async #table(tbl: XmlElement): Promise<string> {
    const rows: string[][] = [];
    for (const tr of findRows(tbl)) {
      const row: string[] = [];
      for (const tc of findCells(tr)) {
        const tcPr = child(tc, W('tcPr'));
        const merged = child(tcPr, W('vMerge'));
        const continued = merged && attr(merged, 'val') !== 'restart';
        const blocks = continued ? [] : await this.#blocks(tc);
        row.push(blocks.join('\n').replace(/^#+\s/gm, '').trim());
        const span = Number(attr(child(tcPr, W('gridSpan')), 'val') ?? 1);
        for (let i = 1; i < span && i < 64; i++) row.push('');
      }
      if (row.some(Boolean)) rows.push(row);
    }
    return table(rows);
  }

  // Runs and what holds them: text, tabs and breaks, links, fields, images, notes, comments and
  // tracked changes. plain: for comments and notes, without markers.
  async #inline(nodes: readonly XmlNode[], options: { plain?: boolean } = {}): Promise<string> {
    let out = '';
    const fields: ('instruction' | 'result')[] = [];
    const say = (text: string, mode: Mode, author: string | undefined) => {
      if (!text) return;
      if (!options.plain && mode !== 'del') for (const quoted of this.#open.values()) quoted.push(text);
      if (options.plain || mode === 'normal') { out += text; return; }
      const who = author || 'unknown';
      const counts = this.#changes.get(who) ?? { ins: 0, del: 0 };
      this.#changes.set(who, counts);
      // The runs of one change read as one.
      const [open, close] = mode === 'ins' ? ['{++', '++}'] : ['{--', '--}'];
      if (out.endsWith(close)) out = out.slice(0, -close.length) + text + close;
      else { out += `${open}${text}${close}`; counts[mode] += 1; }
    };
    const run = async (r: XmlElement, mode: Mode, author: string | undefined) => {
      for (const part of contentOf(r)) {
        if (!isElement(part)) continue;
        if (part.name === W('fldChar')) {
          const type = attr(part, 'fldCharType');
          if (type === 'begin') fields.push('instruction');
          else if (type === 'separate' && fields.length) fields[fields.length - 1] = 'result';
          else if (type === 'end') fields.pop();
          continue;
        }
        // A field's instruction (PAGE, HYPERLINK "…") is not text; its result is.
        if (fields.at(-1) === 'instruction') continue;
        switch (part.name) {
          case W('t'): say(textOf(part), mode, author); break;
          case W('delText'): if (mode === 'del') say(textOf(part), mode, author); break;
          case W('tab'): case W('ptab'): say('\t', mode, author); break;
          case W('br'): case W('cr'): if (attr(part, 'type') !== 'page' && attr(part, 'type') !== 'column') say('\n', mode, author); break;
          case W('noBreakHyphen'): say('-', mode, author); break;
          case W('sym'): {
            const code = parseInt(attr(part, 'char') ?? '', 16);
            if (Number.isFinite(code) && code >= 0x20 && code < 0xf000) say(String.fromCodePoint(code), mode, author);
            break;
          }
          case W('footnoteReference'): case W('endnoteReference'): {
            if (options.plain) break;
            const kind = part.name === W('footnoteReference') ? 'footnote' : 'endnote';
            const label = `${kind === 'footnote' ? '' : 'e'}${this.#notes.filter((note) => note.kind === kind).length + 1}`;
            this.#notes.push({ kind, id: attr(part, 'id') ?? '', label });
            out += `[^${label}]`;
            break;
          }
          case W('commentReference'): if (!options.plain) out += this.#commentMarker(attr(part, 'id') ?? ''); break;
          case W('drawing'): case W('pict'): case W('object'): if (!options.plain) await this.#drawing(part, (markdown) => { out += markdown; }); break;
        }
      }
    };
    const walk = async (list: readonly XmlNode[], mode: Mode, author?: string): Promise<void> => {
      for (const node of contentOf(list)) {
        if (!isElement(node)) continue;
        switch (node.name) {
          case W('r'): await run(node, mode, author); break;
          case W('ins'): case W('moveTo'): await walk(node.children, 'ins', attr(node, 'author')); break;
          case W('del'): case W('moveFrom'): await walk(node.children, 'del', attr(node, 'author')); break;
          case W('hyperlink'): {
            const target = this.#rels.get(node.attributes['r:id'] ?? '');
            const before = out.length;
            await walk(node.children, mode, author);
            const text = out.slice(before);
            if (!options.plain && mode === 'normal' && target?.external && /^(https?|mailto):/i.test(target.target) && text.trim() && !text.includes('{')) out = `${out.slice(0, before)}[${text}](${target.target.replace(/[()\s]/g, encodeURIComponent)})`;
            break;
          }
          case W('commentRangeStart'): if (!options.plain) this.#open.set(attr(node, 'id') ?? '', []); break;
          case W('commentRangeEnd'): {
            const id = attr(node, 'id') ?? '';
            const quoted = this.#open.get(id);
            const comment = this.#comments.get(id);
            if (quoted && comment) comment.quoted = quoted.join('');
            this.#open.delete(id);
            break;
          }
          case W('sdt'): await walk((child(node, W('sdtContent')) ?? node).children, mode, author); break;
          case W('smartTag'): case W('customXml'): case W('fldSimple'): case W('bdo'): case W('dir'): await walk(node.children, mode, author); break;
        }
      }
    };
    await walk(nodes, 'normal');
    return out;
  }

  #commentMarker(id: string): string {
    const comment = this.#comments.get(id);
    if (!comment) return '';
    return ` {>>c${id} ${comment.author || 'unknown'}: ${comment.text.replace(/<</g, '‹‹')}<<}`;
  }

  // An image (its description as its alt text), or a text box said after its paragraph.
  async #drawing(drawing: XmlElement, add: (markdown: string) => void): Promise<void> {
    const boxes = findAll(drawing, W('txbxContent'));
    for (const box of boxes) {
      const blocks = await this.#blocks(box);
      if (blocks.length) this.#floating.push(blocks.map((block) => block.split('\n').map((line) => `> ${line}`).join('\n')).join('\n>\n'));
    }
    const docPr = find(drawing, 'wp:docPr');
    const alt = docPr?.attributes.descr || docPr?.attributes.title || '';
    const blip = find(drawing, 'a:blip');
    const legacy = find(drawing, 'v:imagedata');
    const id = blip?.attributes['r:embed'] ?? legacy?.attributes['r:id'];
    const rel = id ? this.#rels.get(id) : undefined;
    if (rel && !rel.external) add(` ${await this.#parts.image(this.#pkg, rel.target, alt || path.posix.basename(rel.target))} `);
    else if (drawing.name === W('object')) add(' *(an embedded object)* ');
  }
}

function findRows(tbl: XmlElement): XmlElement[] {
  const rows: XmlElement[] = [];
  for (const node of contentOf(tbl)) {
    if (!isElement(node)) continue;
    if (node.name === W('tr')) rows.push(node);
    else if (node.name === W('sdt') || node.name === W('customXml')) rows.push(...findRows(child(node, W('sdtContent')) ?? node));
  }
  return rows;
}

function findCells(tr: XmlElement): XmlElement[] {
  const cells: XmlElement[] = [];
  for (const node of contentOf(tr)) {
    if (!isElement(node)) continue;
    if (node.name === W('tc')) cells.push(node);
    else if (node.name === W('sdt') || node.name === W('customXml')) cells.push(...findCells(child(node, W('sdtContent')) ?? node));
  }
  return cells;
}
