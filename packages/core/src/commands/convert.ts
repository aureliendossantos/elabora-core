import type { Block, Project, Screen } from '../project/model.ts';
import { filesIn } from '../project/files.ts';
import { getRegistry, instanceBehavior } from '../components/registry.ts';
import { blockControls, controlEntity } from '../components/controls.ts';
import { activityEntity, type ActivityBehavior } from '../compile/state-model.ts';
import { markdownToText } from '../compile/markdown.ts';
import { isRecord } from '../util/values.ts';
import { CommandError, Draft, findBlock, listAt, type CommandContext, type CommandOutput } from './context.ts';

// « Transformer en… » (docs/decisions/D63.md): a block becomes another type or presentation that
// holds the same content, in place. Its id is kept, and so are its items' ids: visited marks,
// translations and the lock follow them. Conversions are table-driven: each says what it keeps,
// what it loses and what starts empty, in French and English, and refuses with a reason when the
// content does not fit the target (a text too long for a sort's item, a gallery of three images
// that would become one image). A conversion never reorders items (a sort's saved placements are
// by index). Translation units whose text moves to another prop follow it (translations/*.xlf).

type Props = Record<string, unknown>;
type Item = Record<string, unknown>;

export interface ConvertTarget {
  type: string;
  presentation?: string;
}

// A sentence in the two languages of the app.
export interface Words {
  fr: string;
  en: string;
}

// What a conversion does, in sentences: kept, lost and added (what starts empty) may be "".
export interface ConversionWords {
  kept: string;
  lost: string;
  added: string;
}

export interface ConversionTarget {
  to: ConvertTarget;
  words: { fr: ConversionWords; en: ConversionWords };
  // Learners who started a published package: kept, or what of theirs the block loses (lock entities).
  progress: { kept: boolean; lost: string[] };
}

export interface RefusedConversion {
  to: ConvertTarget;
  reason: Words;
}

export interface ConversionList {
  block: string;
  from: ConvertTarget;
  targets: ConversionTarget[];
  refused: RefusedConversion[];
}

export interface ConvertBlockArgs {
  block: string;
  // Without to (dry run): the possible targets.
  to?: ConvertTarget;
  dryRun?: boolean;
  // The sentences of the result: en (default) or fr.
  language?: string;
}

export interface ConvertBlockResult {
  block: string;
  screen: string;
  dryRun: boolean;
  from: ConvertTarget;
  to?: ConvertTarget;
  kept?: string;
  lost?: string;
  added?: string;
  progress?: ConversionTarget['progress'];
  // Translation units that followed their text to another prop.
  translations?: number;
  // A dry run without to: every target, and those refused with their reason.
  targets?: { to: ConvertTarget; kept: string; lost: string; added: string; progress: ConversionTarget['progress'] }[];
  refused?: { to: ConvertTarget; reason: string }[];
}

// ── words ────────────────────────────────────────────────────────────

const w = (fr: string, en: string): Words => ({ fr, en });
const joinFr = (parts: string[]): string => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} et ${parts[parts.length - 1]}`);
const joinEn = (parts: string[]): string => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
const keeps = (...parts: Words[]): Words => w(`On garde ${joinFr(parts.map((p) => p.fr))}.`, `Keeps ${joinEn(parts.map((p) => p.en))}.`);
const loses = (...parts: Words[]): Words => w(`On perd ${joinFr(parts.map((p) => p.fr))}.`, `Loses ${joinEn(parts.map((p) => p.en))}.`);
const toAdd = (...parts: Words[]): Words => w(`Reste à ajouter : ${joinFr(parts.map((p) => p.fr))}.`, `To add: ${joinEn(parts.map((p) => p.en))}.`);

const N = {
  all: w('tout le contenu', 'all the content'),
  titles: w('les titres', 'the titles'),
  texts: w('les textes', 'the texts'),
  pictures: w('les images', 'the pictures'),
  dates: w('les dates', 'the dates'),
  positions: w('la place des repères', 'the markers\' positions'),
  picture: w('l\'image du bloc', 'the block\'s picture'),
  introSummary: w('l\'introduction et la synthèse', 'the intro and the summary'),
  prompt: w('la question posée avant d\'ouvrir', 'the prompt'),
  regions: w('les régions de la figure', 'the figure\'s regions'),
  figure: w('la figure du défilé', 'the scrolling figure'),
  focus: w('les points focaux', 'the focal points'),
  captions: w('les légendes', 'the captions'),
  galleryCaption: w('la légende de la galerie', 'the gallery\'s caption'),
  stem: w('la consigne', 'the instruction'),
  feedback: w('les retours', 'the feedback'),
  scoring: w('les réglages du score', 'the scoring settings'),
  author: w('l\'auteur, son rôle et son portrait', 'the author, their role and portrait'),
  statementPicture: w('l\'image de l\'énoncé', 'the statement\'s picture'),
  aside: w('la note en marge', 'the margin note'),
  calloutTitle: w('le titre de l\'encadré', 'the callout\'s title'),
  calloutKind: w('le type d\'encadré', 'the callout\'s kind'),
  chartExtras: w('la source, l\'élément mis en avant et les moments de la voix', 'the source, the highlighted item and the voice moments'),
  imageText: w('le titre et le texte de l\'image', 'the image\'s title and text'),
  zoneImage: w('l\'image où placer les zones', 'the picture the zones sit on'),
  optionPictures: w('une image par réponse', 'a picture for each option'),
  distractors: w('deux ou trois distracteurs', 'two or three distractors'),
  stepPictures: w('une image par étape', 'a picture for each step'),
  statementImage: w('l\'image sous l\'énoncé', 'the picture under the statement'),
  quoteAuthor: w('l\'auteur de la citation', 'the quotation\'s author'),
  itemTexts: w('le texte de chaque élément', 'each item\'s text'),
  targets: w('les cibles, et la cible de chaque élément', 'the targets, and each item\'s target'),
  scaleLabels: w('ce que disent les deux bouts de l\'échelle', 'what the two ends of the scale mean')
};

const PROGRESS_LOST = w('Les apprenants déjà commencés perdent ce qu\'ils avaient fait dans ce bloc.', 'Learners who already started lose what they did in this block.');
const NOT_SCORED = w('Il ne compte pas dans le score (scored: false).', 'It does not count in the score (scored: false).');

// ── the table ────────────────────────────────────────────────────────

interface Input {
  block: Block;
  props: Props;
  // The target presentation asked for (undefined: the target's default).
  presentation: string | undefined;
  screenTitle: string;
}

interface Built {
  props: Props;
  // Translation units that follow their text: [from, to] unit paths under block.<id>.
  moves?: [string, string][];
  kept: Words[];
  lost: Words[];
  added: Words[];
}

type Outcome = Built | { refused: Words };

interface Rule {
  from: string;
  to: string;
  // The presentation the dry run offers (any other of the target is accepted); null: not offered for this block.
  offer: (props: Props) => string | undefined | null;
  build: (input: Input) => Outcome;
}

const refuse = (fr: string, en: string): Outcome => ({ refused: w(fr, en) });
const itemsOf = (props: Props, key = 'items'): Item[] => (Array.isArray(props[key]) ? (props[key] as unknown[]).filter(isRecord) as Item[] : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const has = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);
const plain = (markdown: unknown): string => markdownToText(markdown).replace(/\\([\\`*_[\]$#>+-])/g, '$1');
const pick = (source: Props, keys: readonly string[]): Props => Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
const withPresentation = (props: Props, presentation: string | undefined): Props => (presentation ? { presentation, ...props } : props);
const tooLong = (items: Item[], key: string, max: number): number => items.filter((item) => text(item[key]).length > max).length;
const count = (n: number, fr: [string, string], en: [string, string]): Words => w(`${n} ${n > 1 ? fr[1] : fr[0]}`, `${n} ${n > 1 ? en[1] : en[0]}`);

