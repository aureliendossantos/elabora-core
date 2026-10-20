import { parseXml, childNamed, childrenNamed, descendantsNamed, attribute, deepText, decodeEntities } from './xml.ts';
import type { XmlElement } from './xml.ts';
import { plainToMarkdown } from './html-markdown.ts';
import { storylineFontFamily } from './storyline-published.ts';
import type { SourceCourse, SourceSection, SourcePage, SourceItem, SourceLayer, SourceTrigger, SourceAction, SourceCondition, SourceVariable, SourceMedia, ReaderLoss, Box } from './model.ts';

// Storyline's source, the .story file: an OPC package (as .pptx is) of XML parts, `story/story.xml`
// (scenes, variables, quizzes, the media registry) and one part per slide (docs/decisions.md D47).
// Its XML is not documented: what is read here was checked on real projects (Storyline 3) and
// against the open-source storyline_MCP's writer (Storyline 360). It gives the structure, texts,
// pictures, layers, questions and simple triggers; what it does not know, it reports.

export interface StoryMediaFile {
  path: string; // story/media/<name>
  size: number;
  md5: string; // hex
}

export interface StorySource {
  files: ReadonlyMap<string, string>; // XML parts and .rels, by path in the package (no leading slash)
  media: readonly StoryMediaFile[];
  title?: string; // the package's title (docProps), when it has one
}

const NULL_GUID = '00000000-0000-0000-0000-000000000000';
const BUILT_IN_STATES = new Set(['normal', 'hover', 'down', 'visited', 'disabled', 'selected', 'hidden', 'drag over', 'drop correct', 'drop incorrect', 'review', 'selected disabled', 'down selected', 'hover selected', 'visited disabled']);
const QUESTION_TAGS: Record<string, 'single' | 'multiple'> = { multiChoiceIntr: 'single', trueFalseIntr: 'single', freePickOneIntr: 'single', pickOneIntr: 'single', multiResponseIntr: 'multiple', freePickManyIntr: 'multiple', pickManyIntr: 'multiple' };
const FALLBACK_QUESTIONS: Record<string, string> = {
  shortAnswerIntr: 'Texte à trous (Storyline fill in the blank)', freeTextEntryIntr: 'Texte à trous (Storyline fill in the blank)', fillInIntr: 'Texte à trous (Storyline fill in the blank)',
  dragDropIntr: 'Glisser-déposer (Storyline drag and drop)', matchDropDownIntr: 'Association (Storyline matching)', matchDragDropIntr: 'Association (Storyline matching)',
  seqDropDownIntr: 'Remise en ordre (Storyline sequence)', seqDragDropIntr: 'Remise en ordre (Storyline sequence)', numericEntryIntr: 'Réponse numérique (Storyline numeric)',
  hotSpotIntr: 'Zone à cliquer (Storyline hotspot)', freeHotSpotIntr: 'Zone à cliquer (Storyline hotspot)', wordBankIntr: 'Banque de mots (Storyline word bank)', likertIntr: 'Échelle de Likert (Storyline survey)', essay: 'Réponse libre (Storyline essay)'
};
const IGNORED_TAGS = new Set(['intrTitleTextBox', 'intrTextEntryBox', 'feedBackBtn', 'rsltBtn', 'dragDropPnl', 'radio', 'checkMark']);

const parse = (text: string | undefined): XmlElement | null => (text ? parseXml(text) : null);
const num = (value: string | undefined): number => Number(value) || 0;

