import path from 'node:path';
import { OfficePackage, OfficeFileError, coreProperties } from './ooxml.ts';
import type { Relationship } from './ooxml.ts';
import { child, contentOf, elements, find, findAll, isElement } from './xml.ts';
import type { XmlElement } from './xml.ts';
import { escapeLineStart, table } from './markdown.ts';
import { SourceParts } from './reader.ts';
import type { ReaderContext, ReaderResult } from './reader.ts';
import { SMALL_PICTURE } from './image-size.ts';
import type { Placement } from './image-size.ts';

// A PowerPoint deck (.pptx) as Markdown (docs/decisions.md D49): slide after slide, its texts in
// reading order (the title, then from top to bottom and left to right), its tables, SmartArt, the
// speaker's notes and the comments, and the pictures the slide places (from ppt/media, through the
// slide's relationships: pictures, shapes filled with a picture, the slide's background), each at its
// place in the reading order, those too small to matter left out (image-size.ts). Elabora draws no
// slide: the file's own thumbnail of the first slide is kept, and the readable version says so.

export const PPTX_READER = 'pptx/2';

interface Box { x: number; y: number; cx: number; cy: number }
interface Piece { box: Box | null; title: boolean; markdown: string }
interface Placeholder { type?: string; idx?: string }

const textOf = (element: XmlElement): string => element.children.map((node) => (typeof node === 'string' ? node : '')).join('');

export async function readPptx(file: string, context: ReaderContext): Promise<ReaderResult> {
  const pkg = await OfficePackage.open(file);
  let result: ReaderResult;
  try {
    result = await new PptxReader(pkg, context).read();
  } finally {
    await pkg.close();
  }
  return result;
}

class PptxReader {
  readonly #pkg: OfficePackage;
  readonly #context: ReaderContext;
  readonly #parts: SourceParts;
  readonly #layouts = new Map<string, { shapes: Map<string, Box>; parent?: string }>();
  #authors = new Map<string, string>();
  readonly #slides = new Map<string, XmlElement | null>();
  #size = { cx: 12192000, cy: 6858000 };

  constructor(pkg: OfficePackage, context: ReaderContext) {
    this.#pkg = pkg;
    this.#context = context;
    this.#parts = new SourceParts(context);
  }