// An item's picture as the target's: an empty alt marks it decorative in panels and sorts, decorative: true in steps.
function pictureOf(item: Item, to: 'panel' | 'step' | 'marker'): Item {
  if (!has(item.image)) return {};
  const decorative = item.decorative === true || item.alt === '';
  if (to === 'step') return decorative ? { image: item.image, decorative: true } : { image: item.image, ...(has(item.alt) ? { alt: item.alt } : {}) };
  return { image: item.image, alt: decorative ? '' : text(item.alt) };
}

// Markers placed on a grid over the picture, in reading order: the author moves them onto the parts.
function grid(n: number): { x: number; y: number }[] {
  const columns = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / columns);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return Array.from({ length: n }, (_, i) => ({ x: round(((i % columns) + 0.5) / columns), y: round((Math.floor(i / columns) + 0.5) / rows) }));
}
const GRID = w('Les repères sont placés sur une grille : posez-les sur les parties de l\'image.', 'The markers are placed on a grid: move them onto the parts of the picture.');
const ZONES = w('Les zones sont placées sur une grille : posez-les sur l\'image.', 'The zones are placed on a grid: move them onto the picture.');

// Items of panels, steps and markers, each as the target's items, their ids kept.
function asPanels(items: Item[]): Item[] {
  return items.map((item, i) => ({ id: text(item.id) || `i${i + 1}`, title: text(item.title) || `${i + 1}`, markdown: text(item.markdown), ...pictureOf(item, 'panel'), ...(isRecord(item.focus) ? { focus: item.focus } : {}) }));
}
function asSteps(items: Item[]): Item[] {
  return items.map((item, i) => ({ id: text(item.id) || `i${i + 1}`, title: text(item.title) || `${i + 1}`, markdown: text(item.markdown), ...pictureOf(item, 'step'), ...(has(item.date) ? { date: item.date } : {}) }));
}

const ITEM_TYPES = ['accordion', 'steps', 'hotspots'] as const;
const TITLE_MAX: Record<string, number> = { accordion: 200, steps: 120, hotspots: 80 };
const ITEMS_MAX: Record<string, number> = { accordion: 12, steps: 20, hotspots: 20, gallery: 24 };
const NAME: Record<string, Words> = {
  accordion: w('des panneaux', 'panels'), steps: w('des étapes', 'steps'), hotspots: w('une image interactive', 'an interactive picture'), gallery: w('une galerie', 'a gallery'),
  sort: w('un classement', 'a sort'), process: w('un processus', 'a process'), milestones: w('une frise de jalons', 'milestones')
};

// What an items block holds beyond its items, lost when it becomes another one.
function extrasLost(from: string, props: Props, to: string): Words[] {
  const lost: Words[] = [];
  const items = itemsOf(props);
  if (from === 'steps') {
    if (items.some((item) => has(item.date)) && to !== 'steps') lost.push(N.dates);
    const ends = introSummary(props);
    if (ends) lost.push(ends);
    if (items.some((item) => isRecord(item.region))) lost.push(N.regions);
    if (has(props.figureImage) && to !== 'hotspots') lost.push(N.figure);
  }
  if (from === 'accordion') {
    if (has(props.prompt) && to !== 'hotspots') lost.push(N.prompt);
    if (items.some((item) => isRecord(item.focus)) && to !== 'gallery') lost.push(N.focus);
  }
  if (from === 'hotspots') {
    lost.push(N.positions);
    if (has(props.prompt) && to !== 'accordion') lost.push(N.prompt);
  }
  return lost;
}

// A carousel's intro, its summary, or both.
function introSummary(props: Props): Words | null {
  const intro = isRecord(props.intro);
  const summary = isRecord(props.summary);
  return intro && summary ? N.introSummary : intro ? w('l\'introduction', 'the intro') : summary ? w('la synthèse', 'the summary') : null;
}

const RULES: Rule[] = [];

// Panels, steps and markers into one another: the items keep their id, title, text and picture.
for (const from of ITEM_TYPES) for (const to of ITEM_TYPES) {
  if (from === to) continue;
  RULES.push({
    from, to,
    offer: () => (to === 'hotspots' ? (from === 'steps' ? 'tour' : 'popover') : undefined),
    build: ({ props, presentation }) => {
      const items = itemsOf(props);
      if (!items.length) return refuse('Le bloc n\'a aucun élément.', 'The block has no items.');
      if (items.length > ITEMS_MAX[to]) return refuse(`${items.length} éléments : ${NAME[to].fr} en prennent ${ITEMS_MAX[to]} au plus.`, `${items.length} items: ${NAME[to].en} take ${ITEMS_MAX[to]} at most.`);
      const long = tooLong(items, 'title', TITLE_MAX[to]);
      if (long) return refuse(`${long} ${long > 1 ? 'titres dépassent' : 'titre dépasse'} ${TITLE_MAX[to]} caractères, la limite ${to === 'hotspots' ? 'd\'un repère' : 'd\'une étape'} : raccourcissez-les d'abord.`, `${long} ${long > 1 ? 'titles are' : 'title is'} over ${TITLE_MAX[to]} characters, the limit of ${to === 'hotspots' ? 'a marker' : 'a step'}: shorten them first.`);
      const kept: Words[] = [];
      const lost = extrasLost(from, props, to);
      const added: Words[] = [];
      const moves: [string, string][] = [];
      const keptParts = [N.titles, N.texts, ...(items.some((item) => has(item.image)) ? [N.pictures] : [])];
      let out: Props;
      if (to === 'accordion') {
        out = { items: asPanels(items), ...(from === 'hotspots' && has(props.prompt) ? { prompt: props.prompt } : {}) };
        if (from === 'hotspots' && has(props.image)) lost.push(N.picture);
      } else if (to === 'steps') {
        out = { items: asSteps(items) };
        // The picture of an interactive picture becomes the figure the steps scroll beside.
        if (from === 'hotspots' && has(props.image)) {
          out.figureImage = props.image;
          if (has(props.alt)) { out.figureAlt = props.alt; moves.push(['alt', 'figureAlt']); }
          if (props.decorative === true && !has(props.alt)) out.figureAlt = '';
          kept.push(w('L\'image devient la figure du défilé.', 'The picture becomes the scrolling figure.'));
        }
        if (presentation === 'timeline') added.push(N.dates);
        if (presentation === 'scroll' && !items.some((item) => has(item.image)) && !has(out.figureImage)) added.push(N.stepPictures);
      } else {
        // An interactive picture needs its picture: the steps' figure, else the first item's picture.
        const first = items.findIndex((item) => has(item.image));
        let picture: Props;
        let markers = items;
        if (from === 'steps' && has(props.figureImage)) {
          picture = { image: props.figureImage, ...(has(props.figureAlt) ? { alt: props.figureAlt } : { decorative: true }) };
          if (has(props.figureAlt)) moves.push(['figureAlt', 'alt']);
          kept.push(w('La figure du défilé devient l\'image du bloc.', 'The scrolling figure becomes the block\'s picture.'));
        } else if (first >= 0) {
          const item = items[first];
          picture = { image: item.image, ...(has(item.alt) ? { alt: item.alt } : { decorative: true }), ...(isRecord(item.focus) ? { focus: item.focus } : {}) };
          if (has(item.alt)) moves.push([`items.${String(item.id)}.alt`, 'alt']);
          markers = items.map((entry, i) => (i === first ? { ...entry, image: undefined, alt: undefined } : entry));
          kept.push(w(`L'image de « ${clip(text(item.title), 40)} » devient l'image du bloc.`, `The picture of "${clip(text(item.title), 40)}" becomes the block's picture.`));
        } else return refuse('Une image interactive a besoin d\'une image : aucun élément n\'en a.', 'An interactive picture needs a picture: no item has one.');
        const places = grid(markers.length);
        out = {
          ...picture,
          items: markers.map((item, i) => ({ id: text(item.id) || `i${i + 1}`, ...places[i], title: text(item.title) || `${i + 1}`, markdown: text(item.markdown), ...pictureOf(item, 'marker') })),
          ...(from === 'accordion' && has(props.prompt) && text(props.prompt).length <= 200 ? { prompt: props.prompt } : {})
        };
        if (from === 'accordion' && has(props.prompt) && text(props.prompt).length > 200) lost.push(N.prompt);
        added.push(GRID);
      }
      kept.unshift(keeps(...keptParts));
      return { props: withPresentation(out, presentation), moves, kept, lost, added };
    }
  });
}

