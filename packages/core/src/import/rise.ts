import { htmlToMarkdown, htmlToText } from './html-markdown.ts';
import type { SourceCourse, SourceSection, SourcePage, SourceItem, SourceMedia, SourceTrigger, ReaderLoss, SourceDialogueNode, SourceDialogueOption } from './model.ts';

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
  const image = (holder: unknown): { media: SourceMedia; alt?: string } | null => {
    const media = obj(obj(obj(holder).media).image);
    const path = mediaFile(media);
    if (!path) return null;
    return { media: { path, kind: 'image' }, alt: str(media.alt) || undefined };
  };

  const sections: SourceSection[] = [];
  let section: SourceSection | null = null;
  const ensureSection = () => {
    if (!section) { section = { ref: 'section-0', title: str(course.title) || 'Module', pages: [] }; sections.push(section); }
    return section;
  };
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
    if (type === 'quiz') readQuizLesson(lesson, page);
    else for (const block of list(lesson.items)) readBlock(block, page);
    if (type !== 'quiz' && type !== 'blocks' && type !== '') losses.push({ page: title, feature: `Rise lesson "${type}"`, detail: 'read as a lesson of blocks' });
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
    switch (type) {
      case 'text': {
        if (family === 'impact') {
          for (const item of items) {
            const markdown = htmlToMarkdown(str(item.paragraph));
            const title = htmlToText(str(item.heading));
            if (markdown || title) push(page, { ref, kind: 'callout', variant: variant === 'note' ? 'info' : 'important', ...(title && variant !== 'note' ? { title } : {}), markdown: markdown || title });
          }
          return;
        }
        if (variant === 'two column') {
          for (const item of items) text(page, item.paragraph, { width: 'half' });
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
          push(page, { ref, kind: 'text', markdown: `${quote.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')}${name ? `\n\n— ${name}` : ''}`, fallbackOf: { feature: 'Citation (Rise quote)' } });
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
        const gallery = family === 'gallery';
        items.forEach((item, i) => {
          const found = image(item);
          if (!found) return;
          const caption = htmlToText(str(item.caption));
          const imageItem: SourceItem = { ref: `${ref}-${i}`, kind: 'image', media: found.media, alt: found.alt, ...(caption ? { caption } : {}) };
          if (gallery && i === 0) imageItem.fallbackOf = { feature: `Galerie (Rise ${variant || 'gallery'})`, detail: 'images l\'une sous l\'autre' };
          if (variant === 'text aside' && i === 0) imageItem.width = 'half';
          push(page, imageItem);
          if (!gallery && str(item.paragraph)) text(page, item.paragraph, variant === 'text aside' ? { width: 'half' } : {});
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
            const url = str(embed.originalUrl) || (/src="([^"]+)"/.exec(str(embed.src))?.[1] ?? str(embed.src));
            const label = str(embed.title) || title || url;
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
        const rows = items.map((item) => `| ${htmlToText(str(item.type) || str(item.label)).replace(/\|/g, '/')} | ${str(item.value)} |`);
        const head = `| ${htmlToText(str(block.itemsLabel)) || ' '} | ${htmlToText(str(block.valuesLabel)) || ' '} |\n| --- | --- |`;
        push(page, { ref, kind: 'fallback', feature: `Graphique (Rise ${variant || 'chart'})`, markdown: `${htmlToText(str(block.title)) ? `**${htmlToText(str(block.title))}**\n\n` : ''}${head}\n${rows.join('\n')}`, detail: 'un tableau de ses valeurs' });
        return;
      }
      case 'divider':
        if (family === 'continue') {
          const item = items[0] ?? {};
          const completion = str(item.type);
          push(page, { ref, kind: 'continue', opens: completion === 'completeBlock' || completion === 'completeAll' ? 'answered' : 'continue', label: htmlToText(str(item.title)) || undefined });
        } else push(page, { ref, kind: 'shape', name: `Rise ${variant || 'divider'}` });
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
        push(page, { ref, kind: 'accordion', items: entries('title', 'description') });
        return;
      case 'tabs':
        push(page, { ref, kind: 'accordion', items: entries('title', 'description'), fallbackOf: { feature: 'Onglets (Rise tabs)', detail: 'un accordéon' } });
        return;
      case 'labeledgraphic': {
        const found = image(block);
        if (found) push(page, { ref: `${ref}-image`, kind: 'image', media: found.media, alt: found.alt });
        push(page, { ref, kind: 'accordion', items: items.map((item, i) => ({ title: `${i + 1}. ${htmlToText(str(item.title)) || ''}`.trim(), markdown: htmlToMarkdown(str(item.description)) })), fallbackOf: { feature: 'Image interactive (Rise labeled graphic)', detail: 'l\'image, puis ses repères dans un accordéon' } });
        return;
      }
      case 'process':
      case 'timeline': {
        const parts = items.filter((item) => item.isHidden !== true).map((item) => {
          const title = [htmlToText(str(item.date)), htmlToText(str(item.title))].filter(Boolean).join(' — ');
          const body = htmlToMarkdown(str(item.description));
          return `${title ? `### ${title}\n\n` : ''}${body}`.trim();
        }).filter(Boolean);
        if (parts.length) push(page, { ref, kind: 'text', markdown: parts.join('\n\n'), fallbackOf: { feature: variant === 'process' ? 'Processus (Rise process)' : 'Frise (Rise timeline)', detail: 'ses étapes en un texte' } });
        return;
      }
      case 'flashcard':
      case 'stack': {
        const side = (card: Json) => htmlToText(str(obj(card).description)) || (obj(card).media ? '(image)' : '');
        push(page, { ref, kind: 'accordion', items: items.map((item, i) => ({ title: side(item.front as Json) || `${i + 1}`, markdown: htmlToMarkdown(str(obj(item.back).description)) || side(item.back as Json) })), fallbackOf: { feature: 'Cartes à retourner (Rise flashcards)', detail: 'un accordéon' } });
        return;
      }
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
        const piles = list(block.piles);
        const lines = piles.map((pile) => `**${htmlToText(str(pile.title))}** : ${items.filter((item) => str(item.pileId) === str(pile.id)).map((item) => htmlToText(str(item.title))).join(', ')}`);
        push(page, { ref, kind: 'fallback', feature: 'Activité de tri (Rise sorting)', markdown: lines.join('\n\n'), detail: 'ses piles et leurs cartes en texte' });
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
    if (type === 'FILL_IN_THE_BLANK') {
      push(page, { ref, kind: 'fallback', feature: 'Texte à trous (Rise fill in the blank)', markdown: stem, detail: `réponses acceptées : ${answers.map((answer) => htmlToText(str(answer.title))).join(' / ')}` });
      return;
    }
    if (type === 'MATCHING') {
      push(page, { ref, kind: 'fallback', feature: 'Association (Rise matching)', markdown: `${stem}\n\n${answers.map((answer) => `- ${htmlToText(str(answer.title))} → ${htmlToText(str(answer.matchTitle))}`).join('\n')}`, detail: 'les paires en texte' });
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
