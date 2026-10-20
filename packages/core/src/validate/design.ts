import { cssUrls, cssImports, isExternalUrl, literalColors, cssTextContents, fixedFontSizes } from '../project/css.ts';
import { listGenerators, readProvenance, generatorInputsHash } from '../project/generators.ts';
import { hasFile, readText, fileHash, isSourcePath, projectPath } from '../project/files.ts';
import { isFontPath, fontLicenses } from '../project/fonts.ts';
import { normalize, join, dirname, isAbsolute } from '../util/paths.ts';
import { rootOf } from '../components/registry.ts';
import { valuesOfKind } from '../components/props.ts';
import { screenBlocks } from '../project/load.ts';
import type { CheckContext, CourseCheckContext, ScreenFile } from './context.ts';
import { list, fieldsOf } from './guards.ts';
import { cascadeOf, splitOverrides } from '../render/cascade.ts';
import { inlineSvg } from '../render/svg-inline.ts';

// Design layer: agents write free CSS, component templates and generated figures; the checks keep
// content in blocks (editable, translatable, accessible) and packages offline. Components and
// screen layouts are checked in components.ts.

// The theme stylesheet and font files of course.json.
export function checkThemeFiles(ctx: CourseCheckContext): void {
  const { project, reporter } = ctx;
  const theme = ctx.course.theme || {};
  // A stylesheet that is not a string fails the schema.
  if (theme.stylesheet && typeof theme.stylesheet === 'string') {
    if (inSources(theme.stylesheet)) reporter.emit('E_SOURCE_REFERENCED', { file: 'course.json', path: '/theme/stylesheet', message: `The theme stylesheet ${theme.stylesheet} is in sources/, the author's sources, which are never published: keep it in theme/.` });
    else if (!hasFile(project.files, theme.stylesheet)) reporter.emit('E_ASSET_MISSING', { file: 'course.json', path: '/theme/stylesheet', message: `${theme.stylesheet} not found.` });
    else {
      const css = readText(project.files, theme.stylesheet) ?? '';
      checkCss(ctx, css, theme.stylesheet);
      const { nested } = splitOverrides(css);
      if (nested) reporter.emit('W_STYLE_OVERRIDES_NESTED', { file: theme.stylesheet, measured: nested, message: `${theme.stylesheet}: ${nested} @layer overrides block(s) inside another rule or at-rule, which do not override the components.` });
      // Before D32 the theme came after the components: said once the course has both.
      const styled = [...ctx.registry.values()].filter((component) => !component.builtin && component.css).map((component) => component.id);
      if (cascadeOf(ctx.course) === 'theme-over-components' && styled.length) {
        reporter.emit('I_THEME_CASCADE_OLD', { file: 'course.json', path: '/theme', message: `The theme comes after the stylesheets of ${styled.length} component(s) (${styled.slice(0, 4).join(', ')}${styled.length > 4 ? '…' : ''}) and overrides them: \`elabora theme upgrade\` puts its general rules under them, keeping the course's look.` });
      }
    }
  }
  list(theme.fonts).forEach((font, i) => {
    // A source that is not a string fails the schema.
    if (typeof font?.src === 'string' && inSources(font.src)) reporter.emit('E_SOURCE_REFERENCED', { file: 'course.json', path: `/theme/fonts/${i}/src`, message: `Font file ${font.src} is in sources/, the author's sources, which are never published: add the font with elabora font add (--file, --license).` });
    else if (typeof font?.src === 'string' && !hasFile(project.files, font.src)) reporter.emit('E_ASSET_MISSING', { file: 'course.json', path: `/theme/fonts/${i}/src`, message: `Font file ${font.src} not found.` });
  });
}

// A path of course.json that resolves into sources/ (D49).
function inSources(rel: string): boolean {
  const p = projectPath(rel);
  return p !== null && isSourcePath(p);
}