// Items with pictures into a gallery, and back.
for (const from of ITEM_TYPES) {
  RULES.push({
    from, to: 'gallery',
    offer: (props) => (itemsOf(props).length && itemsOf(props).every((item) => has(item.image)) ? undefined : null),
    build: ({ props, presentation }) => {
      const items = itemsOf(props);
      const without = items.filter((item) => !has(item.image)).length;
      if (!items.length) return refuse('Le bloc n\'a aucun élément.', 'The block has no items.');
      if (without) return refuse(`${without} ${without > 1 ? 'éléments n\'ont' : 'élément n\'a'} pas d'image : une galerie ne montre que des images.`, `${without} ${without > 1 ? 'items have' : 'item has'} no picture: a gallery only shows pictures.`);
      const long = tooLong(items, 'title', 200);
      if (long) return refuse(`${long} ${long > 1 ? 'titres dépassent' : 'titre dépasse'} 200 caractères, la limite d'une légende.`, `${long} ${long > 1 ? 'titles are' : 'title is'} over 200 characters, the limit of a caption.`);
      if (presentation === 'compare' && items.length !== 2) return refuse('Comparer prend exactement deux images.', 'Compare takes exactly two pictures.');
      const moves: [string, string][] = [];
      const images = items.map((item, i) => {
        const id = text(item.id) || `i${i + 1}`;
        if (has(item.title)) moves.push([`items.${id}.title`, `images.${id}.caption`]);
        if (has(item.alt)) moves.push([`items.${id}.alt`, `images.${id}.alt`]);
        const decorative = item.decorative === true || item.alt === '';
        return { id, asset: item.image, ...(decorative ? { decorative: true } : has(item.alt) ? { alt: item.alt } : {}), ...(has(item.title) ? { caption: item.title } : {}), ...(isRecord(item.focus) ? { focus: item.focus } : {}) };
      });
      const lost = [...(items.some((item) => has(item.markdown)) ? [N.texts] : []), ...extrasLost(from, props, 'gallery')];
      if (from === 'hotspots' && has(props.image)) lost.push(N.picture);
      return { props: withPresentation({ images }, presentation), moves, kept: [keeps(N.pictures, w('les titres comme légendes', 'the titles as captions'))], lost, added: [] };
    }
  });
}
for (const to of ['accordion', 'steps'] as const) {
  RULES.push({
    from: 'gallery', to,
    offer: () => (to === 'accordion' ? 'cards' : undefined),
    build: ({ props, presentation }) => {
      const images = itemsOf(props, 'images');
      if (!images.length) return refuse('La galerie n\'a aucune image.', 'The gallery has no pictures.');
      if (images.length > ITEMS_MAX[to]) return refuse(`${images.length} images : ${NAME[to].fr} en prennent ${ITEMS_MAX[to]} au plus.`, `${images.length} pictures: ${NAME[to].en} take ${ITEMS_MAX[to]} at most.`);
      const moves: [string, string][] = [];
      const max = TITLE_MAX[to];
      const items = images.map((image, i) => {
        const id = text(image.id) || `i${i + 1}`;
        const caption = text(image.caption);
        if (caption && caption.length <= max) moves.push([`images.${id}.caption`, `items.${id}.title`]);
        if (has(image.alt)) moves.push([`images.${id}.alt`, `items.${id}.alt`]);
        const decorative = image.decorative === true;
        const title = caption ? clip(caption, max) : has(image.alt) ? clip(text(image.alt), max) : `${i + 1}`;
        const picture = to === 'steps' ? (decorative ? { image: image.asset, decorative: true } : { image: image.asset, ...(has(image.alt) ? { alt: image.alt } : {}) }) : { image: image.asset, alt: decorative ? '' : text(image.alt) };
        return { id, title, markdown: '', ...picture, ...(to === 'accordion' && isRecord(image.focus) ? { focus: image.focus } : {}) };
      });
      const lost = [...(has(props.caption) ? [N.galleryCaption] : []), ...(to === 'steps' && images.some((image) => isRecord(image.focus)) ? [N.focus] : [])];
      return { props: withPresentation({ items }, presentation), moves, kept: [keeps(N.pictures, w('les légendes comme titres', 'the captions as titles'))], lost, added: [toAdd(N.itemTexts)] };
    }
  });
}

