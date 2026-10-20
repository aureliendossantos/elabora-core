// A small XML reader for the parts of Office files (docs/decisions.md D49): elements, attributes and
// text, with namespaces resolved, and nothing else. Office parts have no DTD; a DOCTYPE is skipped
// and no entity beyond the five predefined ones and character references is ever expanded, so a
// crafted file cannot make it read anything or grow without bound.
//
// Element names are `<prefix>:<local>` with the prefix Office uses for the namespace (w, a, p, r…),
// whatever prefix the file itself chose: ISO strict files name their namespaces otherwise.

export interface XmlElement {
  readonly name: string; // "w:p", or the file's own name for a namespace this reader does not know
  readonly attributes: Readonly<Record<string, string>>; // "r:embed" etc., with the same prefixes
  readonly children: readonly XmlNode[];
}
export type XmlNode = XmlElement | string;

export class XmlError extends Error {
  readonly code = 'E_SOURCE_XML';
}

// The namespaces Office files use, transitional and strict, by the prefix Office writes.
const NAMESPACES: Record<string, string> = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'rel',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': 'wp',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': 'wp',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://purl.oclc.org/ooxml/drawingml/picture': 'pic',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'http://schemas.microsoft.com/office/word/2010/wordml': 'w14',
  'http://schemas.microsoft.com/office/word/2012/wordml': 'w15',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram': 'dgm',
  'http://schemas.microsoft.com/office/powerpoint/2018/8/main': 'p188',
  'urn:schemas-microsoft-com:vml': 'v',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://purl.oclc.org/ooxml/drawingml/chart': 'c',
  'http://schemas.microsoft.com/office/drawing/2014/chartex': 'cx',
  'http://www.w3.org/XML/1998/namespace': 'xml',
};

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity] ?? match;
  });
}

interface OpenElement {
  rawName: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  scope: Map<string, string>; // prefix → namespace, '' the default one
}

const NAME = /[^\s/>=]+/y;
const SPACE = /\s*/y;

// Parses a whole part into its root element.
export function parseXml(source: string): XmlElement {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const stack: OpenElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const fail = (message: string): never => { throw new XmlError(`Not readable XML (${message} at ${i}).`); };
  const resolve = (rawName: string, scope: Map<string, string>, isAttribute: boolean): string => {
    const colon = rawName.indexOf(':');
    const prefix = colon < 0 ? '' : rawName.slice(0, colon);
    const local = colon < 0 ? rawName : rawName.slice(colon + 1);
    if (prefix === 'xmlns' || (!prefix && local === 'xmlns')) return rawName;
    if (!prefix && isAttribute) return local; // unprefixed attributes have no namespace
    const uri = scope.get(prefix);
    const known = uri !== undefined ? NAMESPACES[uri] : undefined;
    return known ? `${known}:${local}` : rawName;
  };
  const close = (element: OpenElement): void => {
    const scope = element.scope;
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(element.attributes)) if (!name.startsWith('xmlns')) attributes[resolve(name, scope, true)] = value;
    const done: XmlElement = { name: resolve(element.rawName, scope, false), attributes, children: element.children };
    const parent = stack.at(-1);
    if (parent) parent.children.push(done);
    else root ??= done;
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      if (stack.length && i < text.length) stack.at(-1)!.children.push(decode(text.slice(i)));
      break;
    }
    if (lt > i && stack.length) stack.at(-1)!.children.push(decode(text.slice(i, lt)));
    i = lt;
    if (text.startsWith('<!--', i)) { const end = text.indexOf('-->', i + 4); i = end < 0 ? text.length : end + 3; continue; }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) fail('unclosed CDATA');
      if (stack.length) stack.at(-1)!.children.push(text.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) { const end = text.indexOf('?>', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (text.startsWith('<!', i)) {
      // A DOCTYPE, with an internal subset or not: skipped, never read.
      let depth = 0;
      let j = i + 2;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (text[i + 1] === '/') {
      const end = text.indexOf('>', i);
      if (end < 0) fail('unclosed end tag');
      const rawName = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.rawName !== rawName) fail(`</${rawName}> does not close <${open?.rawName ?? ''}>`);
      close(open!);
      i = end + 1;
      continue;
    }
    i++;
    NAME.lastIndex = i;
    const nameMatch = NAME.exec(text);
    if (!nameMatch) fail('element without a name');
    const rawName = nameMatch![0];
    i = NAME.lastIndex;
    const attributes: Record<string, string> = {};
    for (;;) {
      SPACE.lastIndex = i;
      SPACE.exec(text);
      i = SPACE.lastIndex;
      if (i >= text.length) fail('unclosed start tag');
      if (text[i] === '>' || text.startsWith('/>', i)) break;
      NAME.lastIndex = i;
      const attribute = NAME.exec(text);
      if (!attribute) fail('attribute without a name');
      i = NAME.lastIndex;
      SPACE.lastIndex = i;
      SPACE.exec(text);
      i = SPACE.lastIndex;
      if (text[i] !== '=') { attributes[attribute![0]] = ''; continue; }
      i++;
      SPACE.lastIndex = i;
      SPACE.exec(text);
      i = SPACE.lastIndex;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") fail('attribute value without quotes');
      const end = text.indexOf(quote, i + 1);
      if (end < 0) fail('unclosed attribute value');
      attributes[attribute![0]] = decode(text.slice(i + 1, end));
      i = end + 1;
    }
    const parentScope = stack.at(-1)?.scope;
    let scope = parentScope ?? new Map<string, string>();
    for (const [name, value] of Object.entries(attributes)) {
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
      if (scope === parentScope) scope = new Map(scope);
      scope.set(name === 'xmlns' ? '' : name.slice(6), value);
    }
    const element: OpenElement = { rawName, attributes, children: [], scope };
    if (text.startsWith('/>', i)) {
      i += 2;
      close(element);
    } else {
      i += 1;
      stack.push(element);
    }
  }
  if (stack.length) fail(`<${stack.at(-1)!.rawName}> is never closed`);
  if (!root) fail('no element');
  return root!;
}

// Helpers to walk what parseXml gives.
export const isElement = (node: XmlNode): node is XmlElement => typeof node !== 'string';
export const elements = (element: XmlElement, name?: string): XmlElement[] => element.children.filter((child): child is XmlElement => isElement(child) && (name === undefined || child.name === name));
export const child = (element: XmlElement | undefined, name: string): XmlElement | undefined => element?.children.find((node): node is XmlElement => isElement(node) && node.name === name);

// The first element of that name in the tree (depth first), or every one.
export function find(element: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!element) return undefined;
  for (const node of element.children) {
    if (!isElement(node)) continue;
    if (node.name === name) return node;
    const found = find(node, name);
    if (found) return found;
  }
  return undefined;
}

export function findAll(element: XmlElement | undefined, name: string, into: XmlElement[] = []): XmlElement[] {
  if (!element) return into;
  for (const node of element.children) {
    if (!isElement(node)) continue;
    if (node.name === name) into.push(node);
    findAll(node, name, into);
  }
  return into;
}

// Markup compatibility (mc:AlternateContent): the first choice, as an Office reader that knows it
// would show; the fallback repeats the same content in an older form.
export function contentOf(element: XmlElement | readonly XmlNode[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const node of Array.isArray(element) ? element : (element as XmlElement).children) {
    if (isElement(node) && node.name === 'mc:AlternateContent') {
      const choice = child(node, 'mc:Choice') ?? child(node, 'mc:Fallback');
      if (choice) out.push(...contentOf(choice));
    } else out.push(node);
  }
  return out;
}
