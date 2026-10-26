import { htmlToMarkdown, htmlToText, plainToMarkdown } from './html-markdown.ts';
import type { SourceCourse, SourceSection, SourcePage, SourceItem, SourceLayer, SourceTrigger, SourceAction, SourceCondition, SourceVariable, ReaderLoss, Box } from './model.ts';

// A course published by Storyline 360 or Storyline 3 (for the web or an LMS): `html5/data/js/`
// holds the course (`data.js`), the player (`frame.js`: menu, notes) and one file per slide, each
// a call `window.globalProvideData('<kind>', '<JSON in a JavaScript string>')` (docs/decisions.md
// D47). Positions, texts with their styles, images, layers, triggers and questions are all there:
// this is the importer's most faithful source. Media are in `story_content/` and `mobile/`.

export interface ProvidedData {
  kind: string;
  data: Record<string, unknown>;
}

// `window.globalProvideData('slide', '{…}')` → its kind and JSON (a JavaScript string literal
// first: `\'`, `\\`, `\n`, `\uXXXX`; double quotes are accepted too).
export function parseProvidedData(text: string): ProvidedData | null {
  const match = /globalProvideData\(\s*(['"])(\w+)\1\s*,\s*(['"])([\s\S]*)\3\s*\)\s*;?\s*$/.exec(text.replace(/^﻿/, '').trim());
  if (!match) return null;
  const raw = match[4];
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const next = raw[++i];
    if (next === 'u') { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16)); i += 4; continue; }
    if (next === 'x') { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2; continue; }
    out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[next] ?? next;
  }
  try {
    return { kind: match[2], data: JSON.parse(out) as Record<string, unknown> };
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') as Json[] : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value) || 0);

// Storyline's font names carry a subset hash ("Articulate Charset0_v8MBBDD1F1C"): the family is
// the last name of the CSS list that has none, else the name before its hash.
export function storylineFontFamily(css: string): string | null {
  const names = css.split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const clean = names.filter((name) => !/Charset|Chars?(Bold|Italic)|ItaItalic|[0-9A-F]{8}$/.test(name));
  if (clean.length) return clean[clean.length - 1];
  const first = names[0];
  if (!first) return null;
  return first.replace(/(Bold|Italic|BoldIta|Ita)*\s*(Charset\d|Chars?(Bold|Italic)|ItaItalic|Bold[0-9A-F]{8}|[0-9A-F]{8}$).*$/, '').trim() || null;
}

export interface PublishedStoryline {
  data: Json; // data.js
  frame: Json | null; // frame.js
  slides: ReadonlyMap<string, Json>; // html5url → slide JSON
  has: (path: string) => boolean; // a file of the publication
  title?: string; // meta.xml's project title
}

const INTERNAL_VARIABLE = /^(CurrentQuiz_|QuizAdvanceModeWarningShown$|lastSlideViewed|_)/;
// Events the player raises for itself: rollovers, its own navigation, transitions, drags that
// its questions handle.
const PLAYER_EVENTS = new Set(['ontransitionin', 'ontransitionout', 'ontransitionincomplete', 'onrollover', 'onrollout', 'onpress', 'onreleaseoutside', 'onbeforeslidein', 'ontopmostlayer', 'onsubmitslide', 'onlosefocus', 'onfocus', 'onnextslide', 'onprevslide', 'ondragconnect', 'ondragout', 'ondragstart', 'ondragdrop', 'ondragover', 'onvarchanged']);
// Variables of the player and of objects' own states (_hover, _down, _visited…), and properties.
const isPlayerVariable = (name: string) => INTERNAL_VARIABLE.test(name) || /^(#|\$)/.test(name) || /\.\$|^_player(Vars)?\.[#_$]|^_playerVars\./.test(name) || /\.[_$#][^.]*$/.test(name);

export function readStorylinePublished(input: PublishedStoryline): SourceCourse {
  const { data, frame } = input;
  const losses: ReaderLoss[] = [];
  const assets = new Map<string, Json>(list(data.assetLib).map((asset) => [str(asset.id), asset]));

  // Scene titles and notes live in the player's data.
  const sceneTitles = new Map<string, string>();
  const slideTitles = new Map<string, string>();
  const outline = list(obj(obj(obj(frame).navData).outline).links);
  const walkOutline = (links: Json[], scene: string | null) => {
    for (const link of links) {
      const id = str(link.slideid).replace(/^_player\./, '');
      const children = list(link.links);
      const text = htmlToText(str(link.displaytext) || str(link.slidetitle));
      if (id.includes('.')) {
        const [sceneId] = id.split('.');
        if (scene && !sceneTitles.has(sceneId)) sceneTitles.set(sceneId, scene);
        if (text) slideTitles.set(id.split('.')[1], text);
      } else if (children.length && text && id) sceneTitles.set(id, text);
      if (children.length) walkOutline(children, id.includes('.') ? scene : text || scene);
    }
  };
  walkOutline(outline, null);
  const notes = new Map<string, string>();
  for (const note of list(obj(frame).notesData)) {
    const slide = str(note.slideId).split('.').pop() ?? '';
    const markdown = htmlToMarkdown(str(note.content));
    if (slide && markdown) notes.set(slide, markdown);
  }

  const variables: SourceVariable[] = list(data.variables)
    .filter((variable) => !INTERNAL_VARIABLE.test(str(variable.name)))
    .map((variable) => {
      const type = str(variable.type) === 'boolean' ? 'boolean' : str(variable.type) === 'number' ? 'number' : 'string';
      return { name: str(variable.name), type, default: type === 'boolean' ? variable.value === true : type === 'number' ? num(variable.value) : str(variable.value) } as SourceVariable;
    });
  const variableName = (ref: string) => ref.replace(/^#?_player\./, '').replace(/^#/, '');

  let slideSize: { width: number; height: number } | undefined;
  const sections: SourceSection[] = [];
  let passingScore: number | undefined;
  for (const quiz of list(data.quizzes)) if (num(quiz.passPercent) > 0) passingScore = num(quiz.passPercent);

  for (const scene of list(data.scenes)) {
    if (scene.isMessageScene === true) continue;
    const sceneId = str(scene.id);
    const section: SourceSection = { ref: sceneId, title: sceneTitles.get(sceneId) || `Scène ${num(scene.sceneNumber) || sections.length + 1}`, pages: [] };
    for (const entry of list(scene.slides)) {
      const slideId = str(entry.id);
      const file = str(entry.html5url);
      const slide = input.slides.get(file);
      const title = htmlToText(str(entry.title)) || slideTitles.get(slideId) || `Diapositive ${section.pages.length + 1}`;
      if (!slide) {
        losses.push({ page: title, feature: 'Diapositive illisible', detail: file || slideId });
        continue;
      }
      slideSize ??= { width: num(slide.width) || 720, height: num(slide.height) || 540 };
      section.pages.push(readSlide(slideId, title, slide, list(entry.interactions)));
    }
    if (section.pages.length) sections.push(section);
  }

  function readSlide(slideId: string, title: string, slide: Json, interactions: Json[]): SourcePage {
    const page: SourcePage = { ref: slideId, title, kind: 'content', positioned: true, items: [], layers: [], triggers: [] };
    const notesText = notes.get(slideId);
    if (notesText) page.notes = notesText;
    const consumed = new Set<string>(); // object ids that a question stands for
    const feedbackLayers = new Map<string, 'correct' | 'incorrect'>();
    const questionItems: SourceItem[] = [];
    for (const interaction of interactions) {
      const item = readInteraction(interaction, consumed, feedbackLayers);
      if (Array.isArray(item)) questionItems.push(...item);
      else if (item) questionItems.push(item);
    }
    if (questionItems.length) page.kind = 'question';
    const slideGroups = obj(slide.actionGroups);
    const layers = list(slide.slideLayers);
    for (const layer of layers) {
      const base = layer.isBaseLayer === true;
      const groups = { ...slideGroups, ...obj(layer.actionGroups) };
      const target: { items: SourceItem[]; triggers: SourceTrigger[] } = base ? page : { items: [], triggers: [] };
      const shown = timelineStarts(layer);
      // The layer's sound (often the slide's narration), before its objects.
      for (const audio of list(layer.audiolib)) {
        const url = str(assets.get(str(audio.assetId))?.url);
        if (url) target.items.push({ ref: str(audio.id) || `${slideId}-audio`, kind: 'audio', media: { path: url, kind: 'audio' }, title: `${title} (son)` });
      }
      for (const object of list(layer.objects)) readObject(object, { x: 0, y: 0 }, target, groups, shown, consumed);
      for (const event of list(layer.events)) {
        const trigger = readEvent(event, groups, null);
        if (trigger) target.triggers.push(trigger);
      }
      if (!base) {
        const texts = target.items.filter((item) => item.kind === 'text').map((item) => (item as { markdown: string }).markdown);
        const head = (texts[0] ?? '').replace(/[*_\\]/g, '').trim();
        const feedback = page.kind === 'question' ? feedbackLayers.get(str(layer.id)) ?? feedbackKind(head) : undefined;
        const sourceLayer: SourceLayer = { ref: str(layer.id), title: head && head.length <= 60 ? head : `Calque ${page.layers.length + 1}`, modal: layer.modal === true, ...(feedback ? { feedback } : {}), items: target.items, triggers: target.triggers };
        page.layers.push(sourceLayer);
      }
    }
    for (const event of list(slide.events)) {
      const trigger = readEvent(event, slideGroups, null);
      if (trigger) page.triggers.push(trigger);
    }
    if (questionItems.length) {
      // The question's own text on the slide is its stem: kept once, in the question.
      const stems = new Set(questionItems.map((item) => ('stem' in item && item.stem ? plain(item.stem) : 'prompt' in item ? plain(item.prompt) : '')));
      page.items = page.items.filter((item) => !(item.kind === 'text' && stems.has(plain(item.markdown))));
      const top = Math.min(...page.items.map((item) => item.box?.y ?? 0).filter((y) => y > 0), 9999);
      for (const item of questionItems) page.items.push({ ...item, box: { x: 0, y: top + 1, width: slideSize?.width ?? 720, height: 1 } });
    }
    // A results slide: its texts name the quiz's score variables.
    if (page.items.some((item) => item.kind === 'text' && /%Results\.|\$(PercentScore|ScorePercent)/.test(item.markdown))) {
      page.kind = 'result';
      page.items = page.items.filter((item) => !(item.kind === 'text' && /%[A-Za-z_.]+%/.test(item.markdown)));
      // Where its score was: after what the slide says.
      const below = Math.max(0, ...page.items.map((item) => (item.box ? item.box.y + item.box.height : 0)));
      page.items.push({ ref: `${slideId}-results`, kind: 'results', box: { x: 0, y: below + 1, width: slideSize?.width ?? 720, height: 1 } });
    }
    return page;
  }

  function plain(markdown: string): string {
    return markdown.replace(/[*_\\`#>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function feedbackKind(head: string): SourceLayer['feedback'] {
    if (/try again|essayez|réessayez/i.test(head)) return 'try-again';
    if (/incorrect|not quite|wrong|faux|incorrecte|dommage/i.test(head)) return 'incorrect';
    if (/correct|right|bravo|exact|bonne réponse|great|well done/i.test(head)) return 'correct';
    return undefined;
  }

  // When each object of a layer first shows on its timeline (seconds), and which never do.
  function timelineStarts(layer: Json): { starts: Map<string, number>; any: boolean } {
    const starts = new Map<string, number>();
    for (const event of list(obj(layer.timeline).events)) {
      if (str(event.kind) !== 'ontimelinetick') continue;
      for (const action of list(event.actions)) {
        if (str(action.kind) !== 'show') continue;
        const id = str(obj(action.objRef).value);
        if (id && !starts.has(id)) starts.set(id, num(event.time) / 1000);
      }
    }
    return { starts, any: starts.size > 0 };
  }

  function readObject(object: Json, offset: { x: number; y: number }, target: { items: SourceItem[]; triggers: SourceTrigger[] }, groups: Json, shown: { starts: Map<string, number>; any: boolean }, consumed: Set<string>) {
    const id = str(object.id);
    if (consumed.has(id)) return;
    const kind = str(object.kind);
    const box: Box = { x: offset.x + num(object.xPos), y: offset.y + num(object.yPos), width: num(object.width), height: num(object.height) };
    const base: Partial<SourceItem> = { ref: id, box };
    if (str(object.referenceName)) base.name = str(object.referenceName);
    const start = shown.starts.get(id);
    if (start && start > 0) base.start = start;
    if (shown.any && start === undefined) base.hidden = true;
    const states = list(object.states).map((state) => str(state.name)).filter((name) => name && !name.startsWith('_default') && !/^_/.test(name));
    if (states.length) base.states = states;
    for (const event of list(object.events)) {
      const trigger = readEvent(event, { ...groups, ...obj(object.actionGroups) }, id);
      if (trigger) target.triggers.push(trigger);
    }
    const children = list(object.objects);
    if (kind === 'objgroup' || kind === 'scrollarea' || kind === 'shufflegroup') {
      for (const child of children) readObject(child, { x: box.x, y: box.y }, target, groups, shown, consumed);
      return;
    }
    if (kind === 'stategroup') {
      // The objects of its normal state (the first); other states are not taken.
      // Its own events were read above, under its id, which the child takes.
      if (children[0]) readObject({ ...children[0], id, events: [], referenceName: object.referenceName ?? children[0].referenceName }, { x: box.x, y: box.y }, target, groups, shown, consumed);
      return;
    }
    if (kind === 'video') {
      const url = findMediaUrl(object, /\.(mp4|webm|m4v)$/i);
      target.items.push(url ? { ...base, kind: 'video', media: { path: url, kind: 'video' }, title: str(object.altText) || undefined } as SourceItem : { ...base, kind: 'unsupported', feature: 'Vidéo Storyline', detail: 'fichier introuvable' } as SourceItem);
      return;
    }
    if (kind === 'textinput') { target.items.push({ ...base, kind: 'unsupported', feature: 'Champ de saisie (Storyline text entry)' } as SourceItem); return; }
    if (kind === 'webobject') { target.items.push({ ...base, kind: 'unsupported', feature: 'Objet web (Storyline web object)' } as SourceItem); return; }
    if (kind === 'dragitem' || kind === 'droparea') { target.items.push({ ...base, kind: 'unsupported', feature: 'Glisser-déposer (Storyline drag and drop)' } as SourceItem); return; }
    if (kind === 'slider' || kind === 'dial') { target.items.push({ ...base, kind: 'unsupported', feature: kind === 'slider' ? 'Curseur (Storyline slider)' : 'Cadran (Storyline dial)' } as SourceItem); return; }
    const text = textOf(object);
    const image = list(object.imagelib).find((entry) => str(entry.url));
    const accType = str(object.accType);
    if ((accType === 'button' || kind === 'button') && text) {
      target.items.push({ ...base, kind: 'button', label: text.markdown.replace(/\\([\\`*_[\]$#>+-])/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim() } as SourceItem);
      return;
    }
    // Text set in a symbol font draws icons (Wingdings' check marks), not words.
    if (text && text.fonts?.length && text.fonts.every((font) => /^(wingdings|webdings|symbol|marlett)/i.test(font))) {
      target.items.push({ ...base, kind: 'shape', name: text.fonts[0] } as SourceItem);
      return;
    }
    if (text) {
      const variable = /%[A-Za-z_][\w.]*%/.test(text.markdown);
      target.items.push({ ...base, kind: 'text', markdown: text.markdown.replace(/\^%\^/g, '%'), fontSize: text.fontSize, fonts: text.fonts, heading: text.heading, ...(variable ? { fallbackOf: { feature: 'Texte à variable (%…%)', detail: 'la référence reste écrite telle quelle' } } : {}) } as SourceItem);
      return;
    }
    if (image) {
      // Old publications draw vector pictures as Flash (.swf); the asset's own file may be a PNG.
      const asset = assets.get(str(image.assetId));
      const web = (url: string) => /\.(png|jpe?g|gif|svg|webp)$/i.test(url) && input.has(url);
      const url = [str(image.url), str(asset?.url), str(asset?.mobileUrl)].find(web) ?? str(image.url);
      target.items.push({ ...base, kind: 'image', media: { path: url, kind: 'image' }, alt: str(image.altText) || str(object.altText) || undefined } as SourceItem);
      return;
    }
    target.items.push({ ...base, kind: 'shape' } as SourceItem);
  }

  function findMediaUrl(object: Json, pattern: RegExp): string | null {
    let found: string | null = null;
    const walk = (value: unknown) => {
      if (found) return;
      if (typeof value === 'string') { if (pattern.test(value) && input.has(value)) found = value; return; }
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === 'object') for (const entry of Object.values(value)) walk(entry);
    };
    walk(object);
    return found;
  }

  // The text of an object (its first text data), as Markdown with what its styles say.
  function textOf(object: Json): { markdown: string; fontSize?: number; fonts?: string[]; heading?: boolean } | null {
    const entries = list(object.textLib).filter((entry) => entry.vartext !== undefined);
    if (!entries.length) return null;
    const vartext = entries[0].vartext;
    const fonts = new Set<string>();
    let fontSize = 0;
    let heading = false;
    let markdown = '';
    if (typeof vartext === 'string') {
      for (const match of vartext.matchAll(/font-family:\s*([^;"]+)/g)) { const family = storylineFontFamily(match[1].replace(/&quot;/g, '"')); if (family) fonts.add(family); }
      for (const match of vartext.matchAll(/font-size:\s*([\d.]+)px/g)) fontSize = Math.max(fontSize, Number(match[1]));
      heading = /<h[1-3]\b/i.test(vartext);
      markdown = htmlToMarkdown(vartext);
    } else {
      const paragraphs: string[] = [];
      let listIndex = 0;
      for (const block of list(obj(vartext).blocks)) {
        const style = obj(block.style);
        const spans = list(block.spans).map((span) => {
          const spanStyle = obj(span.style);
          const family = storylineFontFamily(str(spanStyle.fontFamily));
          if (family) fonts.add(family);
          fontSize = Math.max(fontSize, num(spanStyle.fontSize));
          let value = plainToMarkdown(str(span.text).replace(/\n$/, ''));
          if (!value.trim()) return value;
          if (spanStyle.fontIsItalic === true) value = `*${value}*`;
          if (spanStyle.fontIsBold === true) value = `**${value}**`;
          return value;
        });
        const line = spans.join('').trim();
        if (!line) continue;
        if (/^H[1-3]$/.test(str(style.tagType))) heading = true;
        const listType = str(obj(style.listStyle).listType);
        if (listType && listType !== 'none' && listType !== 'None') paragraphs.push(listType.toLowerCase().includes('bullet') ? `- ${line}` : `${++listIndex}. ${line}`);
        else { listIndex = 0; paragraphs.push(line); }
      }
      markdown = paragraphs.join('\n\n').replace(/(^|\n\n)(- |\d+\. )([^\n]*)\n\n(?=- |\d+\. )/g, '$1$2$3\n');
      const defaults = obj(obj(obj(vartext).defaultBlockStyle).baseSpanStyle);
      const family = storylineFontFamily(str(defaults.fontFamily));
      if (family && !fonts.size) fonts.add(family);
      if (!fontSize) fontSize = num(defaults.fontSize);
    }
    markdown = markdown.trim();
    if (!markdown) return null;
    return { markdown, ...(fontSize ? { fontSize } : {}), ...(fonts.size ? { fonts: [...fonts] } : {}), ...(heading ? { heading } : {}) };
  }

  // A question of data.js: its kind, its choices and which are correct.
  function readInteraction(interaction: Json, consumed: Set<string>, feedbackLayers: Map<string, 'correct' | 'incorrect'>): SourceItem | SourceItem[] | null {
    const type = str(interaction.type);
    const id = str(interaction.id);
    const stem = plainToMarkdown(str(interaction.lmstext)) || 'Question';
    const choices = list(interaction.choices);
    for (const choice of [...choices, ...list(interaction.statements)]) consumed.add(str(choice.id).replace(/^(choice|statement)_/, ''));
    const correct = new Set<string>();
    const walk = (statements: Json[]) => {
      for (const statement of statements) {
        if (str(statement.choiceid)) correct.add(str(statement.choiceid).replace(/^choices\./, ''));
        walk(list(statement.statements));
      }
    };
    for (const answer of list(interaction.answers)) {
      const status = str(answer.status);
      if (status === 'correct') walk(list(obj(answer.evaluate).statements));
      // The layer an answer shows is the question's feedback for that answer.
      const layers: string[] = [];
      const find = (actions: Json[]) => { for (const action of actions) { if (str(action.kind) === 'show_slidelayer') layers.push(str(obj(action.objRef).value || action.objRef).replace(/^_parent\./, '')); find(list(action.thenActions)); find(list(action.elseActions)); } };
      find(list(answer.actions));
      for (const layer of layers) if (status === 'correct' || status === 'incorrect') feedbackLayers.set(layer, status);
    }
    const label = (choice: Json) => htmlToText(str(choice.lmstext)) || str(choice.id);
    if ((type === 'multiplechoice' || type === 'truefalse' || type === 'multipleresponse') && choices.length >= 2) {
      return { ref: id, kind: 'quiz', stem, mode: type === 'multipleresponse' ? 'multiple' : 'single', options: choices.map((choice) => ({ text: label(choice), correct: correct.has(str(choice.id)) })), scored: interaction.issurvey !== true };
    }
    if (type === 'numeric') {
      for (const answer of list(interaction.answers)) {
        if (str(answer.status) !== 'correct') continue;
        const statement = list(obj(answer.evaluate).statements)[0];
        const value = Number(str(obj(statement?.valueb).value ?? statement?.valueb));
        if (statement && str(statement.operator) === 'eq' && Number.isFinite(value)) return { ref: id, kind: 'numeric', stem, answer: value };
      }
    }
    const activity = readActivity(interaction, id, stem, choices, label);
    if (activity) return activity;
    const names: Record<string, string> = { fillin: 'Texte à trous (Storyline fill in the blank)', matching: 'Association (Storyline matching)', sequence: 'Remise en ordre (Storyline sequence)', hotspot: 'Zone à cliquer (Storyline hotspot)', wordbank: 'Banque de mots (Storyline word bank)', likert: 'Échelle de Likert (Storyline survey)', numeric: 'Réponse numérique en intervalle (Storyline numeric)', multiplechoice: 'Question sans réponse juste (Storyline survey)', multipleresponse: 'Question sans réponse juste (Storyline survey)' };
    const lines = [...choices, ...list(interaction.statements)].map((choice) => `- ${label(choice)}`);
    return { ref: id, kind: 'fallback', feature: names[type] ?? `Question Storyline (${type || 'inconnue'})`, markdown: [stem, ...lines].join('\n\n'), detail: 'sa consigne et ses éléments en texte' };
  }

  // The activities of D63 in data.js: a matching or a drag and drop (statements paired with choices by
  // the right answer) as a sort in pairs, a sequence (choices in the right answer's order) as a sort in
  // order, a fill in the blank (the accepted answers) and a word bank (words to place) as a fill-in,
  // a Likert scale (statements rated on its choices) as reflections on a scale. Surveys are not scored.
  function readActivity(interaction: Json, id: string, stem: string, choices: Json[], label: (choice: Json) => string): SourceItem | SourceItem[] | null {
    const type = str(interaction.type);
    const scored = interaction.issurvey !== true;
    const statements = list(interaction.statements);
    const key = (value: unknown) => str(value).replace(/^(choices|statements)\./, '').replace(/^(choice|statement)_/, '');
    const choiceById = new Map(choices.map((choice) => [key(choice.id), choice]));
    const statementById = new Map(statements.map((statement) => [key(statement.id), statement]));
    const right = list(obj(list(interaction.answers).find((answer) => str(answer.status) === 'correct')?.evaluate).statements);
    const flat = (entries: Json[]): Json[] => entries.flatMap((entry) => [entry, ...flat(list(entry.statements))]);
    const evaluated = flat(right);
    const pairs = evaluated.filter((entry) => str(entry.choiceid) && str(entry.statementid)).map((entry) => ({ statement: statementById.get(key(entry.statementid)), choice: choiceById.get(key(entry.choiceid)) })).filter((pair) => pair.statement && pair.choice) as { statement: Json; choice: Json }[];
    if ((type === 'matching' || type === 'wordbank') && pairs.length >= 2) {
      return { ref: id, kind: 'sort', presentation: 'pairs', stem, items: pairs.map((pair) => ({ text: label(pair.statement), target: key(pair.choice.id) })), targets: [...new Set(pairs.map((pair) => pair.choice))].map((choice) => ({ ref: key(choice.id), text: label(choice) })), scored };
    }
    if (type === 'sequence') {
      const order = evaluated.map((entry) => choiceById.get(key(entry.choiceid))).filter((choice): choice is Json => !!choice);
      const items = (order.length >= 2 ? [...new Set(order)] : choices).map((choice) => ({ text: label(choice) }));
      if (items.length >= 2) return { ref: id, kind: 'sort', presentation: 'order', stem, items, scored };
    }
    const words = (value: string) => value.replace(/[|[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (type === 'fillin') {
      const compared = evaluated.map((entry) => (typeof entry.valueb === 'string' && str(entry.typeb) !== 'property' ? entry.valueb : '')).filter(Boolean);
      const accepted = [...new Set([...choices.map(label), ...compared].map(words).filter(Boolean))];
      if (accepted.length) return { ref: id, kind: 'fill-in', stem, markdown: `[[${accepted.join('|')}]]`, scored };
    }
    if (type === 'wordbank') {
      const answer = choiceById.get(key(evaluated.find((entry) => str(entry.choiceid))?.choiceid));
      if (answer) return { ref: id, kind: 'fill-in', presentation: 'bank', stem, markdown: `[[${words(label(answer))}]]`, distractors: choices.filter((choice) => choice !== answer).map((choice) => words(label(choice))).filter(Boolean), scored };
    }
    if (type === 'likert' && choices.length >= 2 && choices.length <= 10) {
      const scale = { min: 1, max: Math.min(9, choices.length), minLabel: label(choices[0]), maxLabel: label(choices[Math.min(9, choices.length) - 1]) };
      const rows = statements.length ? statements : [{ id, lmstext: '' }];
      return rows.map((row, i) => ({ ref: `${id}-${i + 1}`, kind: 'reflection', prompt: [i === 0 ? stem : '', htmlToText(str(row.lmstext))].filter(Boolean).join('\n\n') || stem, scale }) as SourceItem);
    }
    return null;
  }

  // An object's or a layer's event as a trigger of the model.
  function readEvent(event: Json, groups: Json, objectId: string | null): SourceTrigger | null {
    const kind = str(event.kind);
    let on: SourceTrigger['on'];
    if (kind === 'onrelease' && objectId) on = { type: 'click', item: objectId };
    else if (kind === 'onslidestart' || (kind === 'ontransitionin' && !objectId)) on = { type: 'page-start' };
    else if (kind === 'ontimelinecomplete') on = { type: 'page-end' };
    else if (PLAYER_EVENTS.has(kind)) return null; // the player's own
    else on = { type: 'other', label: kind };
    const { actions, conditions } = readActions(list(event.actions), groups, 0, objectId);
    if (!actions.length) return null;
    return { ref: `${objectId ?? 'slide'}-${kind}`, on, conditions, actions };
  }

  function readActions(actions: Json[], groups: Json, depth: number, self: string | null): { actions: SourceAction[]; conditions: SourceCondition[] } {
    const out: SourceAction[] = [];
    let conditions: SourceCondition[] = [];
    for (const action of actions) {
      const kind = str(action.kind);
      // Targets are written from where the trigger is: _this (the object itself), _parent.<id>.
      const raw = str(obj(action.objRef).value || action.objRef);
      const ref = raw === '_this' ? (self ?? '') : raw.replace(/^(_parent\.)+/, '');
      switch (kind) {
        case 'exe_actiongroup': {
          const group = obj(groups[str(action.id)]);
          if (depth < 8) { const inner = readActions(list(group.actions), groups, depth + 1, self); out.push(...inner.actions); conditions = conditions.concat(inner.conditions); }
          break;
        }
        case 'if_action': {
          if (depth >= 8) break;
          const statement = obj(obj(action.condition).statement);
          const then = readActions(list(action.thenActions), groups, depth + 1, self).actions;
          const otherwise = readActions(list(action.elseActions), groups, depth + 1, self).actions;
          // A condition on the player's own state (a hover, an attempt count) guards the player's work.
          if (!then.length && !otherwise.length) break;
          if (conditionOnPlayer(statement)) { out.push(...then); break; }
          const parsed = readCondition(statement);
          if (parsed && !otherwise.length && !out.length && !conditions.length) {
            conditions = parsed;
            out.push(...then);
          } else out.push({ type: 'other', label: 'condition (if/else)' });
          break;
        }
        case 'gotoplay': {
          const target = ref.replace(/^_player\./, '');
          if (/next/i.test(target)) out.push({ type: 'go-to', page: 'next' });
          else if (/prev/i.test(target)) out.push({ type: 'go-to', page: 'previous' });
          else out.push({ type: 'go-to', page: target.split('.').pop() ?? target });
          break;
        }
        case 'trigger_next_slide': case 'gotonextslide': out.push({ type: 'go-to', page: 'next' }); break;
        case 'gotoprevslide': case 'trigger_prev_slide': out.push({ type: 'go-to', page: 'previous' }); break;
        case 'show_slidelayer': out.push({ type: 'show-layer', layer: ref }); break;
        case 'hide_slidelayer': out.push(raw && raw !== '_this' ? { type: 'hide-layer', layer: ref } : { type: 'hide-layer' }); break;
        case 'show': if (ref) out.push({ type: 'show-item', item: ref }); break;
        case 'hide': if (ref) out.push({ type: 'hide-item', item: ref }); break;
        case 'adjustvar': {
          if (isPlayerVariable(variableName(str(action.variable)))) break;
          const variable = variableName(str(action.variable));
          const value = obj(action.value);
          const raw = value.value ?? action.value;
          if (str(action.operator) === 'add' || str(action.operator) === 'subtract') out.push({ type: 'adjust-variable', variable, by: (str(action.operator) === 'subtract' ? -1 : 1) * num(raw) });
          else if (str(action.operator) === 'set' && str(value.type) !== 'variable') out.push({ type: 'set-variable', variable, value: typeof raw === 'boolean' || typeof raw === 'number' ? raw : str(raw) });
          else out.push({ type: 'other', label: `variable ${str(action.operator)}` });
          break;
        }
        case 'media_play': if (ref) out.push({ type: 'play-media', item: ref }); break;
        case 'media_pause': if (ref) out.push({ type: 'pause-media', item: ref }); break;
        case 'exit_player': case 'close_window': out.push({ type: 'exit' }); break;
        case 'exe_javascript': out.push({ type: 'other', label: 'JavaScript' }); break;
        case 'open_url': out.push({ type: 'other', label: 'open URL' }); break;
        case 'setobjstate': out.push({ type: 'other', label: 'change state' }); break;
        case 'eval_interaction': case 'setactivetimeline': case 'addchoiceresponse': case 'addpairresponse': case 'set_enabled': case 'enable_frame_control': case 'set_frame_layout': case 'history_prev': case 'history_next': case 'resetobjstates': case 'reset_timeline': case 'media_seek': case 'set_volume': case 'pause_timeline': case 'resume_timeline': case 'enable_window_control': case 'exe_animation': break; // the player's own (entrance animations: see the timeline)
        default: out.push({ type: 'other', label: kind || 'action' });
      }
    }
    return { actions: out, conditions };
  }

  function conditionOnPlayer(statement: Json): boolean {
    if (str(statement.kind) === 'and' || str(statement.kind) === 'or') return list(statement.statements).some(conditionOnPlayer);
    const a = str(obj(statement.valuea).value || statement.valuea);
    return isPlayerVariable(variableName(a));
  }

  function readCondition(statement: Json): SourceCondition[] | null {
    if (str(statement.kind) === 'and') {
      const parts = list(statement.statements).map(readCondition);
      return parts.every(Boolean) ? parts.flat() as SourceCondition[] : null;
    }
    if (str(statement.kind) !== 'compare') return null;
    const valueA = obj(statement.valuea);
    const valueB = obj(statement.valueb);
    if (str(valueA.type) !== 'var' && str(valueA.type) !== 'variable' && !str(statement.valuea).startsWith('_player')) return null;
    const ops: Record<string, SourceCondition['op']> = { eq: 'eq', noteq: 'neq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte' };
    const op = ops[str(statement.operator)];
    if (!op) return null;
    const raw = valueB.value ?? statement.valueb;
    return [{ variable: variableName(str(valueA.value || statement.valuea)), op, value: typeof raw === 'boolean' || typeof raw === 'number' ? raw : str(raw) }];
  }

  return {
    kind: 'storyline-published',
    title: input.title || htmlToText(str(obj(frame).title) || str(data.title)) || '',
    slideSize,
    sections,
    variables,
    passingScore,
    losses
  };
}