// Panels into a sort's pairs (title ↔ text), and back.
RULES.push({
  from: 'accordion', to: 'sort',
  offer: () => 'pairs',
  build: ({ props, presentation }) => {
    if (presentation && presentation !== 'pairs') return refuse('Des panneaux deviennent un classement par paires (titre ↔ texte).', 'Panels become a sort in pairs (title ↔ text).');
    const items = itemsOf(props);
    if (items.length < 2) return refuse('Un classement a besoin d\'au moins deux paires.', 'A sort needs at least two pairs.');
    const sides = items.map((item) => ({ id: text(item.id), title: text(item.title), back: plain(item.markdown) }));
    const long = sides.filter((side) => side.title.length > 200 || side.back.length > 200).length;
    const empty = sides.filter((side) => !side.back).length;
    if (empty) return refuse(`${empty} ${empty > 1 ? 'panneaux n\'ont' : 'panneau n\'a'} pas de texte à associer à ${empty > 1 ? 'leur' : 'son'} titre.`, `${empty} ${empty > 1 ? 'panels have' : 'panel has'} no text to pair with ${empty > 1 ? 'their' : 'its'} title.`);
    if (long) return refuse(`${long} ${long > 1 ? 'panneaux ont' : 'panneau a'} un titre ou un texte de plus de 200 caractères : les éléments d'un classement sont courts. Raccourcissez-les d'abord.`, `${long} ${long > 1 ? 'panels have' : 'panel has'} a title or a text over 200 characters: a sort's items are short. Shorten them first.`);
    const moves: [string, string][] = sides.flatMap((side) => [[`items.${side.id}.title`, `items.${side.id}.text`], [`items.${side.id}.markdown`, `targets.${side.id}.text`]] as [string, string][]);
    const lost = [...(items.some((item) => has(item.image)) ? [N.pictures] : []), ...(has(props.prompt) ? [N.prompt] : []), ...(items.some((item) => /[*_`[\]]|\n/.test(text(item.markdown))) ? [w('la mise en forme des textes', 'the texts\' formatting')] : [])];
    return {
      props: { presentation: 'pairs', items: sides.map((side) => ({ id: side.id, text: side.title, target: side.id })), targets: sides.map((side) => ({ id: side.id, text: side.back })), scored: false },
      moves, kept: [keeps(w('chaque titre et son texte, en paires', 'each title and its text, as pairs')), NOT_SCORED], lost, added: [toAdd(N.stem, N.feedback)]
    };
  }
});
RULES.push({
  from: 'sort', to: 'accordion',
  offer: (props) => ((props.presentation ?? 'pairs') === 'pairs' ? undefined : null),
  build: ({ props, presentation }) => {
    if ((props.presentation ?? 'pairs') !== 'pairs') return refuse('Seul un classement par paires devient des panneaux (élément ↔ cible).', 'Only a sort in pairs becomes panels (item ↔ target).');
    const items = itemsOf(props);
    const targets = new Map(itemsOf(props, 'targets').map((target) => [text(target.id), target]));
    if (!items.length) return refuse('Le classement n\'a aucun élément.', 'The sort has no items.');
    const moves: [string, string][] = [];
    const panels = items.map((item, i) => {
      const id = text(item.id) || `i${i + 1}`;
      const target = targets.get(text(item.target));
      if (has(item.text)) moves.push([`items.${id}.text`, `items.${id}.title`]);
      if (target && has(target.text)) moves.push([`targets.${text(target.id)}.text`, `items.${id}.markdown`]);
      return { id, title: text(item.text) || text(item.alt) || `${i + 1}`, markdown: text(target?.text) || text(target?.alt) };
    });
    const lost = [N.stem, N.feedback, N.scoring, ...(items.some((item) => has(item.image)) || [...targets.values()].some((target) => has(target.image)) ? [N.pictures] : []), PROGRESS_LOST];
    return { props: withPresentation({ items: panels.slice(0, 12) }, presentation), moves, kept: [keeps(w('chaque paire, l\'élément comme titre et sa cible comme texte', 'each pair, the item as title and its target as text'))], lost: panels.length > 12 ? [...lost, w(`On perd ${panels.length - 12} paires au-delà de douze.`, `Loses ${panels.length - 12} pairs beyond twelve.`)] : lost, added: [] };
  }
});

// Steps into a sort in order, and back.
RULES.push({
  from: 'steps', to: 'sort',
  offer: () => 'order',
  build: ({ props, presentation }) => {
    if (presentation && presentation !== 'order') return refuse('Des étapes deviennent un classement dans l\'ordre.', 'Steps become a sort in order.');
    const items = itemsOf(props);
    if (items.length < 2) return refuse('Un classement a besoin d\'au moins deux étapes.', 'A sort needs at least two steps.');
    if (items.length > 12) return refuse(`${items.length} étapes : un classement en prend douze au plus.`, `${items.length} steps: a sort takes twelve at most.`);
    const moves: [string, string][] = items.map((item) => [`items.${text(item.id)}.title`, `items.${text(item.id)}.text`]);
    const sorted = items.map((item) => ({ id: text(item.id), text: text(item.title), ...(has(item.image) && has(item.alt) ? { image: item.image, alt: item.alt } : {}) }));
    for (const item of items) if (has(item.image) && has(item.alt)) moves.push([`items.${text(item.id)}.alt`, `items.${text(item.id)}.alt`]);
    const lost = [...(items.some((item) => has(item.markdown)) ? [N.texts] : []), ...extrasLost('steps', props, 'sort'), ...(items.some((item) => has(item.image) && !has(item.alt)) ? [w('les images sans texte de remplacement', 'the pictures without a text alternative')] : [])];
    return { props: { presentation: 'order', items: sorted, scored: false }, moves, kept: [keeps(w('les titres, dans l\'ordre des étapes : c\'est la bonne réponse', 'the titles, in the steps\' order: it is the right answer')), NOT_SCORED], lost, added: [toAdd(N.stem, N.feedback)] };
  }
});
RULES.push({
  from: 'sort', to: 'steps',
  offer: (props) => (props.presentation === 'order' ? undefined : null),
  build: ({ props, presentation }) => {
    if (props.presentation !== 'order') return refuse('Seul un classement dans l\'ordre devient des étapes.', 'Only a sort in order becomes steps.');
    const items = itemsOf(props);
    if (!items.length) return refuse('Le classement n\'a aucun élément.', 'The sort has no items.');
    if (items.some((item) => text(item.text).length > 120)) return refuse('Un élément dépasse 120 caractères, la limite du titre d\'une étape.', 'An item is over 120 characters, the limit of a step\'s title.');
    const moves: [string, string][] = items.filter((item) => has(item.text)).map((item) => [`items.${text(item.id)}.text`, `items.${text(item.id)}.title`]);
    const steps = items.map((item, i) => ({ id: text(item.id) || `i${i + 1}`, title: text(item.text) || clip(text(item.alt), 120) || `${i + 1}`, markdown: '', ...(has(item.image) ? { image: item.image, ...(has(item.alt) ? { alt: item.alt } : {}) } : {}) }));
    return { props: withPresentation({ items: steps }, presentation), moves, kept: [keeps(w('les éléments, dans le bon ordre, comme titres des étapes', 'the items, in the right order, as the steps\' titles'))], lost: [N.stem, N.feedback, N.scoring, PROGRESS_LOST], added: [toAdd(N.itemTexts)] };
  }
});

// Steps into the D60 charts process and milestones, and back.
for (const chart of ['process', 'milestones'] as const) {
  const max = chart === 'process' ? 7 : 8;
  const titleMax = chart === 'process' ? 60 : 80;
  RULES.push({
    from: 'steps', to: chart,
    offer: (props) => (chart === 'milestones' && !itemsOf(props).every((item) => has(item.date)) ? null : undefined),
    build: ({ props, screenTitle }) => {
      const items = itemsOf(props);
      if (items.length < 2 || items.length > max) return refuse(`${items.length} étapes : ${NAME[chart].fr} en prend de deux à ${max}.`, `${items.length} steps: ${NAME[chart].en} take two to ${max}.`);
      if (chart === 'milestones') {
        const undated = items.filter((item) => !has(item.date)).length;
        if (undated) return refuse(`${undated} ${undated > 1 ? 'étapes n\'ont' : 'étape n\'a'} pas de date : chaque jalon est daté.`, `${undated} ${undated > 1 ? 'steps have' : 'step has'} no date: every milestone is dated.`);
        if (items.some((item) => text(item.date).length > 24)) return refuse('Une date dépasse 24 caractères, la limite d\'un jalon.', 'A date is over 24 characters, the limit of a milestone.');
      }
      let clipped = 0;
      let dropped = 0;
      const moves: [string, string][] = [];
      const entries = items.map((item) => {
        const id = text(item.id);
        const title = text(item.title);
        if (title.length > titleMax) clipped++;
        else moves.push([`items.${id}.title`, `items.${id}.title`]);
        const said = plain(item.markdown);
        const fits = said.length > 0 && said.length <= 200;
        if (has(item.markdown) && !fits) dropped++;
        if (fits && said === text(item.markdown)) moves.push([`items.${id}.markdown`, `items.${id}.text`]);
        return { id, ...(chart === 'milestones' ? { date: item.date } : {}), title: clip(title, titleMax), ...(fits ? { text: said } : {}) };
      });
      const intro = isRecord(props.intro) ? text(props.intro.title) : '';
      const takeaway = clip(intro || screenTitle || text(items[0].title), 160);
      if (intro && intro.length <= 160) moves.push(['intro.title', 'takeaway']);
      const lost: Words[] = [];
      if (clipped) lost.push(w(`On coupe ${clipped} ${clipped > 1 ? 'titres' : 'titre'} à ${titleMax} caractères.`, `Cuts ${clipped} ${clipped > 1 ? 'titles' : 'title'} to ${titleMax} characters.`));
      if (dropped) lost.push(w(`On perd ${dropped} ${dropped > 1 ? 'textes trop longs' : 'texte trop long'} pour le graphique (200 caractères).`, `Loses ${dropped} ${dropped > 1 ? 'texts too long' : 'text too long'} for the chart (200 characters).`));
      const extras = [...(items.some((item) => has(item.image)) ? [N.pictures] : []), ...(chart === 'process' && items.some((item) => has(item.date)) ? [N.dates] : []), ...(isRecord(props.summary) ? [w('la synthèse', 'the summary')] : []), ...(has(props.figureImage) ? [N.figure] : []), ...(items.some((item) => isRecord(item.region)) ? [N.regions] : [])];
      if (extras.length) lost.push(loses(...extras));
      if (items.some((item) => /[*_`[\]]|\n/.test(text(item.markdown)))) lost.push(w('Les textes perdent leur mise en forme.', 'The texts lose their formatting.'));
      const added = intro ? [w('Le titre-message du graphique reprend le titre de l\'introduction : écrivez-le comme un constat.', 'The chart\'s takeaway is the intro\'s title: write it as the finding.')] : [w('Le titre-message du graphique reprend le titre de l\'écran : écrivez-le comme un constat.', 'The chart\'s takeaway is the screen\'s title for now: write it as the finding.')];
      return { props: { takeaway, items: entries }, moves, kept: [keeps(...(chart === 'milestones' ? [N.dates] : []), N.titles, w('les textes courts', 'the short texts'))], lost, added };
    }
  });
  RULES.push({
    from: chart, to: 'steps',
    offer: () => (chart === 'milestones' ? 'timeline' : undefined),
    build: ({ props, presentation }) => {
      const items = itemsOf(props);
      if (!items.length) return refuse('Le graphique n\'a aucun élément.', 'The chart has no items.');
      const moves: [string, string][] = items.filter((item) => has(item.text)).map((item) => [`items.${text(item.id)}.text`, `items.${text(item.id)}.markdown`]);
      const steps = items.map((item, i) => ({ id: text(item.id) || `i${i + 1}`, title: text(item.title) || `${i + 1}`, markdown: text(item.text), ...(has(item.date) ? { date: item.date } : {}) }));
      moves.push(['takeaway', 'intro.title']);
      const lost = [...(has(props.context) ? [w('la ligne de contexte', 'the context line')] : []), ...(has(props.source) || has(props.highlight) || items.some((item) => isRecord(item.at)) ? [N.chartExtras] : [])];
      return { props: withPresentation({ items: steps, ...(has(props.takeaway) ? { intro: { title: clip(text(props.takeaway), 120) } } : {}) }, presentation), moves, kept: [keeps(...(chart === 'milestones' ? [N.dates] : []), N.titles, N.texts, w('le titre-message comme introduction', 'the takeaway as the intro'))], lost: lost.length ? [loses(...lost)] : [], added: [] };
    }
  });
}

