import { screenOrder, screenBlocks } from '../project/load.ts';
import { hasDirections } from '../narration/directions.ts';
import { getRegistry } from '../components/registry.ts';
import { kindOf } from '../components/template.ts';
import type { SchemaNode } from '../components/template.ts';
import type { Project, Block } from '../project/model.ts';
import { isRecord, recordOf, textOf } from '../compile/values.ts';
import { listOf } from '../util/values.ts';
import { pointer } from '../util/json.ts';
import { enumPlaces } from '../validate/object-props.ts';
import { lineWordAnchors, anchorMarks } from './anchors.ts';
import type { XliffMark } from './xliff.ts';

// Translation units: every string a learner (or the approver of a translated plan, or an author in
// the editor of the translated course) reads, with a stable id, the file and JSON pointer it comes
// from, and what translators need to know.
//   course.title · course.section.<id>.title · course.ui.<label>
//   plan.title · plan.objective.<OBJ>.statement · plan.item.<ITEM>.title · plan.text.<TXT>
//   plan.question.<Q>.stem / .option.<id>.text / .feedback.correct / .misconception.<id>.feedback…
//   course.speaker.<id>.name · course.glossary.<id>.term / .definition / .variant.<n>
//   course.resource.<id>.title / .description · course.credit.<n> · course.logo.alt
//   screen.<id>.title · screen.<id>.layout.<prop> · screen.<id>.layer.<id>.title · screen.<id>.step.<n>.label
//   screen.<id>.narration.<line>.text
//   block.<id>.<prop path> (array items by id when they have one) · block.<id>.strings.<key>
//   block.<id>.enumLabels.<prop or prop_field>.<value>
// Ids only use letters, digits, '.', '-' and '_' (XLIFF unit ids are NMTOKENs). Words never live in
// CSS, templates or figures (the validator sees to it), so these units are the whole text of a course.
export type UnitFormat = 'text' | 'markdown' | 'icu';

export interface TranslationUnit {
  id: string;
  file: string;
  pointer: string; // JSON pointer of the string in its file
  text: string;
  format: UnitFormat;
  note?: string;
  maxLength?: number;
  // What the file holds at a pointer above this one, written there first when the file has nothing:
  // a free-object list a block leaves to the manifest default (its words are in the default's items).
  base?: { pointer: string; value: unknown };
  // Words authors read in the editor, not learners (how a free object's choices read): translated
  // with the course, never found by findText.
  editor?: boolean;
  // A narration line's word anchors (docs/decisions.md D28): the markers translators place.
  marks?: (XliffMark & { word: string })[];
}

interface UnitOptions {
  format?: UnitFormat;
  note?: string;
  maxLength?: number;
  base?: { pointer: string; value: unknown };
  editor?: boolean;
  marks?: (XliffMark & { word: string })[];
}

// Adds a unit for a value, when it is words: units come from values of any type.
type AddUnit = (id: string, pointer: string, text: unknown, options: UnitOptions) => void;

