import { contrastRatio } from '../validate/theme.ts';

// Whether an SVG logo reads on its bar (docs/decisions.md D58, W_PLAYER_LOGO_CONTRAST): the colours
// its painted shapes show (paths, rectangles, circles, ellipses, polygons, lines, text), each
// against the bar's background; the logo reads when one of them stands out. A logo is exempt from
// WCAG's contrast criteria, but a dark logo on a dark bar is a common slip.
// Only what is painted counts: what <defs>, clip paths, masks, patterns, symbols, markers and
// gradients hold is not, and neither is a hidden shape (display, visibility, opacity 0). Fill and
// stroke are inherited, from presentation attributes (either quote), <style> rules with simple
// selectors (a type, classes, an id) and style attributes, in CSS's order; black when nothing says
// a fill, as SVG paints; currentColor is the SVG's own color property, black unless it says
// another (the player shows the logo as an image: the page's colours do not reach it).
// When unsure, it says nothing (null): an embedded image, <use>, a foreign object, a gradient or
// pattern paint, a colour it cannot read, transparency between 0 and 1, a filter, mask or blend on
// something painted, a style rule it cannot match, an animation, a file over 2 MB.
// Raster logos (PNG, JPEG, WebP) are not measured: their pixels would need a decoder.

const MAX_LENGTH = 2_000_000;
const MAX_TAGS = 100_000;

// CSS Color 4's named colours.
const NAMED: ReadonlyMap<string, string> = new Map(('aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 ' +
  'blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 ' +
  'cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 ' +
  'darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a ' +
  'darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 ' +
  'deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff ' +
  'gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 ' +
  'hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 ' +
  'lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 ' +
  'lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 ' +
  'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa ' +
  'mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a ' +
  'mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead ' +
  'navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 ' +
  'paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 ' +
  'purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 ' +
  'seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa ' +
  'springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 ' +
  'white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32').split(' ').flatMap((word, index, words) => (index % 2 ? [] : [[word, `#${words[index + 1].toUpperCase()}`] as const])));

// What paints (the shapes and text), what holds them, and what makes the logo unsure. Any other
// element, <defs>, <clipPath>, <mask>, <pattern>, <symbol> and the gradients among them, is not
// rendered where it stands (SVG names are case-sensitive).
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
const TEXTS = new Set(['text', 'tspan', 'textPath']);
const CONTAINERS = new Set(['svg', 'g', 'a']);
const UNSURE = new Set(['image', 'use', 'foreignObject', 'switch', 'animate', 'set', 'animateColor', 'tref', 'video', 'audio', 'iframe', 'canvas']);
// The properties read, as attributes or CSS.
const PROPERTIES = new Set(['fill', 'stroke', 'color', 'opacity', 'fill-opacity', 'stroke-opacity', 'display', 'visibility', 'stroke-width', 'filter', 'mask', 'mix-blend-mode', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'd', 'width', 'height', 'r', 'rx', 'ry', 'points']);

class Unsure extends Error {}
const unsure = (): never => { throw new Unsure(); };

interface Colour { hex: string; alpha: number }
type Paint = { kind: 'none' } | { kind: 'current' } | { kind: 'colour'; colour: Colour };

const hex2 = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
const channel = (part: string) => (part.endsWith('%') ? (Number(part.slice(0, -1)) / 100) * 255 : Number(part));
const fraction = (part: string | undefined) => (part === undefined ? 1 : part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part));