// A statement, a callout and a text into one another: the words and their plan link are kept.
const TEXTS = ['statement', 'callout', 'text'] as const;
for (const from of TEXTS) for (const to of TEXTS) {
  if (from === to) continue;
  RULES.push({
    from, to,
    offer: () => undefined,
    build: ({ props, presentation }) => {
      const source: Props = has(props.textRef) ? { textRef: props.textRef } : { markdown: text(props.markdown) };
      if (to === 'statement' && text(source.markdown).length > 400) return refuse('Le texte dépasse 400 caractères : un énoncé tient en une ou deux phrases.', 'The text is over 400 characters: a statement is one or two sentences.');
      const lost: Words[] = [];
      if (from === 'statement') {
        if (has(props.author) || has(props.role) || has(props.portrait)) lost.push(N.author);
        if (has(props.image)) lost.push(N.statementPicture);
      }
      if (from === 'callout') {
        if (has(props.title)) lost.push(N.calloutTitle);
        if (props.variant && props.variant !== 'info') lost.push(N.calloutKind);
      }
      if (from === 'text' && has(props.aside)) lost.push(N.aside);
      const out: Props = to === 'callout' ? { variant: 'info', ...source } : source;
      return { props: withPresentation(out, to === 'statement' ? presentation : undefined), kept: [keeps(has(props.textRef) ? w('le texte validé du plan', 'the plan\'s validated text') : w('le texte', 'the text'))], lost: lost.length ? [loses(...lost)] : [], added: [] };
    }
  });
}

