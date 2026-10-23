import { parseCss, type CssBlockNode, type CssNode } from '../project/css-tree.ts';

// An SVG file put in the page instead of an <img> (image block `inline: true`): the timeline's
// `draw` effect, the theme's CSS and currentColor then reach its shapes. The file is the course's
// own (assets/, generators/), but it lands in the learner's page, so it is read as XML and written
// again from an allowlist: SVG elements that draw (no script, no foreignObject, no links), no event
// handlers, no reference out of the drawing (only #fragments and data: images), its ids prefixed
// with the block's so that two drawings never share one, and its own <style> scoped to it. It is
// named as the <img> was: role="img" and aria-label from the block's alt, or hidden from screen
// readers when decorative.

export interface InlineSvg {
  html: string;
  // What was left out, in words (the validator reports it: W_SVG_INLINE_SANITIZED).
  removed: string[];
}

export interface InlineSvgOptions {
  prefix: string; // ids become <prefix>-<id>; the drawing is svg[data-t-svg="<prefix>"]
  label?: string; // the accessible name (the block's alt)
  decorative?: boolean;
  className?: string; // classes of the <img> it replaces
  // A figure (t-figure-svg: an image block's drawing) or a dialogue's character (t-character:
  // docs/dialogues.md, characters).
  kind?: 'figure' | 'character';
}

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'text', 'tspan', 'textPath', 'title', 'desc',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker', 'image', 'switch', 'style', 'view',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight',
  'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
  'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence', 'animate', 'animateTransform', 'animateMotion', 'mpath', 'set'
]);
// Kept for their content only: a link's drawing stays, the link goes.
const UNWRAPPED = new Set(['a']);
// Dropped silently: they draw nothing.
const QUIET = new Set(['metadata', 'sodipodi:namedview', 'inkscape:perspective']);
const VOID_IN_HTML = new Set<string>(); // SVG elements are all written with an end tag
const SAFE_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const REFERENCES = new Set(['href', 'xlink:href']);
const ID_LISTS = new Set(['aria-labelledby', 'aria-describedby']);

interface Tag { name: string; attributes: [string, string][]; selfClosing: boolean }

export function inlineSvg(source: string, { prefix, label, decorative = false, className, kind = 'figure' }: InlineSvgOptions): InlineSvg {
  const removed = new Set<string>();
  // Every id the drawing names is prefixed, its own and those it does not have (a reference to an id
  // of the page then points at nothing).
  const renameId = (id: string) => `${prefix}-${id}`;
  const fixUrls = (value: string) => value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (_m, _q, id: string) => `url(#${renameId(id)})`);
  const out: string[] = [];
  // Open elements: name, and whether it is written (dropped ones swallow their content).
  const stack: { name: string; written: boolean; style: boolean }[] = [];
  const dropping = () => stack.some((entry) => !entry.written && !UNWRAPPED.has(entry.name));
  let root = true;
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    const text = source.slice(i, lt < 0 ? source.length : lt);
    if (text && !dropping() && !root) {
      const inStyle = stack.at(-1)?.style;
      out.push(inStyle ? escapeStyleText(scopeStyle(decodeEntities(text), prefix, renameId, removed)) : text.replace(/&(?!#?\w+;)/g, '&amp;'));
    }
    if (lt < 0) break;
    if (source.startsWith('<!--', lt)) { const end = source.indexOf('-->', lt + 4); i = end < 0 ? source.length : end + 3; continue; }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const data = source.slice(lt + 9, end < 0 ? source.length : end);
      if (!dropping() && stack.at(-1)?.style) out.push(escapeStyleText(scopeStyle(data, prefix, renameId, removed)));
      else if (!dropping() && !root) out.push(escapeText(data));
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) { const end = source.indexOf('?>', lt + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (source.startsWith('<!', lt)) { i = skipDeclaration(source, lt); continue; }
    if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt);
      const name = source.slice(lt + 2, end < 0 ? source.length : end).trim();
      i = end < 0 ? source.length : end + 1;
      const at = stack.map((entry) => entry.name).lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) {
        const entry = stack.pop()!;
        if (entry.written && !dropping()) out.push(`</${entry.name}>`);
      }
      continue;
    }
    const parsed = readTag(source, lt);
    if (!parsed) { i = lt + 1; if (!dropping() && !root) out.push('&lt;'); continue; }
    i = parsed.end;
    const tag = parsed.tag;
    if (root) {
      if (tag.name !== 'svg') return { html: '', removed: [`<${tag.name}> as the root (not an SVG)`] };
      root = false;
      out.push(`<svg${rootAttributes(tag, { prefix, label, decorative, className, kind }, fixUrls, removed)}>`);
      stack.push({ name: 'svg', written: true, style: false });
      if (tag.selfClosing) { stack.pop(); out.push('</svg>'); }
      continue;
    }
    const allowed = ELEMENTS.has(tag.name) && !(tag.name === 'title' && stack.length === 1);
    if (!dropping() && !allowed && !UNWRAPPED.has(tag.name) && !QUIET.has(tag.name) && !(tag.name === 'title' && stack.length === 1)) removed.add(`<${tag.name}>`);
    if (!dropping() && UNWRAPPED.has(tag.name)) removed.add(`<${tag.name}> (its content kept)`);
    const write = allowed && !dropping();
    if (write) out.push(`<${tag.name}${attributes(tag, renameId, fixUrls, removed)}>`);
    if (tag.selfClosing || VOID_IN_HTML.has(tag.name)) { if (write) out.push(`</${tag.name}>`); continue; }
    stack.push({ name: tag.name, written: allowed, style: tag.name === 'style' });
    // A <style>'s content is text up to </style>, whatever it holds (a « < » in a comment or a string
    // is no tag): XML comments and CDATA sections in it are read as XML would.
    if (tag.name === 'style') {
      const css = readStyleText(source, i);
      i = css.end;
      if (write) out.push(escapeStyleText(scopeStyle(css.text, prefix, renameId, removed)));
    }
  }
  while (stack.length) { const entry = stack.pop()!; if (entry.written && !dropping()) out.push(`</${entry.name}>`); }
  return { html: out.join('').trim(), removed: [...removed] };
}