  async read(): Promise<ReaderResult> {
    const main = [...(await this.#pkg.relationships('')).values()].find((rel) => rel.type === 'officeDocument' && !rel.external)?.target ?? 'ppt/presentation.xml';
    const presentation = await this.#pkg.xml(main);
    if (!presentation) throw new OfficeFileError('E_SOURCE_UNREADABLE', `${this.#context.source} has no presentation part: it is not a PowerPoint deck.`);
    const rels = await this.#pkg.relationships(main);
    for (const rel of rels.values()) {
      if (rel.type === 'commentAuthors') for (const author of findAll((await this.#pkg.xml(rel.target)) ?? undefined, 'p:cmAuthor')) this.#authors.set(author.attributes.id ?? '', author.attributes.name ?? '');
      if (rel.type === 'authors') for (const author of findAll((await this.#pkg.xml(rel.target)) ?? undefined, 'p188:author')) this.#authors.set(author.attributes.id ?? '', author.attributes.name ?? '');
    }
    const size = child(presentation, 'p:sldSz');
    this.#size = { cx: Number(size?.attributes.cx) || this.#size.cx, cy: Number(size?.attributes.cy) || this.#size.cy };
    const height = this.#size.cy;
    const slides = elements(child(presentation, 'p:sldIdLst') ?? presentation, 'p:sldId')
      .map((entry) => rels.get(entry.attributes['r:id'] ?? ''))
      .filter((rel): rel is Relationship => !!rel && !rel.external);
    for (const rel of slides) this.#slides.set(rel.target, await this.#pkg.xml(rel.target));

    // No slide is drawn here: the file's own thumbnail of the first slide is all there is of how a
    // slide looks, and the pictures the slides place come with their text.
    const notes: string[] = ['Elabora does not draw slides, so how a slide looks (its layout, shapes and colours) is not here: each slide below gives its text, its speaker\'s notes and the pictures it places. To see the slides as they are shown, save the deck as a PDF from PowerPoint and add the PDF to the sources too.'];
    const thumbnail = this.#pkg.parts.find((part) => /^docProps\/thumbnail\.(jpe?g|png)$/i.test(part));
    if (thumbnail) {
      const name = `thumbnail${path.posix.extname(thumbnail).toLowerCase().replace('.jpeg', '.jpg')}`;
      if (await this.#pkg.extract(thumbnail, path.join(this.#context.partsDir, name))) {
        this.#parts.written.push(name);
        notes.push(`The file's own thumbnail of the first slide: ${this.#parts.link(name)}.`);
      }
    }

    const out: string[] = [];
    const properties = await coreProperties(this.#pkg);
    if (properties.title) out.push(`Title: ${properties.title}`);
    out.push(`${slides.length} slide${slides.length === 1 ? '' : 's'}.`);
    for (const [index, rel] of slides.entries()) out.push(await this.#slide(rel.target, index + 1, height));
    if (this.#parts.skipped) notes.push(`${this.#parts.skipped} picture${this.#parts.skipped === 1 ? '' : 's'} too small to matter (an icon, a bullet, a rule: ${SMALL_PICTURE.pixels} px or less on its longest side, under ${SMALL_PICTURE.hairlinePixels} px on its shortest, or placed no larger than ${SMALL_PICTURE.placedShare * 100}% of the slide's width) ${this.#parts.skipped === 1 ? 'is' : 'are'} left out.`);
    return { markdown: out.join('\n\n'), complete: true, notes, parts: this.#parts.written };
  }

  async #slide(part: string, number: number, height: number): Promise<string> {
    const slide = this.#slides.get(part);
    if (!slide) return `## Slide ${number}\n\n*(missing from the file)*`;
    const rels = await this.#pkg.relationships(part);
    const layout = [...rels.values()].find((rel) => rel.type === 'slideLayout')?.target;
    const tree = find(slide, 'p:spTree');
    const pieces = tree ? await this.#shapes(tree, rels, layout, null) : [];
    const titles = pieces.filter((piece) => piece.title);
    const body = pieces.filter((piece) => !piece.title);
    // Reading order: from top to bottom in bands of a twentieth of the slide, left to right in a band.
    const band = Math.max(1, height / 20);
    body.sort((a, b) => {
      if (!a.box || !b.box) return a.box ? -1 : b.box ? 1 : 0;
      const rowA = Math.floor(a.box.y / band);
      const rowB = Math.floor(b.box.y / band);
      return rowA - rowB || a.box.x - b.box.x;
    });
    const title = titles.map((piece) => piece.markdown.replace(/\s*\n\s*/g, ' ')).join(' — ').trim();
    const out = [`## Slide ${number}${title ? ` — ${title}` : ''}`];
    if (slide.attributes.show === '0') out.push('*(hidden in the slide show)*');
    const background = find(find(slide, 'p:bg'), 'a:blip')?.attributes['r:embed'];
    const backdrop = background ? rels.get(background) : undefined;
    if (backdrop && !backdrop.external) {
      const markdown = await this.#parts.placed(this.#pkg, backdrop.target, `Slide ${number}, background`, null);
      if (markdown) out.push(markdown);
    }
    for (const piece of body) if (piece.markdown.trim()) out.push(piece.markdown);
    const notesPart = [...rels.values()].find((rel) => rel.type === 'notesSlide' && !rel.external)?.target;
    const speaker = notesPart ? await this.#notes(notesPart) : '';
    if (speaker) out.push(`**Speaker's notes:**\n\n${speaker}`);
    const comments = await this.#comments([...rels.values()].filter((rel) => rel.type === 'comments' && !rel.external).map((rel) => rel.target));
    if (comments.length) out.push(`**Comments:**\n\n${comments.join('\n')}`);
    return out.join('\n\n');
  }

  // The shapes of a tree (a slide, a group), each with where it is on the slide.
  async #shapes(tree: XmlElement, rels: Map<string, Relationship>, layout: string | undefined, transform: ((box: Box) => Box) | null): Promise<Piece[]> {
    const pieces: Piece[] = [];
    const place = (box: Box | null) => (box && transform ? transform(box) : box);
    for (const node of contentOf(tree)) {
      if (!isElement(node)) continue;
      if (node.name === 'p:sp') {
        const placeholder = placeholderOf(node, 'p:nvSpPr');
        if (placeholder && ['sldNum', 'dt', 'ftr', 'hdr'].includes(placeholder.type ?? '')) continue;
        const box = place(boxOf(child(node, 'p:spPr')) ?? (placeholder ? await this.#layoutBox(layout, placeholder) : null));
        const isTitle = placeholder?.type === 'title' || placeholder?.type === 'ctrTitle';
        const textBox = child(child(node, 'p:nvSpPr'), 'p:cNvSpPr')?.attributes.txBox === '1';
        const bulleted = !!placeholder && !isTitle && placeholder.type !== 'subTitle' && !textBox;
        const text = paragraphs(child(node, 'p:txBody'), bulleted);
        // A shape filled with a picture (Format Shape › Fill › Picture): behind its text.
        const fill = find(child(node, 'p:spPr'), 'a:blip');
        const filled = fill ? rels.get(fill.attributes['r:embed'] ?? '') : undefined;
        if (filled && !filled.external) {
          const properties = child(child(node, 'p:nvSpPr'), 'p:cNvPr');
          const markdown = await this.#parts.placed(this.#pkg, filled.target, properties?.attributes.descr || properties?.attributes.title || path.posix.basename(filled.target), this.#placement(box));
          if (markdown) pieces.push({ box, title: false, markdown });
        }
        if (text) pieces.push({ box, title: isTitle, markdown: text });
      } else if (node.name === 'p:grpSp') {
        const props = child(child(node, 'p:grpSpPr'), 'a:xfrm');
        const outer = boxOf(child(node, 'p:grpSpPr'));
        const childOffset = child(props, 'a:chOff');
        const childExtent = child(props, 'a:chExt');
        let inner = transform;
        if (outer && childOffset && childExtent) {
          const ox = Number(childOffset.attributes.x ?? 0);
          const oy = Number(childOffset.attributes.y ?? 0);
          const sx = outer.cx / Math.max(1, Number(childExtent.attributes.cx ?? 1));
          const sy = outer.cy / Math.max(1, Number(childExtent.attributes.cy ?? 1));
          const own = (box: Box): Box => ({ x: outer.x + (box.x - ox) * sx, y: outer.y + (box.y - oy) * sy, cx: box.cx * sx, cy: box.cy * sy });
          inner = transform ? (box: Box) => transform(own(box)) : own;
        }
        pieces.push(...(await this.#shapes(node, rels, layout, inner)));
      } else if (node.name === 'p:graphicFrame') {
        const box = place(boxOf(node, 'p:xfrm'));
        const tbl = find(node, 'a:tbl');
        if (tbl) {
          const rows = elements(tbl, 'a:tr').map((tr) => elements(tr, 'a:tc').filter((tc) => tc.attributes.hMerge !== '1' && tc.attributes.vMerge !== '1').map((tc) => paragraphs(child(tc, 'a:txBody'), false)));
          const rendered = table(rows.filter((row) => row.some(Boolean)));
          if (rendered) pieces.push({ box, title: false, markdown: rendered });
          continue;
        }
        const diagram = find(node, 'dgm:relIds');
        if (diagram) {
          const data = rels.get(diagram.attributes['r:dm'] ?? '');
          const model = data && !data.external ? await this.#pkg.xml(data.target) : null;
          const items = findAll(model ?? undefined, 'dgm:pt').map((point) => paragraphs(child(point, 'dgm:t'), false)).filter(Boolean);
          if (items.length) pieces.push({ box, title: false, markdown: items.map((item) => `- ${item.replace(/\n/g, ' ')}`).join('\n') });
          continue;
        }
        const chartRef = findAll(node, 'c:chart')[0] ?? findAll(node, 'cx:chart')[0];
        if (chartRef) {
          const target = rels.get(chartRef.attributes['r:id'] ?? '');
          const chartXml = target && !target.external ? await this.#pkg.xml(target.target) : null;
          const titleNode = chartXml ? findAll(chartXml, 'c:title')[0] : undefined;
          const chartTitle = titleNode ? findAll(titleNode, 'a:t').map(textOf).join('').trim() : '';
          pieces.push({ box, title: false, markdown: `*(a chart${chartTitle ? `: ${chartTitle}` : ''})*` });
        }
      } else if (node.name === 'p:pic') {
        const box = place(boxOf(child(node, 'p:spPr')));
        const properties = child(child(node, 'p:nvPicPr'), 'p:cNvPr');
        const alt = properties?.attributes.descr || properties?.attributes.title || '';
        const media = find(node, 'a:videoFile') ?? find(node, 'a:audioFile');
        if (media) {
          const rel = rels.get(media.attributes['r:link'] ?? media.attributes['r:embed'] ?? '');
          pieces.push({ box, title: false, markdown: `*(a ${media.name === 'a:videoFile' ? 'video' : 'sound'}${rel ? `: ${path.posix.basename(rel.target)}` : ''}${alt ? `, ${alt}` : ''})*` });
          continue;
        }
        const blip = find(node, 'a:blip');
        const rel = rels.get(blip?.attributes['r:embed'] ?? blip?.attributes['r:link'] ?? '');
        if (rel && !rel.external) {
          const markdown = await this.#parts.placed(this.#pkg, rel.target, alt || path.posix.basename(rel.target), this.#placement(box));
          if (markdown) pieces.push({ box, title: false, markdown });
        } else if (rel) {
          pieces.push({ box, title: false, markdown: `*(${alt || 'a picture'}: linked to ${rel.target.split(/[\\/]/).pop() || 'a file'} outside the deck, not kept in it)*` });
        }
      }
    }
    return pieces;
  }

  // The box a picture is shown in, with the slide's size, for the judgement of smallPicture.
  #placement(box: Box | null): Placement | null {
    return box && box.cx > 0 && box.cy > 0 ? { cx: box.cx, cy: box.cy, slideCx: this.#size.cx, slideCy: this.#size.cy } : null;
  }

  // Where a placeholder without a position of its own is: on its layout, else on the master.
  async #layoutBox(layout: string | undefined, placeholder: Placeholder): Promise<Box | null> {
    for (let part = layout, depth = 0; part && depth < 3; depth++) {
      let known = this.#layouts.get(part);
      if (!known) {
        const shapes = new Map<string, Box>();
        const root = await this.#pkg.xml(part);
        for (const shape of findAll(root ?? undefined, 'p:sp')) {
          const ph = placeholderOf(shape, 'p:nvSpPr');
          const box = boxOf(child(shape, 'p:spPr'));
          if (!ph || !box) continue;
          if (ph.idx) shapes.set(`idx:${ph.idx}`, box);
          shapes.set(`type:${ph.type ?? 'body'}`, box);
        }
        const parent = [...(await this.#pkg.relationships(part)).values()].find((rel) => rel.type === 'slideMaster')?.target;
        known = { shapes, parent };
        this.#layouts.set(part, known);
      }
      const box = (placeholder.idx ? known.shapes.get(`idx:${placeholder.idx}`) : undefined) ?? known.shapes.get(`type:${placeholder.type ?? 'body'}`);
      if (box) return box;
      part = known.parent;
    }
    return null;
  }

  async #notes(part: string): Promise<string> {
    const root = await this.#pkg.xml(part);
    const texts: string[] = [];
    for (const shape of findAll(root ?? undefined, 'p:sp')) {
      const ph = placeholderOf(shape, 'p:nvSpPr');
      if (ph?.type !== 'body') continue;
      const text = paragraphs(child(shape, 'p:txBody'), false);
      if (text) texts.push(text);
    }
    return texts.join('\n\n');
  }

  // The comments of a slide: PowerPoint's older ones (p:cm) and the threaded ones of 2021 (p188:cm).
  async #comments(parts: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const part of parts) {
      const root = await this.#pkg.xml(part);
      if (!root) continue;
      for (const comment of elements(root, 'p:cm')) {
        const text = findAll(comment, 'p:text').map(textOf).join(' ').trim();
        if (text) out.push(`- ${this.#authors.get(comment.attributes.authorId ?? '') || 'unknown'}${comment.attributes.dt ? `, ${comment.attributes.dt.slice(0, 10)}` : ''}: ${text}`);
      }
      for (const comment of elements(root, 'p188:cm')) {
        const say = (entry: XmlElement, reply: boolean) => {
          const text = paragraphs(child(entry, 'p188:txBody'), false).replace(/\n+/g, ' ');
          if (text) out.push(`${reply ? '  - ↳ ' : '- '}${this.#authors.get(entry.attributes.authorId ?? '') || 'unknown'}${entry.attributes.created ? `, ${entry.attributes.created.slice(0, 10)}` : ''}${!reply && entry.attributes.status === 'resolved' ? ' (resolved)' : ''}: ${text}`);
        };
        say(comment, false);
        for (const reply of findAll(child(comment, 'p188:replyLst'), 'p188:reply')) say(reply, true);
      }
    }
    return out;
  }
}

function placeholderOf(shape: XmlElement, nonVisual: string): Placeholder | null {
  const ph = child(child(child(shape, nonVisual), 'p:nvPr'), 'p:ph');
  return ph ? { type: ph.attributes.type, idx: ph.attributes.idx } : null;
}

function boxOf(properties: XmlElement | undefined, name = 'a:xfrm'): Box | null {
  const xfrm = child(properties, name);
  const off = child(xfrm, 'a:off');
  const ext = child(xfrm, 'a:ext');
  if (!off) return null;
  return { x: Number(off.attributes.x ?? 0), y: Number(off.attributes.y ?? 0), cx: Number(ext?.attributes.cx ?? 0), cy: Number(ext?.attributes.cy ?? 0) };
}

// A text body's paragraphs: bullets where the shape is a list (a body placeholder, or a paragraph
// that asks for one), indented by level.
function paragraphs(body: XmlElement | undefined, bulleted: boolean): string {
  if (!body) return '';
  const lines: { text: string; listed: boolean }[] = [];
  const counters: number[] = [];
  for (const p of elements(body, 'a:p')) {
    let text = '';
    for (const node of contentOf(p)) {
      if (!isElement(node)) continue;
      if (node.name === 'a:r' || node.name === 'a:fld') text += findAll(node, 'a:t').map(textOf).join('');
      else if (node.name === 'a:br') text += '\n';
    }
    text = text.replace(/\u000b/g, '\n').trim();
    if (!text) continue;
    const pPr = child(p, 'a:pPr');
    const level = Math.max(0, Math.min(8, Number(pPr?.attributes.lvl ?? 0)));
    const none = !!child(pPr, 'a:buNone');
    const numbered = !!child(pPr, 'a:buAutoNum');
    const listed = !none && (bulleted || numbered || !!child(pPr, 'a:buChar') || !!child(pPr, 'a:buBlip'));
    const indent = '  '.repeat(level);
    if (!listed) { lines.push({ text: escapeLineStart(text), listed }); counters.length = 0; continue; }
    let marker = '-';
    if (numbered) {
      counters[level] = (counters[level] ?? 0) + 1;
      counters.length = level + 1;
      marker = `${counters[level]}.`;
    }
    lines.push({ text: `${indent}${marker} ${text.replace(/\n/g, `\n${indent}  `)}`, listed });
  }
  // A list's items follow each other; other paragraphs stand apart.
  return lines.map((line, i) => (i && !(line.listed && lines[i - 1].listed) ? `\n\n${line.text}` : line.text)).join('\n').replace(/\n\n\n/g, '\n\n');
}