export function extractUnits(project: Project): TranslationUnit[] {
  const units: TranslationUnit[] = [];
  const registry = getRegistry(project);
  const seen = new Set<string>();
  const add = (id: string, file: string, pointer: string, text: unknown, { format = 'text', note, maxLength, base, editor, marks }: UnitOptions = {}): void => {
    if (typeof text !== 'string' || !/\p{L}/u.test(text) || seen.has(id)) return;
    seen.add(id);
    units.push({ id, file, pointer, text, format, ...(note ? { note } : {}), ...(maxLength ? { maxLength } : {}), ...(base ? { base } : {}), ...(editor ? { editor } : {}), ...(marks?.length ? { marks } : {}) });
  };
  const course = project.course;
  add('course.title', 'course.json', '/title', course?.title, { note: 'Course title' });
  add('course.description', 'course.json', '/description', course?.description, { note: 'Course description (catalogue)' });
  listOf(course?.sections).forEach((section, i) => { if (isRecord(section)) add(`course.section.${section.id}.title`, 'course.json', `/sections/${i}/title`, section.title, { note: 'Section of the course outline' }); });
  for (const [label, text] of Object.entries(course?.ui || {})) add(`course.ui.${label}`, 'course.json', `/ui/${label}`, text, { note: `Player label "${label}" (placeholders in braces stay)` });
  listOf(course?.speakers).forEach((speaker, i) => { if (isRecord(speaker)) add(`course.speaker.${speaker.id}.name`, 'course.json', `/speakers/${i}/name`, speaker.name, { note: 'Name of a voice of the narration, shown in captions and in the transcript', maxLength: 60 }); });
  // The player's content (D58): the glossary, the resources, the credits and the logo's text.
  listOf(course?.glossary).forEach((entry, i) => {
    if (!isRecord(entry)) return;
    // « Le terme ne se traduit pas » (translate false): the term and its variants stay as they are.
    if (entry.translate !== false) add(`course.glossary.${entry.id}.term`, 'course.json', `/glossary/${i}/term`, entry.term, { note: 'A term of the glossary, as learners look it up', maxLength: 80 });
    add(`course.glossary.${entry.id}.definition`, 'course.json', `/glossary/${i}/definition`, entry.definition, { note: `Definition of the glossary term "${String(entry.term)}"`, maxLength: 600 });
    if (entry.translate !== false) listOf(entry.variants).forEach((variant, j) => add(`course.glossary.${entry.id}.variant.${j + 1}`, 'course.json', `/glossary/${i}/variants/${j}`, variant, { note: `Another form or a synonym of the glossary term "${String(entry.term)}", for the search`, maxLength: 80 }));
  });
  listOf(course?.resources).forEach((resource, i) => {
    if (!isRecord(resource)) return;
    add(`course.resource.${resource.id}.title`, 'course.json', `/resources/${i}/title`, resource.title, { note: 'Title of a file learners may open or download from Resources', maxLength: 120 });
    add(`course.resource.${resource.id}.description`, 'course.json', `/resources/${i}/description`, resource.description, { note: 'One line on what the resource is for', maxLength: 300 });
  });
  listOf(course?.credits).forEach((credit, i) => add(`course.credit.${i + 1}`, 'course.json', `/credits/${i}`, credit, { note: 'A line of the credits (keep names and addresses as they are)', maxLength: 300 }));
  for (const bar of ['top', 'bottom'] as const) {
    listOf(isRecord(course?.player) && isRecord(course.player[bar]) ? course.player[bar].items : undefined).forEach((item, i) => {
      if (isRecord(item) && item.id === 'logo' && isRecord(item.options)) add('course.logo.alt', 'course.json', `/player/${bar}/items/${i}/options/alt`, item.options.alt, { note: 'What the course\'s logo says (an organisation\'s name)', maxLength: 120 });
    });
  }

  const plan = project.plan;
  if (plan) {
    const addPlan = (id: string, pointer: string, text: unknown, options?: UnitOptions): void => add(`plan.${id}`, 'plan.json', pointer, text, options);
    addPlan('title', '/title', plan.title, { note: 'Title of the validated plan' });
    addPlan('businessGoal', '/businessGoal', plan.businessGoal);
    addPlan('audience.role', '/audience/role', plan.audience?.role);
    addPlan('audience.notes', '/audience/notes', plan.audience?.notes);
    listOf(plan.objectives).forEach((objective, i) => {
      if (!isRecord(objective)) return;
      addPlan(`objective.${objective.id}.statement`, `/objectives/${i}/statement`, objective.statement, { note: 'Learning objective' });
      addPlan(`objective.${objective.id}.short`, `/objectives/${i}/short`, objective.short, { note: 'Short name of the learning objective, three to five words', maxLength: 60 });
      addPlan(`objective.${objective.id}.criterion`, `/objectives/${i}/criterion`, objective.criterion);
    });
    listOf(plan.items).forEach((item, i) => {
      if (!isRecord(item)) return;
      addPlan(`item.${item.id}.title`, `/items/${i}/title`, item.title);
      addPlan(`item.${item.id}.part`, `/items/${i}/part`, item.part, { note: 'Part of the module the item belongs to: the same words for every item of the part', maxLength: 200 });
      addPlan(`item.${item.id}.description`, `/items/${i}/description`, item.description);
      listOf(item.lockedTexts).forEach((text, j) => { if (isRecord(text)) addPlan(`text.${text.id}`, `/items/${i}/lockedTexts/${j}/text`, text.text, { format: 'markdown', note: 'Locked text of the plan, shown as it is' }); });
      listOf(item.voiceover).forEach((line, j) => { if (isRecord(line)) addPlan(`item.${item.id}.voiceover.${j + 1}`, `/items/${i}/voiceover/${j}/text`, line.text, { note: 'A line of the voice-over the client validated, said word for word' }); });
      listOf(item.questions).forEach((question, j) => {
        if (!isRecord(question)) return;
        const base = `/items/${i}/questions/${j}`;
        addPlan(`question.${question.id}.stem`, `${base}/stem`, question.stem, { format: 'markdown', note: 'Validated question' });
        addPlan(`question.${question.id}.unit`, `${base}/unit`, question.unit, { note: 'Unit of the expected number' });
        listOf(question.options).forEach((option, k) => {
          if (!isRecord(option)) return;
          addPlan(`question.${question.id}.option.${option.id}.text`, `${base}/options/${k}/text`, option.text);
          addPlan(`question.${question.id}.option.${option.id}.feedback`, `${base}/options/${k}/feedback`, option.feedback, { format: 'markdown' });
        });
        addPlan(`question.${question.id}.feedback.correct`, `${base}/feedback/correct`, question.feedback?.correct, { format: 'markdown' });
        addPlan(`question.${question.id}.feedback.incorrect`, `${base}/feedback/incorrect`, question.feedback?.incorrect, { format: 'markdown' });
        listOf(question.misconceptions).forEach((misconception, k) => { if (isRecord(misconception)) addPlan(`question.${question.id}.misconception.${misconception.id}.feedback`, `${base}/misconceptions/${k}/feedback`, misconception.feedback, { format: 'markdown' }); });
      });
    });
    listOf(plan.spacing).forEach((spacing, i) => addPlan(`spacing.${i}`, `/spacing/${i}`, spacing));
  }

  for (const { id } of screenOrder(project)) {
    const entry = project.screens.get(id);
    if (!entry) continue;
    const { file, data: screen } = entry;
    add(`screen.${id}.title`, file, '/title', screen.title, { note: 'Screen title' });
    const layout = screen.layout ? registry.get(screen.layout) : undefined;
    if (layout) walkProps(layout.schema, screen.layoutProps, '/layoutProps', `screen.${id}.layout`, false, (unitId, pointer, text, options) => add(unitId, file, pointer, text, { ...options, note: `Layout ${screen.layout} of screen "${screen.title}"` }));
    listOf(screen.layers).forEach((layer, i) => { if (isRecord(layer)) add(`screen.${id}.layer.${layer.id}.title`, file, `/layers/${i}/title`, layer.title, { note: `Title of a layer of screen "${screen.title}"` }); });
    if (isRecord(screen.steps)) for (const [step, settings] of Object.entries(screen.steps)) if (isRecord(settings)) add(`screen.${id}.step.${step}.label`, file, `/steps/${step}/label`, settings.label, { note: `Continue button opening step ${step} of screen "${screen.title}"`, maxLength: 40 });
    const anchored = lineWordAnchors(screen);
    listOf(screen.narration?.lines).forEach((line, i) => {
      if (!isRecord(line)) return;
      const speaker = typeof line.speaker === 'string' ? ` (${line.speaker})` : '';
      const marks = typeof line.text === 'string' ? anchorMarks(line.text, anchored.get(line.id) ?? [], course?.language ?? '') : [];
      const anchors = marks.length ? `. Markers <mrk type="elabora:anchor"> wrap words a block or an event waits for (${marks.map((mark) => `« ${mark.word} »`).join(', ')}): keep each marker, with its id, around the words of your language that say the same thing` : '';
      const directions = typeof line.text === 'string' && hasDirections(line.text) ? '. Text in square brackets, in markers <mrk type="elabora:direction">, is a stage direction for the voice (how to say it, never shown): keep it in brackets where the delivery changes in your sentence, and translate or adapt it' : '';
      add(`screen.${id}.narration.${line.id}.text`, file, `/narration/lines/${i}/text`, line.text, { note: `Narration line ${line.id}${speaker} of screen "${screen.title}": said by a voice in the translated course and shown as its captions${anchors}${directions}`, maxLength: 2000, marks });
    });
    for (const { block, path } of screenBlocks(screen, file)) {
      const descriptor = registry.get(block.type);
      if (!descriptor) continue;
      const where = `${descriptor.title || block.type} on screen "${screen.title}"`;
      walkProps(descriptor.schema, block.props, `${path}/props`, `block.${block.id}`, descriptor.builtin, (unitId, pointer, text, options) => add(unitId, file, pointer, text, { ...options, note: where }));
      if (descriptor.root === 'free-object') objectUnits(project, block, path, (unitId, pointer, text, options) => add(unitId, file, pointer, text, { ...options, note: options.note || where }));
    }
  }
  return units;
}

