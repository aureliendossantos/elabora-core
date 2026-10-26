import { htmlToMarkdown, htmlToText } from './html-markdown.ts';
import type { SourceCourse, SourceSection, SourcePage, SourceItem, SourceMedia, SourceTrigger, ReaderLoss, SourceDialogueNode, SourceDialogueOption, SourceBlockMedia } from './model.ts';

// Rise 360's exports (web, SCORM 1.2 and 2004, xAPI): the course is JSON, base64 in the player's
// page, in a locale file beside it or, since 2026, in `runtime-data.js` (docs/decisions.md D47).
// `findRiseCourse` finds it in the page's text, `readRiseLocale` and `readRiseRuntime` in those
// files; `readRise` reads it into the importer's model. Lessons are pages that scroll,
// sections start course sections, quiz lessons are pages of questions with their results. No
// Articulate code is read or kept: only the course's data and its media.

// Where the course data is in the page (each shape seen in real exports, 2018 to 2026).
const PATTERNS: { re: RegExp; wrapped: boolean }[] = [
  { re: /deserialize\(\s*"([A-Za-z0-9+/=]+)"\s*\)/, wrapped: true }, // 2025–2026: __fetchCourse returns deserialize("…")
  { re: /window\.courseData\s*=\s*"([A-Za-z0-9+/=]+)"/, wrapped: true }, // 2021–2023
  { re: /window\.course\s*=\s*'([A-Za-z0-9+/=]+)'/, wrapped: false }, // 2018: the course itself
  // 2017: a script's `var data = '…'`, the course itself (base64 of a JSON object, so it starts with "eyJ").
  { re: /\bvar data = '(eyJ[A-Za-z0-9+/=]{1000,})'/, wrapped: false }
];
const LOCALE = /__resolveJsonp\(\s*"course:[^"]*"\s*,\s*"([A-Za-z0-9+/=]+)"\s*\)/;
// 2026: `runtime-data.js` is `__jsonp("runtime-data.js","<base64 of {course, labelSet, settings, …}>")`.
const RUNTIME = /__jsonp\(\s*"runtime-data\.js"\s*,\s*"([A-Za-z0-9+/=]+)"\s*\)/;
// Where a 2026 export keeps it, relative to the folder of its player page and assets.
export const RISE_RUNTIME_FILES = ['lib/runtime-data.js', 'runtime-data.js']; // the longest first: a path ends with both

const decodeBase64 = (text: string): string => new TextDecoder().decode(Uint8Array.from(atob(text), (c: string) => c.charCodeAt(0)));

export interface RisePage {
  // The locale file a 2024–2025 page loads its course from (`locales/<locale>.js`), when it does.
  localeFile: string | null;
  data: Record<string, unknown> | null;
}

// The course data of a Rise player page, or the locale file to read it from.
export function findRiseCourse(indexHtml: string): RisePage {
  for (const { re, wrapped } of PATTERNS) {
    const match = re.exec(indexHtml);
    if (!match) continue;
    const json = JSON.parse(decodeBase64(match[1])) as Record<string, unknown>;
    return { localeFile: null, data: wrapped ? json : { course: json } };
  }
  const i18n = /window\.i18n\s*=\s*(\{[^;]*\})\s*;/.exec(indexHtml);
  if (i18n) {
    try {
      const settings = JSON.parse(i18n[1]) as { default?: string };
      return { localeFile: `locales/${settings.default || 'und'}.js`, data: null };
    } catch { /* not JSON: not a Rise page */ }
  }
  return { localeFile: null, data: null };
}

export function readRiseLocale(text: string): Record<string, unknown> | null {
  const match = LOCALE.exec(text);
  return match ? JSON.parse(decodeBase64(match[1])) as Record<string, unknown> : null;
}

// The course data of a 2026 export's `runtime-data.js`.
export function readRiseRuntime(text: string): Record<string, unknown> | null {
  const match = RUNTIME.exec(text);
  return match ? JSON.parse(decodeBase64(match[1])) as Record<string, unknown> : null;
}