// The text of a <style> from its content's start to its end tag (not included): XML comments left
// out, CDATA sections as they are, character references decoded outside them.
function readStyleText(source: string, from: number): { text: string; end: number } {
  let text = '';
  let i = from;
  while (i < source.length) {
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      text += source.slice(i + 9, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!--', i)) { const end = source.indexOf('-->', i + 4); i = end < 0 ? source.length : end + 3; continue; }
    if (/^<\/style\s*>/i.test(source.slice(i, i + 16))) return { text, end: i };
    const next = source.slice(i).search(/<!\[CDATA\[|<!--|<\/style\s*>/i);
    const stop = next < 0 ? source.length : i + Math.max(next, 1);
    text += decodeEntities(source.slice(i, stop));
    i = stop;
  }
  return { text, end: source.length };
}

function readTag(source: string, lt: number): { tag: Tag; end: number } | null {
  const name = /^<([A-Za-z][\w:.-]*)/.exec(source.slice(lt, lt + 200))?.[1];
  if (!name) return null;
  const attributes: [string, string][] = [];
  let i = lt + 1 + name.length;
  for (;;) {
    while (/\s/.test(source[i] ?? '')) i++;
    if (i >= source.length) return null;
    if (source[i] === '>') return { tag: { name, attributes, selfClosing: false }, end: i + 1 };
    if (source.startsWith('/>', i)) return { tag: { name, attributes, selfClosing: true }, end: i + 2 };
    const attribute = /^([^\s=/>]+)\s*(=\s*("[^"]*"|'[^']*'|[^\s>]+))?/.exec(source.slice(i));
    if (!attribute) return null;
    const raw = attribute[3] ?? '';
    attributes.push([attribute[1], /^["']/.test(raw) ? raw.slice(1, -1) : raw]);
    i += attribute[0].length;
  }
}

// <!DOCTYPE …> with an internal subset in brackets.
function skipDeclaration(source: string, lt: number): number {
  let depth = 0;
  for (let i = lt + 2; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') depth--;
    else if (source[i] === '>' && depth <= 0) return i + 1;
  }
  return source.length;
}

function attributes(tag: Tag, renameId: (id: string) => string, fixUrls: (value: string) => string, removed: Set<string>): string {
  let written = '';
  for (const [name, raw] of tag.attributes) {
    const lower = name.toLowerCase();
    let value = decodeEntities(raw);
    if (lower.startsWith('on')) { removed.add('event handlers'); continue; }
    if (lower.startsWith('xmlns') || /^(sodipodi|inkscape):/.test(lower)) continue;
    if (!/^[a-zA-Z_:][\w:.-]*$/.test(name)) continue;
    if (REFERENCES.has(lower)) {
      if (value.startsWith('#')) value = `#${renameId(value.slice(1))}`;
      else if (!(tag.name === 'image' && SAFE_DATA.test(value))) { removed.add(`a reference out of the drawing (${value.slice(0, 40)})`); continue; }
    } else if (lower === 'id') value = renameId(value);
    else if (ID_LISTS.has(lower)) value = value.split(/\s+/).map(renameId).join(' ');
    else if ((lower === 'begin' || lower === 'end') && /(^|;\s*)[A-Za-z_][\w-]*\./.test(value)) value = value.replace(/(^|;\s*)([A-Za-z_][\w-]*)\./g, (_m, before: string, id: string) => `${before}${renameId(id)}.`);
    else if (lower === 'attributename' && /href/i.test(value)) { removed.add('an animation of a link'); return ' data-t-removed=""'; }
    if (/javascript:|expression\s*\(|@import/i.test(value)) { removed.add(`an unsafe ${name}`); continue; }
    if (lower === 'style' && unsafeCss(value)) { removed.add(`${unsafeCss(value)} in a style attribute`); continue; }
    if (/url\(/i.test(value)) {
      value = fixUrls(value);
      if (/url\(\s*['"]?(?!#|data:image\/)/i.test(value)) { removed.add(`a reference out of the drawing in ${name}`); continue; }
    }
    written += ` ${name}="${escapeAttribute(value)}"`;
  }
  return written;
}

function rootAttributes(tag: Tag, { prefix, label, decorative, className, kind }: InlineSvgOptions, fixUrls: (value: string) => string, removed: Set<string>): string {
  const kept: [string, string][] = [];
  const has = (name: string) => tag.attributes.some(([key]) => key === name);
  for (const [name, raw] of tag.attributes) {
    if (['class', 'role', 'aria-label', 'aria-hidden', 'aria-labelledby', 'focusable', 'data-t-svg', 'x', 'y'].includes(name)) continue;
    kept.push([name, raw]);
  }
  // Without a viewBox, its width and height give one, so that it scales as the <img> did.
  const width = parseFloat(tag.attributes.find(([key]) => key === 'width')?.[1] ?? '');
  const height = parseFloat(tag.attributes.find(([key]) => key === 'height')?.[1] ?? '');
  if (!has('viewBox') && width > 0 && height > 0) kept.push(['viewBox', `0 0 ${width} ${height}`]);
  const own = tag.attributes.find(([key]) => key === 'class')?.[1];
  const classes = [kind === 'character' ? 't-character' : 't-figure-svg', ...(className ? className.split(/\s+/) : []), ...(own ? own.split(/\s+/) : [])].filter(Boolean);
  const a11y: [string, string][] = decorative || !label ? [['aria-hidden', 'true']] : [['role', 'img'], ['aria-label', label]];
  return `${attributes({ name: 'svg', attributes: kept, selfClosing: false }, (id) => id, fixUrls, removed)} class="${escapeAttribute([...new Set(classes)].join(' '))}" data-t-svg="${escapeAttribute(prefix)}"${a11y.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')} focusable="false"`;
}

// The drawing's own stylesheet, scoped to it: selectors under svg[data-t-svg="<prefix>"], ids
// renamed, @keyframes prefixed (and the animations that name them), nothing that loads or imports.
function scopeStyle(css: string, prefix: string, renameId: (id: string) => string, removed: Set<string>): string {
  const scope = `svg[data-t-svg="${prefix}"]`;
  const tree = parseCss(css);
  const keyframes = new Set<string>();
  const collect = (nodes: readonly CssNode[]) => { for (const node of nodes) if (node.kind !== 'declaration') { if (/keyframes$/.test(node.name)) keyframes.add(node.prelude.replace(/^@[\w-]+\s+/, '').trim()); collect(node.children); } };
  collect(tree);
  const renameFrames = (text: string) => text.replace(/[\w-]+/g, (word) => (keyframes.has(word) ? `${prefix}-${word}` : word));
  const write = (nodes: readonly CssNode[], nested: boolean): string => nodes.map((node) => {
    if (node.kind === 'declaration') {
      const unsafe = unsafeCss(node.text);
      if (unsafe) { removed.add(`${unsafe} in its <style>`); return ''; }
      let text = node.text.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (_m, _q, id: string) => `url(#${renameId(id)})`);
      if (/^(-webkit-)?animation(-name)?$/.test(node.property)) text = `${node.property}:${renameFrames(text.slice(text.indexOf(':') + 1))}`;
      return `${text};`;
    }
    const block = node as CssBlockNode;
    if (block.kind === 'at-rule') {
      if (['import', 'font-face', 'namespace', 'charset'].includes(block.name)) { if (block.name !== 'charset') removed.add(`@${block.name} in its <style>`); return ''; }
      // A registered property is the page's, not the drawing's: two drawings that register one each
      // would fight over it.
      if (block.name === 'property') { removed.add('@property in its <style> (registered properties belong to the whole page)'); return ''; }
      if (/keyframes$/.test(block.name)) return `@${block.name} ${prefix}-${block.prelude.replace(/^@[\w-]+\s+/, '').trim()}{${write(parseCss(css.slice(block.bodyStart, block.bodyEnd)), true)}}`; // opaque to the reader: read on its own
      // A statement (« @layer base; ») would order the page's own cascade.
      if (!block.block) { removed.add(`@${block.name} without a block in its <style>`); return ''; }
      return `${block.prelude}{${write(block.children, nested)}}`;
    }
    const selector = nested ? block.prelude : scopeSelector(block.prelude, scope, renameId);
    if (!selector) { removed.add('a selector reaching out of the drawing in its <style>'); return ''; }
    return `${selector}{${write(block.children, true)}}`;
  }).join('');
  return write(tree, false);
}

// Under the drawing's root; a selector that would reach the page beside it (the root's siblings,
// « svg ~ p », « + p ») is left out (an empty string when none is left). The list is cut on its own
// commas only (not those of :is(), :where(), :not(), :has() nor of a string), and ids are renamed in
// id selectors only (not a « # » in an attribute's value).
function scopeSelector(list: string, scope: string, renameId: (id: string) => string): string {
  return splitTopLevel(list).map((part) => {
    const selector = renameIdSelectors(part.trim(), renameId);
    const scoped = /^(svg|:root)\b/.test(selector) ? selector.replace(/^(svg|:root)/, scope) : `${scope} ${selector}`;
    return scoped.slice(scope.length).trimStart().startsWith('~') || scoped.slice(scope.length).trimStart().startsWith('+') ? '' : scoped;
  }).filter(Boolean).join(',');
}

// A selector list cut on the commas outside parentheses, brackets and strings.
export function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
  }
  parts.push(list.slice(start));
  return parts;
}

// « #id » renamed where it is an id selector: outside attribute selectors and strings.
function renameIdSelectors(selector: string, renameId: (id: string) => string): string {
  let out = '';
  let brackets = 0;
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (quote) { out += ch; if (ch === '\\') { out += selector[i + 1] ?? ''; i++; } else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets = Math.max(0, brackets - 1);
    else if (ch === '#' && brackets === 0) {
      const id = /^[\w-]+/.exec(selector.slice(i + 1))?.[0];
      if (id) { out += `#${renameId(id)}`; i += id.length; continue; }
    }
    out += ch;
  }
  return out;
}

// What makes a declaration unsafe in the page, in words, or null: anything that loads (a url() out of
// the drawing, image-set(), src()), a CSS escape (« u\72l( » is url(), so none is kept), script
// (expression(), javascript:), and a drawing fixed over the page.
function unsafeCss(text: string): string | null {
  if (/\\/.test(text)) return 'a CSS escape';
  if (/url\(\s*['"]?(?!#|data:image\/(png|jpe?g|gif|webp);)/i.test(text) || /image-set\s*\(|(^|[^\w-])src\s*\(|@import/i.test(text)) return 'a reference out of the drawing';
  if (/expression\s*\(|javascript:/i.test(text)) return 'script';
  if (/position\s*:\s*(fixed|sticky)/i.test(text)) return 'a drawing fixed over the page';
  return null;
}

const escapeAttribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// An SVG's <style> in an HTML page is foreign content: its text is markup (a « <img » in it would be an
// element) and character references are decoded. So < is written as a CSS escape, and & too where it
// would start a character reference (CSS nesting's « & .x », « &:hover » are kept); > stays (a
// child combinator).
const escapeStyleText = (value: string): string => value.replace(/</g, '\\3c ').replace(/&(?=[#a-zA-Z])/g, '\\26 ');
const decodeEntities = (value: string): string => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, entity: string) => {
  const lower = entity.toLowerCase();
  if (lower === 'amp') return '&';
  if (lower === 'lt') return '<';
  if (lower === 'gt') return '>';
  if (lower === 'quot') return '"';
  if (lower === 'apos') return "'";
  return String.fromCodePoint(lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10));
});

// The <img> of an image block's template whose src is the asset, replaced by the drawing (its alt
// as the name, its classes kept); kept when the file is not an SVG drawing.
export function replaceImage(html: string, src: string, svg: (found: { img: string; alt: string | null; className: string | null }) => string): string {
  const escaped = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`<img\\b[^>]*\\bsrc="${escaped}"[^>]*>`, 'g'), (img) => {
    const attribute = (name: string) => { const found = new RegExp(`\\s${name}="([^"]*)"`).exec(img); return found ? decodeEntities(found[1]) : null; };
    return svg({ img, alt: attribute('alt'), className: attribute('class') });
  });
}