// The rich text Storyline keeps beside the plain one: an XML document in a string,
// `Document > Content > Block > Span[@Text] > Style[@FontFamily, @FontSize, @FontIsBold…]`.
export function storyText(documentText: string): { markdown: string; fonts: string[]; fontSize?: number } {
  // Read from its part, the document is text already decoded once; written escaped twice, it is decoded here.
  const doc = parseXml(documentText.includes('<Document') ? documentText : decodeEntities(documentText));
  const fonts = new Set<string>();
  let fontSize = 0;
  const paragraphs: string[] = [];
  let index = 0;
  for (const block of descendantsNamed(doc, 'Block')) {
    const blockStyle = childNamed(block, 'Style');
    const listType = attribute(childNamed(blockStyle, 'ListStyle'), 'ListType') ?? 'None';
    const spans = childrenNamed(block, 'Span').map((span) => {
      const style = childNamed(span, 'Style');
      const family = storylineFontFamily(attribute(style, 'FontFamily') ?? '');
      if (family) fonts.add(family);
      fontSize = Math.max(fontSize, num(attribute(style, 'FontSize')));
      let value = plainToMarkdown(attribute(span, 'Text') ?? '').replace(/\n+/g, ' ');
      if (!value.trim()) return value;
      if (attribute(style, 'FontIsItalic') === 'True') value = `*${value.trim()}*`;
      if (attribute(style, 'FontIsBold') === 'True') value = `**${value.trim()}**`;
      return value;
    });
    const line = spans.join('').replace(/\*\*\*\*/g, '').trim();
    if (!line) continue;
    if (listType !== 'None') paragraphs.push(/bullet/i.test(listType) ? `- ${line}` : `${++index}. ${line}`);
    else { index = 0; paragraphs.push(line); }
  }
  const markdown = paragraphs.join('\n\n').replace(/(^|\n\n)(- |\d+\. )([^\n]*)\n\n(?=- |\d+\. )/g, '$1$2$3\n');
  return { markdown, fonts: [...fonts], ...(fontSize ? { fontSize } : {}) };
}