// Every font file of the course (theme, components, objects) has its licence in its folder: the
// build carries it into the package with the font. One finding per folder.
export function checkFontLicenses(ctx: CourseCheckContext): void {
  const paths = [...ctx.project.files.keys()];
  const unlicensed = new Map<string, string[]>();
  for (const font of paths.filter(isFontPath).sort()) {
    if (fontLicenses(paths, font).length) continue;
    const folder = dirname(font);
    unlicensed.set(folder, [...(unlicensed.get(folder) ?? []), font]);
  }
  for (const [folder, fonts] of unlicensed) {
    const names = fonts.map((font) => font.slice(font.lastIndexOf('/') + 1));
    const listed = `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
    ctx.reporter.emit('W_FONT_LICENSE_MISSING', { file: fonts[0], message: `${fonts.length === 1 ? fonts[0] : `${listed} in ${folder === '.' ? 'the course folder' : `${folder}/`}`} ${fonts.length === 1 ? 'has' : 'have'} no licence file next to ${fonts.length === 1 ? 'it' : 'them'} (OFL.txt, LICENSE.txt…): a package that embeds ${fonts.length === 1 ? 'it' : 'them'} would carry no licence.` });
  }
}

// Shared by the theme stylesheet and component stylesheets.
export function checkCss(ctx: Pick<CheckContext, 'project' | 'reporter'>, css: string, file: string): void {
  const { project, reporter } = ctx;
  for (const rule of cssImports(css)) reporter.emit('E_STYLE_RULE', { file, message: `@import ${rule.slice(0, 60)}: not allowed (one stylesheet per theme or component).` });
  for (const url of cssUrls(css)) {
    if (isExternalUrl(url)) { reporter.emit('E_STYLE_RULE', { file, message: `url(${url.slice(0, 80)}): external resources are not allowed.` }); continue; }
    const target = normalize(join(dirname(file), url.split(/[?#]/)[0]));
    if (target.startsWith('..') || isAbsolute(url)) reporter.emit('E_STYLE_RULE', { file, message: `url(${url}) points outside the course folder.` });
    else if (isSourcePath(target)) reporter.emit('E_SOURCE_REFERENCED', { file, message: `url(${url}) points to ${target}, one of the author's sources, which are never published: import it into assets/ (elabora media import . ${target}) and point to that.` });
    else if (!hasFile(project.files, target)) reporter.emit('E_ASSET_MISSING', { file, message: `url(${url}): ${target} not found.` });
  }
  const colors = literalColors(css);
  if (colors.length) reporter.emit('W_STYLE_LITERAL_COLOR', { file, measured: colors.length, message: `${colors.length} hard-coded colour(s) in ${file} (${[...new Set(colors)].slice(0, 5).join(', ')}${colors.length > 5 ? '…' : ''}).` });
  const fixed = fixedFontSizes(css);
  if (fixed.length) reporter.emit('W_STYLE_FIXED_FONT_SIZE', { file, measured: fixed.length, message: `${fixed.length} font size(s) in px in ${file} (${[...new Set(fixed)].slice(0, 4).join(', ')}${fixed.length > 4 ? '…' : ''}): they keep their size at 1280×720 and on phones.` });
  for (const content of cssTextContents(css)) reporter.emit('W_STYLE_TEXT', { file, message: `content: "${content.slice(0, 40)}" in ${file}.` });
}

// Words in SVG figures cannot be translated or edited: numbers and symbols are fine.
// Images of image blocks (and SVG assets bound in component props) are checked, once per block id.
export function checkFigures(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { project, reporter, registry } = ctx;
  const seen = new Set<string>();
  for (const { block, path } of screenBlocks(screen.data, screen.file)) {
    if (block === null || block === undefined || ctx.blocks.get(block.id)?.block !== block) continue;
    const component = registry.get(block.type);
    if (!component) continue;
    const props = fieldsOf(block.props);
    if (rootOf(registry, block.type) === 'image' && props.inline === true && typeof props.asset === 'string') checkInlineSvg(ctx, screen, block.id, `${path}/props`, props.asset);
    const svgs = rootOf(registry, block.type) === 'image'
      ? (props.decorative ? [] : [{ value: props.asset, path: '/asset' }])
      : component.builtin ? [] : valuesOfKind(component.schema, block.props || {}, 'asset');
    for (const { value, path: sub } of svgs) {
      if (!value) continue;
      const asset = String(value);
      if (!/\.svg$/i.test(asset) || seen.has(`${asset}|${block.id}`)) continue;
      seen.add(`${asset}|${block.id}`);
      const svg = readText(project.files, `assets/${asset}`);
      if (svg === null) continue;
      const words = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter((t) => /\p{L}{2,}/u.test(t));
      if (words.length) reporter.emit('W_ASSET_SVG_TEXT', { file: screen.file, path: `${path}/props${sub}`, target: block.id, measured: words.length, message: `assets/${asset} contains ${words.length} text label(s): "${words.slice(0, 3).join('", "').slice(0, 90)}".` });
    }
  }
}