// Strings of block or layout props: built-in schemas mark them x-translatable; in components, props
// of kind text and markdown are words (plan references stay references).
function walkProps(schema: SchemaNode, value: unknown, pointer: string, idBase: string, builtin: boolean, addUnit: AddUnit): void {
  const walk = (node: SchemaNode, current: unknown, path: string, id: string, key: string | null): void => {
    if (current === undefined || current === null) return;
    const keywords = node && typeof node === 'object' ? node : null;
    if (typeof current === 'string') {
      if (key === 'id' || key === 'textRef' || key === 'questionRef' || keywords?.enum) return;
      const kind = kindOf(node);
      // Ids and references (a pattern, a plan id) are not words, even as component props of kind text.
      const words = keywords?.['x-translatable'] === true || (!builtin && (kind === 'text' || kind === 'markdown') && !keywords?.pattern && keywords?.['x-translatable'] !== false && !/^[A-Z]+-\d+$/.test(current));
      if (words) addUnit(id, path, current, { format: kind === 'markdown' ? 'markdown' : 'text', maxLength: keywords?.maxLength });
      return;
    }
    if (Array.isArray(current)) { current.forEach((item, i) => walk(keywords?.items, item, `${path}/${i}`, `${id}.${segment((isRecord(item) ? item.id : undefined) ?? i)}`, null)); return; }
    if (isRecord(current)) {
      if (builtin && key === 'props' && !keywords?.properties) return; // free-object props: from the manifest
      for (const [name, item] of Object.entries(current)) walk(keywords?.properties?.[name], item, `${path}/${name}`, `${id}.${segment(name)}`, name);
    }
  };
  walk(schema, value, pointer, idBase, null);
}
const segment = (key: unknown): string => String(key).replace(/[^A-Za-z0-9_-]/g, '_');