// Does this file look like a 2026 export's course data? (detection: its first bytes are enough)
export const isRiseRuntime = (text: string): boolean => /^\s*__jsonp\(\s*"runtime-data\.js"\s*,\s*"[A-Za-z0-9+/=]{16}/.test(text.slice(0, 256));

// Does this page look like a Rise player? (detection, before decoding)
export const isRisePage = (indexHtml: string): boolean => PATTERNS.some(({ re }) => re.test(indexHtml)) || /__fetchCourse|__loadJsonp\('course:/.test(indexHtml);

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') as Json[] : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
// Statements A to D (D63): their presentation and alignment.
const STATEMENTS: Record<string, Record<string, unknown>> = { a: {}, b: { presentation: 'ruled' }, c: { align: 'start' }, d: { presentation: 'ruled', align: 'start' } };
// Rise's image variants as the presentations of an image (D63); hero is Rise's centred image.
const IMAGE_PRESENTATIONS: Record<string, 'wide' | 'band' | 'beside' | 'over' | undefined> = { full: 'wide', banner: 'band', 'text aside': 'beside', 'text overlay': 'over' };

// A Rise chart as a chart of D60 when its values fit one: pie → donut, bar → bars, line → trend.
function riseChart(block: Json, variant: string, items: Json[], ref: string): SourceItem | null {
  const values = items.map((item) => ({ label: htmlToText(str(item.type) || str(item.label)), value: Number(str(item.value)) }));
  if (!values.length || values.some((entry) => !entry.label || !Number.isFinite(entry.value))) return null;
  const takeaway = clip(htmlToText(str(block.title)) || htmlToText(str(block.valuesLabel)) || htmlToText(str(block.itemsLabel)) || values.map((entry) => entry.label).join(', '), 160);
  const unit = str(obj(block.settings).valueType) === 'percentage' ? { unit: '%' } : {};
  const kind = variant || 'bar';
  if (kind === 'pie' && values.length >= 2 && values.length <= 6 && values.every((entry) => entry.value >= 0)) return { ref, kind: 'block', type: 'donut', props: { takeaway, parts: values.map((entry, i) => ({ id: `p${i + 1}`, label: clip(entry.label, 60), value: entry.value })), ...unit } };
  if (kind === 'bar' && values.length <= 12) return { ref, kind: 'block', type: 'bars', props: { takeaway, rows: values.map((entry, i) => ({ id: `r${i + 1}`, label: clip(entry.label, 80), value: entry.value })), sort: 'none', ...unit } };
  if (kind === 'line' && values.length >= 2 && values.length <= 40) return { ref, kind: 'block', type: 'trend', props: { takeaway, points: values.map((entry) => ({ x: clip(entry.label, 40), y: entry.value })), ...unit } };
  return null;
}

export interface ReadRiseOptions {
  // Whether the export holds a file (paths relative to the player page's folder).
  has: (path: string) => boolean;
}

export function readRise(data: Json, options: ReadRiseOptions): SourceCourse {
  const course = obj(data.course ?? data);
  const labelSet = obj(data.labelSet);
  const losses: ReaderLoss[] = [];
  let itemCounter = 0;
  const nextRef = (prefix: string) => `${prefix}${++itemCounter}`;

  // A media object's file: crushed (optimised) when Rise says so, a Rise stock image by its src,
  // else its key; keys are URL-encoded.
  const mediaFile = (media: Json): string | null => {
    const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    const candidates: string[] = [];
    if (media.useCrushedKey === true && str(media.crushedKey)) candidates.push(decode(str(media.crushedKey)));
    if (str(media.key).startsWith('assets/rise/') && str(media.src)) candidates.push(decode(str(media.src)));
    if (str(media.key)) candidates.push(decode(str(media.key)));
    if (str(media.src)) candidates.push(decode(str(media.src)));
    if (str(media.crushedKey)) candidates.push(decode(str(media.crushedKey)));
    for (const candidate of candidates) {
      const path = candidate.startsWith('assets/') ? candidate : `assets/${candidate}`;
      if (options.has(path)) return path;
    }
    // A folder whose files were flattened beside the page (no assets/ folder) still holds them.
    for (const candidate of candidates) if (!candidate.startsWith('assets/') && !/^[a-z]+:/i.test(candidate) && options.has(candidate)) return candidate;
    return candidates.length ? (candidates[0].startsWith('assets/') ? candidates[0] : `assets/${candidates[0]}`) : null;
  };
  const image = (holder: unknown): { media: SourceMedia; alt?: string; focus?: { x: number; y: number } } | null => {
    const media = obj(obj(obj(holder).media).image);
    const path = mediaFile(media);
    if (!path) return null;
    // Rise's crop (dimensions: the part of the original kept) gives the focal point: its centre.
    const crop = obj(media.dimensions);
    const [left, top, width, height, fullWidth, fullHeight] = ['left', 'top', 'width', 'height', 'originalWidth', 'originalHeight'].map((key) => Number(crop[key]));
    const focus = [left, top, width, height, fullWidth, fullHeight].every(Number.isFinite) && fullWidth > 0 && fullHeight > 0 && (width < fullWidth || height < fullHeight)
      ? { x: round3(Math.min(1, Math.max(0, (left + width / 2) / fullWidth))), y: round3(Math.min(1, Math.max(0, (top + height / 2) / fullHeight))) } : undefined;
    const alt = str(media.alt).replace(/^"+|"+$/g, '').trim();
    return { media: { path, kind: 'image' }, ...(alt ? { alt } : {}), ...(focus ? { focus } : {}) };
  };
  // A medium of a native block: where it goes in the props, what happens when it cannot be kept.
  const blockMedium = (found: { media: SourceMedia }, at: (string | number)[], missing: SourceBlockMedia['missing'], hint = ''): SourceBlockMedia => ({ at, media: found.media, missing, ...(hint ? { hint } : {}) });
  // A picture's text alternative in a native block: alt, or decorative when the source gives none.
  const altOf = (found: { alt?: string }): Record<string, unknown> => (found.alt ? { alt: clip(found.alt, 250) } : { decorative: true });

  const sections: SourceSection[] = [];
  let section: SourceSection | null = null;
  const ensureSection = () => {
    if (!section) { section = { ref: 'section-0', title: str(course.title) || 'Module', pages: [] }; sections.push(section); }
    return section;
  };
  // The types of the blocks since the last Continue of the lesson: what a Continue that waits waits for.
  let above: string[] = [];
  const lessonIds = new Set(list(course.lessons).map((lesson) => str(lesson.id)));
  let passingScore: number | undefined;

  for (const lesson of list(course.lessons)) {
    if (lesson.deleted === true) continue;
    const type = str(lesson.type);
    const title = htmlToText(str(lesson.title)) || (type === 'quiz' ? 'Quiz' : 'Leçon');
    if (type === 'section') {
      section = { ref: str(lesson.id) || nextRef('section'), title, pages: [] };
      sections.push(section);
      continue;
    }
    const page: SourcePage = { ref: str(lesson.id) || nextRef('lesson'), title, kind: type === 'quiz' ? 'question' : 'content', positioned: false, items: [], layers: [], triggers: [] };
    above = [];
    if (type === 'quiz') readQuizLesson(lesson, page);
    // 2017's interactive lessons: a labeled graphic (map) or a sorting activity, its text first.
    else if (type === 'map' || type === 'sorting') {
      text(page, lesson.description);
      readInteractive(lesson, page, str(lesson.id) || nextRef('block'), 'interactive-fullscreen', type === 'map' ? 'labeledgraphic' : 'sorting', list(lesson.items), type);
    } else for (const block of list(lesson.items)) readBlock(block, page);
    if (type !== 'quiz' && type !== 'blocks' && type !== '' && type !== 'map' && type !== 'sorting') losses.push({ page: title, feature: `Rise lesson "${type}"`, detail: 'read as a lesson of blocks' });
    ensureSection().pages.push(page);
  }

  function push(page: SourcePage, item: SourceItem) { page.items.push(item); }
  function text(page: SourcePage, html: unknown, extra: Partial<SourceItem> = {}) {
    const markdown = htmlToMarkdown(str(html));
    if (markdown) push(page, { ref: nextRef('text'), kind: 'text', markdown, ...extra } as SourceItem);
  }
  function heading(page: SourcePage, html: unknown, level: 2 | 3 = 2) {
    const value = htmlToText(str(html));
    if (value) push(page, { ref: nextRef('heading'), kind: 'heading', text: value, level });
  }

  function readBlock(block: Json, page: SourcePage) {
    const type = str(block.type);
    const family = str(block.family);
    const variant = str(block.variant);
    const items = list(block.items);
    const ref = str(block.id) || nextRef('block');
    const feature = `${family || type}${variant && variant !== family ? ` (${variant})` : ''}`;
    if (!(type === 'divider' && family === 'continue')) above.push(type);
    switch (type) {
      case 'text': {
        if (family === 'impact') {
          for (const item of items) {
            const markdown = htmlToMarkdown(str(item.paragraph));
            const title = htmlToText(str(item.heading));
            if (!markdown && !title) continue;
            if (variant === 'note') { push(page, { ref, kind: 'callout', variant: 'info', markdown: markdown || title }); continue; }
            // Statements A to D (D63): large, between rules, at the start of the line; a heading in bold before.
            const body = title && markdown ? `**${title.replace(/[*_]/g, '')}**\n\n${markdown}` : markdown || title;
            if (body.length <= 400) push(page, { ref, kind: 'block', type: 'statement', props: { ...STATEMENTS[variant], markdown: body } });
            else push(page, { ref, kind: 'callout', variant: 'important', ...(title ? { title: clip(title, 120) } : {}), markdown: markdown || title, fallbackOf: { feature: `Énoncé (Rise statement ${variant.toUpperCase()})`, detail: 'un encadré : plus de 400 caractères' } });
          }
          return;
        }
        if (variant === 'two column') {
          // Columns (D63): each column's heading in bold, then its text.
          const columns = items.map((item) => {
            const heading = htmlToText(str(item.heading));
            const body = htmlToMarkdown(str(item.paragraph));
            return heading && body ? `**${heading.replace(/[*_]/g, '')}**\n\n${body}` : body || (heading ? `**${heading.replace(/[*_]/g, '')}**` : '');
          }).filter(Boolean);
          if (columns.length >= 2 && columns.length <= 3) push(page, { ref, kind: 'block', type: 'columns', props: columns.length === 3 ? { count: 3 } : {}, children: columns.map((markdown, i) => ({ slot: ['first', 'second', 'third'][i], item: { ref: `${ref}-${i}`, kind: 'text', markdown } as SourceItem })) });
          else for (const markdown of columns) push(page, { ref: nextRef('text'), kind: 'text', markdown });
          return;
        }
        for (const item of items) {
          if (variant.includes('heading') || variant.includes('subheading')) heading(page, item.heading, variant.startsWith('subheading') ? 3 : 2);
          if (variant === 'table' || variant === 'paragraph' || variant.endsWith('paragraph') || !variant) text(page, item.paragraph);
        }
        return;
      }
      case 'quote':
        for (const item of items) {
          const quote = htmlToMarkdown(str(item.paragraph));
          if (!quote) continue;
          const name = htmlToText(str(item.name));
          const asText: SourceItem = { ref, kind: 'text', markdown: `${quote.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')}${name ? `\n\n— ${name}` : ''}`, fallbackOf: { feature: 'Citation (Rise quote)', detail: 'plus de 400 caractères' } };
          if (quote.length > 400) { push(page, asText); continue; }
          // A quotation (D63): its author, their portrait unless it is Rise's default one; on its picture (Quote on image).
          const props: Record<string, unknown> = { presentation: 'quote', markdown: quote, ...(name ? { author: clip(name, 80) } : {}) };
          const media: SourceBlockMedia[] = [];
          const portrait = image(item.avatar);
          const settings = obj(block.settings);
          if (portrait && settings.avatar !== false && !/block-defaults\/avatar/.test(str(obj(obj(obj(item.avatar).media).image).key)) && name) { props.portrait = ''; media.push(blockMedium(portrait, ['portrait'], 'unset', `${name}-portrait`)); }
          const backdrop = variant === 'background' ? image(item.background) : null;
          if (backdrop) {
            const onPicture = { ...props, presentation: 'image', image: '', ...altOf(backdrop), ...(backdrop.focus ? { focus: backdrop.focus } : {}) };
            push(page, { ref, kind: 'block', type: 'statement', props: onPicture, media: [...media, blockMedium(backdrop, ['image'], 'block')], otherwise: { ref, kind: 'block', type: 'statement', props, media } });
          } else push(page, { ref, kind: 'block', type: 'statement', props, media });
        }
        return;
      case 'list': {
        const lines = items.map((item, i) => {
          const body = htmlToMarkdown(str(item.paragraph)).replace(/\n+/g, ' ');
          return body ? `${variant === 'numbered' ? `${i + 1}.` : '-'} ${body}` : '';
        }).filter(Boolean);
        if (lines.length) push(page, { ref, kind: 'text', markdown: lines.join('\n'), ...(variant === 'checkboxes' ? { fallbackOf: { feature: 'Liste à cocher (Rise checkboxes)', detail: 'liste à puces' } } : {}) });
        return;
      }
      case 'image': {
        if (family === 'gallery') {
          // A gallery (D63): Rise's grids of two to four columns, or its carousel (centered).
          const media: SourceBlockMedia[] = [];
          const images = items.map((item) => ({ item, found: image(item) })).filter((entry) => entry.found).slice(0, 24).map(({ item, found }, i) => {
            media.push(blockMedium(found!, ['images', i, 'asset'], 'entry'));
            const caption = htmlToText(str(item.caption));
            return { id: `i${i + 1}`, asset: '', ...altOf(found!), ...(caption ? { caption: clip(caption, 200) } : {}), ...(found!.focus ? { focus: found!.focus } : {}) };
          });
          if (!images.length) return;
          const columns = { 'two column': 2, 'four column': 4 }[variant];
          push(page, { ref, kind: 'block', type: 'gallery', props: { ...(variant === 'centered' ? { presentation: 'carousel' } : {}), images, ...(columns ? { columns } : {}), ...(obj(block.settings).zoomOnClick === true ? { zoom: true } : {}) }, media });
          return;
        }
        const presentation = IMAGE_PRESENTATIONS[variant];
        items.forEach((item, i) => {
          const found = image(item);
          if (!found) { if (str(item.paragraph) || (variant === 'text overlay' && str(item.caption))) text(page, str(item.paragraph) || item.caption); return; }
          const caption = htmlToText(str(item.caption));
          // Beside and over: the text goes with the picture (over: Rise keeps it in the caption).
          const words = presentation === 'beside' ? htmlToMarkdown(str(item.paragraph)) : presentation === 'over' ? htmlToMarkdown(str(item.caption)) || htmlToMarkdown(str(item.paragraph)) : '';
          const together = words.length <= 1500 && (presentation !== 'over' || words.length <= 400);
          const shown = together ? presentation : presentation === 'over' ? 'band' : 'centered';
          const size = str(obj(block.settings).imageSize);
          push(page, {
            ref: `${ref}-${i}`, kind: 'image', media: found.media, ...(found.alt ? { alt: found.alt } : {}),
            ...(caption && presentation !== 'over' ? { caption } : {}), ...(shown && shown !== 'centered' ? { presentation: shown } : {}), ...(found.focus ? { focus: found.focus } : {}),
            ...(together && words ? { markdown: words } : {}), ...(shown === 'beside' && size === 'small' ? { share: 'third' as const } : shown === 'beside' && size === 'large' ? { share: 'two-thirds' as const } : {})
          } as SourceItem);
          if (!together && words) push(page, { ref: nextRef('text'), kind: 'text', markdown: words });
          else if (!presentation && str(item.paragraph)) text(page, item.paragraph);
        });
        return;
      }
      case 'multimedia': {
        for (const item of items) {
          const media = obj(item.media);
          const title = htmlToText(str(item.caption)) || htmlToText(str(item.title)) || undefined;
          if (variant === 'audio' || media.audio) {
            const path = mediaFile(obj(media.audio));
            if (path) push(page, { ref, kind: 'audio', media: { path, kind: 'audio' }, title });
          } else if (variant === 'video' || media.video) {
            const path = mediaFile(obj(media.video));
            if (path) push(page, { ref, kind: 'video', media: { path, kind: 'video' }, title });
          } else if (variant === 'embed' || media.embed) {
            const embed = obj(media.embed);
            // originalUrl and src may hold the frame's HTML (an <iframe> pasted): its src is the address.
            const frameSrc = (value: string) => /src=["']([^"']+)["']/.exec(value)?.[1] ?? '';
            const url = [str(embed.originalUrl), str(embed.src)].map((value) => (/^(https?:)?\/\//.test(value) ? value.replace(/^\/\//, 'https://') : frameSrc(value).replace(/^\/\//, 'https://'))).find((value) => /^https?:/.test(value)) ?? '';
            const label = htmlToText(str(embed.title)) || title || url || 'Contenu intégré';
            push(page, { ref, kind: 'fallback', feature: 'Contenu intégré (Rise embed)', markdown: /^https?:/.test(url) ? `[${label.replace(/[[\]]/g, '')}](${url})` : label, detail: 'un lien à la place du cadre' });
          } else if (variant === 'attachment' || media.attachment) {
            const name = str(obj(media.attachment).filename) || title || 'fichier';
            push(page, { ref, kind: 'fallback', feature: 'Pièce jointe (Rise attachment)', markdown: `${title ? `${title} : ` : ''}${name}`, detail: 'le fichier n\'est pas repris' });
          } else if (variant === 'code' || item.code) {
            const code = str(item.code);
            if (code) push(page, { ref, kind: 'text', markdown: `\`\`\`\n${code.replace(/```/g, "'''")}\n\`\`\`` });
          }
        }
        return;
      }
      case 'interactive':
        return readInteractive(block, page, ref, family, variant, items, feature);
      case 'knowledgeCheck':
        for (const item of items) readQuestion(item, page, ref, false);
        return;
      case 'chart': {
        const chart = riseChart(block, variant, items, ref);
        if (chart) { push(page, chart); return; }
        const rows = items.map((item) => `| ${htmlToText(str(item.type) || str(item.label)).replace(/\|/g, '/')} | ${str(item.value)} |`);
        const head = `| ${htmlToText(str(block.itemsLabel)) || ' '} | ${htmlToText(str(block.valuesLabel)) || ' '} |\n| --- | --- |`;
        push(page, { ref, kind: 'fallback', feature: `Graphique (Rise ${variant || 'chart'})`, markdown: `${htmlToText(str(block.title)) ? `**${htmlToText(str(block.title))}**\n\n` : ''}${head}\n${rows.join('\n')}`, detail: 'un tableau de ses valeurs' });
        return;
      }
      case 'divider':
        if (family === 'continue') {
          const item = items[0] ?? {};
          const completion = str(item.type);
          // "Complete block above" or "complete all above": once explored (D63), or once answered when
          // what it waits for is knowledge checks only.
          const waitedFor = completion === 'completeBlock' ? above.slice(-1) : above;
          const opens = completion !== 'completeBlock' && completion !== 'completeAll' ? 'continue' : waitedFor.length && waitedFor.every((kind) => kind === 'knowledgeCheck') ? 'answered' : 'explored';
          push(page, { ref, kind: 'continue', opens, label: htmlToText(str(item.title)) || undefined });
          above = [];
        } else push(page, { ref, kind: 'block', type: 'divider', props: variant === 'numbered divider' ? { presentation: 'number' } : variant === 'spacing divider' ? { presentation: 'space' } : {} });
        return;
      case 'custom':
        push(page, { ref, kind: 'unsupported', feature: 'Bloc personnalisé (Rise custom block)' });
        return;
      default:
        push(page, { ref, kind: 'unsupported', feature: `Rise ${feature || 'block'}` });
    }
  }

  function readInteractive(block: Json, page: SourcePage, ref: string, family: string, variant: string, items: Json[], feature: string) {
    const entries = (titleKey: string, bodyKey: string) => items.map((item) => ({ title: htmlToText(str(item[titleKey])), markdown: htmlToMarkdown(str(item[bodyKey])) }));
    switch (variant || family) {
      case 'accordion':
      case 'tabs': {
        // Panels and tabs (D63): an item's picture goes with it; its video or embed does not.
        const panels = items.map((item) => {
          const found = image(item);
          const other = Object.keys(obj(item.media)).filter((key) => key !== 'image' && key !== 'tmp');
          if (other.length) losses.push({ page: page.title, item: ref, feature: `${other.includes('video') ? 'Vidéo' : 'Contenu intégré'} dans ${variant === 'tabs' ? 'un onglet' : 'un panneau'} (Rise ${variant})`, detail: htmlToText(str(item.title)) });
          return { title: htmlToText(str(item.title)), markdown: htmlToMarkdown(str(item.description)), ...(found ? { media: found.media, ...(found.alt ? { alt: found.alt } : {}) } : {}) };
        });
        push(page, { ref, kind: 'accordion', ...(variant === 'tabs' ? { presentation: 'tabs' as const } : {}), items: panels });
        return;
      }
      case 'labeledgraphic': {
        // An interactive picture (D63): Rise places its markers in percent of the picture.
        const found = image(block);
        const markers = items.slice(0, 20);
        const asPanels: SourceItem = { ref, kind: 'accordion', items: markers.map((item, i) => ({ title: `${i + 1}. ${htmlToText(str(item.title)) || ''}`.trim(), markdown: htmlToMarkdown(str(item.description)) })), fallbackOf: { feature: 'Image interactive (Rise labeled graphic)', detail: 'ses repères dans des panneaux : l\'image est introuvable' } };
        if (!found || !markers.length) { push(page, asPanels); return; }
        const media: SourceBlockMedia[] = [blockMedium(found, ['image'], 'block')];
        const place = (value: unknown) => round3(Math.min(1, Math.max(0, (Number(value) || 50) / 100)));
        const hotspots = markers.map((item, i) => {
          const detail = image(item);
          if (detail) media.push(blockMedium(detail, ['items', i, 'image'], 'unset'));
          return { id: `i${i + 1}`, x: place(item.x), y: place(item.y), title: clip(htmlToText(str(item.title)) || `${i + 1}`, 80), markdown: htmlToMarkdown(str(item.description)), ...(detail ? { image: '', alt: clip(detail.alt ?? '', 250) } : {}) };
        });
        if (items.length > 20) losses.push({ page: page.title, item: ref, feature: 'Repères au-delà de vingt (Rise labeled graphic)', detail: `${items.length - 20}` });
        push(page, { ref, kind: 'block', type: 'hotspots', props: { image: '', ...altOf(found), ...(found.focus ? { focus: found.focus } : {}), items: hotspots }, media, otherwise: asPanels });
        return;
      }
      case 'process':
      case 'timeline': {
        // Steps (D63): Rise's process as a carousel with its intro and summary, its timeline as a frise.
        const visible = items.filter((item) => item.isHidden !== true);
        const kindOf = (item: Json) => (variant === 'process' ? str(item.type) || 'step' : 'step');
        const media: SourceBlockMedia[] = [];
        const part = (item: Json, at: (string | number)[], fallbackTitle: string): { title: string; markdown: string; picture: Record<string, unknown> } => {
          const found = image(item);
          if (found) media.push(blockMedium(found, [...at, 'image'], 'unset'));
          const other = obj(item.media).audio || obj(item.media).embed || obj(item.media).video;
          if (other) losses.push({ page: page.title, item: ref, feature: `Son ou vidéo d'une étape (Rise ${variant})`, detail: htmlToText(str(item.title)) });
          return { title: clip(htmlToText(str(item.title)) || fallbackTitle, 120), markdown: htmlToMarkdown(str(item.description)), picture: found ? { image: '', ...(found.alt ? { alt: clip(found.alt, 250) } : {}) } : {} };
        };
        const all = visible.filter((item) => kindOf(item) === 'step');
        const steps = all.slice(0, 20);
        const intro = visible.find((item) => kindOf(item) === 'intro');
        const summary = visible.find((item) => kindOf(item) === 'summary');
        if (!steps.length) { for (const item of [intro, summary]) if (item) text(page, `${str(item.title) ? `<h3>${str(item.title)}</h3>` : ''}${str(item.description)}`); return; }
        const props: Record<string, unknown> = {
          ...(variant === 'timeline' ? { presentation: 'timeline' } : {}),
          items: steps.map((item, i) => {
            const { title, markdown, picture } = part(item, ['items', i], `${i + 1}`);
            // A step's picture without alt is decorative (its text says what matters).
            const shown = 'image' in picture && !('alt' in picture) ? { ...picture, decorative: true } : picture;
            return { id: `i${i + 1}`, title, markdown, ...shown, ...(variant === 'timeline' && htmlToText(str(item.date)) ? { date: clip(htmlToText(str(item.date)), 40) } : {}) };
          })
        };
        // The intro's and the summary's pictures: an empty alt when the source gives none (decorative).
        for (const [key, item] of [['intro', intro], ['summary', summary]] as const) {
          if (!item) continue;
          const { title, markdown, picture } = part(item, [key], key === 'intro' ? 'Introduction' : 'Synthèse');
          props[key] = { title, ...(markdown ? { markdown } : {}), ...('image' in picture ? { image: '', alt: String(picture.alt ?? '') } : {}) };
        }
        if (all.length > 20) losses.push({ page: page.title, item: ref, feature: `Étapes au-delà de vingt (Rise ${variant})`, detail: `${all.length - 20}` });
        push(page, { ref, kind: 'block', type: 'steps', props, media });
        return;
      }
      case 'flashcard':
      case 'stack': {
        // Flip cards (D63): the front's words as the title and its picture, the back's words behind.
        const side = (card: Json) => htmlToText(str(obj(card).description));
        const cards = items.map((item, i) => {
          const front = obj(item.front);
          const back = obj(item.back);
          const found = image(front);
          if (image(back) && str(back.type) === 'fullimage') losses.push({ page: page.title, item: ref, feature: 'Image au dos d\'une carte (Rise flashcard)', detail: side(front) || `${i + 1}` });
          const title = side(front) || (found?.alt ? clip(found.alt, 200) : `${i + 1}`);
          return { title: clip(title, 200), markdown: htmlToMarkdown(str(back.description)) || side(back), ...(found ? { media: found.media, alt: found.alt ?? '' } : {}) };
        });
        push(page, { ref, kind: 'accordion', presentation: variant === 'stack' ? 'stack' : 'cards', items: cards });
        return;
      }
      case 'knowledge':
        for (const item of items) readQuestion(item, page, ref, false);
        return;
      case 'button':
      case 'button stack': {
        for (const item of items) {
          const label = htmlToText(str(item.label)) || 'Ouvrir';
          const description = htmlToMarkdown(str(item.description));
          const destination = str(item.destination);
          const kind = str(item.type);
          if (description) text(page, item.description);
          if (kind === 'lesson' && lessonIds.has(destination)) {
            const buttonRef = nextRef('button');
            push(page, { ref: buttonRef, kind: 'button', label });
            page.triggers.push({ ref: nextRef('trigger'), on: { type: 'click', item: buttonRef }, conditions: [], actions: [{ type: 'go-to', page: destination }] } satisfies SourceTrigger);
          } else if (kind === 'exit-course') {
            const buttonRef = nextRef('button');
            push(page, { ref: buttonRef, kind: 'button', label });
            page.triggers.push({ ref: nextRef('trigger'), on: { type: 'click', item: buttonRef }, conditions: [], actions: [{ type: 'exit' }] });
          } else if (/^(https?:|mailto:)/.test(destination) || kind === 'email') {
            const url = kind === 'email' && !destination.startsWith('mailto:') ? `mailto:${destination}` : destination;
            push(page, { ref: nextRef('link'), kind: 'text', markdown: `[${label.replace(/[[\]]/g, '')}](${url})`, fallbackOf: { feature: 'Bouton lien (Rise button)', detail: 'un lien dans le texte' } });
          } else push(page, { ref: nextRef('button'), kind: 'unsupported', feature: 'Bouton (Rise button)', detail: destination || kind });
        }
        return;
      }
      case 'sorting': {
        // Sort into categories (D63), unscored as Rise's is; more than twelve cards make several.
        const piles = list(block.piles);
        const cards = items.map((item) => ({ text: clip(htmlToText(str(item.title)), 200), target: `pile-${str(item.pileId)}` })).filter((card) => card.text);
        const targets = piles.map((pile) => ({ ref: `pile-${str(pile.id)}`, text: clip(htmlToText(str(pile.title)) || str(pile.id), 200) }));
        const chunks = Math.max(1, Math.ceil(cards.length / 12));
        for (let n = 0; n < chunks; n++) {
          const share = cards.slice(Math.round((n * cards.length) / chunks), Math.round(((n + 1) * cards.length) / chunks));
          push(page, {
            ref: n ? `${ref}-${n + 1}` : ref, kind: 'sort', presentation: 'categories', items: share, targets, scored: false,
            ...(n === 0 && chunks > 1 ? { fallbackOf: { feature: 'Activité de tri (Rise sorting)', detail: `${chunks} activités de douze cartes au plus` } } : {})
          });
        }
        return;
      }
      case 'scenario': {
        const dialogue = readScenario(block, items);
        if (dialogue) push(page, { ref, kind: 'dialogue', ...dialogue });
        else push(page, { ref, kind: 'unsupported', feature: 'Scénario (Rise scenario)', detail: 'vide' });
        return;
      }
      case 'storyline':
        push(page, { ref, kind: 'unsupported', feature: 'Bloc Storyline dans Rise', detail: 'importez sa publication à part' });
        return;
      default:
        push(page, { ref, kind: 'unsupported', feature: `Rise ${feature}` });
    }
  }

  // Rise's scenario block (D61): scenes (items) of contents (slides). A content is a character's line
  // (its description; a text content may hide the character: a narration), with its scene description
  // for screen readers (a narration before it), and up to three answers (responses), each with its
  // feedback and where it goes: the next content, another content or scene, try again, or the end
  // (End Scenario). The scene's character speaks every line of the scene. Poses, backdrops and the
  // marks of the newer format are read when they are there; poses and backdrops are not kept.
  function readScenario(block: Json, scenes: Json[]): { title?: string; nodes: SourceDialogueNode[]; lost?: { feature: string; detail?: string }[] } | null {
    const nodes: SourceDialogueNode[] = [];
    const sceneFirst = new Map<string, string>();
    const slideRefs = new Set<string>();
    const lost: { feature: string; detail?: string }[] = [];
    let poses = 0;
    let backgrounds = 0;
    const characterOf = (scene: Json): string => htmlToText(str(obj(scene.character).name) || str(scene.characterName) || str(obj(scene.character).title)) || 'Personnage';
    const destination = (holder: Json): string | Json => {
      for (const key of ['destination', 'goTo', 'goto', 'target', 'next', 'link']) {
        const value = holder[key];
        if (typeof value === 'string' && value) return value;
        if (value && typeof value === 'object') return value as Json;
      }
      return '';
    };
    // Every content and scene first: an answer may go to one further on.
    scenes.forEach((scene, sceneIndex) => list(scene.slides).forEach((slide, slideIndex) => {
      const ref = str(slide.id) || `s${sceneIndex + 1}-${slideIndex + 1}`;
      if (slideIndex === 0) sceneFirst.set(str(scene.id) || `scene-${sceneIndex}`, ref);
      slideRefs.add(ref);
    }));
    scenes.forEach((scene, sceneIndex) => {
      const character = characterOf(scene);
      if (obj(scene.background).media || scene.background && typeof scene.background === 'string' || obj(scene.media).image) backgrounds++;
      list(scene.slides).forEach((slide, slideIndex) => {
        const ref = str(slide.id) || `s${sceneIndex + 1}-${slideIndex + 1}`;
        if (str(slide.characterPose) || str(slide.pose) || obj(slide.character).pose) poses++;
        const lines: SourceDialogueNode['lines'] = [];
        const description = htmlToText(str(slide.sceneDescription) || str(slide.altText) || str(slide.accessibilityDescription));
        if (description) lines.push({ text: description });
        const said = htmlToText(str(slide.dialogue) || str(slide.description) || str(slide.text) || str(slide.title));
        const hidden = slide.hideCharacter === true || slide.characterHidden === true || obj(slide.character).hidden === true;
        if (said) lines.push(hidden ? { text: said } : { speaker: character, text: said });
        const options: SourceDialogueOption[] = list(slide.responses).map((response) => {
          if (str(response.pose) || str(response.characterPose)) poses++;
          const text = htmlToText(str(response.description) || str(response.text) || str(response.title));
          const feedback = htmlToMarkdown(str(response.feedback)) || htmlToMarkdown(str(obj(response.feedback).description));
          const mark = str(response.correctness || response.type || response.status || (response.correct === true ? 'correct' : response.correct === false ? 'incorrect' : '')).toLowerCase();
          const quality = mark === 'correct' ? 'good' : mark === 'neutral' ? 'ok' : mark === 'incorrect' || mark === 'wrong' ? 'bad' : undefined;
          return { text: text || '…', ...(feedback ? { feedback } : {}), ...(quality ? { quality } : {}), to: target(destination(response)) };
        });
        nodes.push({ ref, ...(str(scene.title) && slideIndex === 0 ? { title: htmlToText(str(scene.title)) } : {}), lines, options });
      });
    });
    // Where an answer goes: the next content (null: the node's way out), a content or a scene, try
    // again, the end.
    function target(value: string | Json): SourceDialogueOption['to'] {
      const kind = (typeof value === 'string' ? value : str(value.type) || str(value.kind) || str(value.action)).toLowerCase();
      const id = typeof value === 'string' ? value : str(value.id) || str(value.slideId) || str(value.contentId) || str(value.sceneId) || str(value.target);
      if (/end/.test(kind)) return { end: true };
      if (/retry|try|again|repeat/.test(kind)) return { retry: true };
      if (id && (slideRefs.has(id) || sceneFirst.has(id))) return { node: id };
      return null;
    }
    // Targets named by scene go to its first content.
    for (const node of nodes) for (const option of node.options) {
      if (option.to && 'node' in option.to && sceneFirst.has(option.to.node) && !slideRefs.has(option.to.node)) option.to = { node: sceneFirst.get(option.to.node)! };
    }
    if (!nodes.length) return null;
    if (poses) lost.push({ feature: 'Poses du personnage (Rise scenario)', detail: `${poses}` });
    if (backgrounds) lost.push({ feature: 'Arrière-plans de scène (Rise scenario)', detail: `${backgrounds}` });
    const title = htmlToText(str(block.title));
    return { ...(title ? { title } : {}), nodes, ...(lost.length ? { lost } : {}) };
  }

  function readQuestion(item: Json, page: SourcePage, ref: string, inQuiz: boolean) {
    const type = str(item.type) || 'MULTIPLE_CHOICE';
    const stem = htmlToMarkdown(str(item.title)) || 'Question';
    const answers = list(item.answers);
    const correctIds = new Set<string>([str(item.correct), ...(Array.isArray(item.corrects) ? (item.corrects as unknown[]).map(str) : [])].filter(Boolean));
    if (type === 'MULTIPLE_CHOICE' || type === 'MULTIPLE_RESPONSE') {
      const feedbackType = str(item.feedbackType);
      const same = feedbackType === 'ANY' ? htmlToMarkdown(str(item.feedback)) : '';
      push(page, {
        ref, kind: 'quiz', stem, mode: type === 'MULTIPLE_RESPONSE' ? 'multiple' : 'single',
        options: answers.map((answer) => ({
          text: htmlToText(str(answer.title)),
          // In quizzes the correct ids are the truth (the flags may be stale).
          correct: inQuiz && correctIds.size ? correctIds.has(str(answer.id)) : answer.correct === true,
          feedback: feedbackType === 'CHOICE' ? htmlToMarkdown(str(answer.feedback)) || undefined : same || undefined
        })),
        correctFeedback: feedbackType === 'CORRECT_INCORRECT' ? htmlToMarkdown(str(item.feedbackCorrect)) || undefined : undefined,
        incorrectFeedback: feedbackType === 'CORRECT_INCORRECT' ? htmlToMarkdown(str(item.feedbackIncorrect)) || undefined : undefined
      });
      return;
    }
    const feedback = (): { correctFeedback?: string; incorrectFeedback?: string } => {
      const same = htmlToMarkdown(str(item.feedback));
      const correct = htmlToMarkdown(str(item.feedbackCorrect)) || same;
      const incorrect = htmlToMarkdown(str(item.feedbackIncorrect)) || same;
      return { ...(correct ? { correctFeedback: correct } : {}), ...(incorrect ? { incorrectFeedback: incorrect } : {}) };
    };
    if (type === 'FILL_IN_THE_BLANK') {
      // A text with one blank (D63), typed; Rise accepts any of its answers.
      const accepted = [...new Set(answers.map((answer) => htmlToText(str(answer.title)).replace(/[|[\]]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))];
      if (!accepted.length) { push(page, { ref, kind: 'fallback', feature: 'Texte à trous (Rise fill in the blank)', markdown: stem, detail: 'aucune réponse acceptée' }); return; }
      const blank = `[[${accepted.join('|')}]]`;
      const marker = /(?:\\_){2,}|_{2,}/;
      push(page, { ref, kind: 'fill-in', ...(marker.test(stem) ? { markdown: stem.replace(marker, blank) } : { stem, markdown: blank }), ...feedback() });
      return;
    }
    if (type === 'MATCHING') {
      // Pairs to match (D63): each left side to its right side.
      const pairs = answers.map((answer, i) => ({ text: htmlToText(str(answer.title)), match: htmlToText(str(answer.matchTitle)), ref: `match-${i + 1}` })).filter((pair) => pair.text && pair.match);
      push(page, { ref, kind: 'sort', presentation: 'pairs', stem, items: pairs.map((pair) => ({ text: pair.text, target: pair.ref })), targets: pairs.map((pair) => ({ ref: pair.ref, text: pair.match })), ...feedback() });
      return;
    }
    if (type === 'DRAW_FROM_QUESTION_BANK') {
      push(page, { ref, kind: 'unsupported', feature: 'Questions tirées d\'une banque (Rise question bank)' });
      return;
    }
    push(page, { ref, kind: 'unsupported', feature: `Question Rise ${type}` });
  }

  function readQuizLesson(lesson: Json, page: SourcePage) {
    const settings = obj(lesson.settings);
    const score = Number(settings.passingScore);
    if (Number.isFinite(score) && score > 0) passingScore = score;
    for (const item of list(lesson.items)) readQuestion(item, page, str(item.id) || nextRef('question'), true);
    if (str(settings.revealAnswers) === 'none' || settings.randomizeQuestionOrder === true) {
      losses.push({ page: page.title, feature: 'Réglages du quiz Rise', detail: [settings.randomizeQuestionOrder === true ? 'ordre aléatoire' : '', str(settings.revealAnswers) === 'none' ? 'réponses cachées' : ''].filter(Boolean).join(', ') });
    }
    push(page, { ref: nextRef('results'), kind: 'results' });
  }

  const fonts = { body: str(course.bodyTypeface) || undefined, heading: str(course.headingTypeface) || undefined };
  return {
    kind: 'rise',
    title: htmlToText(str(course.title)) || 'Module Rise',
    description: htmlToText(str(course.description)) || undefined,
    language: str(labelSet.iso639Code) || undefined,
    sections: sections.filter((entry) => entry.pages.length),
    variables: [],
    passingScore,
    accentColor: /^#[0-9a-f]{6}$/i.test(str(course.color)) ? str(course.color) : undefined,
    fonts: fonts.body || fonts.heading ? fonts : undefined,
    navigation: str(course.navigationMode) === 'restricted' ? 'linear' : 'free',
    losses
  };
}
