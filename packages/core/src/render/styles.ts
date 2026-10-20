import type { Presentation, TokenValues } from '@elabora/player/course-data';
import type { RenderSheet } from '@elabora/player/canvas-protocol';
import { tokenCssVars } from '@elabora/player/tokens';
import type { Project, ThemeFont } from '../project/model.ts';
import type { Registry } from '../components/registry.ts';
import { iterateBlocks, screenOrder } from '../project/load.ts';
import { readText } from '../project/files.ts';
import { cssUrls } from '../project/css.ts';
import { dirname, join, normalize } from '../util/paths.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import { cascadeOf, layerOrder, splitOverrides, type Cascade } from './cascade.ts';

// The design layer of a course as stylesheets: component stylesheets (cascade layer
// elabora.components, parents before their forks), the course stylesheet (elabora.theme), its
// `@layer overrides` blocks (elabora.overrides) and the embedded fonts, the layers in the order of the
// course's cascade (cascade.ts, D32). A package ties them together in elabora/theme.css with @import
// (the build writes it from here); the editor canvas gets the same sheets inline, one style element
// each, so an edit replaces one sheet without a fetch.

export type DesignLayer = 'elabora.components' | 'elabora.theme' | 'elabora.overrides';

export interface DesignSheet {
  // Path in the project and in the package (components/<id>/component.css, the theme stylesheet).
  path: string;
  layer: DesignLayer;
  css: string;
  // Project files its url() point to, normalised (the build copies those that exist).
  files: string[];
}

export interface DesignFont {
  family: string;
  src: string;
  weight: string;
  style: string;
  unicodeRange?: string; // the characters the file holds (a subset of the face): loaded only for them
}

export interface DesignStylesheets {
  cascade: Cascade;
  order: string; // the @layer statement that orders the layers
  sheets: DesignSheet[];
  fonts: DesignFont[];
  // elabora/theme.css of a package: '' when the course has no design layer.
  css: string;
  // Components whose stylesheet applies, sorted.
  components: string[];
}

// The player's layer. elabora/player.css, shared by every course, starts by naming it alone; the
// course's order of the other layers (cascade.ts layerOrder) starts elabora/theme.css and the canvas.
// Browsers order layers where their names first appear, so elabora.base comes first either way.
export const BASE_LAYER = '@layer elabora.base;';

// Where a package keeps the theme's `@layer overrides` blocks (their url() rebased to it).
export const OVERRIDES_SHEET = 'elabora/overrides.css';

// Types of the course: the layouts of its screens and the types of its blocks (layers and slots
// included), in course order.
export function usedTypes(project: Project): string[] {
  const types: string[] = [];
  for (const { id } of screenOrder(project)) { const layout = project.screens.get(id)?.data?.layout; if (layout) types.push(layout); }
  for (const { block } of iterateBlocks(project)) types.push(block.type);
  return types;
}

// The stylesheets of the given types (the course's own by default) and of the theme, in cascade
// order: a fork's instances carry their parents' classes too, so parents' stylesheets come first.
export function designStylesheets(project: Pick<Project, 'course' | 'files'>, registry: Registry, types: Iterable<string>): DesignStylesheets {
  const used = new Set<string>();
  for (const type of types) if (typeof type === 'string') for (const id of registry.get(type)?.cssChain || []) used.add(id);
  const depth = (id: string) => registry.get(id)?.lineage.length || 0;
  const sheets: DesignSheet[] = [];
  const imports: string[] = [];
  for (const id of [...used].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
    const css = registry.get(id)?.css;
    if (!css) continue;
    const path = `components/${id}/component.css`;
    sheets.push({ path, layer: 'elabora.components', css, files: urlFiles(path, css) });
    imports.push(`@import url("../${path}") layer(elabora.components);`);
  }
  // Read defensively: a theme that fails its schema is reported by the validator.
  const theme = isRecord(project.course?.theme) ? project.course.theme : {};
  const themeCss = typeof theme.stylesheet === 'string' && theme.stylesheet ? readText(project.files, theme.stylesheet) : null;
  if (typeof theme.stylesheet === 'string' && themeCss !== null) {
    const { defaults, overrides } = splitOverrides(themeCss);
    sheets.push({ path: theme.stylesheet, layer: 'elabora.theme', css: defaults, files: urlFiles(theme.stylesheet, defaults) });
    imports.push(`@import url("../${theme.stylesheet}") layer(elabora.theme);`);
    if (overrides.trim()) {
      sheets.push({ path: OVERRIDES_SHEET, layer: 'elabora.overrides', css: rebaseUrls(overrides, theme.stylesheet, '../'), files: urlFiles(theme.stylesheet, overrides) });
      imports.push(`@import url("../${OVERRIDES_SHEET}") layer(elabora.overrides);`);
    }
  }
  const fonts = objectsIn(theme.fonts).filter((font) => typeof font.src === 'string' && typeof font.family === 'string').map(designFont);
  const faces = fonts.map((font) => fontFace(font, '../'));
  const cascade = cascadeOf(project.course);
  const order = layerOrder(cascade);
  const css = imports.length || faces.length ? `${order}\n${imports.join('\n')}\n${faces.join('\n')}\n` : '';
  return { cascade, order, sheets, fonts, css, components: [...used].sort() };
}