// An image put in the page (inline: true): an SVG, safe as it is, not too heavy for the page.
const INLINE_HEAVY = 256 * 1024;
function checkInlineSvg(ctx: CourseCheckContext, screen: ScreenFile, blockId: string, path: string, asset: string): void {
  const { reporter, project } = ctx;
  if (!/\.svg$/i.test(asset)) { reporter.emit('W_IMAGE_INLINE_NOT_SVG', { file: screen.file, path: `${path}/inline`, target: blockId, message: `Block "${blockId}": assets/${asset} is not an SVG, so inline does nothing; it stays an <img>.` }); return; }
  const svg = readText(project.files, `assets/${asset}`);
  if (svg === null) return;
  const { removed } = inlineSvg(svg, { prefix: blockId });
  if (removed.length) reporter.emit('W_SVG_INLINE_SANITIZED', { file: screen.file, path: `${path}/asset`, target: blockId, measured: removed.length, message: `assets/${asset}, put in the page by block "${blockId}", lost what is not safe there: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '…' : ''}.` });
  const bytes = new TextEncoder().encode(svg).length;
  if (bytes > INLINE_HEAVY) reporter.emit('W_IMAGE_INLINE_HEAVY', { file: screen.file, path: `${path}/inline`, target: blockId, measured: Math.round(bytes / 1024), limit: INLINE_HEAVY / 1024, message: `assets/${asset} (${Math.round(bytes / 1024)} KB) goes into the page of block "${blockId}" and into the course data every learner loads.` });
}

// Generated assets (generators/*.mjs): edited by hand, or stale because an input changed.
export function checkGenerators(ctx: CourseCheckContext): void {
  const { project, reporter } = ctx;
  const generators = listGenerators(project);
  const provenance = readProvenance(project);
  const byGenerator = new Map<unknown, { asset: string; inputsHash: unknown }[]>();
  for (const [asset, entry] of Object.entries(provenance.assets || {})) {
    const { generator, inputsHash, outputHash } = fieldsOf(entry);
    if (!byGenerator.has(generator)) byGenerator.set(generator, []);
    byGenerator.get(generator)?.push({ asset, inputsHash });
    const hash = fileHash(project.files, `assets/${asset}`);
    if (hash !== null && hash !== outputHash) reporter.emit('W_GENERATED_ASSET_EDITED', { file: `assets/${asset}`, target: asset, message: `assets/${asset} differs from what ${generator} produced.` });
  }
  for (const generator of generators) {
    const { hash, error } = generatorInputsHash(project.files, ctx.course, generator);
    if (error) { reporter.emit('E_GENERATOR', { file: generator, message: error }); continue; }
    const entries = byGenerator.get(generator) || [];
    if (!entries.length) reporter.emit('W_GENERATED_ASSET_STALE', { file: generator, message: `${generator} has never been run.` });
    else if (entries.some((entry) => entry.inputsHash !== hash)) reporter.emit('W_GENERATED_ASSET_STALE', { file: generator, message: `${generator} or one of its inputs changed: ${entries.length} asset(s) to regenerate (${entries.map((entry) => entry.asset).slice(0, 4).join(', ')}).` });
  }
  for (const generator of byGenerator.keys()) {
    if (!generators.some((name) => name === generator)) reporter.emit('W_GENERATED_ASSET_STALE', { file: 'generators/provenance.json', message: `Generator ${generator} no longer exists; its assets are no longer maintained.` });
  }
}
