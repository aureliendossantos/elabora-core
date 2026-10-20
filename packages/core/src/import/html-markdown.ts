import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

// The rich text of Rise (HTML strings) and of Storyline (its text runs, given here as HTML) in the
// Elabora Markdown subset (SPEC §4.3): paragraphs, emphasis, links, lists, headings, quotes and code.
// What the subset has no room for (colours, sizes, underlines, alignment, fonts) is dropped: the
// design layer owns the look. The result is trimmed and never holds raw HTML.

export interface MarkdownOptions {
  // Headings in the text start at this level (the screen title is level 1). Default 3: a heading
  // inside a text block is a sub-heading of the screen's own headings.
  headingLevel?: number;
}

const isElement = (node: Node): node is Element => 'tagName' in node;
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr']);

// Characters Markdown would read as syntax at the start of a line or around words.
const escapeText = (text: string): string => text.replace(/([\\`*_[\]$])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+\.)(\s)/gm, '$1\\$2$3');

function inline(nodes: readonly Node[]): string {
  let out = '';
  for (const node of nodes) {
    if (!isElement(node)) {
      if (node.nodeName === '#text') out += escapeText((node as DefaultTreeAdapterMap['textNode']).value.replace(/\s+/g, ' '));
      continue;
    }
    const tag = node.tagName;
    if (tag === 'br') { out += '  \n'; continue; }
    if (tag === 'script' || tag === 'style' || tag === 'template') continue;
    if (tag === 'img') continue; // images are blocks of their own (SPEC §4.3)
    const content = inline(node.childNodes);
    if (!content.trim()) { out += content; continue; }
    const style = node.attrs.find((attr) => attr.name === 'style')?.value ?? '';
    const bold = tag === 'strong' || tag === 'b' || /font-weight:\s*(bold|[6-9]00)/i.test(style);
    const italic = tag === 'em' || tag === 'i' || /font-style:\s*italic/i.test(style);
    let piece = content;
    if (tag === 'code') piece = `\`${content.replace(/\\([\\`*_[\]$])/g, '$1').replace(/`/g, '')}\``;
    else {
      // Emphasis marks hug the words: spaces stay outside them.
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece)!;
      let marked = core;
      if (italic) marked = `*${marked}*`;
      if (bold) marked = `**${marked}**`;
      piece = `${lead}${marked}${trail}`;
    }
    if (tag === 'a') {
      const href = node.attrs.find((attr) => attr.name === 'href')?.value ?? '';
      if (/^(https?:|mailto:)/i.test(href)) piece = `[${piece.trim()}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    out += piece;
  }
  return out;
}

function hasBlocks(nodes: readonly Node[]): boolean {
  return nodes.some((node) => isElement(node) && BLOCK_TAGS.has(node.tagName));
}

function blocks(nodes: readonly Node[], options: Required<MarkdownOptions>, depth: number): string[] {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const text = inline(run).replace(/[ \t]+\n/g, (match) => (match.startsWith('  ') ? '  \n' : '\n')).trim();
    if (text) out.push(text);
    run = [];
  };
  for (const node of nodes) {
    if (!isElement(node) || !BLOCK_TAGS.has(node.tagName)) { run.push(node); continue; }
    flush();
    const tag = node.tagName;
    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(6, Math.max(options.headingLevel, options.headingLevel + Number(tag[1]) - 1));
      const text = inline(node.childNodes).replace(/\s+/g, ' ').trim();
      if (text) out.push(`${'#'.repeat(level)} ${text}`);
    } else if (tag === 'ul' || tag === 'ol') {
      const items = node.childNodes.filter((child): child is Element => isElement(child) && child.tagName === 'li');
      const lines = items.map((item, index) => {
        const marker = tag === 'ol' ? `${index + 1}.` : '-';
        const body = blocks(item.childNodes, options, depth + 1).join('\n\n');
        return `${marker} ${body.replace(/\n/g, `\n${' '.repeat(marker.length + 1)}`)}`;
      }).filter((line) => line.trim().length > 2);
      if (lines.length) out.push(lines.join('\n'));
    } else if (tag === 'blockquote') {
      const body = blocks(node.childNodes, options, depth + 1).join('\n\n');
      if (body) out.push(body.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n'));
    } else if (tag === 'pre') {
      const text = textContent(node).replace(/\n+$/, '');
      if (text.trim()) out.push(`\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``);
    } else if (tag === 'table') {
      const rows: string[][] = [];
      const collect = (element: Element) => {
        for (const child of element.childNodes) {
          if (!isElement(child)) continue;
          if (child.tagName === 'tr') rows.push(child.childNodes.filter((cell): cell is Element => isElement(cell) && (cell.tagName === 'td' || cell.tagName === 'th')).map((cell) => inline(cell.childNodes).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()));
          else collect(child);
        }
      };
      collect(node);
      const width = Math.max(0, ...rows.map((row) => row.length));
      if (width) {
        const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] || ' ').join(' | ')} |`;
        out.push([line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n'));
      }
    } else if (tag === 'hr') {
      // A rule is decoration.
    } else if (tag === 'li') {
      out.push(`- ${blocks(node.childNodes, options, depth + 1).join(' ')}`);
    } else if (hasBlocks(node.childNodes)) {
      out.push(...blocks(node.childNodes, options, depth + 1));
    } else {
      run = [...node.childNodes];
      flush();
    }
  }
  flush();
  return out;
}

export function textContent(node: Node): string {
  if (!isElement(node)) return node.nodeName === '#text' ? (node as DefaultTreeAdapterMap['textNode']).value : '';
  if (node.tagName === 'br') return '\n';
  return node.childNodes.map(textContent).join('');
}

// HTML (a fragment) → Markdown of the Elabora subset.
export function htmlToMarkdown(html: string, options: MarkdownOptions = {}): string {
  const fragment = parseFragment(String(html ?? ''));
  return blocks(fragment.childNodes, { headingLevel: options.headingLevel ?? 3 }, 0).join('\n\n').trim();
}

// HTML (a fragment) → one line of plain text: titles, labels, option texts.
export function htmlToText(html: string): string {
  const fragment = parseFragment(String(html ?? ''));
  return fragment.childNodes.map(textContent).join(' ').replace(/\s+/g, ' ').trim();
}

// Plain text with line breaks → Markdown paragraphs (Storyline text runs, notes).
export function plainToMarkdown(text: string): string {
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map((paragraph) => escapeText(paragraph.trim()).replace(/\n/g, '  \n')).filter(Boolean).join('\n\n');
}