// What the schema accepts (validation reports anything else): nothing but code points goes into
// the rule.
const UNICODE_RANGE = /^[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?(, ?[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?)*$/;

const designFont = (font: ThemeFont): DesignFont => ({
  family: font.family, src: font.src, weight: font.weight || '400', style: font.style || 'normal',
  ...(typeof font.unicodeRange === 'string' && UNICODE_RANGE.test(font.unicodeRange) ? { unicodeRange: font.unicodeRange } : {})
});

// prefix: the way from the stylesheet that declares the face to the package root. A face split
// into subset files is one rule per file: the browser downloads a file only for a page that uses
// one of its characters.
const fontFace = (font: DesignFont, prefix: string): string =>
  `@font-face{font-family:"${font.family}";src:url("${prefix}${font.src}") format("${font.src.endsWith('.woff2') ? 'woff2' : 'woff'}");font-weight:${font.weight};font-style:${font.style};font-display:swap${font.unicodeRange ? `;unicode-range:${font.unicodeRange}` : ''}}`;

// Project files a stylesheet's url() point to (query and fragment left out), when they stay inside
// the project.
function urlFiles(path: string, css: string): string[] {
  return cssUrls(css).map((url) => normalize(join(dirname(path), url.split(/[?#]/)[0]))).filter((target) => !target.startsWith('..'));
}

// The token variables and content widths, set unlayered on :root (index.html of a package): they
// are the source of truth of the theme.
export function rootStyle(tokens: Readonly<TokenValues>, presentation: Partial<Pick<Presentation, 'contentWidth' | 'wideWidth'>> | undefined): string {
  const widths = presentation || {};
  const variables = { ...tokenCssVars(tokens), '--t-content-width': `${(widths.contentWidth || 760) / 16}rem`, '--t-wide-width': `${(widths.wideWidth || 1100) / 16}rem` };
  return `:root{${Object.entries(variables).map(([name, value]) => `${name}:${value}`).join(';')}}`;
}

// The design layer as the canvas applies it, one sheet per style element after elabora/player.css,
// in the order a package gives them: the layer order, each stylesheet in its layer (its url()
// rebased on the package root, where the canvas page sits), the font faces, the root variables.
// A sheet in its own element keeps a parse error to itself, as a file of a package does.
export function inlineSheets(design: DesignStylesheets, root: string): RenderSheet[] {
  const sheets: RenderSheet[] = [];
  if (design.css) {
    sheets.push({ id: 'layers', css: design.order });
    for (const sheet of design.sheets) sheets.push({ id: sheet.path, css: `@layer ${sheet.layer} {\n${rebaseUrls(withoutCharset(sheet.css), sheet.path)}\n}` });
    if (design.fonts.length) sheets.push({ id: 'fonts', css: design.fonts.map((font) => fontFace(font, '')).join('\n') });
  }
  sheets.push({ id: 'root', css: root });
  return sheets;
}

// @charset is only valid first in a file, never inside a block.
const withoutCharset = (css: string): string => css.replace(/^﻿?@charset\s+"[^"]*"\s*;\s*/i, '');

// Comments and strings are kept as they are; url() with a relative target is rebased from the
// stylesheet's folder to the package root (query and fragment kept), or to a folder of it that
// prefix leads back from ('../' for elabora/).
const URL_TOKENS = /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|url\(\s*(['"]?)([^'")]*)\3\s*\)/gi;
export function rebaseUrls(css: string, from: string, prefix = ''): string {
  return css.replace(URL_TOKENS, (match: string, comment: string | undefined, string: string | undefined, _quote: string, url: string) => {
    if (comment !== undefined || string !== undefined) return match;
    const target = url.trim();
    if (!target || target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return match;
    const [, file, suffix] = /^([^?#]*)(.*)$/s.exec(target) ?? ['', target, ''];
    const rebased = normalize(join(dirname(from), file));
    return rebased.startsWith('..') ? match : `url("${prefix}${rebased}${suffix}")`;
  });
}
