// A small XML reader for the files importers meet (a Storyline source's XML, SCORM manifests,
// Storyline's meta.xml): elements, attributes, text and CDATA, entities. No DTD, no namespaces
// resolved (a prefixed name stays as written: `xml:lang`), no validation. It never throws on
// what it cannot read: an unclosed element ends at the end of the text.

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string; // the element's own text and CDATA, its children's left out
  nodes: (XmlElement | string)[]; // children and text in document order
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function parseXml(source: string): XmlElement | null {
  const text = source.replace(/^﻿/, '');
  const root: XmlElement = { name: '#document', attributes: {}, children: [], text: '', nodes: [] };
  const addText = (value: string) => { if (!value) return; top().text += value; top().nodes.push(value); };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  let position = 0;
  while (position < text.length) {
    const open = text.indexOf('<', position);
    if (open < 0) { addText(decodeEntities(text.slice(position))); break; }
    if (open > position) addText(decodeEntities(text.slice(position, open)));
    if (text.startsWith('<!--', open)) { const end = text.indexOf('-->', open); position = end < 0 ? text.length : end + 3; continue; }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open);
      addText(text.slice(open + 9, end < 0 ? text.length : end));
      position = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', open) || text.startsWith('<!', open)) { const end = text.indexOf('>', open); position = end < 0 ? text.length : end + 1; continue; }
    const close = findTagEnd(text, open);
    const tag = text.slice(open + 1, close);
    position = close + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      // Close up to the matching element; a stray closing tag is ignored.
      const index = stack.map((element) => element.name).lastIndexOf(name);
      if (index > 0) stack.length = index;
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) continue;
    const element: XmlElement = { name: nameMatch[1], attributes: {}, children: [], text: '', nodes: [] };
    for (const match of body.slice(nameMatch[0].length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      element.attributes[match[1]] = decodeEntities(match[3] ?? match[4] ?? '');
    }
    top().children.push(element);
    top().nodes.push(element);
    if (!selfClosing) stack.push(element);
  }
  return root.children[0] ?? null;
}

// The end of a tag: its `>` outside quoted attribute values.
function findTagEnd(text: string, open: number): number {
  let quote = '';
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return text.length;
}

// Helpers that read a tree the way importers do: by local name (without a prefix), case-insensitively.
const local = (name: string) => name.replace(/^.*:/, '').toLowerCase();

export function childrenNamed(element: XmlElement | null | undefined, name: string): XmlElement[] {
  const wanted = name.toLowerCase();
  return element ? element.children.filter((child) => local(child.name) === wanted) : [];
}

export function childNamed(element: XmlElement | null | undefined, name: string): XmlElement | null {
  return childrenNamed(element, name)[0] ?? null;
}

// Every descendant with that local name, in document order.
export function descendantsNamed(element: XmlElement | null | undefined, name: string): XmlElement[] {
  const wanted = name.toLowerCase();
  const out: XmlElement[] = [];
  const walk = (node: XmlElement) => {
    for (const child of node.children) {
      if (local(child.name) === wanted) out.push(child);
      walk(child);
    }
  };
  if (element) walk(element);
  return out;
}

export function attribute(element: XmlElement | null | undefined, name: string): string | undefined {
  if (!element) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(element.attributes)) if (local(key) === wanted) return value;
  return undefined;
}

// All the text inside an element, its children's included.
export function deepText(element: XmlElement | null | undefined): string {
  if (!element) return '';
  return element.nodes.map((node) => (typeof node === 'string' ? node : deepText(node))).join('');
}