// Free object: props marked x-translatable in the manifest (and the fields so marked of its lists),
// and its strings (manifest text, or the block's own wording in props.strings).
function objectUnits(project: Project, block: Block, path: string, addUnit: AddUnit): void {
  const props = recordOf(block.props);
  const manifest = project.objects.get(textOf(props.object))?.manifest;
  if (!manifest) return;
  for (const [name, schema] of Object.entries(manifest.props?.properties || {})) {
    if (!isRecord(schema)) continue;
    const own = recordOf(props.props)[name];
    const value = own ?? schema.default;
    const pointer = `${path}/props/props/${name}`;
    // A list the block leaves to the manifest default is written whole, then its words translated.
    const base = own == null && Array.isArray(value) ? { pointer, value } : undefined;
    walkProps(schema, value, pointer, `block.${block.id}.props.${segment(name)}`, true, (unitId, unitPointer, text, options) => addUnit(unitId, unitPointer, text, { ...options, note: schema.description, ...(base ? { base } : {}) }));
  }
  // What screen readers say about the object (manifest a11y), worded for this block.
  for (const key of ['description', 'keyboard'] as const) {
    const value = recordOf(props.a11y)[key] ?? manifest.a11y?.[key];
    addUnit(`block.${block.id}.a11y.${key}`, `${path}/props/a11y/${key}`, value, { note: key === 'description' ? `${manifest.title}: what the object shows, read by screen readers` : `${manifest.title}: how to use it with the keyboard` });
  }
  for (const [key, string] of Object.entries(manifest.strings || {})) {
    if (!isRecord(string)) continue;
    const value = recordOf(props.strings)[key] ?? string.text;
    addUnit(`block.${block.id}.strings.${segment(key)}`, `${path}/props/strings/${key}`, value, { format: 'icu', maxLength: string.maxLength, note: `${manifest.title}: ${string.description || key} (placeholders in braces stay, plural forms follow the target language)` });
  }
  // How the values of its choices read in the editor (manifest x-enum-labels, or the block's own
  // props.enumLabels), in the order of the enum.
  for (const [name, schema] of Object.entries(manifest.props?.properties || {})) {
    for (const place of enumPlaces(name, schema)) {
      const own = recordOf(recordOf(props.enumLabels)[place.key]);
      for (const value of listOf(place.values).map(String)) {
        addUnit(`block.${block.id}.enumLabels.${segment(place.key)}.${segment(value)}`, `${path}/props/enumLabels${pointer(place.key, value)}`, own[value] ?? place.labels[value], { maxLength: 60, editor: true, note: `${manifest.title}: value "${value}" of the setting "${place.title}", as authors choose it in the editor` });
      }
    }
  }
}

