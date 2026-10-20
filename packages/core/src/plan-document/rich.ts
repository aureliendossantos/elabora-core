import { parseMarkdown } from '../compile/markdown.ts';
import type { MarkdownToken } from '../compile/markdown.ts';

// The plan's texts (Elabora Markdown: paragraphs, lists, tables, emphasis, links, code, maths) as
// data that any renderer reads without a Markdown parser of its own: the HTML of the PDF, Word's
// runs, the app's view (docs/decisions.md D48). A change since the validated version is the same
// data with its words marked inserted or deleted (D52).

export type Change = 'ins' | 'del';

export interface RichMarks {
  bold?: true;
  italic?: true;
  strike?: true;
  code?: true;
  href?: string;
  change?: Change;
}

export type RichInline =
  | ({ type: 'text'; text: string } & RichMarks)
  | ({ type: 'math'; tex: string } & RichMarks)
  | ({ type: 'break' } & RichMarks);

export type RichBlock = (
  | { type: 'paragraph'; content: RichInline[] }
  | { type: 'heading'; content: RichInline[] }
  | { type: 'list'; ordered: boolean; start?: number; items: RichBlock[][] }
  | { type: 'quote'; blocks: RichBlock[] }
  | { type: 'code'; text: string }
  | { type: 'math'; tex: string }
  | { type: 'table'; header: RichInline[][]; rows: RichInline[][][] }
  | { type: 'rule' }
) & { change?: Change };

// A text of the plan: its source as written, and the same as data.
export interface RichText {
  markdown: string;
  blocks: RichBlock[];
}

export function richText(markdown: string): RichText {
  return { markdown, blocks: parseRich(markdown) };
}

export function parseRich(markdown: string): RichBlock[] {
  const tokens = parseMarkdown(markdown);
  let index = 0;
  const blocksUntil = (close: string | null): RichBlock[] => {
    const blocks: RichBlock[] = [];
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (close && token.type === close) { index++; return blocks; }
      const block = readBlock();
      if (block) blocks.push(block);
    }
    return blocks;
  };
  const readBlock = (): RichBlock | null => {
    const token = tokens[index++]!;
    switch (token.type) {
      case 'paragraph_open': {
        const content = inlineOf(tokens[index]);
        index += 2; // inline, paragraph_close
        return { type: 'paragraph', content };
      }
      case 'heading_open': {
        const content = inlineOf(tokens[index]);
        index += 2;
        return { type: 'heading', content };
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = token.type === 'ordered_list_open';
        const start = Number(token.attrGet('start') ?? 1);
        const close = ordered ? 'ordered_list_close' : 'bullet_list_close';
        const items: RichBlock[][] = [];
        while (index < tokens.length && tokens[index]!.type !== close) {
          if (tokens[index]!.type === 'list_item_open') { index++; items.push(blocksUntil('list_item_close')); } else index++;
        }
        index++;
        return { type: 'list', ordered, ...(ordered && start !== 1 ? { start } : {}), items };
      }
      case 'blockquote_open': return { type: 'quote', blocks: blocksUntil('blockquote_close') };
      case 'fence':
      case 'code_block': return { type: 'code', text: token.content.replace(/\n$/, '') };
      case 'math_block': return { type: 'math', tex: token.content };
      case 'hr': return { type: 'rule' };
      case 'table_open': {
        const header: RichInline[][] = [];
        const rows: RichInline[][][] = [];
        let row: RichInline[][] | null = null;
        let head = false;
        while (index < tokens.length && tokens[index]!.type !== 'table_close') {
          const cell = tokens[index++]!;
          if (cell.type === 'thead_open') head = true;
          else if (cell.type === 'thead_close') head = false;
          else if (cell.type === 'tr_open') row = [];
          else if (cell.type === 'tr_close' && row) { if (head) header.push(...row); else rows.push(row); row = null; }
          else if (cell.type === 'inline' && row) row.push(inlineOf(cell));
        }
        index++;
        return { type: 'table', header, rows };
      }
      default: return null; // closing tokens of what was read above, or nothing to show
    }
  };
  return blocksUntil(null);
}