// An image and a gallery of one image.
RULES.push({
  from: 'image', to: 'gallery',
  offer: () => undefined,
  build: ({ props, presentation }) => {
    if (presentation === 'compare') return refuse('Comparer prend deux images.', 'Compare takes two pictures.');
    const id = 'i1';
    const image = { id, asset: props.asset, ...pick(props, ['alt', 'caption', 'focus', 'decorative']) };
    const moves: [string, string][] = [];
    if (has(props.alt)) moves.push(['alt', `images.${id}.alt`]);
    if (has(props.caption)) moves.push(['caption', `images.${id}.caption`]);
    const lost = [...(has(props.title) || has(props.markdown) ? [N.imageText] : [])];
    return { props: withPresentation({ images: [image], ...pick(props, ['zoom', 'generated']) }, presentation), moves, kept: [keeps(w('l\'image, son texte de remplacement et sa légende', 'the picture, its text alternative and its caption'))], lost: lost.length ? [loses(...lost)] : [], added: [w('Ajoutez d\'autres images à la galerie.', 'Add more pictures to the gallery.')] };
  }
});
RULES.push({
  from: 'gallery', to: 'image',
  offer: (props) => (itemsOf(props, 'images').length === 1 ? undefined : null),
  build: ({ props, presentation }) => {
    const images = itemsOf(props, 'images');
    if (images.length !== 1) return refuse(`La galerie a ${images.length} images : une image n'en montre qu'une.`, `The gallery has ${images.length} pictures: an image shows one.`);
    const [image] = images;
    const id = text(image.id);
    const moves: [string, string][] = [];
    if (has(image.alt)) moves.push([`images.${id}.alt`, 'alt']);
    const caption = has(image.caption) ? image.caption : props.caption;
    if (has(image.caption)) moves.push([`images.${id}.caption`, 'caption']);
    else if (has(props.caption)) moves.push(['caption', 'caption']);
    return { props: withPresentation({ asset: image.asset, ...pick(image, ['alt', 'focus', 'decorative']), ...(has(caption) ? { caption } : {}), ...pick(props, ['zoom', 'generated']) }, presentation), moves, kept: [keeps(w('l\'image, son texte de remplacement et sa légende', 'the picture, its text alternative and its caption'))], lost: [], added: [] };
  }
});

// A text with a list into panels or steps: each list item becomes an item, its first sentence the
// title when it is short.
for (const to of ['accordion', 'steps'] as const) {
  RULES.push({
    from: 'text', to,
    offer: (props) => (listItems(text(props.markdown)).items.length >= 2 ? undefined : null),
    build: ({ props, presentation }) => {
      if (has(props.textRef)) return refuse('Ce texte est un texte validé du plan : il reste un texte.', 'This text is a validated text of the plan: it stays a text.');
      const { items, rest } = listItems(text(props.markdown));
      if (items.length < 2) return refuse('Le texte n\'a pas de liste à puces ou numérotée d\'au moins deux éléments.', 'The text has no bulleted or numbered list of two items or more.');
      if (items.length > ITEMS_MAX[to]) return refuse(`${items.length} éléments de liste : ${NAME[to].fr} en prennent ${ITEMS_MAX[to]} au plus.`, `${items.length} list items: ${NAME[to].en} take ${ITEMS_MAX[to]} at most.`);
      const max = to === 'accordion' ? 60 : 60;
      const entries = items.map((item, i) => ({ id: `i${i + 1}`, ...titled(item, max) }));
      const lost: Words[] = [];
      if (rest) lost.push(w('On perd les paragraphes autour de la liste.', 'Loses the paragraphs around the list.'));
      if (has(props.aside)) lost.push(loses(N.aside));
      return { props: withPresentation({ items: entries }, presentation), kept: [keeps(w('chaque élément de la liste, sa première phrase comme titre quand elle est courte', 'each list item, its first sentence as the title when it is short'))], lost, added: [] };
    }
  });
}

