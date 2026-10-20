import { schemaId, FORMAT } from '@elabora/format';
import type { SourceCourse, SourcePage, SourceItem, SourceLayer, SourceTrigger, SourceAction, SourceMedia, SourceVariable, ImportKind } from './model.ts';
import { layoutTree, flatten, isBackground, visualTitle } from './layout.ts';
import type { LayoutNode } from './layout.ts';
import { decisionWords, lossMessage, blockNote, summarySentence, reportLanguage } from './report.ts';
import type { ImportReport, ImportLoss, ImportDecision, LossCode, LossStatus, DecisionId } from './report.ts';

// A course an importer read (model.ts) as the files of an Elabora module (docs/decisions.md D47):
// course.json, a draft plan with one item per screen, one screen per page, and the media to copy
// from the source into assets/. Pure: the reader gives the course, @elabora/node reads the source
// and writes the files. Every loss is reported, and the block that stands for a lost feature
// carries a note for the author.

export interface ImportChoices {
  presentation: 'slides' | 'scroll'; // Storyline: slides by default; Rise is always scroll
  backgrounds: 'drop' | 'keep';
  timing: 'together' | 'steps';
  fonts: 'substitute' | 'theme';
  mediaAccessibility: 'decorative' | 'errors';
}

// A font of the source, as the caller maps it to a font Elabora may embed.
export interface FontMapping {
  family: string; // a vetted family (packages/fonts)
  same: boolean; // the source's own family is vetted: nothing changes
}

export interface ConvertOptions {
  id?: string; // course id (a slug); from the title by default
  title?: string;
  language?: string; // BCP 47; the source's, else fr
  file?: string; // the source file's name, for the report
  choices?: Partial<ImportChoices>;
  mapFont?: (family: string) => FontMapping | null; // null: no font of the course
  hasMedia?: (path: string) => boolean; // whether the source holds a medium's file (default: yes)
}

export interface ConvertedMedia {
  from: string; // path in the source
  to: string; // project path (assets/…)
}

export interface ConvertResult {
  files: Map<string, string>; // project path → text (course.json, plan.json, screens/*.json)
  media: ConvertedMedia[];
  fonts: { family: string; for: ('body' | 'heading')[] }[]; // vetted fonts to add (elabora font add)
  report: ImportReport;
}

type Json = Record<string, unknown>;
interface Block extends Json { id: string; type: string; props: Json }

const SUPPORTED_MEDIA: Record<SourceMedia['kind'], RegExp> = {
  image: /\.(jpe?g|png|gif|webp|svg)$/i,
  video: /\.(mp4|webm|m4v|mpeg)$/i, // a .story keeps its videos as .mpeg parts that hold MP4
  audio: /\.(mp3|m4a|ogg|aac|wav)$/i
};
const MEDIA_FOLDER: Record<SourceMedia['kind'] | 'captions', string> = { image: 'images', video: 'video', audio: 'audio', captions: 'captions' };

export function slugify(text: string, fallback: string, max = 40): string {
  const slug = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  if (!slug) return fallback;
  return /^[a-z]/.test(slug) ? slug : `${fallback}-${slug}`.slice(0, max).replace(/-+$/, '');
}

const variableId = (name: string): string => {
  const words = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const id = words.map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join('').slice(0, 32);
  return /^[a-z]/.test(id) ? id : `v${id}`.slice(0, 32);
};

