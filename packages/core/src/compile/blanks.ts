import { replaceBlanks } from '@elabora/player/fill-in';

// A fill-in's blanks in its rendered text (D63): before its template renders, each [[…]] of its
// Markdown becomes a marker of private-use characters, which Markdown and the template carry as they
// are; after, each marker becomes <span class="t-blank" data-t-blank="n">, the hook where the player
// builds the blank's field. The answers never reach the text. In an attribute (a fork binding the
// text as plain text), a blank reads as an ellipsis.

const OPEN = '\uE000';
const CLOSE = '\uE001';
const MARKER = /\uE000(\d+)\uE001/g;
// The punctuation that touches a blank stays on its line with it: « [[mot]] », [[mot]].
const ATTACHED = /([«“‘(\[¿¡]?)\uE000(\d+)\uE001([.,;:!?»”’)\]…]*)/g;

export const markBlanks = (markdown: unknown): string => replaceBlanks(markdown, (index) => `${OPEN}${index + 1}${CLOSE}`);

export function placeBlanks(html: string): string {
  return html
    .replace(/<[^>]*>/g, (tag) => tag.replace(MARKER, '…'))
    .replace(ATTACHED, (_, before: string, number: string, after: string) => {
      const blank = `<span class="t-blank" data-t-blank="${number}"></span>`;
      return before || after ? `<span class="t-nobr">${before}${blank}${after}</span>` : blank;
    });
}