// The items of the first list of a Markdown text (bullets or numbers; indented lines continue an
// item), and whether other paragraphs surround it.
export function listItems(markdown: string): { items: string[]; rest: boolean } {
  const items: string[] = [];
  let rest = false;
  let inList = false;
  let ended = false;
  for (const line of markdown.split('\n')) {
    const bullet = /^\s{0,3}(?:[-*+]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (bullet && !ended) { items.push(bullet[1].trim()); inList = true; continue; }
    if (inList && !ended && /^\s{2,}\S/.test(line)) { items[items.length - 1] += ` ${line.trim()}`; continue; }
    if (!line.trim()) { if (inList) ended = true; continue; }
    if (bullet && ended) { rest = true; continue; }
    rest = true;
    if (inList) ended = true;
  }
  return { items, rest };
}

// A list item as a title and a text: a bold lead (**Term**: …) or a short first sentence becomes
// the title; else the first words, the whole item staying the text.
export function titled(item: string, max: number): { title: string; markdown: string } {
  const bold = /^\*\*([^*]+)\*\*\s*[:—–.-]?\s*(.*)$/.exec(item);
  if (bold && bold[1].trim().length <= max) return { title: bold[1].trim().replace(/[.:]$/, ''), markdown: bold[2].trim() };
  const sentence = /^(.+?[.!?:])(?:\s+(.+))?$/.exec(item);
  if (sentence && plain(sentence[1]).length <= max) return { title: plain(sentence[1]).replace(/[.:]$/, ''), markdown: (sentence[2] ?? '').trim() };
  const words = plain(item);
  if (words.length <= max) return { title: words, markdown: '' };
  return { title: clip(words.slice(0, 40).replace(/\s+\S*$/, ''), 41).replace(/…?$/, '…'), markdown: item };
}

// ── presentations of one block ──────────────────────────────────────

// Switching presentation keeps every prop; what the new form needs and does not have yet starts empty.
function samePresentation(type: string, props: Props, presentation: string): Outcome {
  const added: Words[] = [];
  const lost: Words[] = [];
  const out: Props = { ...props, presentation };
  const items = itemsOf(props);
  const from = (props.presentation as string | undefined) ?? undefined;
  switch (type) {
    case 'steps':
      if (presentation === 'timeline' && items.some((item) => !has(item.date))) added.push(N.dates);
      if (presentation === 'scroll' && !items.some((item) => has(item.image)) && !has(props.figureImage)) added.push(N.stepPictures);
      if (presentation !== 'carousel' && (isRecord(props.intro) || isRecord(props.summary))) lost.push(w('L\'introduction et la synthèse ne s\'affichent que dans le carrousel (elles restent dans le bloc).', 'The intro and the summary only show in the carousel (they stay in the block).'));
      break;
    case 'quiz': {
      const options = itemsOf(props, 'options');
      if (has(props.questionRef) && presentation !== 'text') return refuse('Cette question vient du plan : ses réponses n\'ont pas d\'image. Écrivez-la dans le bloc ou dupliquez le quiz.', 'This question comes from the plan: its options have no pictures. Write it in the block, or fork the quiz.');
      if (presentation === 'images' && options.some((option) => !has(option.image))) added.push(N.optionPictures);
      if (presentation === 'image') {
        if (!has(props.image)) added.push(N.zoneImage);
        if (options.some((option) => typeof option.x !== 'number' || typeof option.y !== 'number')) {
          const places = grid(options.length);
          out.options = options.map((option, i) => (typeof option.x === 'number' && typeof option.y === 'number' ? option : { ...option, ...places[i] }));
          added.push(ZONES);
        }
      }
      if (presentation === 'text' && from === 'images' && options.some((option) => has(option.image))) lost.push(w('Les images des réponses ne s\'affichent plus (elles restent dans le bloc).', 'The options\' pictures no longer show (they stay in the block).'));
      break;
    }
    case 'statement':
      if (presentation === 'image' && !has(props.image)) added.push(N.statementImage);
      if (presentation === 'quote' && !has(props.author)) added.push(N.quoteAuthor);
      break;
    case 'image':
      if ((presentation === 'beside' || presentation === 'over') && !has(props.title) && !has(props.markdown)) added.push(N.imageText);
      if ((presentation === 'centered' || presentation === 'wide' || presentation === 'band') && (has(props.title) || has(props.markdown))) lost.push(w('Le titre et le texte ne s\'affichent qu\'à côté ou sur l\'image (ils restent dans le bloc).', 'The title and the text only show beside or over the picture (they stay in the block).'));
      break;
    case 'gallery':
      if (presentation === 'compare' && itemsOf(props, 'images').length !== 2) return refuse('Comparer prend exactement deux images.', 'Compare takes exactly two pictures.');
      break;
    case 'accordion':
      if (presentation === 'tabs') {
        const long = tooLong(items, 'title', 24);
        if (long) added.push(w(`Raccourcissez ${long} ${long > 1 ? 'titres' : 'titre'} à 24 caractères pour des onglets.`, `Shorten ${long} ${long > 1 ? 'titles' : 'title'} to 24 characters for tabs.`));
      }
      break;
    case 'fill-in':
      if ((presentation === 'menus' || presentation === 'bank') && !(Array.isArray(props.distractors) && props.distractors.length)) added.push(N.distractors);
      break;
    case 'sort': {
      const targets = itemsOf(props, 'targets');
      if (presentation === 'categories' && from !== 'order' && targets.length > 4) return refuse(`${targets.length} cibles : un classement par catégories en a de deux à quatre.`, `${targets.length} targets: a sort in categories has two to four.`);
      if (presentation === 'pairs' && from === 'categories' && targets.length !== items.length) return refuse(`${items.length} éléments pour ${targets.length} catégories : des paires vont une à une.`, `${items.length} items for ${targets.length} categories: pairs go one to one.`);
      if (presentation === 'order') {
        if (targets.length) lost.push(w('Les cibles ne servent plus (elles restent dans le bloc).', 'The targets are no longer used (they stay in the block).'));
        added.push(w('L\'ordre des éléments devient la bonne réponse : vérifiez-le.', 'The items\' order becomes the right answer: check it.'));
      } else if (from === 'order' && !targets.length) added.push(N.targets);
      break;
    }
    case 'reflection':
      if (presentation === 'scale' && !(isRecord(props.scale) && has(props.scale.minLabel) && has(props.scale.maxLabel))) added.push(N.scaleLabels);
      break;
  }
  return { props: out, kept: [keeps(N.all)], lost, added };
}

// ── planning ─────────────────────────────────────────────────────────

interface Planned {
  to: ConvertTarget;
  outcome: Outcome;
}

interface Source {
  project: Project;
  block: Block;
  type: string;
  props: Props;
  presentations: string[]; // of the source type ([]: none)
  screenTitle: string;
}

function sourceOf(project: Project, blockId: string): Source & { screenId: string } {
  const place = findBlock(project, blockId);
  const registry = getRegistry(project);
  const descriptor = registry.get(place.block.type);
  if (!descriptor) throw new CommandError(`"${blockId}" is a ${place.block.type} block, a type this course does not know.`);
  if (!descriptor.builtin) throw new CommandError(`"${blockId}" is a ${place.block.type} block, a course component: detach it first (elabora block detach) to convert its native blocks.`);
  const screen = project.screens.get(place.screenId)?.data as Screen | undefined;
  return { project, block: place.block, type: place.block.type, props: isRecord(place.block.props) ? place.block.props : {}, presentations: presentationsOf(project, place.block.type), screenTitle: typeof screen?.title === 'string' ? screen.title : '', screenId: place.screenId };
}

function presentationsOf(project: Project, type: string): string[] {
  const schema = getRegistry(project).get(type)?.schema as { properties?: { presentation?: { enum?: unknown } } } | undefined;
  const values = schema?.properties?.presentation?.enum;
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
}

// Every target of a block: the other presentations of its type, then the conversions of the table.
function plan(source: Source, only?: ConvertTarget): Planned[] {
  const out: Planned[] = [];
  const current = (source.props.presentation as string | undefined) ?? source.presentations[0];
  const input = (presentation: string | undefined): Input => ({ block: source.block, props: source.props, presentation, screenTitle: source.screenTitle });
  if (only) {
    if (only.type === source.type) {
      if (!only.presentation) throw new CommandError(`"${source.block.id}" is already a ${source.type} block: give a presentation to switch to (${source.presentations.join(', ') || 'it has none'}).`);
      if (!source.presentations.includes(only.presentation)) throw new CommandError(`${source.type} has no presentation "${only.presentation}" (${source.presentations.join(', ') || 'none'}).`);
      if (only.presentation === current) throw new CommandError(`"${source.block.id}" is already a ${source.type} block in presentation ${current}.`);
      return [{ to: only, outcome: samePresentation(source.type, source.props, only.presentation) }];
    }
    const rule = RULES.find((entry) => entry.from === source.type && entry.to === only.type);
    if (!rule) throw new CommandError(`A ${source.type} block does not convert into ${only.type}. ${targetsSentence(source)}`);
    const targets = presentationsOf(source.project, only.type);
    if (only.presentation && !targets.includes(only.presentation)) throw new CommandError(`${only.type} has no presentation "${only.presentation}" (${targets.join(', ') || 'none'}).`);
    return [{ to: only, outcome: rule.build(input(only.presentation)) }];
  }
  for (const presentation of source.presentations) {
    if (presentation === current) continue;
    out.push({ to: { type: source.type, presentation }, outcome: samePresentation(source.type, source.props, presentation) });
  }
  for (const rule of RULES.filter((entry) => entry.from === source.type)) {
    const presentation = rule.offer(source.props);
    if (presentation === null) continue;
    const to: ConvertTarget = { type: rule.to, ...(presentation ? { presentation } : {}) };
    out.push({ to, outcome: rule.build(input(presentation)) });
  }
  return out;
}

function targetsSentence(source: Source): string {
  const types = [...new Set(RULES.filter((entry) => entry.from === source.type).map((entry) => entry.to))];
  return types.length ? `It converts into ${types.join(', ')}${source.presentations.length > 1 ? `, or another presentation (${source.presentations.join(', ')})` : ''}.` : source.presentations.length > 1 ? `It only changes presentation (${source.presentations.join(', ')}).` : 'It converts into nothing.';
}

// The block after the conversion: same id and placement, the target's type and props.
const converted = (block: Block, to: ConvertTarget, props: Props): Block => ({ ...block, type: to.type, props });

// What learners who started keep: the block's activity and controls, before and after (lock entities).
function progressOf(project: Project, before: Block, after: Block): ConversionTarget['progress'] {
  const entities = (block: Block): string[] => {
    const behavior = instanceBehavior(getRegistry(project), block);
    const activity = behavior && behavior !== 'predict' && ['quiz', 'numeric', 'fill-in', 'sort', 'reflection', 'decision', 'dialogue', 'object'].includes(behavior) ? [activityEntity(behavior as ActivityBehavior, block.id)] : [];
    let controls: string[] = [];
    try { controls = [...blockControls(project, block).keys()].map((name) => controlEntity(block.id, name)); } catch { /* props the template cannot render: no controls */ }
    return [...activity, ...controls];
  };
  const after_ = new Set(entities(after));
  const lost = entities(before).filter((entity) => !after_.has(entity));
  return { kept: !lost.length, lost };
}

// Lists of nouns (the dates, the pictures) become one sentence (« On perd les dates et les images. »);
// sentences stay as they are.
const isSentence = (part: Words): boolean => /[.!?)]$/.test(part.en);
function sentences(parts: readonly Words[], wrap: (...nouns: Words[]) => Words): Words[] {
  const nouns = parts.filter((part) => !isSentence(part));
  return [...(nouns.length ? [wrap(...nouns)] : []), ...parts.filter(isSentence)];
}