function inlineOf(token: MarkdownToken | undefined): RichInline[] {
  const out: RichInline[] = [];
  const marks: RichMarks = {};
  const push = (inline: RichInline) => {
    const last = out.at(-1);
    if (inline.type === 'text' && last?.type === 'text' && sameMarks(last, inline)) { last.text += inline.text; return; }
    out.push(inline);
  };
  const text = (value: string) => { if (value) push({ type: 'text', text: value, ...marks }); };
  for (const child of token?.children ?? []) {
    switch (child.type) {
      case 'text': text(child.content); break;
      case 'softbreak': text(' '); break;
      case 'hardbreak': push({ type: 'break', ...marks }); break;
      case 'code_inline': push({ type: 'text', text: child.content, ...marks, code: true }); break;
      case 'strong_open': marks.bold = true; break;
      case 'strong_close': delete marks.bold; break;
      case 'em_open': marks.italic = true; break;
      case 'em_close': delete marks.italic; break;
      case 's_open': marks.strike = true; break;
      case 's_close': delete marks.strike; break;
      case 'link_open': marks.href = String(child.attrGet('href') ?? ''); break;
      case 'link_close': delete marks.href; break;
      case 'math_inline': {
        const meta = (child.meta ?? {}) as { lead?: string; trail?: string };
        text(meta.lead ?? '');
        push({ type: 'math', tex: child.content, ...marks });
        text(meta.trail ?? '');
        break;
      }
      default: if (child.content) text(child.content);
    }
  }
  return out;
}

const MARK_KEYS = ['bold', 'italic', 'strike', 'code', 'href', 'change'] as const;
function sameMarks(a: RichMarks, b: RichMarks): boolean {
  return MARK_KEYS.every((key) => a[key] === b[key]);
}