// The value at a JSON pointer (undefined when the document has none there).
export function valueAt(document: unknown, pointer: string): unknown {
  let current = document;
  for (const part of pointer.split('/').slice(1).map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (current === null || typeof current !== 'object') return undefined;
    current = Reflect.get(current, part);
  }
  return current;
}

// Set a value at a JSON pointer, creating the objects on the way (block strings may not exist yet).
export function setAt(document: object, pointer: string, value: unknown): void {
  const parts = pointer.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: object = document;
  for (const [i, key] of parts.entries()) {
    if (i === parts.length - 1) { Reflect.set(current, key, value); return; }
    let next: unknown = Reflect.get(current, key);
    if (next === undefined || next === null) { next = {}; Reflect.set(current, key, next); }
    if (typeof next !== 'object' || next === null) return; // a text on the way: the pointer does not fit the document
    current = next;
  }
}

// What must survive translation: maths, links and code in Markdown; placeholders in ICU strings.
export function invariants(text: unknown, format: UnitFormat): Record<string, number | string> {
  const source = String(text || '');
  if (format === 'markdown') {
    return {
      maths: (source.match(/\$\$[\s\S]+?\$\$|\$(?!\s)[^$\n]+?\$/g) || []).length,
      links: (source.match(/\]\([^)]+\)/g) || []).length,
      code: (source.match(/`[^`]+`/g) || []).length
    };
  }
  if (format === 'icu' || /\{[A-Za-z_]\w*\}/.test(source)) {
    return { placeholders: [...new Set((source.match(/\{\s*([A-Za-z_]\w*)/g) || []).map((placeholder) => placeholder.replace(/[{\s]/g, '')))].sort().join(',') };
  }
  return {};
}
