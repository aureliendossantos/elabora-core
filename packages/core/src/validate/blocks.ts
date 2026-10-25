import { findingKey } from '../diagnostics/index.ts';
import { getFile, hasFile, isSourcePath, projectPath } from '../project/files.ts';
import { resolveBlockProps, screenBlocks, screenLayout, readingOrder } from '../project/load.ts';
import type { NumericTolerance } from '@elabora/format';
import { mathErrors } from '../compile/markdown.ts';
import { withinTolerance } from '@elabora/player/numeric';
import { blockControls, CONTROL_NAME, NAMED_CONTROL_HOOKS } from '../components/controls.ts';
import type { ComponentDescriptor } from '../components/registry.ts';
import type { Block, Event, Plan } from '../project/model.ts';
import { checkInstance, checkKinds, headingSequence } from './components.ts';
import { markdownToText } from '../compile/markdown.ts';
import { checkChart } from './charts.ts';
import { checkFillIn, checkSort, checkReflection, checkQuizPictures } from './activities.ts';
import { checkSteps, checkHotspots } from './starter-interactions.ts';
import { isChartType } from '../charts/index.ts';
import { objectPropErrors, blockEnumLabelErrors, textContrasts, TEXT_CONTRAST } from './object-props.ts';
import { resolveTokens } from './theme.ts';
import type { CheckContext, CourseCheckContext, ScreenFile } from './context.ts';
import { isRecord, list, fieldsOf, text, lengthOf, byId, entriesOf, targetOf } from './guards.ts';