// The words of a text, as plain text: for a title, a search, a test.
export function plainOf(blocks: readonly RichBlock[]): string {
  const inline = (content: readonly RichInline[]) => content.map((part) => (part.type === 'text' ? part.text : part.type === 'math' ? part.tex : ' ')).join('');
  return blocks.map((block): string => {
    switch (block.type) {
      case 'paragraph': case 'heading': return inline(block.content);
      case 'list': return block.items.map((item) => plainOf(item)).join(' ');
      case 'quote': return plainOf(block.blocks);
      case 'code': return block.text;
      case 'math': return block.tex;
      case 'table': return [...block.header, ...block.rows.flat()].map(inline).join(' ');
      default: return '';
    }
  }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// ── a change, word by word ──────────────────────────────────────────

// Two plain strings (a title, a name) as one run of words marked deleted and inserted.
export function diffPlain(before: string, after: string): RichInline[] {
  const plain = (text: string): RichInline[] => (text ? [{ type: 'text', text }] : []);
  return diffInline(plain(before), plain(after));
}

// A text as it was and as it is now (D52: since the validated version) as one text whose words are
// marked deleted (as it was) or inserted (as it is). Blocks are compared one by one when the two texts have the
// same shape (the same paragraphs, list items and cells); otherwise the whole validated text is
// deleted and the whole new text inserted.
export function diffRich(before: readonly RichBlock[], after: readonly RichBlock[]): RichBlock[] {
  if (sameShape(before, after)) return before.map((block, index) => diffBlock(block, after[index]!));
  return [...before.map((block) => markBlock(block, 'del')), ...after.map((block) => markBlock(block, 'ins'))];
}

function sameShape(a: readonly RichBlock[], b: readonly RichBlock[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((block, index) => {
    const other = b[index]!;
    if (block.type !== other.type) return false;
    if (block.type === 'list' && other.type === 'list') return block.ordered === other.ordered && block.items.length === other.items.length && block.items.every((item, at) => sameShape(item, other.items[at]!));
    if (block.type === 'quote' && other.type === 'quote') return sameShape(block.blocks, other.blocks);
    if (block.type === 'table' && other.type === 'table') return block.header.length === other.header.length && block.rows.length === other.rows.length && block.rows.every((row, at) => row.length === other.rows[at]!.length);
    return true;
  });
}

function diffBlock(before: RichBlock, after: RichBlock): RichBlock {
  switch (before.type) {
    case 'paragraph': case 'heading': return { ...before, content: diffInline(before.content, (after as typeof before).content) };
    case 'list': return { ...before, items: before.items.map((item, index) => diffRich(item, (after as typeof before).items[index]!)) };
    case 'quote': return { ...before, blocks: diffRich(before.blocks, (after as typeof before).blocks) };
    case 'table': {
      const other = after as typeof before;
      return { ...before, header: before.header.map((cell, index) => diffInline(cell, other.header[index] ?? [])), rows: before.rows.map((row, at) => row.map((cell, index) => diffInline(cell, other.rows[at]![index]!))) };
    }
    case 'code': return before.text === (after as typeof before).text ? before : { type: 'paragraph', content: [{ type: 'text', text: before.text, code: true, change: 'del' }, { type: 'text', text: (after as typeof before).text, code: true, change: 'ins' }] };
    case 'math': return before.tex === (after as typeof before).tex ? before : { type: 'paragraph', content: [{ type: 'math', tex: before.tex, change: 'del' }, { type: 'math', tex: (after as typeof before).tex, change: 'ins' }] };
    default: return before;
  }
}

function markBlock(block: RichBlock, change: Change): RichBlock {
  const inline = (content: RichInline[]) => content.map((part) => ({ ...part, change }));
  switch (block.type) {
    case 'paragraph': case 'heading': return { ...block, content: inline(block.content), change };
    case 'list': return { ...block, items: block.items.map((item) => item.map((child) => markBlock(child, change))), change };
    case 'quote': return { ...block, blocks: block.blocks.map((child) => markBlock(child, change)), change };
    case 'table': return { ...block, header: block.header.map(inline), rows: block.rows.map((row) => row.map(inline)), change };
    default: return { ...block, change };
  }
}

// Words with the spaces after them, each with its marks; maths and line breaks are one token. A
// change then reads as one span (« ~~de leur apparition~~ du premier symptôme »), not as words
// changed between kept spaces.
function tokens(content: readonly RichInline[]): RichInline[] {
  const out: RichInline[] = [];
  for (const part of content) {
    if (part.type !== 'text') { out.push(part); continue; }
    for (const piece of part.text.split(/(\S+\s*)/)) if (piece) out.push({ ...part, text: piece });
  }
  return out;
}

const tokenKey = (token: RichInline): string => JSON.stringify(token.type === 'text' ? { ...token, text: token.text.replace(/\s+/g, ' ') } : token);

function diffInline(before: readonly RichInline[], after: readonly RichInline[]): RichInline[] {
  const a = tokens(before);
  const b = tokens(after);
  const keysA = a.map(tokenKey);
  const keysB = b.map(tokenKey);
  // Longest common subsequence of tokens (a plan's texts are short).
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lengths[i]![j] = keysA[i] === keysB[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const marked: RichInline[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (keysA[i] === keysB[j]) { marked.push(b[j]!); i++; j++; }
    else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) marked.push({ ...a[i++]!, change: 'del' });
    else marked.push({ ...b[j++]!, change: 'ins' });
  }
  while (i < a.length) marked.push({ ...a[i++]!, change: 'del' });
  while (j < b.length) marked.push({ ...b[j++]!, change: 'ins' });
  return merge(absorbIslands(marked));
}

// One short word kept between two changes (« même ~~si vous pensez connaître~~ quand la ~~cause.~~
// cause vous paraît évidente. ») belongs to the rewording: it is deleted and inserted with it, so
// that the change reads as one phrase replaced by another.
function absorbIslands(parts: RichInline[]): RichInline[] {
  const out: RichInline[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const before = parts[index - 1];
    const after = parts[index + 1];
    const island = !part.change && part.type === 'text' && part.text.trim().length > 0 && part.text.trim().length <= 3 && !/\s\S/.test(part.text.trim());
    if (island && before?.change && after?.change) {
      // The kept word goes into the deletion before it and the insertion after it.
      const deletion = out.findLastIndex((entry) => entry.change === 'del');
      const insertion = parts.slice(index + 1).findIndex((entry) => entry.change === 'ins');
      if (deletion >= 0 && insertion >= 0) {
        out.splice(deletion + 1, 0, { ...part, change: 'del' });
        out.push({ ...part, change: 'ins' });
        continue;
      }
    }
    out.push(part);
  }
  // Deletions first, then insertions, within each run of changes.
  const ordered: RichInline[] = [];
  let run: RichInline[] = [];
  const flush = () => { ordered.push(...run.filter((entry) => entry.change === 'del'), ...run.filter((entry) => entry.change === 'ins')); run = []; };
  for (const part of out) {
    if (part.change) run.push(part);
    else { flush(); ordered.push(part); }
  }
  flush();
  return ordered;
}

function merge(parts: RichInline[]): RichInline[] {
  const out: RichInline[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (part.type === 'text' && last?.type === 'text' && sameMarks(last, part)) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}