export function readStorylineSource(input: StorySource): SourceCourse {
  const losses: ReaderLoss[] = [];
  const story = parse(input.files.get('story/story.xml'));
  if (!story) throw new Error('story/story.xml is missing or unreadable: not a Storyline project.');
  const rels = (part: string): Map<string, string> => {
    const slash = part.lastIndexOf('/');
    const relsPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
    const map = new Map<string, string>();
    for (const rel of descendantsNamed(parse(input.files.get(relsPath)), 'Relationship')) map.set(attribute(rel, 'Id') ?? '', (attribute(rel, 'Target') ?? '').replace(/^\//, ''));
    return map;
  };
  const storyRels = rels('story/story.xml');

  // Media: each record of the registry, found among the package's files by its MD5, else its size.
  const bySize = new Map<number, StoryMediaFile[]>();
  for (const file of input.media) bySize.set(file.size, [...(bySize.get(file.size) ?? []), file]);
  const byMd5 = new Map(input.media.map((file) => [file.md5.toLowerCase(), file]));
  const mediaRecords = new Map<string, SourceMedia | null>();
  for (const record of [...descendantsNamed(story, 'media'), ...descendantsNamed(story, 'video'), ...descendantsNamed(story, 'audio')]) {
    const g = attribute(record, 'g');
    if (!g) continue;
    const md5 = deepText(childNamed(childNamed(record, 'md5Checksum'), 'stream')).trim().toLowerCase();
    const sized = bySize.get(num(attribute(record, 'bytes'))) ?? [];
    const extension = (attribute(record, 'displayName') ?? '').replace(/^.*\./, '').toLowerCase();
    const file = (md5 && byMd5.get(md5)) || (sized.length === 1 ? sized[0] : sized.find((candidate) => candidate.path.toLowerCase().endsWith(`.${extension}`)));
    const origin = `${attribute(record, 'origFile') ?? ''} ${attribute(record, 'source') ?? ''}`;
    // What Articulate installs (textures, the Content Library's characters and photos) may not leave its tools.
    const contentLibrary = /\\Articulate\\|\/Articulate\/|Content Library|ContentLibrary/i.test(origin);
    const kind: SourceMedia['kind'] = record.name.toLowerCase() === 'video' || /^(mp4|mov|wmv|avi|flv|m4v|mpeg)$/i.test(attribute(record, 'type') ?? '') ? 'video' : record.name.toLowerCase() === 'audio' || /^(mp3|wav|m4a|wma)$/i.test(attribute(record, 'type') ?? '') ? 'audio' : 'image';
    // A video part is named .mpeg in the package and holds an MP4.
    mediaRecords.set(g, file ? { path: file.path, kind, ...(contentLibrary ? { contentLibrary } : {}) } : contentLibrary ? { path: `articulate/${attribute(record, 'displayName') ?? g}`, kind, contentLibrary } : null);
  }

  const variables: SourceVariable[] = [];
  const variableNames = new Map<string, string>();
  for (const variable of descendantsNamed(childNamed(story, 'varLst'), 'var')) {
    const name = attribute(variable, 'name') ?? '';
    variableNames.set(attribute(variable, 'g') ?? '', name);
    if (attribute(variable, 'type') !== 'user' || !name) continue;
    const dataType = attribute(variable, 'dataType');
    const value = attribute(variable, 'val') ?? '';
    variables.push(dataType === 'bool' ? { name, type: 'boolean', default: value === 'true' } : dataType === 'num' ? { name, type: 'number', default: num(value) } : { name, type: 'string', default: value });
  }
  let passingScore: number | undefined;
  for (const quiz of descendantsNamed(childNamed(story, 'quizMgr'), 'quiz')) if (num(attribute(quiz, 'passPct')) > 0) passingScore = num(attribute(quiz, 'passPct'));

  let slideSize: { width: number; height: number } | undefined;
  const size = descendantsNamed(childNamed(story, 'propLst'), 'sz')[0];
  if (size && num(attribute(size, 'w')) > 0) slideSize = { width: num(attribute(size, 'w')), height: num(attribute(size, 'h')) };

  // Slides by their g, for jumps; then each scene's slides in order.
  const slideParts = new Map<string, XmlElement>();
  const sections: SourceSection[] = [];
  for (const scene of descendantsNamed(childNamed(story, 'sceneLst'), 'scene')) {
    const section: SourceSection = { ref: attribute(scene, 'g') ?? `scene-${sections.length + 1}`, title: attribute(scene, 'name') || `Scène ${sections.length + 1}`, pages: [] };
    for (const id of descendantsNamed(scene, 'sldId')) {
      const part = storyRels.get(deepText(id).trim());
      const slide = part ? parse(input.files.get(part)) : null;
      if (!slide) { losses.push({ feature: 'Diapositive illisible', detail: part ?? deepText(id) }); continue; }
      slideParts.set(attribute(slide, 'g') ?? part!, slide);
      section.pages.push({ ref: attribute(slide, 'g') ?? part!, title: '', kind: 'content', positioned: true, items: [], layers: [], triggers: [] });
    }
    if (section.pages.length) sections.push(section);
  }


  function readSlide(page: SourcePage, slide: XmlElement) {
    page.title = attribute(slide, 'name') || 'Diapositive';
    const notes = deepText(childNamed(slide, 'note')).trim();
    if (notes) { const text = storyText(notes).markdown; if (text) page.notes = text; }
    const stateOwners = new Map<string, string>(); // a state's g → the shape that has it
    readLayer(childNamed(slide, 'shapeLst'), childNamed(slide, 'trigLst'), page, page, stateOwners);
    for (const layer of childNamed(slide, 'sldLayerLst')?.children ?? []) {
      const name = attribute(layer, 'name') || attribute(layer, 'defaultName') || `Calque ${page.layers.length + 1}`;
      const feedbackName = (attribute(layer, 'defaultName') || name).toLowerCase();
      const isFeedback = layer.name === 'feedBackLayer' || (page.kind === 'question' && /^(correct|incorrect|try again)$/.test(feedbackName));
      const target: SourceLayer = {
        ref: attribute(layer, 'g') ?? name, title: name, modal: attribute(layer, 'modal') === 'true',
        ...(isFeedback ? { feedback: feedbackName.startsWith('incorrect') ? 'incorrect' as const : feedbackName.startsWith('try') ? 'try-again' as const : 'correct' as const } : {}),
        items: [], triggers: []
      };
      readLayer(childNamed(layer, 'shapeLst'), childNamed(layer, 'trigLst'), target, page, stateOwners);
      // A feedback layer's own heading ("Correct") is the player's word.
      if (target.feedback) target.items = target.items.filter((item) => !(item.kind === 'text' && /^\**\s*(correct|incorrect|try again)\s*!?\s*\**$/i.test(item.markdown)));
      page.layers.push(target);
    }
  }

  function readLayer(shapeList: XmlElement | null, triggerList: XmlElement | null, target: { items: SourceItem[]; triggers: SourceTrigger[] }, page: SourcePage, stateOwners: Map<string, string>) {
    const shapes = (shapeList?.children ?? []).filter((shape) => shape.name !== 'group');
    // Shapes inside groups are listed with them, flat; a group of its own shapes is read through.
    for (const group of (shapeList?.children ?? []).filter((shape) => shape.name === 'group')) shapes.push(...(childNamed(group, 'shapeLst')?.children ?? []));
    shapes.sort((a, b) => num(attribute(a, 'zOrder')) - num(attribute(b, 'zOrder')));
    for (const shape of shapes) for (const state of childrenNamed(childNamed(shape, 'stateLst'), 'state')) stateOwners.set(attribute(state, 'g') ?? '', attribute(shape, 'g') ?? '');
    const byG = new Map(shapes.map((shape) => [attribute(shape, 'g') ?? '', shape]));
    const consumed = new Set<string>();
    for (const shape of shapes) {
      const tag = shape.name;
      if (QUESTION_TAGS[tag]) {
        const item = readQuestion(shape, shapes, byG, consumed);
        if (item) { target.items.push(item); page.kind = 'question'; }
      }
    }
    for (const shape of shapes) {
      const g = attribute(shape, 'g') ?? '';
      if (consumed.has(g) || QUESTION_TAGS[shape.name]) continue;
      const item = readShape(shape);
      if (item) target.items.push(item);
      for (const trigger of childrenNamed(childNamed(shape, 'trigLst'), 'trig')) {
        const read = readTrigger(trigger, g, stateOwners);
        if (read) target.triggers.push(read);
      }
    }
    for (const trigger of childrenNamed(triggerList, 'trig')) {
      const read = readTrigger(trigger, null, stateOwners);
      if (read) target.triggers.push(read);
    }
    if (target.items.some((item) => item.kind === 'results')) page.kind = 'result';
  }

  const boxOf = (shape: XmlElement): Box | undefined => {
    const loc = childNamed(shape, 'loc');
    if (!loc) return undefined;
    const sldSz = childNamed(shape, 'sldSz');
    if (!slideSize && sldSz) slideSize = { width: num(attribute(sldSz, 'w')), height: num(attribute(sldSz, 'h')) };
    const l = num(attribute(loc, 'l'));
    const t = num(attribute(loc, 't'));
    return { x: l, y: t, width: Math.max(0, num(attribute(loc, 'r')) - l), height: Math.max(0, num(attribute(loc, 'b')) - t) };
  };

  // A shape's own text, else its normal state's.
  const shapeText = (shape: XmlElement) => {
    const own = deepText(childNamed(shape, 'text'));
    if (own.trim() && own.includes('Span')) return storyText(own);
    const plain = deepText(childNamed(shape, 'plain')).trim();
    if (plain) return { markdown: plainToMarkdown(plain), fonts: [] as string[] };
    const normal = childrenNamed(childNamed(shape, 'stateLst'), 'state').find((state) => (attribute(state, 'name') ?? '').toLowerCase() === 'normal');
    const stateText = deepText(childNamed(normal, 'text'));
    if (stateText.includes('Span')) return storyText(stateText);
    return { markdown: '', fonts: [] as string[] };
  };

  let anonymous = 0;
  function readShape(shape: XmlElement): SourceItem | null {
    const tag = shape.name;
    if (IGNORED_TAGS.has(tag) && !(tag === 'radio' || tag === 'checkMark')) return null;
    const g = attribute(shape, 'g') ?? `shape-${++anonymous}`;
    const base: Partial<SourceItem> = { ref: g, box: boxOf(shape) };
    const name = attribute(shape, 'name');
    if (name) base.name = name;
    if (attribute(shape, 'initState') === 'Hidden') base.hidden = true;
    const timing = childNamed(shape, 'tmCtxLst')?.children[0];
    const start = num(attribute(timing, 'start')) / 1000;
    if (start > 0) base.start = start;
    const states = childrenNamed(childNamed(shape, 'stateLst'), 'state').map((state) => attribute(state, 'name') ?? '').filter((stateName) => stateName && !BUILT_IN_STATES.has(stateName.toLowerCase()));
    if (states.length) base.states = states;
    switch (tag) {
      case 'pic': {
        const media = mediaRecords.get(attribute(shape, 'assetG') ?? '');
        if (!media) return { ...base, kind: 'unsupported', feature: 'Image Storyline', detail: 'fichier introuvable dans le projet' } as SourceItem;
        return { ...base, kind: 'image', media, alt: deepText(childNamed(shape, 'alt')).trim() || undefined } as SourceItem;
      }
      case 'char':
        return { ...base, kind: 'image', media: { path: `articulate/character-${g}`, kind: 'image', contentLibrary: true } } as SourceItem;
      case 'video':
      case 'sound': {
        const media = mediaRecords.get(attribute(shape, 'assetG') ?? '') ?? null;
        if (!media) return { ...base, kind: 'unsupported', feature: tag === 'video' ? 'Vidéo Storyline' : 'Son Storyline', detail: 'fichier introuvable dans le projet' } as SourceItem;
        return tag === 'video' ? { ...base, kind: 'video', media: { ...media, kind: 'video' }, title: name } as SourceItem : { ...base, kind: 'audio', media: { ...media, kind: 'audio' }, title: name } as SourceItem;
      }
      case 'rsltsIntr':
        return { ...base, kind: 'results' } as SourceItem;
      case 'web':
        return { ...base, kind: 'unsupported', feature: 'Objet web (Storyline web object)' } as SourceItem;
      case 'textEntry':
        return { ...base, kind: 'unsupported', feature: 'Champ de saisie (Storyline text entry)' } as SourceItem;
    }
    if (FALLBACK_QUESTIONS[tag]) return { ...base, kind: 'fallback', feature: FALLBACK_QUESTIONS[tag], markdown: shapeText(shape).markdown || undefined, detail: 'sa consigne en texte' } as SourceItem;
    const text = shapeText(shape);
    if (tag === 'btn' || tag === 'feedBackBtn') return text.markdown ? { ...base, kind: 'button', label: text.markdown.replace(/[*_\\]/g, '').trim() } as SourceItem : { ...base, kind: 'shape' } as SourceItem;
    if (text.markdown) {
      if (text.fonts.length && text.fonts.every((font) => /^(wingdings|webdings|symbol|marlett)/i.test(font))) return { ...base, kind: 'shape' } as SourceItem;
      return { ...base, kind: 'text', markdown: text.markdown, ...(text.fonts.length ? { fonts: text.fonts } : {}), ...(text.fontSize ? { fontSize: text.fontSize } : {}) } as SourceItem;
    }
    return { ...base, kind: 'shape' } as SourceItem;
  }

  function readQuestion(intr: XmlElement, shapes: XmlElement[], byG: Map<string, XmlElement>, consumed: Set<string>): SourceItem | null {
    const g = attribute(intr, 'g') ?? '';
    consumed.add(g);
    const props = childNamed(intr, 'intrProps');
    const title = byG.get(attribute(props, 'titleBoxG') ?? '') ?? shapes.find((shape) => shape.name === 'intrTitleTextBox');
    if (title) consumed.add(attribute(title, 'g') ?? '');
    const listed = new Set(childrenNamed(childNamed(intr, 'childLst'), 'g').map((child) => deepText(child).trim()));
    const options = shapes.filter((shape) => attribute(shape, 'parentG') === g || listed.has(attribute(shape, 'g') ?? ''));
    for (const option of options) consumed.add(attribute(option, 'g') ?? '');
    const stem = title ? shapeText(title).markdown : '';
    const attempts = attribute(props, 'attempts');
    return {
      ref: g, box: boxOf(intr), kind: 'quiz', stem: stem || 'Question', mode: QUESTION_TAGS[intr.name],
      options: options.sort((a, b) => (boxOf(a)?.y ?? 0) - (boxOf(b)?.y ?? 0) || (boxOf(a)?.x ?? 0) - (boxOf(b)?.x ?? 0)).map((option) => ({
        text: shapeText(option).markdown.replace(/[*_\\]/g, '').trim(),
        correct: attribute(childNamed(option, 'scoreData'), 'correct') === 'true'
      })),
      ...(attempts && /^\d+$/.test(attempts) ? { attempts: Number(attempts) } : {})
    };
  }

  function readTrigger(trigger: XmlElement, shapeG: string | null, stateOwners: Map<string, string>): SourceTrigger | null {
    const data = childNamed(trigger, 'data');
    if (!data || attribute(data, 'enabled') === 'false') return null;
    const event = attribute(data, 'event') ?? '';
    const action = attribute(data, 'action') ?? '';
    let on: SourceTrigger['on'];
    if (event === 'OnClick' && shapeG) on = { type: 'click', item: shapeG };
    else if (event === 'OnStart' && !shapeG) on = { type: 'page-start' };
    else if (event === 'OnEnd' && !shapeG) on = { type: 'page-end' };
    else if (event === 'OnVariableValueChange') on = { type: 'variable-changed', variable: variableNames.get(attribute(childNamed(data, 'other'), 'varG') ?? '') ?? '' };
    else if (event === 'OnMediaComplete' && shapeG) on = { type: 'media-ended', item: shapeG };
    else on = { type: 'other', label: event };
    const other = childNamed(data, 'other');
    const actions: SourceAction[] = [];
    switch (action) {
      case 'jumpToSlide': {
        const sub = attribute(data, 'actSubType');
        const jump = attribute(childNamed(data, 'slide'), 'jumpG');
        if (sub === 'next') actions.push({ type: 'go-to', page: 'next' });
        else if (sub === 'prev') actions.push({ type: 'go-to', page: 'previous' });
        else if (jump && jump !== NULL_GUID) actions.push({ type: 'go-to', page: jump });
        break;
      }
      case 'showSubSlide': { const layer = attribute(childNamed(data, 'sldLayer'), 'showG'); if (layer) actions.push({ type: 'show-layer', layer }); break; }
      case 'hideSubSlide': { const layer = attribute(childNamed(data, 'sldLayer'), 'hideG'); actions.push(layer && layer !== NULL_GUID ? { type: 'hide-layer', layer } : { type: 'hide-layer' }); break; }
      case 'adjustVar': {
        const variable = variableNames.get(attribute(other, 'varG') ?? '');
        const op = attribute(other, 'op');
        if (!variable || attribute(other, 'useVar') === 'true') { actions.push({ type: 'other', label: 'variable' }); break; }
        const declared = variables.find((entry) => entry.name === variable);
        const value: string | number | boolean = declared?.type === 'boolean' ? attribute(other, 'boolVal') === 'true' : declared?.type === 'number' ? num(attribute(other, 'dblVal')) : attribute(other, 'varVal1') ?? '';
        if (op === 'add' || op === 'sub') actions.push({ type: 'adjust-variable', variable, by: (op === 'sub' ? -1 : 1) * num(attribute(other, 'dblVal')) });
        else if (op === 'ass') actions.push({ type: 'set-variable', variable, value });
        else actions.push({ type: 'other', label: `variable ${op}` });
        break;
      }
      case 'changeShapeState': {
        const shape = childNamed(data, 'shape');
        const stateName = attribute(shape, 'setStateName') ?? '';
        const owner = stateOwners.get(attribute(shape, 'setStateG') ?? '') ?? attribute(shape, 'shapeG') ?? attribute(data, 'target');
        if (owner && stateName === 'Hidden') actions.push({ type: 'hide-item', item: owner });
        else if (owner && stateName === 'Normal') actions.push({ type: 'show-item', item: owner });
        else actions.push({ type: 'other', label: `change state (${stateName || '?'})` });
        break;
      }
      case 'exitProject': actions.push({ type: 'exit' }); break;
      case 'executeJavaScript': actions.push({ type: 'other', label: 'JavaScript' }); break;
      case 'jumpToFileUrl': actions.push({ type: 'other', label: 'open URL' }); break;
      case 'submitInteraction': case 'SubmitQuizSL': return null; // a question's own submission
      case 'Move': actions.push({ type: 'other', label: 'motion path' }); break;
      case 'LightboxSlide': actions.push({ type: 'other', label: 'lightbox' }); break;
      default: actions.push({ type: 'other', label: action || 'action' });
    }
    const conditions: SourceCondition[] = [];
    for (const condition of descendantsNamed(childNamed(trigger, 'condLst'), 'trigCond')) {
      const variable = variableNames.get(attribute(condition, 'varG') ?? '');
      const ops: Record<string, SourceCondition['op']> = { eq: 'eq', noteq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte' };
      const op = ops[attribute(condition, 'op') ?? ''];
      // A condition on a shape's state (or an "or") is not a variable's.
      if (!variable || !op || childNamed(condition, 'shapeState') || attribute(condition, 'andOr') === 'or') return { ref: attribute(trigger, 'g') ?? '', on: { type: 'other', label: `${event} (condition on a state)` }, conditions: [], actions };
      const declared = variables.find((entry) => entry.name === variable);
      const value: string | number | boolean = declared?.type === 'boolean' ? attribute(condition, 'boolVal') === 'true' : declared?.type === 'number' ? num(attribute(condition, 'floatVal1')) : attribute(condition, 'strVal1') ?? '';
      conditions.push({ variable, op, value });
    }
    return { ref: attribute(trigger, 'g') ?? '', on, conditions, actions };
  }

  for (const section of sections) for (const page of section.pages) readSlide(page, slideParts.get(page.ref)!);

  return {
    kind: 'storyline-source',
    title: input.title ?? '',
    slideSize: slideSize ?? { width: 720, height: 540 },
    sections,
    variables,
    passingScore,
    losses
  };
}