function wordsOf(built: Built, progress: ConversionTarget['progress']): { fr: ConversionWords; en: ConversionWords } {
  const lost = sentences(progress.kept || built.lost.includes(PROGRESS_LOST) ? built.lost : [...built.lost, PROGRESS_LOST], loses);
  const added = sentences(built.added, toAdd);
  built = { ...built, lost, added };
  const join = (parts: Words[], language: 'fr' | 'en') => parts.map((part) => part[language]).join(' ');
  return {
    fr: { kept: join(built.kept, 'fr'), lost: join(lost, 'fr'), added: join(built.added, 'fr') },
    en: { kept: join(built.kept, 'en'), lost: join(lost, 'en'), added: join(built.added, 'en') }
  };
}

// The possible targets of a block, with what each keeps, loses and adds; refused ones with their reason.
export function conversionsFor(project: Project, blockId: string): ConversionList {
  const source = sourceOf(project, blockId);
  const targets: ConversionTarget[] = [];
  const refused: RefusedConversion[] = [];
  for (const { to, outcome } of plan(source)) {
    if ('refused' in outcome) { refused.push({ to, reason: outcome.refused }); continue; }
    const progress = progressOf(project, source.block, converted(source.block, to, outcome.props));
    targets.push({ to, words: wordsOf(outcome, progress), progress });
  }
  return { block: blockId, from: fromOf(source), targets, refused };
}

const fromOf = (source: Source): ConvertTarget => ({ type: source.type, ...(source.presentations.length ? { presentation: (source.props.presentation as string | undefined) ?? source.presentations[0] } : {}) });
const languageOf = (language: string | undefined): 'fr' | 'en' => (language?.toLowerCase().startsWith('fr') ? 'fr' : 'en');

// The conversions of a block as the app shows them, in one language (fr, else en).
export function conversionTargets(project: Project, blockId: string, language?: string): { block: string; from: ConvertTarget; targets: { to: ConvertTarget; kept: string; lost: string; added: string; progress: ConversionTarget['progress'] }[]; refused: { to: ConvertTarget; reason: string }[] } {
  const list = conversionsFor(project, blockId);
  const lang = languageOf(language);
  return {
    block: list.block, from: list.from,
    targets: list.targets.map((target) => ({ to: target.to, ...target.words[lang], progress: target.progress })),
    refused: list.refused.map((entry) => ({ to: entry.to, reason: entry.reason[lang] }))
  };
}

// ── the command ──────────────────────────────────────────────────────

// convert_block: the block in place, one change (its translations follow). dryRun, or no to: what it
// would do, nothing written.
export function convertBlock(context: CommandContext, args: ConvertBlockArgs): CommandOutput<ConvertBlockResult> {
  const project = context.project();
  const source = sourceOf(project, args.block);
  const lang = languageOf(args.language);
  const from = fromOf(source);
  if (!args.to) {
    const list = conversionTargets(project, args.block, lang);
    return { files: context.files, result: { block: args.block, screen: source.screenId, dryRun: true, from, targets: list.targets, refused: list.refused } };
  }
  if (!isRecord(args.to) || typeof args.to.type !== 'string') throw new CommandError('to: { type, presentation? }, the type to convert into.');
  const to: ConvertTarget = { type: args.to.type, ...(typeof args.to.presentation === 'string' && args.to.presentation ? { presentation: args.to.presentation } : {}) };
  const [{ outcome }] = plan(source, to);
  if ('refused' in outcome) throw new CommandError(`${source.type} "${args.block}" does not convert into ${to.type}${to.presentation ? ` (${to.presentation})` : ''}: ${outcome.refused.en}`, [], 'E_CONVERT_REFUSED');
  const after = converted(source.block, to, outcome.props);
  const progress = progressOf(project, source.block, after);
  const words = wordsOf(outcome, progress)[lang];
  // The result names the presentation the block takes (the target's default when none was asked).
  const presentations = presentationsOf(project, to.type);
  const shown: ConvertTarget = to.presentation || !presentations.length ? to : { ...to, presentation: (outcome.props.presentation as string | undefined) ?? presentations[0] };
  const result: ConvertBlockResult = { block: args.block, screen: source.screenId, dryRun: args.dryRun === true, from, to: shown, ...words, progress };
  if (args.dryRun) return { files: context.files, result };

  const draft = new Draft(context.files);
  const place = findBlock(project, args.block);
  const screen = draft.json<Screen>(place.file);
  const list = listAt(screen, place.list);
  list[place.index] = { ...list[place.index], type: to.type, props: outcome.props } as Block;
  draft.writeJson(place.file, screen);
  result.translations = moveUnits(context, draft, args.block, outcome.moves ?? []);
  return { files: draft.files(), result };
}

// Translation units follow their text to its new prop: block.<id>.<from> becomes block.<id>.<to> in
// every translations/<lang>.xlf (their source text is the same, so their translation still holds).
function moveUnits(context: CommandContext, draft: Draft, blockId: string, moves: readonly [string, string][]): number {
  const renames = moves.filter(([from, to]) => from !== to);
  if (!renames.length) return 0;
  let moved = 0;
  for (const name of filesIn(context.files, 'translations').filter((file) => file.endsWith('.xlf'))) {
    const file = `translations/${name}`;
    const before = draft.text(file);
    if (before === null) continue;
    // Two passes through placeholders, so that units swapping their names (a ↔ b) do not collide.
    let next = before;
    renames.forEach(([from], i) => {
      const search = `<unit id="block.${blockId}.${from}"`;
      if (next.includes(search)) { next = next.split(search).join(`<unit id="\u0000${i}"`); moved++; }
    });
    renames.forEach(([, to], i) => { next = next.split(`<unit id="\u0000${i}"`).join(`<unit id="block.${blockId}.${to}"`); });
    if (next !== before) draft.writeText(file, next);
  }
  return moved;
}
