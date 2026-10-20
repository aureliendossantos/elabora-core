// Markdown pieces shared by the readers of sources (docs/decisions.md D49).

// A link to a part of a readable version, relative to the Markdown file (both in sources/): angle
// brackets when the path has spaces or parentheses, as CommonMark allows.
export function partLink(partsFolder: string, part: string): string {
  const target = `${partsFolder}/${part}`;
  return /[\s()<>]/.test(target) ? `<${target.replace(/[<>]/g, '')}>` : target;
}

// Blocks one after the other: a list's items on consecutive lines, anything else apart.
export function joinBlocks(blocks: readonly string[]): string {
  const item = /^\s*(?:[-*+]|\d+\.)\s/;
  return blocks.map((block, i) => (i === 0 ? block : `${item.test(block) && item.test(blocks[i - 1].split('\n').at(-1) ?? '') ? '\n' : '\n\n'}${block}`)).join('');
}

export const image = (alt: string, link: string): string => `![${alt.replace(/[[\]\n]/g, ' ').trim()}](${link})`;

// A table: the first row is the header; cells on one line, pipes escaped.
export function table(rows: readonly (readonly string[])[]): string {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const cell = (value: string | undefined) => (value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' <br> ').trim();
  const line = (row: readonly string[]) => `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

// Text that starts a line and would read as Markdown structure (a heading, a list, a quote) keeps
// its meaning as text.
export function escapeLineStart(text: string): string {
  return text.replace(/^(\s*)(#{1,6}\s|[-*+]\s|>\s?|\d+[.)]\s)/, (_, space: string, mark: string) => `${space}\\${mark}`);
}

export function seconds(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function duration(total: number): string {
  const s = Math.round(total);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(s % 60).padStart(2, '0')} s`;
}