const ALL_NONE = /(all of the above|none of the above|toutes les réponses|toutes ces réponses|aucune des réponses|aucune de ces réponses|les deux réponses|both of the above)/i;
const NEGATION = /(\bnot\b|\bexcept\b|\bne\b[^.?!]{0,40}\bpas\b|n['’][^.?!]{0,30}\bpas\b|\bsauf\b|\bjamais\b)/i;
const ALT_SUSPECT = /(\.(png|jpe?g|gif|svg|webp)$)|^(image|photo|picture|img|illustration|graphic|visuel|icône|icon)\s*\d*$/i;
const PORTABLE_NAME = /^[A-Za-z0-9._/-]+$/;

// Where the findings about a question go: the screen for an inline question, the plan for a
// validated question (questionRef).
interface QuestionPlace {
  file: string;
  target: string | undefined;
}

// Per-block rules: content sources, quiz item writing, media accessibility, assets, free-object placement.
// Rules follow the built-in root of a type: a fork of quiz is checked like a quiz. Course
// components are also checked as component instances (props, kinds, fallback).
export function checkBlocks(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { reporter, planIndex, registry } = ctx;
  const { id: screenId, file, data } = screen;
  const screenObjectives = new Set(list(data.covers).flatMap((itemId) => planIndex.items.get(itemId)?.objectives || []));
  const eventTargets = new Map<string, Event[]>();
  for (const event of list(data.events)) {
    if (event?.on?.target) {
      if (!eventTargets.has(event.on.target)) eventTargets.set(event.on.target, []);
      eventTargets.get(event.on.target)?.push(event);
    }
  }
  checkQuoteRepeats(ctx, screen);
  for (const { block, path } of screenBlocks(data, file)) {
    if (block === null || block === undefined) continue;
    const component = registry.get(block.type);
    if (!component) { reporter.emit('E_COMPONENT_UNKNOWN', { file, path: `${path}/type`, target: block.id, message: `"${block.type}" is neither a built-in type nor a component of components/ (${[...registry.values()].filter((d) => !d.builtin && d.level === 'block').map((d) => d.id).join(', ') || 'no course components'}).` }); continue; }
    checkBlock(ctx, { block, component, path, file, screenId, eventTargets, screenObjectives });
  }

  // Heading order: the screen title is level 1; headings start at 2 and never skip. The reading
  // order follows the templates: layout slots, headings of component templates, their slots.
  let level = 1;
  const layout = screenLayout(ctx.project, data);
  const where = new Map([...screenBlocks(data, file)].map((location) => [location.block, location.path]));
  for (const heading of headingSequence(ctx, data.blocks, layout)) {
    const { block } = heading;
    if (heading.level > level + 1) reporter.emit('E_HEADING_ORDER', { file, path: `${where.get(block)}${block.type === 'heading' ? '/props/level' : ''}`, target: block.id, message: `${block.type === 'heading' ? 'Heading' : `A heading of ${block.type}`} "${block.id}" jumps from level ${level} to ${heading.level}${layout || block.type !== 'heading' ? ' (reading order of the templates)' : ''}.` });
    level = heading.level;
  }

  // Steps: only blocks of the screen carry one. In scroll presentation steps appear one below
  // the other, so the reading order (layout slots, then block order) never goes back to an
  // earlier step; slides reveal steps in place and may build in any order.
  for (const { block, path, layer, parent } of screenBlocks(data, file)) {
    if (block === null || block === undefined) continue;
    if ((layer || parent) && (block.step ?? 0) > 1) reporter.emit('W_STEP_PLACEMENT', { file, path: `${path}/step`, target: block.id, message: `"${block.id}" is ${layer ? `in layer "${layer.id}"` : `inside "${parent?.id}"`}: its step is ignored (it follows ${layer ? 'the layer' : 'its parent'}).` });
  }
  if ((ctx.course.presentation?.mode || 'scroll') === 'scroll') {
    let reached = 1;
    for (const block of readingOrder(data.blocks, layout)) {
      if (block === null || block === undefined) continue;
      const step = block.step || 1;
      if (step < reached) reporter.emit('W_STEP_ORDER', { file, path: `${where.get(block)}/step`, target: block.id, message: `"${block.id}" (step ${step}) comes after a block of step ${reached} in the reading order${layout ? ` of the layout ${layout.id}` : ''}: it would appear above content the learner has already read.` });
      reached = Math.max(reached, step);
    }
  }
}

interface BlockUnderCheck {
  block: Block;
  component: ComponentDescriptor;
  path: string;
  file: string;
  screenId: string;
  eventTargets: Map<string, Event[]>;
  screenObjectives: Set<string>;
}

function checkBlock(ctx: CourseCheckContext, { block, component, path, file, screenId, eventTargets, screenObjectives }: BlockUnderCheck): void {
  const { project, reporter, planIndex, registry } = ctx;
  const props = fieldsOf(block.props);
  const id = block.id;
  const at = (sub?: string) => `${path}/props${sub ? `/${sub}` : ''}`;
  const eventsOn = (target: string) => eventTargets.get(target) || [];
  if (component.builtin && component.level === 'screen') { reporter.emit('E_COMPONENT_LEVEL', { file, path: `${path}/type`, target: id, message: `${component.id} is a screen layout: use it as the screen's layout ("layout": "${component.id}"), not as a block.` }); return; }
  if (!component.builtin) checkInstance(ctx, block, component, path, file);
  // Buttons of components (data-t-click, unnamed or named): each needs a click event that listens to
  // it; tabs and disclosures act by themselves. Names bound to props are checked once rendered.
  if (component.root !== 'button') {
    for (const [name, hook] of blockControls(project, block)) {
      if (hook !== 'click') {
        // Items, cards, disclosures and what comes into view (D63) carry names bound to props too.
        if ((NAMED_CONTROL_HOOKS as readonly string[]).includes(hook) && !CONTROL_NAME.test(name)) reporter.emit('E_COMPONENT_HOOK', { file, path: at(), target: id, message: `${component.id} "${id}" renders data-t-${hook}="${name}": a name is lowercase letters, digits, "-", "_" or "." (48 at most), starting with a letter or digit.` });
        continue;
      }
      if (name && !CONTROL_NAME.test(name)) reporter.emit('E_COMPONENT_HOOK', { file, path: at(), target: id, message: `${component.id} "${id}" renders data-t-click="${name}": a name is lowercase letters, digits, "-", "_" or "." (48 at most), starting with a letter or digit.` });
      else if (!eventsOn(id).some((event) => event.on.type === 'click' && (event.on.name === undefined || event.on.name === name))) reporter.emit('W_DEAD_BUTTON', { file, path, target: id, message: name ? `${component.id} "${id}" has a button named "${name}" but no click event for it.` : `${component.id} "${id}" has a button (data-t-click) but no click event.` });
    }
  }
  if (!component.root) return;
  if (isChartType(component.root)) { checkChart(ctx, { block, type: component.root, path, file }); return; }

  switch (component.root) {
    case 'text':
    case 'callout':
      if (!!props.markdown === !!props.textRef) reporter.emit('E_BLOCK_TEXT_SOURCE', { file, path: at(), target: id, message: `Block "${id}": set exactly one of markdown or textRef.` });
      checkMarkdown(ctx, props.markdown, file, at('markdown'), id);
      if (props.textRef) checkMath(ctx, resolveBlockProps(block, planIndex, registry).markdown, 'plan.json', '', targetOf(props.textRef));
      break;
    case 'math':
      for (const error of mathErrors(props.tex, { tex: true })) reporter.emit('E_MATH_PARSE', { file, path: at('tex'), target: id, message: `Math block "${id}": ${error.message.trim()}` });
      checkMarkdown(ctx, props.caption, file, at('caption'), id);
      break;
    case 'numeric': {
      const inline = ['stem', 'answer', 'tolerance', 'unit', 'feedback', 'misconceptions'].some((key) => props[key] !== undefined);
      if (props.questionRef ? inline : !(props.stem && props.answer !== undefined && props.feedback)) {
        reporter.emit('E_QUIZ_SOURCE', { file, path: at(), target: id, message: `Numeric "${id}": either questionRef only, or stem + answer + feedback (and optionally tolerance, unit, misconceptions).` });
        break;
      }
      const planQuestion = props.questionRef ? byId(planIndex.questions, props.questionRef) : undefined;
      if (planQuestion && planQuestion.mode !== 'numeric') {
        reporter.emit('E_QUIZ_SOURCE', { file, path: at('questionRef'), target: id, message: `Numeric "${id}" references ${props.questionRef}, a ${planQuestion.mode}-choice question: use a quiz block.` });
        break;
      }
      checkNumericItem(ctx, resolveBlockProps(block, planIndex, registry), questionPlace(ctx, props.questionRef, file, path, id));
      break;
    }
    case 'heading':
      if (!!props.text === !!props.textRef) reporter.emit('E_BLOCK_TEXT_SOURCE', { file, path: at(), target: id, message: `Heading "${id}": set exactly one of text or textRef.` });
      break;
    case 'quiz': {
      // With questionRef, the plan gives stem, mode and options; a fork may still add presentation
      // fields to the plan's options (an image…), keyed by option id.
      const planQuestion = props.questionRef ? byId(planIndex.questions, props.questionRef) : null;
      const inline = props.stem !== undefined || props.mode !== undefined || (props.options !== undefined && (component.builtin || list(props.options).some((option) => { const fields = fieldsOf(option); return fields.text !== undefined || fields.correct !== undefined || fields.feedback !== undefined; })));
      if (props.questionRef ? inline : !(props.stem && props.options && props.mode)) {
        reporter.emit('E_QUIZ_SOURCE', { file, path: at(), target: id, message: `Quiz "${id}": either questionRef only${component.builtin ? '' : ' (options may then only add presentation fields to the plan options)'}, or stem + mode + options.` });
        break;
      }
      if (planQuestion && !component.builtin) {
        const planOptions = list(planQuestion.options);
        list(props.options).forEach((option, i) => {
          const optionId = fieldsOf(option).id;
          if (!planOptions.some((planOption) => planOption?.id === optionId)) reporter.emit('E_QUIZ_SOURCE', { file, path: at(`options/${i}/id`), target: id, message: `Quiz "${id}": option "${optionId}" is not an option of ${props.questionRef} (${planOptions.map((planOption) => planOption?.id).join(', ')}).` });
        });
      }
      if (props.questionRef && planQuestion?.mode === 'numeric') {
        reporter.emit('E_QUIZ_SOURCE', { file, path: at('questionRef'), target: id, message: `Quiz "${id}" references ${props.questionRef}, a numeric question: use a numeric block.` });
        break;
      }
      const question = resolveBlockProps(block, planIndex, registry);
      if (!question.options) break;
      const place = questionPlace(ctx, props.questionRef, file, path, id);
      checkQuizItem(ctx, question, place);
      for (const [i, option] of list(question.options).entries()) checkMarkdown(ctx, fieldsOf(option).feedback, place.file, props.questionRef ? '' : at(`options/${i}/feedback`), place.target);
      checkMarkdown(ctx, question.stem, file, at('stem'), id);
      checkQuizPictures(ctx, { block, component, file, at }, props, question);
      break;
    }
    case 'fill-in':
      checkFillIn(ctx, { block, component, file, at }, props);
      break;
    case 'sort':
      checkSort(ctx, { block, component, file, at }, props);
      break;
    case 'reflection':
      checkReflection(ctx, { block, component, file, at }, props);
      break;
    case 'decision': {
      const events = eventsOn(id);
      list(props.options).forEach((option, i) => {
        const { id: optionId, feedback } = fieldsOf(option);
        const hasEvent = events.some((event) => event.on.type === 'decision.selected' && (!event.on.option || event.on.option === optionId));
        if (!feedback && !hasEvent) reporter.emit('W_DECISION_WITHOUT_CONSEQUENCE', { file, path: at(`options/${i}`), target: id, message: `Option "${optionId}" of decision "${id}" has neither feedback nor event.` });
      });
      if (props.scored && !list(props.options).some((option) => fieldsOf(option).correct)) reporter.emit('W_QUIZ_NO_CORRECT', { file, path: at('options'), target: id, message: `Scored decision "${id}" has no option marked correct.` });
      checkMarkdown(ctx, props.prompt, file, at('prompt'), id);
      break;
    }
    case 'button':
      if (!eventsOn(id).some((event) => event.on.type === 'click')) reporter.emit('W_DEAD_BUTTON', { file, path, target: id, message: `Button "${id}" has no click event.` });
      break;
    case 'accordion':
      list(props.items).forEach((item, i) => checkMarkdown(ctx, fieldsOf(item).markdown, file, at(`items/${i}/markdown`), id));
      break;
    case 'image': {
      const alt = text(props.alt);
      if (!props.decorative && !alt.trim()) reporter.emit('E_IMAGE_ALT_MISSING', { file, path: at('alt'), target: id, message: `Image "${id}" has no alt text and is not marked decorative.` });
      else if (alt && ALT_SUSPECT.test(alt.trim())) reporter.emit('W_IMAGE_ALT_SUSPECT', { file, path: at('alt'), target: id, key: findingKey(`${id}/alt`, alt), message: `Alt "${alt}" of image "${id}" does not describe information.` });
      checkAsset(ctx, props.asset, file, at('asset'), id);
      checkMarkdown(ctx, props.markdown, file, at('markdown'), id);
      if (props.generated) reporter.emit('I_GENERATED_MEDIA', { file, path, target: id, message: `Image "${id}" is AI-generated.` });
      break;
    }
    case 'video':
      checkAsset(ctx, props.asset, file, at('asset'), id);
      if (props.captions) checkAsset(ctx, props.captions, file, at('captions'), id);
      if (props.poster) checkAsset(ctx, props.poster, file, at('poster'), id);
      checkVideoAlternatives(ctx, props, file, at, id);
      if (props.generated) reporter.emit('I_GENERATED_MEDIA', { file, path, target: id, message: `Video "${id}" is AI-generated.` });
      break;
    case 'audio':
      checkAsset(ctx, props.asset, file, at('asset'), id);
      if (!props.decorative && !text(props.transcript).trim()) reporter.emit('E_MEDIA_TRANSCRIPT_MISSING', { file, path: at('transcript'), target: id, message: `Audio "${id}" has no transcript and is not marked decorative.` });
      if (props.generated) reporter.emit('I_GENERATED_MEDIA', { file, path, target: id, message: `Audio "${id}" is AI-generated.` });
      break;
    case 'free-object': {
      const object = byId(project.objects, props.object);
      if (!object) { reporter.emit('E_OBJECT_NOT_FOUND', { file, path: at('object'), target: id, message: `Free object "${props.object}" not found in objects/.` }); break; }
      if (!text(props.textAlternative).trim()) reporter.emit('E_OBJECT_A11Y_ALTERNATIVE', { file, path: at('textAlternative'), target: id });
      const manifest = object.manifest;
      if (manifest?.props?.properties) {
        for (const error of objectPropErrors(manifest, props.props || {})) reporter.emit('E_OBJECT_PROP_VALUE', { file, path: at(`props${error.path}`), target: id, message: `Free object "${id}" (${manifest.id}): ${error.message}.` });
        // Text colours the block changes (the manifest's own are checked with the object).
        const values = fieldsOf(props.props);
        for (const found of textContrasts(manifest, values, resolveTokens(ctx.course))) {
          const set = Object.hasOwn(values, found.prop) ? found.prop : Object.hasOwn(values, found.on) ? found.on : null;
          if (set && found.ratio !== null) reporter.emit('E_OBJECT_TEXT_CONTRAST', { file, path: at(`props/${set}`), target: id, measured: found.ratio, limit: TEXT_CONTRAST, message: `Free object "${id}" (${manifest.id}): ${found.message}.` });
        }
      }
      const objectives = list(manifest?.planRefs?.objectives);
      if (objectives.length && !objectives.some((objective) => screenObjectives.has(objective))) {
        reporter.emit('E_OBJECT_PLAN_MISMATCH', { file, path: at('object'), target: id, message: `Object ${manifest?.id} serves ${objectives.join(', ')}, but screen "${screenId}" covers items serving ${[...screenObjectives].join(', ') || 'no objective'}.` });
      }
      checkMarkdown(ctx, props.textAlternative, file, at('textAlternative'), id);
      // Words of the object: rewordings match the declared strings; a manifest in another language
      // than the course needs every string reworded by the block.
      const declared = manifest?.strings || {};
      for (const [key, value] of entriesOf(props.strings)) {
        if (!declared[key]) { reporter.emit('E_OBJECT_STRINGS', { file, path: at(`strings/${key}`), target: id, message: `String "${key}" is not declared in the manifest of ${manifest?.id}.` }); continue; }
        const expected = placeholders(declared[key].text);
        const found = placeholders(value);
        if (expected !== found) reporter.emit('E_OBJECT_STRINGS', { file, path: at(`strings/${key}`), target: id, message: `String "${key}": placeholders {${found}} instead of {${expected}}.` });
      }
      const languageOf = (value: unknown) => String(value || '').toLowerCase().split('-')[0];
      const reworded = fieldsOf(props.strings);
      const untranslated = Object.keys(declared).filter((key) => !reworded[key]);
      if (manifest?.language && languageOf(manifest.language) !== languageOf(ctx.course.language) && untranslated.length) {
        reporter.emit('W_OBJECT_STRINGS_LANGUAGE', { file, path: at('strings'), target: id, message: `${manifest.id} is written in ${manifest.language}, the course in ${ctx.course.language}: ${untranslated.length} string(s) without wording here (${untranslated.slice(0, 4).join(', ')}${untranslated.length > 4 ? '…' : ''}).` });
      }
      // How the values of its choices read for this block: values of the enums they word.
      if (manifest) for (const error of blockEnumLabelErrors(manifest, props.enumLabels)) reporter.emit('E_OBJECT_ENUM_LABELS', { file, path: at(`enumLabels${error.path}`), target: id, message: `Free object "${id}" (${manifest.id}): ${error.message}.` });
      break;
    }
    case 'results':
      break;
    // Starter blocks (D63): their assets and Markdown as a component's, their pictures named.
    case 'statement':
      if (component.builtin) checkKinds(ctx, component.schema, props, file, at(), id);
      if (!!props.markdown === !!props.textRef) reporter.emit('E_BLOCK_TEXT_SOURCE', { file, path: at(), target: id, message: `Statement "${id}": set exactly one of markdown or textRef.` });
      if (props.presentation === 'image' && props.image && !props.decorative && !text(props.alt).trim()) reporter.emit('E_IMAGE_ALT_MISSING', { file, path: at('alt'), target: id, message: `The picture of statement "${id}" has no alt text and is not marked decorative.` });
      if (props.generated) reporter.emit('I_GENERATED_MEDIA', { file, path, target: id, message: `Statement "${id}" shows an AI-generated picture.` });
      break;
    case 'gallery': {
      if (component.builtin) checkKinds(ctx, component.schema, props, file, at(), id);
      const images = list(props.images).map(fieldsOf);
      images.forEach((image, i) => { if (!image.decorative && !text(image.alt).trim()) reporter.emit('E_IMAGE_ALT_MISSING', { file, path: at(`images/${i}/alt`), target: id, message: `Image "${image.id}" of gallery "${id}" has no alt text and is not marked decorative.` }); });
      if (props.presentation === 'compare' && images.length !== 2) reporter.emit('E_GALLERY_COMPARE', { file, path: at('images'), target: id, measured: images.length, message: `Gallery "${id}" compares ${images.length} image${images.length === 1 ? '' : 's'}: before and after takes two.` });
      if (props.generated) reporter.emit('I_GENERATED_MEDIA', { file, path, target: id, message: `Gallery "${id}" shows AI-generated images.` });
      break;
    }
    case 'columns':
      if ((props.count ?? 2) === 2) list(block.blocks).forEach((child, i) => { if (child?.slot === 'third') reporter.emit('W_COLUMNS_HIDDEN', { file, path: `${path}/blocks/${i}/slot`, target: child.id, message: `"${child.id}" is in the third column of "${id}", which shows two: it is not shown.` }); });
      break;
    case 'divider':
      break;
    // A steps block (« Étapes », not the screen's steps) and an interactive picture (D63).
    case 'steps':
      if (component.builtin) checkKinds(ctx, component.schema, props, file, at(), id);
      checkSteps(ctx, { block, path, file });
      break;
    case 'hotspots':
      if (component.builtin) checkKinds(ctx, component.schema, props, file, at(), id);
      checkHotspots(ctx, { block, path, file });
      break;
  }
  if (component.root === 'text' && props.aside) checkMarkdown(ctx, props.aside, file, at('aside'), id);
}

// A statement whose words a text block of its screen also says (D63): the text of the statement,
// as plain text, found in a text block (or a text's aside) of the screen, its layers included.
function checkQuoteRepeats(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { reporter, registry, planIndex } = ctx;
  const plain = (value: unknown) => markdownToText(value).toLowerCase().replace(/[\s\u00a0\u202f]+/g, ' ').replace(/[«»“”"‘’'.,;:!?…—–-]+/g, '').trim();
  const located = [...screenBlocks(screen.data, screen.file)].filter((location) => location.block);
  const texts = located.filter(({ block }) => registry.get(block.type)?.root === 'text').map(({ block }) => {
    const props = resolveBlockProps(block, planIndex, registry);
    return `${plain(props.markdown)} ${plain(props.aside)}`;
  });
  if (!texts.length) return;
  for (const { block, path } of located) {
    if (registry.get(block.type)?.root !== 'statement') continue;
    const props = resolveBlockProps(block, planIndex, registry);
    const said = plain(props.markdown);
    if (said.length < 12 || !texts.some((found) => found.includes(said))) continue;
    reporter.emit('W_QUOTE_REPEATS', { file: screen.file, path: `${path}/props/markdown`, target: block.id, message: `${props.author ? 'The quotation' : 'The statement'} "${block.id}" repeats words a text block of screen "${screen.id}" already says: « ${markdownToText(props.markdown).slice(0, 60)} ».` });
  }
}

// questionRef set: the findings go to the plan question, at its place in plan.json.
function questionPlace(ctx: CheckContext, questionRef: unknown, file: string, path: string, id: string): QuestionPlace & { pathOf: (sub: string) => string } {
  if (questionRef) {
    const planPath = questionPointer(ctx.project.plan, questionRef);
    return { file: 'plan.json', target: targetOf(questionRef), pathOf: (sub) => `${planPath}${sub}` };
  }
  return { file, target: id, pathOf: (sub) => `${path}/props${sub}` };
}

function checkQuizItem(ctx: CheckContext, question: Record<string, unknown>, place: QuestionPlace & { pathOf: (sub: string) => string }): void {
  const { reporter } = ctx;
  const { pathOf, ...where } = place;
  const options = list(question.options).map(fieldsOf);
  const correct = options.filter((option) => option.correct);
  if (!correct.length) reporter.emit('W_QUIZ_NO_CORRECT', { ...where, path: pathOf('/options'), message: `Question ${where.target} has no correct option.` });
  if (question.mode === 'single' && correct.length > 1) reporter.emit('E_QUIZ_SINGLE_MULTIPLE_CORRECT', { ...where, path: pathOf('/mode'), message: `Question ${where.target} is single-choice with ${correct.length} correct options.` });
  options.forEach((option, i) => {
    if (!text(option.feedback).trim()) reporter.emit('E_FEEDBACK_MISSING', { ...where, path: pathOf(`/options/${i}/feedback`), message: `Option "${option.id}" of ${where.target} has no feedback explaining why it is ${option.correct ? 'right' : 'wrong'}.` });
    if (ALL_NONE.test(String(option.text))) reporter.emit('W_QUIZ_ALL_NONE', { ...where, path: pathOf(`/options/${i}/text`), key: findingKey(`${where.target}/options/${String(option.id)}`, String(option.text)), message: `Option "${option.id}" of ${where.target}: "${option.text}".` });
  });
  if (options.length < 3 || options.length > 5) reporter.emit('W_QUIZ_OPTION_COUNT', { ...where, path: pathOf('/options'), measured: options.length, key: `${where.target}/options@${options.length}`, message: `Question ${where.target} has ${options.length} options.` });
  const stem = String(question.stem || '');
  const negation = NEGATION.exec(stem);
  if (negation && !/\*\*[^*]*\b(not|except|ne|pas|n['’]|sauf|jamais)\b[^*]*\*\*/i.test(stem)) {
    reporter.emit('W_QUIZ_NEGATION', { ...where, path: pathOf('/stem'), key: findingKey(`${where.target}/stem`, stem), message: `Stem of ${where.target} contains "${negation[0].trim()}" without emphasis.` });
  }
  if (correct.length === 1 && options.length >= 3) {
    const length = (option: Record<string, unknown>) => lengthOf(option.text);
    const others = options.filter((option) => !option.correct);
    const average = others.reduce((sum, option) => sum + length(option), 0) / others.length;
    if (length(correct[0]) > 20 && length(correct[0]) >= 1.5 * average && others.every((option) => length(option) < length(correct[0]))) {
      reporter.emit('W_QUIZ_LENGTH_CUE', { ...where, path: pathOf('/options'), measured: { correct: length(correct[0]), othersAverage: Math.round(average) }, key: findingKey(`${where.target}/options`, JSON.stringify(options.map((option) => [option.text, !!option.correct]))) });
    }
  }
}

function checkNumericItem(ctx: CheckContext, question: Record<string, unknown>, place: QuestionPlace & { pathOf: (sub: string) => string }): void {
  const { reporter } = ctx;
  const { pathOf, ...where } = place;
  const feedback = fieldsOf(question.feedback);
  for (const kind of ['correct', 'incorrect']) {
    if (!text(feedback[kind]).trim()) reporter.emit('E_FEEDBACK_MISSING', { ...where, path: pathOf(`/feedback/${kind}`), message: `Numeric question ${where.target} has no ${kind} feedback.` });
  }
  const misconceptions = list(question.misconceptions).map(fieldsOf);
  const { answer } = question;
  const tolerance = toleranceOf(question.tolerance);
  misconceptions.forEach((misconception, i) => {
    // Values that are not numbers are never accepted (and fail the schema).
    if (typeof misconception.value === 'number' && typeof answer === 'number' && withinTolerance(misconception.value, answer, tolerance)) reporter.emit('W_NUMERIC_AMBIGUOUS', { ...where, path: pathOf(`/misconceptions/${i}`), message: `Misconception "${misconception.id}" (${misconception.value}) is accepted as the correct answer (${question.answer}).` });
  });
  if (!lengthOf(question.misconceptions || [])) reporter.emit('I_NUMERIC_NO_MISCONCEPTION', { ...where, path: pathOf('') });
  checkMarkdown(ctx, question.stem, where.file, pathOf('/stem'), where.target);
  checkMarkdown(ctx, feedback.correct, where.file, pathOf('/feedback/correct'), where.target);
  checkMarkdown(ctx, feedback.incorrect, where.file, pathOf('/feedback/incorrect'), where.target);
  misconceptions.forEach((misconception, i) => checkMarkdown(ctx, misconception.feedback, where.file, pathOf(`/misconceptions/${i}/feedback`), where.target));
}

function toleranceOf(value: unknown): NumericTolerance | null {
  if (!value) return null;
  const { absolute, percent } = fieldsOf(value);
  return { absolute: typeof absolute === 'number' ? absolute : undefined, percent: typeof percent === 'number' ? percent : undefined };
}

// JSON pointer of a validated question in plan.json ('' when the plan has none with that id).
function questionPointer(plan: Plan | null, questionId: unknown): string {
  for (const [i, item] of list(plan?.items).entries()) {
    const j = list(item?.questions).findIndex((question) => question?.id === questionId);
    if (j >= 0) return `/items/${i}/questions/${j}`;
  }
  return '';
}

export function checkMarkdown(ctx: CheckContext, markdown: unknown, file: string, path: string, target: string | undefined): void {
  if (!markdown) return;
  const source = String(markdown);
  const { reporter } = ctx;
  if (/!\[[^\]]*\]\(\s*(https?:)?\/\//i.test(source) || /<(img|script|iframe|link|video|audio|source)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?\/\//i.test(source)) {
    reporter.emit('E_EXTERNAL_RESOURCE', { file, path, target, message: `External resource in the text of "${target}". Images belong in image blocks with a local asset.` });
  } else if (/!\[[^\]]*\]\(/.test(source)) {
    reporter.emit('E_EXTERNAL_RESOURCE', { file, path, target, message: `Markdown image in "${target}": use an image block (it carries alt text and is checked).` });
  }
  if (/\]\(\s*https?:\/\//i.test(source)) reporter.emit('I_EXTERNAL_LINK', { file, path, target });
  checkMath(ctx, markdown, file, path, target);
}

export function checkMath(ctx: CheckContext, markdown: unknown, file: string, path: string, target: string | undefined): void {
  if (!markdown) return;
  const source = String(markdown);
  if (!/\$/.test(source)) return;
  const key = `${file}|${path}|${target}|${source}`;
  if (ctx.reportedMath.has(key)) return;
  ctx.reportedMath.add(key);
  for (const error of mathErrors(source)) ctx.reporter.emit('E_MATH_PARSE', { file, path, target, message: `${target}: $${error.tex.slice(0, 50)}$ — ${error.message.trim()}` });
}

// What stands for a video for those who cannot watch or hear it (rule F3): nothing when it is
// decorative; for a loop (always muted), alt; for a video played with its controls, captions when it
// has sound and a transcript, or alt when it has none. Whether it has sound is what the media probe
// says of its file; a file not probed counts as having sound.
function checkVideoAlternatives(ctx: CheckContext, props: Record<string, unknown>, file: string, at: (sub?: string) => string, id: string): void {
  const { reporter } = ctx;
  if (props.decorative) return;
  const alt = text(props.alt).trim();
  if (props.loop) {
    if (!alt) reporter.emit('E_VIDEO_ALT_MISSING', { file, path: at('alt'), target: id, message: `Looping video "${id}" has no alt text and is not marked decorative.` });
    return;
  }
  const found = typeof props.asset === 'string' ? getFile(ctx.project.files, `assets/${props.asset}`) : undefined;
  const media = found?.kind === 'binary' ? found.media : undefined;
  const silent = media?.kind === 'video' && !media.audioCodec;
  if (!silent && !props.captions) reporter.emit('E_VIDEO_CAPTIONS_MISSING', { file, path: at('captions'), target: id, message: `Video "${id}" has ${media ? 'a sound track' : 'sound (or was not probed)'} and no captions.` });
  if (!text(props.transcript).trim() && !(silent && alt)) {
    reporter.emit('E_MEDIA_TRANSCRIPT_MISSING', { file, path: at('transcript'), target: id, message: `Video "${id}" has no transcript${silent ? ' and no alt' : ''}.` });
  }
}

export function checkAsset(ctx: CheckContext, asset: unknown, file: string, path: string, target: string | undefined): void {
  if (!asset) return;
  const name = String(asset);
  if (!PORTABLE_NAME.test(name)) ctx.reporter.emit('E_FILENAME_NOT_PORTABLE', { file, path, target, message: `Asset name "${name}" is not portable.` });
  const resolved = projectPath(`assets/${name}`);
  if (resolved !== null && isSourcePath(resolved)) { ctx.reporter.emit('E_SOURCE_REFERENCED', { file, path, target, message: `"${name}" points to ${resolved}, one of the author's sources, which are never published: import it (elabora media import . ${resolved}) and use the name it prints.` }); return; }
  if (hasFile(ctx.project.files, `assets/${name}`)) return;
  // The output of a media job under way: it appears when the job is done.
  if (ctx.project.media?.processing.includes(`assets/${name}`)) ctx.reporter.emit('I_MEDIA_PROCESSING', { file, path, target, message: `assets/${name} is being converted by a media job (elabora media status).` });
  else ctx.reporter.emit('E_ASSET_MISSING', { file, path, target, message: `assets/${name} not found.` });
}

// Placeholder names of an ICU message: {gap}, {n, plural, …} → "gap,n".
const placeholders = (message: unknown) => [...new Set((String(message).match(/\{\s*([A-Za-z_]\w*)/g) || []).map((x) => x.replace(/[{\s]/g, '')))].sort().join(',');

