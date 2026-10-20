// DOM helpers of the player and its behaviours.

export type Child = Node | string | number | false | null | undefined;

// class, html (HTML rendered by the compiler), text, on<event> listeners, and attributes: true
// gives an empty attribute; false, null and undefined leave it out.
export type AttributeValue = string | number | boolean | null | undefined | EventListener;

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Readonly<Record<string, AttributeValue>> = {}, ...children: (Child | readonly Child[])[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = String(value);
    else if (name === 'html') node.innerHTML = String(value); // compile-time HTML from the Markdown subset (raw HTML disabled)
    else if (name === 'text') node.textContent = String(value);
    else if (name.startsWith('on')) { if (typeof value === 'function') node.addEventListener(name.slice(2), value); }
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

let idCount = 0;
// Ids of the elements the player makes, unique in the page.
export const uniqueId = (prefix: string): string => `${prefix}-${++idCount}`;

// The pieces of a text, its web addresses apart (without the punctuation that ends a sentence).
const ADDRESS = /https:\/\/[^\s()<>]+/g;
export function textAndAddresses(text: string): Array<{ text: string } | { href: string }> {
  const pieces: Array<{ text: string } | { href: string }> = [];
  let last = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const href = match[0].replace(/[.,;:!?»”’]+$/, '');
    if (match.index > last) pieces.push({ text: text.slice(last, match.index) });
    pieces.push({ href });
    last = match.index + href.length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });
  return pieces;
}

// A line of text whose web addresses are links (the credits of CC-BY material name their source and
// licence by address): opened in a new tab, without the module's address as referrer.
export function linkedText(tag: 'p' | 'span', text: string, attributes: Readonly<Record<string, AttributeValue>> = {}): HTMLElement {
  return element(tag, attributes, textAndAddresses(text).map((piece) => 'href' in piece
    ? element('a', { href: piece.href, target: '_blank', rel: 'noopener noreferrer' }, piece.href)
    : piece.text));
}