// A colour, 'none' (none, transparent), or null when it cannot be read.
export function colourOf(value: string): Colour | 'none' | null {
  const text = value.trim().toLowerCase();
  if (text === 'none' || text === 'transparent') return 'none';
  const named = NAMED.get(text);
  if (named) return { hex: named, alpha: 1 };
  let match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (match) {
    const digits = match[1].length <= 4 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
    return { hex: `#${digits.slice(0, 6)}`.toUpperCase(), alpha: digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1 };
  }
  match = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(text);
  if (!match) return null;
  const parts = match[2].replace(/\s*\/\s*/, ',').split(/\s*,\s*|\s+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const alpha = fraction(parts[3]);
  let rgb: number[];
  if (match[1].startsWith('rgb')) rgb = parts.slice(0, 3).map(channel);
  else {
    const hue = ((Number(parts[0].replace(/deg$/, '')) % 360) + 360) % 360;
    const [s, l] = [fraction(parts[1]), fraction(parts[2])];
    if (!parts[1].endsWith('%') || !parts[2].endsWith('%')) return null;
    const k = (n: number) => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    rgb = [0, 8, 4].map((n) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  }
  if (![...rgb, alpha].every(Number.isFinite)) return null;
  return { hex: `#${rgb.map(hex2).join('')}`.toUpperCase(), alpha: Math.min(1, Math.max(0, alpha)) };
}

// A fill or stroke: null to inherit.
function paintOf(value: string, initial: Paint): Paint | null {
  const text = value.trim().toLowerCase();
  if (text === 'inherit' || text === 'unset') return null;
  if (text === 'initial') return initial;
  if (text === 'currentcolor') return { kind: 'current' };
  const colour = colourOf(text);
  if (colour === 'none') return { kind: 'none' };
  return colour ? { kind: 'colour', colour } : unsure();
}

// --- Reading the file: tags, character data, comments; linear, never throwing beyond Unsure.

interface Tag { kind: 'open' | 'close'; name: string; attributes: Map<string, string>; selfClosing: boolean }
type Token = Tag | { kind: 'text'; text: string };

function tokens(svg: string): Token[] {
  const out: Token[] = [];
  const n = svg.length;
  let i = 0;
  while (i < n) {
    if (out.length > MAX_TAGS) unsure();
    const lt = svg.indexOf('<', i);
    if (lt < 0) { out.push({ kind: 'text', text: svg.slice(i) }); break; }
    if (lt > i) out.push({ kind: 'text', text: svg.slice(i, lt) });
    if (svg.startsWith('<!--', lt)) {
      const end = svg.indexOf('-->', lt + 4);
      if (end < 0) unsure();
      i = end + 3;
    } else if (svg.startsWith('<![CDATA[', lt)) {
      const end = svg.indexOf(']]>', lt + 9);
      if (end < 0) unsure();
      out.push({ kind: 'text', text: svg.slice(lt + 9, end) });
      i = end + 3;
    } else if (svg[lt + 1] === '?') {
      const end = svg.indexOf('?>', lt + 2);
      if (end < 0) unsure();
      i = end + 2;
    } else if (svg[lt + 1] === '!') {
      // <!DOCTYPE …>, with its internal subset in brackets.
      const close = svg.indexOf('>', lt);
      if (close < 0) unsure();
      const bracket = svg.indexOf('[', lt);
      const subset = bracket >= 0 && bracket < close ? svg.indexOf(']', bracket) : -1;
      if (bracket >= 0 && bracket < close && subset < 0) unsure();
      const end = subset >= 0 ? svg.indexOf('>', subset) : close;
      if (end < 0) unsure();
      i = end + 1;
    } else {
      let j = lt + 1;
      let quote = '';
      for (; j < n; j++) {
        const c = svg[j];
        if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === '\'') quote = c; else if (c === '>') break;
      }
      if (j >= n) unsure();
      out.push(tagOf(svg.slice(lt + 1, j)));
      i = j + 1;
    }
  }
  return out;
}

function tagOf(inside: string): Tag {
  const close = inside.startsWith('/');
  const body = close ? inside.slice(1) : inside;
  const name = /^[A-Za-z_][\w:.-]*/.exec(body)?.[0] ?? unsure();
  const selfClosing = !close && /\/\s*$/.test(body);
  const attributes = new Map<string, string>();
  for (const match of body.slice(name.length).matchAll(/([^\s=/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g)) {
    attributes.set(match[1], match[2] ?? match[3] ?? match[4] ?? '');
  }
  return { kind: close ? 'close' : 'open', name: name.replace(/^svg:/, ''), attributes, selfClosing };
}

// --- Style sheets: simple selectors only; a rule it cannot match that sets a property read is unsure.

interface Rule { tag: string | null; classes: string[]; id: string | null; specificity: number; order: number; declarations: Map<string, string> }

function withoutComments(css: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = css.indexOf('/*', i);
    if (start < 0) return out + css.slice(i);
    out += css.slice(i, start);
    const end = css.indexOf('*/', start + 2);
    if (end < 0) return out;
    i = end + 2;
  }
}

function declarationsOf(text: string, inStyleAttribute: boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    if (!PROPERTIES.has(property)) continue;
    let value = part.slice(colon + 1).trim();
    if (/!\s*important$/i.test(value)) {
      if (!inStyleAttribute) unsure();
      value = value.replace(/!\s*important$/i, '').trim();
    }
    if (/var\(|env\(|attr\(|calc\(/i.test(value)) unsure();
    out.set(property, value);
  }
  return out;
}

function rulesOf(sheets: readonly string[]): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (const sheet of sheets) {
    const css = withoutComments(sheet);
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf('{', i);
      if (open < 0) break;
      // Statements before the rule: @charset and @namespace hold no paint; an @import is unsure.
      const statements = css.slice(i, open).split(';');
      const prelude = statements.pop()!.trim();
      if (statements.some((statement) => statement.trim() && !/^@(charset|namespace)\b/i.test(statement.trim()))) unsure();
      if (prelude.startsWith('@')) {
        // @font-face holds no paint; a conditional sheet (@media, @supports…) is unsure.
        if (!/^@font-face\b/i.test(prelude)) unsure();
        const close = css.indexOf('}', open);
        if (close < 0) unsure();
        i = close + 1;
        continue;
      }
      const selectorText = prelude;
      const close = css.indexOf('}', open);
      if (close < 0) unsure();
      const declarations = declarationsOf(css.slice(open + 1, close), false);
      i = close + 1;
      if (!declarations.size) continue;
      for (const selector of selectorText.split(',').map((part) => part.trim())) {
        const match = /^(\*|[A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(selector);
        if (!selector || !match) unsure();
        const parts = match![2].match(/[.#][\w-]+/g) ?? [];
        const ids = parts.filter((part) => part.startsWith('#')).map((part) => part.slice(1));
        if (ids.length > 1) unsure();
        const classes = parts.filter((part) => part.startsWith('.')).map((part) => part.slice(1));
        const tag = match![1] && match![1] !== '*' ? match![1] : null;
        rules.push({ tag, classes, id: ids[0] ?? null, specificity: ids.length * 10_000 + classes.length * 100 + (tag ? 1 : 0), order: order++, declarations });
      }
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
}

// --- Painting.

interface Inherited { fill: Paint; stroke: Paint; color: Colour; fillOpacity: number; strokeOpacity: number; visible: boolean; strokeWidth: number }
interface Frame { name: string; inert: boolean; opacity: number; effect: boolean; inherited: Inherited; measured: boolean; declared: Map<string, string>; attributes: Map<string, string> }

const BLACK: Colour = { hex: '#000000', alpha: 1 };
const NONE: Paint = { kind: 'none' };
const number = (value: string) => {
  const text = value.trim();
  const parsed = text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text.replace(/px$/, ''));
  return Number.isFinite(parsed) ? parsed : unsure();
};

// The colours an SVG paints with (#RRGGBB), or null when it is unsure what it paints.
export function svgPaints(svg: string): string[] | null {
  try {
    if (svg.length > MAX_LENGTH) return null;
    const all = tokens(svg);
    const sheets: string[] = [];
    let inStyle = 0;
    for (const token of all) {
      if (token.kind === 'open' && token.name === 'style' && !token.selfClosing) inStyle++;
      else if (token.kind === 'close' && token.name === 'style') inStyle = Math.max(0, inStyle - 1);
      else if (token.kind === 'text' && inStyle) sheets.push(token.text);
    }
    const rules = rulesOf(sheets);
    const colours = new Set<string>();
    const root: Frame = { name: '#root', inert: false, opacity: 1, effect: false, measured: true, declared: new Map(), attributes: new Map(), inherited: { fill: { kind: 'colour', colour: BLACK }, stroke: NONE, color: BLACK, fillOpacity: 1, strokeOpacity: 1, visible: true, strokeWidth: 1 } };
    const stack: Frame[] = [root];
    let seenRoot = false;

    const declared = (tag: Tag): Map<string, string> => {
      const out = new Map<string, string>();
      for (const [name, value] of tag.attributes) if (PROPERTIES.has(name)) out.set(name, value);
      const classes = new Set((tag.attributes.get('class') ?? '').split(/\s+/).filter(Boolean));
      const id = tag.attributes.get('id') ?? null;
      for (const rule of rules) {
        if ((rule.tag && rule.tag !== tag.name) || (rule.id && rule.id !== id) || !rule.classes.every((name) => classes.has(name))) continue;
        for (const [property, value] of rule.declarations) out.set(property, value);
      }
      const style = tag.attributes.get('style');
      if (style) for (const [property, value] of declarationsOf(style, true)) out.set(property, value);
      return out;
    };

    const paint = (frame: Frame, which: 'fill' | 'stroke') => {
      const { inherited } = frame;
      const chosen = which === 'fill' ? inherited.fill : inherited.stroke;
      if (chosen.kind === 'none' || (which === 'stroke' && inherited.strokeWidth <= 0)) return;
      const colour = chosen.kind === 'current' ? inherited.color : chosen.colour;
      const alpha = colour.alpha * (which === 'fill' ? inherited.fillOpacity : inherited.strokeOpacity) * frame.opacity;
      if (alpha <= 0) return;
      if (alpha < 1 || frame.effect) unsure();
      colours.add(colour.hex);
    };
    const measure = (frame: Frame) => {
      if (frame.measured || !frame.inherited.visible) return;
      frame.measured = true;
      if (frame.name !== 'line') paint(frame, 'fill');
      paint(frame, 'stroke');
    };
    // Whether a shape has something to paint (a path without d, a rectangle of no size, do not).
    const drawn = (frame: Frame): boolean => {
      const value = (name: string) => frame.declared.get(name) ?? frame.attributes.get(name);
      const positive = (name: string) => { const text = value(name); return text !== undefined && text.trim() !== '' && number(text) > 0; };
      switch (frame.name) {
        case 'path': return Boolean(value('d')?.trim()) && value('d')?.trim() !== 'none';
        case 'rect': return positive('width') && positive('height');
        case 'circle': return positive('r');
        case 'ellipse': return ['rx', 'ry'].every((name) => value(name) === undefined || value(name)!.trim() === 'auto' || number(value(name)!) > 0) && (value('rx') !== undefined || value('ry') !== undefined);
        case 'polygon': case 'polyline': return Boolean(value('points')?.trim());
        default: return true;
      }
    };

    for (const token of all) {
      const top = stack[stack.length - 1];
      if (token.kind === 'text') {
        if (!top.inert && TEXTS.has(top.name) && token.text.trim()) measure(top);
        continue;
      }
      if (token.kind === 'close') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (!seenRoot) {
        if (token.name !== 'svg') return null;
        seenRoot = true;
      }
      const tag = token;
      let frame: Frame;
      if (top.inert || !(SHAPES.has(tag.name) || TEXTS.has(tag.name) || CONTAINERS.has(tag.name) || UNSURE.has(tag.name)) || (TEXTS.has(tag.name) && tag.name !== 'text' && !TEXTS.has(top.name))) {
        frame = { ...top, name: tag.name, inert: true };
      } else {
        if (UNSURE.has(tag.name)) unsure();
        const props = declared(tag);
        const inherited = { ...top.inherited };
        const fill = props.get('fill');
        if (fill !== undefined) inherited.fill = paintOf(fill, { kind: 'colour', colour: BLACK }) ?? inherited.fill;
        const stroke = props.get('stroke');
        if (stroke !== undefined) inherited.stroke = paintOf(stroke, NONE) ?? inherited.stroke;
        const color = props.get('color');
        if (color !== undefined && !/^(inherit|unset|currentcolor)$/i.test(color.trim())) {
          const read = /^initial$/i.test(color.trim()) ? BLACK : colourOf(color);
          if (!read || read === 'none') unsure();
          inherited.color = read as Colour;
        }
        const opacityOf = (name: string, current: number) => { const value = props.get(name); return value === undefined || /^(inherit|unset)$/i.test(value.trim()) ? current : number(value); };
        inherited.fillOpacity = opacityOf('fill-opacity', inherited.fillOpacity);
        inherited.strokeOpacity = opacityOf('stroke-opacity', inherited.strokeOpacity);
        const visibility = props.get('visibility')?.trim().toLowerCase();
        if (visibility === 'hidden' || visibility === 'collapse') inherited.visible = false;
        else if (visibility === 'visible') inherited.visible = true;
        const width = props.get('stroke-width');
        if (width !== undefined && !/^(inherit|unset)$/i.test(width.trim())) inherited.strokeWidth = number(width);
        const opacity = props.get('opacity');
        const blend = props.get('mix-blend-mode')?.trim().toLowerCase();
        const effect = top.effect || ['filter', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end'].some((name) => { const value = props.get(name)?.trim().toLowerCase(); return value !== undefined && value !== 'none'; }) || (blend !== undefined && blend !== 'normal');
        const hidden = props.get('display')?.trim().toLowerCase() === 'none';
        frame = { name: tag.name, inert: hidden, opacity: top.opacity * (opacity === undefined ? 1 : number(opacity)), effect, inherited, measured: false, declared: props, attributes: tag.attributes };
        if (!hidden && SHAPES.has(tag.name) && drawn(frame)) measure(frame);
      }
      if (!tag.selfClosing) stack.push(frame);
    }
    return seenRoot && colours.size ? [...colours] : null;
  } catch {
    return null;
  }
}

// The best contrast of the logo's colours against the background, or null when it is unsure.
export function svgLogoContrast(svg: string, background: string): { ratio: number; background: string } | null {
  const bar = colourOf(background);
  if (!bar || bar === 'none' || bar.alpha < 1) return null;
  const paints = svgPaints(svg);
  if (!paints) return null;
  return { ratio: Math.max(...paints.map((paint) => contrastRatio(paint, bar.hex))), background: bar.hex };
}