const plainText = (markdown: string): string => markdown.replace(/\\([\\`*_[\]$#>+-])/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function convertCourse(source: SourceCourse, options: ConvertOptions = {}): ConvertResult {
  const language = options.language || source.language || 'fr';
  const words = reportLanguage(language);
  const positioned = source.sections.some((section) => section.pages.some((page) => page.positioned));
  const choices: ImportChoices = {
    presentation: source.kind === 'rise' ? 'scroll' : 'slides',
    backgrounds: 'drop', timing: 'together', fonts: 'substitute', mediaAccessibility: 'decorative',
    ...options.choices
  };
  if (source.kind === 'rise') choices.presentation = 'scroll';
  const hasMedia = options.hasMedia ?? (() => true);
  const title = clip((options.title || source.title || (words === 'fr' ? 'Module importé' : 'Imported module')).trim(), 200);
  const courseId = options.id || slugify(title, 'imported', 48);

  const losses: ImportLoss[] = [];
  const decisions = new Map<DecisionId, { count: number; where: { screen: string; block?: string }[]; a?: string; b?: string; applied: string }>();
  const decide = (id: DecisionId, applied: string, where: { screen: string; block?: string } | null, a?: string, b?: string, by = 1) => {
    const key = (id === 'fonts' ? `fonts:${a}` : id) as DecisionId;
    const entry = decisions.get(key) ?? { count: 0, where: [], a, b, applied };
    entry.count += by;
    if (where) entry.where.push(where);
    decisions.set(key, entry);
  };
  const counts = { sections: 0, pages: 0, screens: 0, layers: 0, events: 0, items: 0, kept: 0, fallback: 0, notYet: 0, dropped: 0, decoration: 0, media: 0 };
  const lose = (code: LossCode, status: LossStatus, feature: string, where: { page?: string; source?: string; screen?: string; block?: string }, detail = '') => {
    losses.push({ code, status, feature, ...where, message: lossMessage(words, code, feature, detail) });
  };

  // Ids are unique in the course (sections, screens, layers, blocks, events).
  const taken = new Set<string>();
  const unique = (base: string): string => {
    let id = base.slice(0, 48).replace(/-+$/, '');
    for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 44).replace(/-+$/, '')}-${n}`;
    taken.add(id);
    return id;
  };
  const mediaNames = new Set<string>();
  const mediaByPath = new Map<string, string>();
  const media: ConvertedMedia[] = [];
  const assetFor = (medium: SourceMedia, hint: string, kind: SourceMedia['kind'] | 'captions' = medium.kind): string => {
    const known = mediaByPath.get(medium.path);
    if (known) return known;
    const extension = (/\.[a-z0-9]+$/i.exec(medium.path)?.[0] ?? '').toLowerCase().replace('.jpeg', '.jpg').replace('.mpeg', '.mp4');
    const folder = MEDIA_FOLDER[kind];
    const stem = slugify(hint || medium.path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), folder.replace(/s$/, ''), 40);
    let name = `${folder}/${stem}${extension}`;
    for (let n = 2; mediaNames.has(name); n++) name = `${folder}/${stem}-${n}${extension}`;
    mediaNames.add(name);
    mediaByPath.set(medium.path, name);
    media.push({ from: medium.path, to: `assets/${name}` });
    return name;
  };

  // Fonts: what each text of the source was set in.
  const fontUse = new Map<string, { texts: number; headings: number }>();
  for (const section of source.sections) for (const page of section.pages) for (const item of [...page.items, ...page.layers.flatMap((layer) => layer.items)]) {
    if (item.kind !== 'text') continue;
    for (const family of new Set(item.fonts ?? [])) {
      const use = fontUse.get(family) ?? { texts: 0, headings: 0 };
      use.texts++;
      if (item.heading || (item.fontSize ?? 0) >= 28) use.headings++;
      fontUse.set(family, use);
    }
  }

  // A source that names its typefaces for the whole course (Rise): every text in them.
  if (!fontUse.size && source.fonts) {
    let texts = 0;
    let headings = 0;
    for (const section of source.sections) for (const page of section.pages) for (const item of page.items) {
      if (item.kind === 'text' || item.kind === 'callout' || item.kind === 'accordion') texts++;
      if (item.kind === 'heading') headings++;
    }
    if (source.fonts.body && texts) fontUse.set(source.fonts.body, { texts, headings: source.fonts.heading === source.fonts.body ? headings : 0 });
    if (source.fonts.heading && headings && source.fonts.heading !== source.fonts.body) fontUse.set(source.fonts.heading, { texts: headings, headings });
  }

  // Variables: only those the triggers read or write (a variable for a text entry the importer
  // does not take would weigh in the learner's saved state for nothing); a string as long as the
  // longest value it is given.
  const used = new Map<string, number>(); // name → longest string value written
  const use = (name: string, value?: unknown) => used.set(name, Math.max(used.get(name) ?? 0, typeof value === 'string' ? value.length : 0));
  for (const section of source.sections) for (const page of section.pages) for (const trigger of [...page.triggers, ...page.layers.flatMap((layer) => layer.triggers)]) {
    if (trigger.on.type === 'variable-changed') use(trigger.on.variable);
    for (const condition of trigger.conditions) use(condition.variable, condition.value);
    for (const action of trigger.actions) if (action.type === 'set-variable') use(action.variable, action.value); else if (action.type === 'adjust-variable') use(action.variable);
  }
  const variables = new Map<string, string>(); // source name → Elabora id
  const variableTypes = new Map<string, SourceVariable['type']>(); // source name → type
  const courseVariables: Json[] = [];
  // A value as the variable's type; undefined when it cannot be one.
  const typed = (name: string, value: unknown): string | number | boolean | undefined => {
    const type = variableTypes.get(name);
    if (type === 'number') { const number = typeof value === 'number' ? value : Number(value); return Number.isFinite(number) && String(value).trim() !== '' ? number : undefined; }
    if (type === 'boolean') return value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
    return typeof value === 'string' ? value : String(value);
  };
  for (const variable of source.variables.filter((entry) => !used.has(entry.name))) {
    losses.push({ code: 'variable', status: 'dropped', feature: variable.name, message: lossMessage(words, 'variable', variable.name, words === 'fr' ? 'aucun déclencheur repris ne s\'en sert' : 'no trigger taken uses it') });
  }
  for (const variable of source.variables.filter((entry) => used.has(entry.name))) {
    let id = variableId(variable.name);
    for (let n = 2; [...variables.values()].includes(id); n++) id = `${variableId(variable.name).slice(0, 29)}${n}`;
    variables.set(variable.name, id);
    variableTypes.set(variable.name, variable.type);
    courseVariables.push(variable.type === 'string'
      ? { id, type: 'string', default: String(variable.default).slice(0, 200), maxLength: Math.min(200, Math.max(20, String(variable.default).length, used.get(variable.name) ?? 0)) }
      : { id, type: variable.type, default: variable.type === 'boolean' ? variable.default === true || variable.default === 'true' : Number(variable.default) || 0 });
  }

  // Pages first get their screen ids, so that triggers can jump to any of them.
  const screenIds = new Map<string, string>();
  for (const section of source.sections) for (const page of section.pages) {
    const pageTitle = page.title?.trim() || (words === 'fr' ? 'Écran' : 'Screen');
    screenIds.set(page.ref, unique(slugify(pageTitle, 'screen', 40)));
  }

  const sections: Json[] = [];
  const screenFiles = new Map<string, string>();
  const planItems: Json[] = [];
  let hasScored = false;
  let hasResults = false;

  for (const section of source.sections) {
    if (!section.pages.length) continue;
    counts.sections++;
    const sectionId = unique(slugify(section.title, 'section', 40));
    const sectionScreens: string[] = [];
    for (const page of section.pages) {
      counts.pages++;
      const screen = convertPage(page);
      sectionScreens.push(screen.id);
    }
    sections.push({ id: sectionId, title: clip(section.title?.trim() || title, 200), screens: sectionScreens });
  }

  function convertPage(page: SourcePage): { id: string } {
    const screenId = screenIds.get(page.ref)!;
    const pageTitle = page.title?.trim() || (words === 'fr' ? 'Écran' : 'Screen');
    const where = (block?: string) => ({ page: pageTitle, screen: screenId, ...(block ? { block } : {}) });
    const blockIds = new Map<string, string>(); // item ref → block id
    const layerIds = new Map<string, string>(); // layer ref → layer id
    const clickable = new Set<string>();
    const allTriggers = [...page.triggers, ...page.layers.flatMap((layer) => layer.triggers)];
    for (const trigger of allTriggers) if (trigger.on.type === 'click') clickable.add(trigger.on.item);
    const decorative = new Set<string>([...page.items, ...page.layers.flatMap((layer) => layer.items)].filter((item) => item.kind === 'shape' || item.kind === 'unsupported' || isBackground(item, source.slideSize)).map((item) => item.ref));
    const shownLater = new Set<string>();
    for (const trigger of allTriggers) for (const action of trigger.actions) if (action.type === 'show-item') shownLater.add(action.item);

    // The question's feedback layers become its feedback.
    const feedbackLayers = page.kind === 'question' ? page.layers.filter((layer) => layer.feedback) : [];
    // Its own heading ("Correct", "Incorrect") is the player's word, not the feedback.
    const layerText = (layer: SourceLayer) => layer.items.filter((item) => item.kind === 'text').map((item) => (item as { markdown: string }).markdown)
      .filter((markdown) => !/^\W*(correct|incorrect|try again|essayez encore|bonne réponse|mauvaise réponse)\W*$/i.test(markdown)).join('\n\n');

    let screenTitle = pageTitle;
    const slide = source.slideSize;
    let items = page.items;
    // A positioned page: its title, its backgrounds, then its reading order.
    let tree: LayoutNode;
    if (page.positioned) {
      const titleItem = visualTitle(items, slide);
      if (titleItem && titleItem.kind === 'text' && !clickable.has(titleItem.ref)) {
        screenTitle = clip(plainText(titleItem.markdown), 200) || pageTitle;
        items = items.filter((item) => item !== titleItem);
        counts.items++;
        counts.kept++;
      }
      const backgrounds = items.filter((item) => isBackground(item, slide) && !clickable.has(item.ref));
      items = items.filter((item) => !backgrounds.includes(item));
      tree = layoutTree(items.filter((item) => item.kind !== 'shape' || clickable.has(item.ref)));
      const decorations = items.filter((item) => item.kind === 'shape' && !clickable.has(item.ref));
      if (decorations.length) {
        counts.items += decorations.length;
        counts.dropped += decorations.length;
        counts.decoration += decorations.length;
        lose('decoration', 'dropped', words === 'fr' ? `${decorations.length} ${decorations.length === 1 ? 'forme' : 'formes'}` : `${decorations.length} ${decorations.length === 1 ? 'shape' : 'shapes'}`, where());
      }
      for (const background of backgrounds) {
        counts.items++;
        if (choices.backgrounds === 'keep' && background.kind === 'image') {
          tree = { kind: 'rows', children: [{ kind: 'item', item: { ...background, alt: undefined, decorative: true, box: undefined } }, tree] };
          decide('backgrounds', 'keep', { screen: screenId });
        } else {
          counts.dropped++;
          decide('backgrounds', 'drop', { screen: screenId });
          lose('background', 'dropped', background.name || background.ref, where());
        }
      }
    } else {
      const decorations = items.filter((item) => item.kind === 'shape' && !clickable.has(item.ref));
      if (decorations.length) {
        counts.items += decorations.length;
        counts.dropped += decorations.length;
        counts.decoration += decorations.length;
        lose('decoration', 'dropped', [...new Set(decorations.map((item) => item.name || (words === 'fr' ? 'séparateur' : 'divider')))].join(', '), where(), String(decorations.length));
      }
      tree = { kind: 'rows', children: items.filter((item) => !decorations.includes(item)).map((item) => ({ kind: 'item', item })) };
    }

    // Steps: Rise's continue dividers, or Storyline's start times when the author chose steps.
    const ordered = flatten(tree);
    const stepOf = new Map<SourceItem, number>();
    const stepSettings: Record<string, Json> = {};
    let step = 1;
    const starts = [...new Set(ordered.map((item) => item.start ?? 0).filter((start) => start > 0))].sort((a, b) => a - b);
    const timed = ordered.filter((item) => (item.start ?? 0) > 0);
    if (timed.length && page.positioned) {
      if (choices.timing === 'steps') decide('timing', 'steps', { screen: screenId }, undefined, undefined, timed.length);
      else decide('timing', 'together', { screen: screenId }, undefined, undefined, timed.length);
    }
    let activityAbove = false;
    for (const item of ordered) {
      if (item.kind === 'quiz' || item.kind === 'numeric') activityAbove = true;
      if (item.kind === 'continue') {
        if (step >= 12) { lose('steps', 'fallback', item.label || 'Continue', where()); continue; }
        step++;
        const setting: Json = {};
        // Opening once answered needs an activity above (E_STEP_UNREACHABLE): else Continue opens it.
        if (item.opens === 'answered' && activityAbove) setting.opens = 'answered';
        if (item.label && item.label.length <= 40) setting.label = item.label;
        if (Object.keys(setting).length) stepSettings[String(step)] = setting;
        counts.items++;
        counts.kept++;
        continue;
      }
      if (choices.timing === 'steps' && item.start && starts.length) stepOf.set(item, Math.min(12, 1 + starts.indexOf(item.start) + 1));
      else stepOf.set(item, step);
    }

    const toBlocks = (node: LayoutNode, inLayer: boolean): Block[] => {
      if (node.kind === 'item') return itemBlocks(node.item, inLayer);
      const children = node.children.map((child) => toBlocks(child, inLayer));
      // Two columns of one block each sit side by side (half width) on wide screens.
      if (node.kind === 'columns' && children.length === 2 && children.every((blocks) => blocks.length === 1) && !inLayer
        && children.every((blocks) => ['text', 'image', 'heading', 'callout'].includes(blocks[0].type)) && children[0][0].type !== 'heading') {
        for (const blocks of children) blocks[0].width = 'half';
      }
      return mergeTexts(children.flat());
    };

    // Consecutive plain texts of one step merge into one text block, as one column of reading.
    const mergeTexts = (blocks: Block[]): Block[] => {
      const out: Block[] = [];
      for (const block of blocks) {
        const last = out[out.length - 1];
        if (last && last.type === 'text' && block.type === 'text' && !last.hidden && !block.hidden && !last.width && !block.width
          && last.step === block.step && !last.note && !block.note && !isTarget(block.id) && !isTarget(last.id)) {
          last.props.markdown = `${last.props.markdown}\n\n${block.props.markdown}`;
          taken.delete(block.id);
          for (const [ref, id] of blockIds) if (id === block.id) blockIds.set(ref, last.id);
          continue;
        }
        out.push(block);
      }
      return out;
    };
    // Texts under an invisible hotspot become its button's label.
    const labelsOfHotspots = new Set<string>();
    for (const item of [...page.items, ...page.layers.flatMap((layer) => layer.items)]) {
      if (!clickable.has(item.ref)) continue;
      const under = textItemUnder(item);
      if (under && !clickable.has(under.ref)) labelsOfHotspots.add(under.ref);
    }
    // Items named by actions keep a block of their own (an event shows, hides or plays it).
    const targets = new Set<string>();
    for (const trigger of allTriggers) for (const action of trigger.actions) if ('item' in action) targets.add(action.item);
    const isTarget = (blockId: string) => [...targets].some((ref) => blockIds.get(ref) === blockId);

    const newBlock = (type: string, props: Json, item: SourceItem | null, extra: Json = {}): Block => {
      const id = unique(`${screenId.slice(0, 30)}-${type === 'free-object' ? 'object' : type}`);
      const block: Block = { id, type, props, ...extra };
      if (item) {
        if (!blockIds.has(item.ref)) blockIds.set(item.ref, id);
        if (item.hidden && shownLater.has(item.ref)) block.hidden = true;
        const itemStep = stepOf.get(item) ?? 1;
        if (itemStep > 1) block.step = itemStep;
      }
      return block;
    };
    const note = (block: Block, code: LossCode, feature: string, detail = '') => {
      const text = blockNote(words, code, feature, detail);
      block.note = block.note ? clip(`${block.note} ${text}`, 500) : text;
    };

    // The blocks of one item, a stand-in for a feature without its block reported as such.
    const itemBlocks = (item: SourceItem, inLayer: boolean): Block[] => {
      const keptBefore = counts.kept;
      const blocks = itemBlocksOf(item, inLayer);
      if (item.width === 'half' && blocks.length === 1 && !inLayer) blocks[0].width = 'half';
      if (item.fallbackOf && blocks.length) {
        if (counts.kept > keptBefore) { counts.kept--; counts.fallback++; }
        note(blocks[0], 'feature', item.fallbackOf.feature, item.fallbackOf.detail);
        lose('feature', 'fallback', item.fallbackOf.feature, where(blocks[0].id), item.fallbackOf.detail);
      }
      return blocks;
    };
    const itemBlocksOf = (item: SourceItem, inLayer: boolean): Block[] => {
      counts.items++;
      const label = item.name || ('media' in item && item.media ? item.media.path.replace(/^.*\//, '') : '') || item.ref;
      const isClickable = clickable.has(item.ref);
      if (item.hidden && !shownLater.has(item.ref) && !inLayer) {
        // Hidden and never shown by a trigger Elabora keeps: a state the importer cannot reach.
        counts.dropped++;
        lose('states', 'dropped', label, where(), words === 'fr' ? 'caché au départ, montré par un déclencheur non repris' : 'hidden at first, shown by a trigger not taken');
        return [];
      }
      if (item.states?.length) lose('states', 'fallback', label, where(), item.states.join(', '));
      switch (item.kind) {
        case 'text': {
          const text = plainText(item.markdown);
          if (!text) { counts.items--; return []; }
          if (labelsOfHotspots.has(item.ref)) { counts.kept++; return []; }
          if (isClickable) return [clickableButton(item, text, 'clickable')];
          counts.kept++;
          if (item.heading && text.length <= 200 && !item.markdown.includes('\n')) return [newBlock('heading', { text }, item)];
          return [newBlock('text', { markdown: item.markdown }, item)];
        }
        case 'heading':
          counts.kept++;
          return [newBlock('heading', { text: clip(item.text, 200), ...(item.level && item.level !== 2 ? { level: item.level } : {}) }, item)];
        case 'image': {
          const kept = mediaBlock(item, item.media, () => {
            const props: Json = { asset: assetFor(item.media, item.alt || item.name || '') };
            const alt = (item.alt ?? '').trim();
            if (item.decorative) props.decorative = true;
            else if (alt) props.alt = clip(alt, 250);
            else props.decorative = true;
            if (item.caption) props.caption = clip(item.caption, 300);
            const block = newBlock('image', props, item);
            if (!item.decorative && !alt) {
              decide('alt-missing', 'decorative', { screen: screenId, block: block.id });
              lose('alt-missing', 'fallback', label, where(block.id));
            }
            return block;
          });
          if (kept && isClickable) return [kept, clickableButton(item, item.alt || item.name || '', 'clickable')];
          return kept ? [kept] : [];
        }
        case 'video': {
          const kept = mediaBlock(item, item.media, () => {
            const props: Json = { asset: assetFor(item.media, item.title || item.name || ''), title: clip(item.title || item.name || (words === 'fr' ? 'Vidéo' : 'Video'), 200) };
            if (item.captions && hasMedia(item.captions.path) && /\.vtt$/i.test(item.captions.path)) props.captions = assetFor(item.captions, `${item.title || item.name || 'video'}-captions`, 'captions');
            if (item.transcript) props.transcript = item.transcript;
            const block = newBlock('video', props, item);
            if (!props.captions || !props.transcript) accessibility(block, item, props.captions ? 'transcript' : 'captions');
            return block;
          });
          return kept ? [kept] : [];
        }
        case 'audio': {
          const kept = mediaBlock(item, item.media, () => {
            const props: Json = { asset: assetFor(item.media, item.title || item.name || ''), title: clip(item.title || item.name || (words === 'fr' ? 'Son' : 'Sound'), 200) };
            if (item.transcript) props.transcript = item.transcript;
            const block = newBlock('audio', props, item);
            if (!props.transcript) accessibility(block, item, 'transcript');
            return block;
          });
          return kept ? [kept] : [];
        }
        case 'button':
          counts.kept++;
          return [newBlock('button', { label: clip(item.label || label, 80) }, item)];
        case 'callout':
          counts.kept++;
          return [newBlock('callout', { variant: item.variant ?? 'info', ...(item.title ? { title: clip(item.title, 120) } : {}), markdown: item.markdown }, item)];
        case 'accordion': {
          const entries = item.items.filter((entry) => entry.title.trim() || entry.markdown.trim()).slice(0, 12);
          if (!entries.length) { counts.dropped++; lose('unsupported', 'dropped', label, where(), words === 'fr' ? 'vide' : 'empty'); return []; }
          counts.kept++;
          return [newBlock('accordion', { items: entries.map((entry, i) => ({ id: `i${i + 1}`, title: clip(entry.title.trim() || `${i + 1}`, 200), markdown: entry.markdown.trim() || '—' })) }, item)];
        }
        case 'quiz': {
          let options = item.options.filter((option) => option.text.trim());
          if (options.length > 6) { lose('options', 'fallback', label, where(), options.slice(6).map((option) => option.text).join(' / ')); options = options.slice(0, 6); }
          if (options.length < 2 || !options.some((option) => option.correct)) {
            return [fallbackBlock(item, words === 'fr' ? 'Question' : 'Question', [item.stem, ...options.map((option) => `- ${option.text}`)].join('\n\n'), words === 'fr' ? 'moins de deux réponses ou aucune juste' : 'fewer than two answers or none correct')];
          }
          counts.kept++;
          if (item.scored !== false) hasScored = true;
          const feedbackFrom = (correct: boolean): string => {
            const given = correct ? item.correctFeedback : item.incorrectFeedback;
            if (given) return given;
            const layer = feedbackLayers.find((candidate) => candidate.feedback === (correct ? 'correct' : 'incorrect'));
            return layer ? layerText(layer) : '';
          };
          let generic = false;
          const props: Json = {
            stem: item.stem || (words === 'fr' ? 'Question' : 'Question'),
            // A single choice with several right answers is a multiple choice (Rise keeps such items).
            mode: item.mode === 'single' && options.filter((option) => option.correct).length > 1 ? 'multiple' : item.mode,
            options: options.map((option, i) => {
              let feedback = option.feedback || feedbackFrom(option.correct);
              // Elabora asks every option for its feedback (guardrail D1): a generic one until the author writes it.
              if (!feedback) { generic = true; feedback = option.correct ? (words === 'fr' ? 'C\'est une bonne réponse.' : 'This is a right answer.') : (words === 'fr' ? 'Ce n\'est pas la bonne réponse.' : 'This is not the right answer.'); }
              return { id: String.fromCharCode(97 + i), text: clip(option.text, 500), correct: option.correct, feedback };
            })
          };
          if (item.attempts && item.attempts > 1) props.attempts = Math.min(5, item.attempts);
          if (item.scored === false) props.scored = false;
          const quiz = newBlock('quiz', props, item);
          if (generic) {
            decide('quiz-feedback', 'generic', { screen: screenId, block: quiz.id });
            note(quiz, 'quiz-feedback', label);
            lose('quiz-feedback', 'fallback', label, where(quiz.id));
          }
          return [quiz];
        }
        case 'numeric': {
          counts.kept++;
          if (item.scored !== false) hasScored = true;
          const props: Json = { stem: item.stem, answer: item.answer, feedback: { correct: item.correctFeedback || (words === 'fr' ? 'Juste.' : 'Correct.'), incorrect: item.incorrectFeedback || (words === 'fr' ? 'Ce n\'est pas la valeur attendue.' : 'That is not the expected value.') } };
          if (item.tolerance) props.tolerance = { absolute: item.tolerance };
          if (item.unit) props.unit = item.unit;
          if (item.scored === false) props.scored = false;
          return [newBlock('numeric', props, item)];
        }
        case 'results':
          counts.kept++;
          hasResults = true;
          return [newBlock('results', {}, item)];
        case 'continue':
          return [];
        case 'shape':
          if (isClickable) return [clickableButton(item, item.name || '', 'hotspot')];
          counts.dropped++;
          counts.decoration++;
          lose('decoration', 'dropped', label, where());
          return [];
        case 'fallback': {
          if (item.media && SUPPORTED_MEDIA[item.media.kind].test(item.media.path) && hasMedia(item.media.path) && !item.media.contentLibrary && item.media.kind === 'image') {
            counts.fallback++;
            const props: Json = { asset: assetFor(item.media, item.alt || item.name || '') };
            if (item.alt) props.alt = clip(item.alt, 250); else props.decorative = true;
            const blocks: Block[] = [newBlock('image', props, item)];
            if (item.markdown?.trim()) blocks.push(newBlock('text', { markdown: item.markdown }, item));
            note(blocks[0], 'feature', item.feature, item.detail);
            lose('feature', 'fallback', item.feature, where(blocks[0].id), item.detail);
            return blocks;
          }
          if (item.markdown?.trim()) return [fallbackBlock(item, item.feature, item.markdown, item.detail)];
          counts.notYet++;
          lose('unsupported', 'not-yet', item.feature, where(), item.detail);
          return [];
        }
        case 'unsupported':
          counts.notYet++;
          lose(item.feature.toLowerCase().includes('javascript') ? 'javascript' : 'unsupported', item.feature.toLowerCase().includes('javascript') ? 'dropped' : 'not-yet', item.feature, where(), item.detail);
          return [];
      }
    };

    const fallbackBlock = (item: SourceItem, feature: string, markdown: string, detail?: string): Block => {
      counts.fallback++;
      const block = newBlock('text', { markdown }, item);
      note(block, 'feature', feature, detail);
      lose('feature', 'fallback', feature, where(block.id), detail);
      return block;
    };

    // An invisible hotspot over a text is named by that text (what the learner reads there).
    const textUnder = (item: SourceItem): string => {
      const under = textItemUnder(item);
      return under ? plainText(under.markdown) : '';
    };
    function textItemUnder(item: SourceItem): (SourceItem & { kind: 'text' }) | null {
      if (!item.box || item.kind !== 'shape') return null;
      const area = (a: NonNullable<SourceItem['box']>, b: NonNullable<SourceItem['box']>) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      const under = [...page.items, ...page.layers.flatMap((layer) => layer.items)]
        .filter((other): other is SourceItem & { kind: 'text' } => other.kind === 'text' && !!other.box && other.ref !== item.ref)
        .map((other) => ({ other, overlap: area(item.box!, other.box!) / Math.max(1, other.box!.width * other.box!.height) }))
        .filter(({ overlap }) => overlap > 0.5)
        .sort((a, b) => b.overlap - a.overlap)[0];
      return under && plainText(under.other.markdown).length <= 120 ? under.other : null;
    }

    const clickableButton = (item: SourceItem, text: string, code: 'clickable' | 'hotspot'): Block => {
      counts.fallback++;
      const labelText = clip(plainText(text) || (code === 'hotspot' ? textUnder(item) : '') || item.name || (words === 'fr' ? 'Ouvrir' : 'Open'), 80);
      const block = newBlock('button', { label: labelText }, null);
      blockIds.set(item.ref, block.id);
      if (item.hidden && shownLater.has(item.ref)) block.hidden = true;
      const itemStep = stepOf.get(item) ?? 1;
      if (itemStep > 1) block.step = itemStep;
      if (code === 'hotspot') {
        decide('hotspots', 'buttons', { screen: screenId, block: block.id });
        note(block, 'hotspot', item.name || item.ref);
      }
      lose(code, 'fallback', item.name || item.ref, where(block.id));
      return block;
    };

    const mediaBlock = (item: SourceItem, medium: SourceMedia, make: () => Block): Block | null => {
      const label = item.name || medium.path.replace(/^.*\//, '');
      if (medium.contentLibrary) {
        counts.dropped++;
        decide('content-library', 'drop', { screen: screenId });
        lose('content-library', 'dropped', label, where());
        pendingNotes.push(['content-library', label]);
        return null;
      }
      if (!SUPPORTED_MEDIA[medium.kind].test(medium.path)) {
        counts.notYet++;
        lose('media-format', 'not-yet', label, where(), medium.path.replace(/^.*\./, '.'));
        pendingNotes.push(['media-format', label]);
        return null;
      }
      if (!hasMedia(medium.path)) {
        counts.notYet++;
        lose('media-missing', 'not-yet', label, where(), medium.path);
        pendingNotes.push(['media-missing', label]);
        return null;
      }
      counts.kept++;
      counts.media++;
      return make();
    };
    // Notes of media left out go on the next block kept, so the author finds the place.
    const pendingNotes: [LossCode, string][] = [];

    // A video or a sound is named by its author's name, else its title (Rise's caption), else its id.
    const accessibility = (block: Block, item: SourceItem, missing: 'captions' | 'transcript') => {
      const name = item.name || ('title' in item && item.title) || item.ref;
      lose('media-accessibility', 'fallback', name, where(block.id), missing);
      if (choices.mediaAccessibility === 'decorative') {
        block.props.decorative = true;
        note(block, 'media-accessibility', name, missing);
        decide('media-accessibility', 'decorative', { screen: screenId, block: block.id });
      } else decide('media-accessibility', 'errors', { screen: screenId, block: block.id });
    };

    let blocks = toBlocks(tree, false);
    // Pending notes of media left out: on the block that follows (or the last one).
    const placeNotes = (list: Block[]) => {
      while (pendingNotes.length) {
        const [code, label] = pendingNotes.shift()!;
        const target = list[list.length - 1];
        if (target) note(target, code, label);
      }
    };
    placeNotes(blocks);

    // Layers: Storyline's, as Elabora layers; a question's feedback layers went into its feedback.
    const layers: Json[] = [];
    for (const layer of page.layers) {
      if (feedbackLayers.includes(layer)) {
        lose('feedback-layer', 'fallback', layer.title, where());
        counts.items += layer.items.length;
        counts.fallback += layer.items.length;
        continue;
      }
      const layerItems = layer.items.filter((item) => item.kind !== 'shape' || clickable.has(item.ref));
      const layerTree = page.positioned ? layoutTree(layerItems.filter((item) => !isBackground(item, slide))) : { kind: 'rows' as const, children: layerItems.map((item) => ({ kind: 'item' as const, item })) };
      const layerBlocks = toBlocks(layerTree, true).map((block) => { delete block.step; delete block.width; return block; });
      placeNotes(layerBlocks);
      const dropped = layer.items.length - layerItems.length;
      if (dropped) { counts.items += dropped; counts.dropped += dropped; counts.decoration += dropped; }
      if (!layerBlocks.length) { lose('layer-empty', 'dropped', layer.title, where()); continue; }
      const id = unique(`${screenId.slice(0, 30)}-${slugify(layer.title, 'layer', 16)}`);
      layerIds.set(layer.ref, id);
      layers.push({ id, title: clip(layer.title || (words === 'fr' ? 'Calque' : 'Layer'), 200), presentation: layer.modal ? 'dialog' : 'panel', blocks: layerBlocks });
      counts.layers++;
    }

    // Triggers → events.
    const events: Json[] = [];
    const blockTypes = new Map<string, string>();
    const walk = (list: Json[]) => { for (const block of list as Block[]) { blockTypes.set(block.id, block.type); if (Array.isArray(block.blocks)) walk(block.blocks as Json[]); } };
    walk(blocks);
    for (const layer of layers) walk(layer.blocks as Json[]);
    for (const trigger of page.kind === 'question' ? allTriggers.filter((trigger) => trigger.on.type !== 'click' || blockTypes.get(blockIds.get(trigger.on.item) ?? '') === 'button') : allTriggers) {
      const event = convertTrigger(trigger);
      if (!event) continue;
      // Storyline writes one trigger per action: those with the same trigger and conditions are one event.
      const same = events.find((other) => JSON.stringify(other.on) === JSON.stringify(event.on) && JSON.stringify(other.if ?? null) === JSON.stringify(event.if ?? null));
      if (same) { (same.do as Json[]).push(...(event.do as Json[])); taken.delete(event.id as string); continue; }
      events.push(event);
      counts.events++;
    }

    function convertTrigger(trigger: SourceTrigger): Json | null {
      const label = trigger.on.type === 'other' ? trigger.on.label : trigger.on.type;
      let on: Json | null = null;
      switch (trigger.on.type) {
        case 'click': {
          const block = blockIds.get(trigger.on.item);
          if (block && blockTypes.get(block) === 'button') on = { type: 'click', target: block };
          break;
        }
        case 'page-start': on = { type: 'screen.enter' }; break;
        case 'layer-closed': { const layer = layerIds.get(trigger.on.layer); if (layer) on = { type: 'layer.closed', target: layer }; break; }
        case 'media-ended': { const block = blockIds.get(trigger.on.item); if (block && ['audio', 'video'].includes(blockTypes.get(block) ?? '')) on = { type: 'media.ended', target: block }; break; }
        case 'variable-changed': { const variable = variables.get(trigger.on.variable); if (variable) on = { type: 'variable.changed', variable }; break; }
        case 'page-end':
          // Going on at the end of the timeline is the player's Next; anything else has no timeline here.
          if (trigger.actions.every((action) => action.type === 'go-to' && action.page === 'next')) return null;
          break;
      }
      if (!on) { lose('trigger', 'not-yet', label, where()); return null; }
      const conditions: Json[] = [];
      for (const condition of trigger.conditions) {
        const variable = variables.get(condition.variable);
        const value = typed(condition.variable, condition.value);
        if (!variable || value === undefined) { lose('condition', 'not-yet', condition.variable, where()); return null; }
        conditions.push({ variable, op: condition.op, value });
      }
      const actions = trigger.actions.map(convertAction).filter((action): action is Json => action !== null);
      if (!actions.length) return null;
      return { id: unique(`${screenId.slice(0, 30)}-event`), on, ...(conditions.length ? { if: conditions } : {}), do: actions };
    }

    function convertAction(action: SourceAction): Json | null {
      switch (action.type) {
        case 'go-to': {
          if (action.page === 'next' || action.page === 'previous') return { type: 'go-to', screen: action.page };
          const target = screenIds.get(action.page);
          if (target) return { type: 'go-to', screen: target };
          lose('action', 'not-yet', 'go-to', where(), action.page);
          return null;
        }
        case 'show-layer': { const layer = layerIds.get(action.layer); if (layer) return { type: 'show-layer', layer }; lose('action', 'not-yet', 'show-layer', where(), action.layer); return null; }
        case 'hide-layer': {
          // Closing a layer the screen does not have (a feedback layer that became feedback) does nothing.
          if (!layers.length) return null;
          const layer = action.layer ? layerIds.get(action.layer) : undefined;
          return layer ? { type: 'hide-layer', layer } : { type: 'hide-layer' };
        }
        case 'show-item':
        case 'hide-item': {
          const block = blockIds.get(action.item);
          if (block) return { type: action.type === 'show-item' ? 'show-block' : 'hide-block', block };
          // Showing or hiding decoration left to the theme is not a loss of its own.
          if (!decorative.has(action.item)) lose('action', 'not-yet', action.type, where(), action.item);
          return null;
        }
        case 'set-variable': {
          const variable = variables.get(action.variable);
          const value = typed(action.variable, action.value);
          if (variable && value !== undefined) return { type: 'set-variable', variable, value };
          lose('variable', 'not-yet', action.variable, where());
          return null;
        }
        case 'adjust-variable': {
          const variable = variables.get(action.variable);
          if (variable && variableTypes.get(action.variable) === 'number') return { type: 'increment-variable', variable, by: action.by };
          lose('variable', 'not-yet', action.variable, where());
          return null;
        }
        case 'play-media':
        case 'pause-media': {
          const block = blockIds.get(action.item);
          if (block && ['audio', 'video'].includes(blockTypes.get(block) ?? '')) return { type: action.type, block };
          lose('action', 'not-yet', action.type, where(), action.item);
          return null;
        }
        case 'exit': return { type: 'exit-course' };
        case 'other':
          if (/javascript/i.test(action.label)) lose('javascript', 'dropped', action.label, where());
          else lose('action', 'not-yet', action.label, where());
          return null;
      }
    }

    // A screen needs one block: an empty slide keeps its title as a heading.
    if (!blocks.length) blocks = [newBlock('heading', { text: screenTitle }, null)];
    // Headings never skip a level below the screen's title (level 1).
    const levels = (list: Block[]) => {
      let previous = 1;
      for (const block of list) {
        if (block.type !== 'heading') continue;
        const level = Math.min(Number(block.props.level ?? 2), previous + 1);
        if (level === 2) delete block.props.level; else block.props.level = level;
        previous = level;
      }
    };
    levels(blocks);
    for (const layer of layers) levels(layer.blocks as Block[]);

    const screen: Json = { $schema: schemaId('screen'), id: screenId, title: screenTitle, covers: [] as string[], blocks };
    const planId = `ITEM-${planItems.length + 1}`;
    screen.covers = [planId];
    if (Object.keys(stepSettings).length) screen.steps = stepSettings;
    if (layers.length) screen.layers = layers;
    if (events.length) screen.events = events;
    const kindOf = (): string => {
      if (page.kind === 'question' || blocks.some((block) => ['quiz', 'numeric'].includes(block.type))) return page.kind === 'question' ? 'assessment' : 'practice';
      if (page.kind === 'result') return 'summary';
      return planItems.length === 0 ? 'intro' : 'exposition';
    };
    const kind = kindOf();
    // Every item but an introduction or a summary serves an objective: the draft's one, to be written.
    const item: Json = { id: planId, kind, title: clip(screenTitle, 200), objectives: kind === 'intro' || kind === 'summary' ? [] : ['OBJ-1'] };
    if (page.notes?.trim()) {
      item.description = clip(page.notes.trim(), 2000);
      lose('notes', 'fallback', pageTitle, where());
    }
    planItems.push(item);
    screenFiles.set(`screens/${screenId}.json`, `${JSON.stringify(screen, null, 2)}\n`);
    counts.screens++;
    return { id: screenId };
  }

  // Reader losses.
  for (const loss of source.losses) {
    const status: LossStatus = /javascript/i.test(loss.feature) ? 'dropped' : 'not-yet';
    losses.push({ code: 'reader', status, feature: loss.feature, ...(loss.page ? { page: loss.page } : {}), ...(loss.item ? { source: loss.item } : {}), message: lossMessage(words, 'reader', loss.feature, loss.detail) });
    if (status === 'dropped') counts.dropped++; else counts.notYet++;
  }

  // Fonts: each family of the source as a vetted font, the most used for the body.
  const fonts: { family: string; for: ('body' | 'heading')[] }[] = [];
  if (options.mapFont && fontUse.size) {
    const byUse = [...fontUse].sort((a, b) => b[1].texts - a[1].texts || a[0].localeCompare(b[0]));
    const body = byUse[0][0];
    const heading = [...fontUse].sort((a, b) => b[1].headings - a[1].headings || a[0].localeCompare(b[0]))[0];
    for (const [family, use] of byUse) {
      const mapped = options.mapFont(family);
      if (!mapped) continue;
      if (!mapped.same) {
        decide('fonts', choices.fonts, null, family, mapped.family, use.texts);
        losses.push({ code: 'font', status: 'fallback', feature: family, message: lossMessage(words, 'font', family, mapped.family) });
      }
      if (choices.fonts === 'theme') continue;
      const roles: ('body' | 'heading')[] = [];
      if (family === body) roles.push('body');
      if (heading && heading[1].headings > 0 && family === heading[0] && family !== body) roles.push('heading');
      if (!roles.length) continue;
      const existing = fonts.find((font) => font.family === mapped.family);
      if (existing) existing.for.push(...roles.filter((role) => !existing.for.includes(role)));
      else fonts.push({ family: mapped.family, for: roles });
    }
  }

  if (positioned) decide('presentation', choices.presentation, null, choices.presentation, undefined, counts.screens);

  const course: Json = {
    $schema: schemaId('course'),
    format: FORMAT,
    id: courseId,
    title,
    language,
    version: '0.1.0',
    ...(source.description ? { description: clip(source.description, 1000) } : {}),
    sections,
    variables: courseVariables,
    theme: { cascade: 'components-over-theme' },
    presentation: { mode: choices.presentation },
    navigation: source.navigation === 'linear' ? { mode: 'linear', lockUntilComplete: true } : { mode: 'free', lockUntilComplete: false },
    completion: hasScored && hasResults && source.passingScore !== undefined
      ? { reportAs: 'passed-incomplete', masteryScore: Math.max(0, Math.min(100, Math.round(source.passingScore))) }
      : { reportAs: 'completed-incomplete' },
    tracking: { exitAfterCompletion: 'suspend', recordInteractions: true, heartbeatSeconds: 60 }
  };
  // The draft's objective is served by at least one item.
  if (planItems.length && !planItems.some((item) => (item.objectives as string[]).length)) planItems[0].objectives = ['OBJ-1'];
  const planIdBase = courseId.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24).replace(/-+$/, '') || 'IMPORT';
  const plan: Json = {
    $schema: schemaId('plan'),
    id: `PLAN-${planIdBase}`,
    title,
    businessGoal: '',
    audience: { role: '', priorKnowledge: 'low' },
    sources: [],
    objectives: [{ id: 'OBJ-1', statement: words === 'fr' ? 'À écrire : ce que l\'apprenant saura faire après ce module (le module importé n\'en disait rien).' : 'To write: what the learner will be able to do after this module (the imported module did not say).' }],
    items: planItems.length ? planItems : [{ id: 'ITEM-1', kind: 'intro', title, objectives: [] }],
    spacing: [],
    waivers: []
  };

  const files = new Map<string, string>();
  files.set('course.json', `${JSON.stringify(course, null, 2)}\n`);
  files.set('plan.json', `${JSON.stringify(plan, null, 2)}\n`);
  for (const [path, text] of screenFiles) files.set(path, text);

  const decisionList: ImportDecision[] = [...decisions].map(([key, entry]) => {
    const id = (key.startsWith('fonts:') ? 'fonts' : key) as DecisionId;
    const wording = decisionWords(words, id, entry.count, entry.a, entry.b, entry.applied);
    return { id, count: entry.count, title: wording.title, ...(wording.detail ? { detail: wording.detail } : {}), applied: entry.applied, accept: wording.accept, choices: wording.choices, where: entry.where };
  });
  const order: DecisionId[] = ['presentation', 'content-library', 'fonts', 'quiz-feedback', 'media-accessibility', 'backgrounds', 'timing', 'hotspots', 'alt-missing'];
  decisionList.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || b.count - a.count);

  const report: ImportReport = {
    format: 'elabora-import-report/1',
    beta: true,
    language: words,
    source: { kind: source.kind, file: options.file ?? null, title: source.title },
    summary: summarySentence(words, source.kind, counts, decisionList.length),
    choices,
    counts,
    decisions: decisionList,
    losses
  };
  return { files, media, fonts, report };
}

export type { ImportKind };
