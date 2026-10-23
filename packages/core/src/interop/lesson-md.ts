import { dialogueData } from '../dialogue/data.ts';
import { dialogueScript, scriptMarkdown, scriptWords } from '../dialogue/script.ts';
import { schemaId } from '@elabora/format';
import { planIndex, resolveBlockProps, screenOrder, readingOrder, screenLayout } from '../project/load.ts';
import { getRegistry } from '../components/registry.ts';
import { fallbackBlocks } from '../components/fallback.ts';
import { isChartType, chartMarkdown } from '../charts/index.ts';
import { fillInText, sortLines } from '../project/activity-text.ts';
import { hasFile } from '../project/files.ts';
import { basename } from '../util/paths.ts';
import type { Project, Screen, Block } from '../project/model.ts';
import { recordOf, recordsOf, optionalTextOf } from '../compile/values.ts';
import { objectsIn } from '../util/values.ts';

// LESSON.md (Slate, v1.9, 23 Sept 2026 — https://docs.slatebuilder.io/lesson-md/format/) for simple blocks.
// Elabora is a superset: export maps what LESSON.md can carry and lists every loss; import maps the
// directives Elabora 0.1 supports and turns the others into text, with a loss report. LESSON.md silently
// ignores unknown keys, so nothing Elabora-specific is written into its files.
// Multiple-select checks use type: multiple-select (Slate's format reference and v1.9 template,
// https://lesson.md/LESSON.md — confirmed 17 Oct 2026).

const oneLine = (text: unknown): string => String(text || '').replace(/\s*\n\s*/g, ' ').trim();

// ── export ───────────────────────────────────────────────────────────
// The files of the export (output: name → text), the assets to copy into media/ (media: project path
// → name in the export) and the losses. @elabora/node (lesson-md.ts) writes them into a folder.
export interface ExportLoss {
  screen: string | null;
  block: string | null;
  loss: string;
}

export interface LessonMdExport {
  files: string[]; // in course order, COURSE.md first
  losses: ExportLoss[];
  output: Map<string, string>; // file name → text
  media: { from: string; name: string }[]; // project path → path in the export
}

export function lessonMdExport(project: Project): LessonMdExport {
  const index = planIndex(project.plan);
  const registry = getRegistry(project);
  const losses: ExportLoss[] = [];
  const files: string[] = [];
  const output = new Map<string, string>();
  const lose = (screen: string | null, block: string | null, loss: string): void => { losses.push({ screen, block, loss }); };
  const media = new Map<string, string>();
  const copyAsset = (asset: unknown): string => {
    if (!asset) return '';
    const name = `media/${String(asset).replace(/\//g, '-')}`;
    if (hasFile(project.files, `assets/${asset}`) && !media.has(name)) media.set(name, `assets/${asset}`);
    return name;
  };
  const resolve = (block: Block): Record<string, unknown> => resolveBlockProps(block, index, registry);

  screenOrder(project).forEach(({ id }, i) => {
    const screen = project.screens.get(id)?.data;
    if (!screen) return;
    const lines = ['---', `title: ${oneLine(screen.title)}`, '---', ''];
    const directive = (type: string, props: Record<string, unknown>, body: string = ''): void => {
      lines.push(`::: ${type}`);
      for (const [key, value] of Object.entries(props)) if (value !== undefined && value !== '') lines.push(`${key}: ${value}`);
      if (body) { if (Object.keys(props).length) lines.push(''); lines.push(body.trim()); }
      lines.push(':::', '');
    };
    // Course components and forks are exported through their fallback (native blocks).
    const natives = readingOrder(screen.blocks, screenLayout(project, screen)).flatMap((block) => {
      const descriptor = registry.get(block.type);
      if (descriptor && !descriptor.builtin) lose(id, block.id, `component ${block.type} exported through its fallback (${descriptor.root ? `as a ${descriptor.root}` : 'native blocks'})`);
      return fallbackBlocks(registry, block, { resolve });
    });
    if (screen.layout) lose(id, null, `layout ${screen.layout} (blocks exported in reading order)`);
    if (screen.narration) lose(id, null, `narration (${recordsOf(screen.narration.lines).length} lines: LESSON.md has no voice-over)`);
    for (const block of natives) {
      // Props as the file holds them (an invalid value shows as it is).
      const props = resolve(block);
      switch (block.type) {
        case 'heading': directive('text', {}, `${'#'.repeat(Math.max(1, (Number(props.level) || 2) - 1))} ${props.text}`); break;
        case 'text': directive('text', {}, optionalTextOf(props.markdown)); if (props.textRef) lose(id, block.id, `link to locked text ${props.textRef} (exported as plain text)`); break;
        case 'callout': directive('note', { variant: 1 }, `${props.title ? `**${props.title}**\n\n` : ''}${props.markdown}`); break;
        case 'image': directive('image', { src: copyAsset(props.asset), alt: props.decorative ? '' : oneLine(props.alt), caption: oneLine(props.caption) }); if (props.generated) lose(id, block.id, 'AI-generated marking'); break;
        case 'video':
        case 'audio':
          directive(block.type, { src: copyAsset(props.asset), caption: oneLine(props.title) });
          // A decorative medium, or a silent video described by its alt, has no transcript to export.
          if (!props.decorative && typeof props.transcript === 'string' && props.transcript.trim()) {
            directive('text', {}, `**Transcription**\n\n${props.transcript}`);
            lose(id, block.id, `${block.type === 'video' ? 'captions file and ' : ''}transcript as a property (transcript exported as a text block)`);
          } else if (block.type === 'video' && props.captions) lose(id, block.id, 'captions file');
          break;
        case 'accordion': directive('accordion', { allowMultiple: props.allowMultiple !== false }, recordsOf(props.items).map((item) => `## ${oneLine(item.title)}\n\n${item.markdown}`).join('\n\n')); break;
        case 'button': directive('button', { text: oneLine(props.label), style: props.variant === 'primary' ? 'primary' : 'secondary' }); lose(id, block.id, 'button events (what the button does)'); break;
        case 'quiz': {
          const options = recordsOf(props.options);
          const correct = options.filter((option) => option.correct);
          const wrong = options.filter((option) => !option.correct);
          directive('knowledge-check', {
            type: props.mode === 'multiple' ? 'multiple-select' : 'multiple-choice',
            question: oneLine(props.stem),
            maxAttempts: props.attempts || 1,
            'correct-feedback': oneLine(correct.map((option) => option.feedback).filter(Boolean).join(' ')),
            'incorrect-feedback': oneLine(wrong.map((option) => `${option.text} : ${option.feedback || ''}`).join(' ')),
            revealCorrectAnswer: props.showCorrectAnswer !== false
          }, options.map((option) => `- [${option.correct ? 'x' : ' '}] ${oneLine(option.text)}`).join('\n'));
          lose(id, block.id, 'per-option feedback (merged into correct/incorrect feedback), objective link, weight, scoring');
          if (props.questionRef) lose(id, block.id, `link to validated question ${props.questionRef}`);
          break;
        }
        case 'decision':
          directive('note', { variant: 2 }, `${props.prompt}\n\n${recordsOf(props.options).map((option) => `- ${option.label}${option.feedback ? ` — ${oneLine(option.feedback)}` : ''}`).join('\n')}`);
          lose(id, block.id, 'decision interaction and its consequences (exported as a note)');
          break;
        case 'dialogue': {
          // D61: the script in Markdown; LESSON.md has no branching conversation.
          const data = dialogueData(props, { course: project.course });
          const words = scriptWords(project.course?.language);
          directive('text', {}, scriptMarkdown(dialogueScript(data, { id: block.id, screen: id, words }), words));
          lose(id, block.id, 'dialogue (exported as its script: its branches, score and state are lost)');
          break;
        }
        case 'free-object':
          directive('text', {}, `**${props.title}**\n\n${props.textAlternative}`);
          lose(id, block.id, `free object ${props.object} (code is not supported by LESSON.md; its text alternative is exported)`);
          break;
        case 'results':
          lose(id, block.id, 'results block');
          break;
        case 'math':
          directive('text', {}, `$$\n${props.tex}\n$$${props.caption ? `\n\n${props.caption}` : ''}`);
          lose(id, block.id, 'equation exported as LaTeX source in a text block');
          break;
        // D63's activities, as native text: LESSON.md has no blanks, sorting or open answer.
        case 'fill-in':
          directive('note', { variant: 2 }, `${props.stem ? `${props.stem}\n\n` : ''}${fillInText(props.markdown)}${recordOf(props.feedback).correct ? `\n\n${recordOf(props.feedback).correct}` : ''}`);
          lose(id, block.id, 'fill-in interaction, its scoring and feedback (exported as a note: the sentence with its answers)');
          break;
        case 'sort':
          directive('note', { variant: 2 }, `${props.stem ? `${props.stem}\n\n` : ''}${sortLines(props).join('\n')}${recordOf(props.feedback).correct ? `\n\n${recordOf(props.feedback).correct}` : ''}`);
          lose(id, block.id, 'sort interaction and its scoring (exported as a note: its items and where they go)');
          break;
        case 'reflection':
          directive('text', {}, `**${oneLine(props.prompt)}**${props.model ? `\n\n${props.model}` : ''}`);
          lose(id, block.id, 'reflection field and its saved answers (exported as the prompt and the expert\'s answer)');
          break;
        case 'numeric':
          directive('note', { variant: 2 }, `${props.stem}\n\n**${props.answer}${props.unit ? ` ${props.unit}` : ''}**\n\n${recordOf(props.feedback).correct || ''}`);
          lose(id, block.id, 'numeric answer, tolerance and misconception feedback (exported as a note)');
          break;
        default:
          // Charts (D60): the takeaway, then the data as a Markdown table.
          if (isChartType(block.type)) {
            directive('text', {}, chartMarkdown(block.type, props, { id: block.id, language: project.course?.language || 'en', tokens: {} }));
            lose(id, block.id, `${block.type} chart (exported as its takeaway and a table of its data${props.mode === 'predict' ? '; the prediction is lost' : ''})`);
          }
      }
    }
    const layers = objectsIn(screen.layers);
    const events = objectsIn(screen.events);
    if (layers.length) lose(id, null, `layers ${layers.map((layer) => layer.id).join(', ')}`);
    if (events.length) lose(id, null, `events ${events.map((event) => event.id).join(', ')}`);
    const name = `${String(i + 1).padStart(2, '0')}-${id}.md`;
    output.set(name, lines.join('\n'));
    files.push(name);
  });
  const course = project.course;
  output.set('COURSE.md', `---\ntitle: ${oneLine(course?.title)}\n---\n\n${course?.description || ''}\n`);
  if (course?.variables?.length) losses.push({ screen: null, block: null, loss: 'course variables' });
  losses.push({ screen: null, block: null, loss: 'validated plan, tracking settings, theme tokens (LESSON.md has no equivalent)' });
  output.set('elabora-export-losses.json', JSON.stringify({ format: 'LESSON.md 1.9', losses }, null, 2) + '\n');
  return { files: ['COURSE.md', ...files], losses, output, media: [...media].map(([name, from]) => ({ from, name })) };
}

// ── import ───────────────────────────────────────────────────────────
const KNOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  image: ['src', 'alt', 'caption', 'width', 'align'], video: ['src', 'provider', 'caption'], audio: ['src', 'caption'],
  accordion: ['allowmultiple'], tabs: ['orientation'], process: ['orientation', 'style'], timeline: ['orientation', 'style'],
  note: ['variant'], button: ['text', 'url', 'style', 'opennewtab', 'openinnewtab', 'align'], divider: ['style'],
  'knowledge-check': ['type', 'question', 'instructions', 'correct-feedback', 'incorrect-feedback', 'maxattempts', 'revealcorrectanswer', 'revealanswersperattempt', 'showfeedback', 'eliminatewrongoptions', 'casesensitive'],
  table: ['headerrow', 'headercolumn', 'borderstyle', 'striping', 'caption'], embed: ['src', 'width', 'height', 'title', 'allowfullscreen'],
  document: ['src', 'filename', 'title', 'description'], layout: ['preset', 'gap'], card: ['title', 'subtitle', 'style', 'imageurl', 'imagealt', 'imageposition', 'linkurl', 'linknewtab']
};

// A ::: directive of a lesson: its type, its known keys (lowercase) and the content after them.
export interface LessonDirective {
  type: string;
  props: Record<string, string>;
  content: string;
}

export function parseLessonMd(text: string): { title: string | null; blocks: LessonDirective[] } {
  const source = text.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  let body = source;
  let title: string | null = null;
  const frontMatter = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (frontMatter) {
    body = source.slice(frontMatter[0].length);
    title = /^title:\s*(.+)$/m.exec(frontMatter[1])?.[1]?.trim() || null;
  }
  const blocks: LessonDirective[] = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^:::\s*([a-z-]+)\s*$/.exec(lines[i]);
    if (!open) continue;
    const type = open[1];
    const inner: string[] = [];
    for (i++; i < lines.length && !/^:::\s*$/.test(lines[i]); i++) inner.push(lines[i]);
    const props: Record<string, string> = {};
    let j = 0;
    const known = KNOWN_KEYS[type] || [];
    while (j < inner.length) {
      const match = /^([A-Za-z-]+):\s*(.*)$/.exec(inner[j]);
      if (!match || !known.includes(match[1].toLowerCase())) break;
      props[match[1].toLowerCase()] = match[2].trim();
      j++;
    }
    blocks.push({ type, props, content: inner.slice(j).join('\n').trim() });
  }
  return { title, blocks };
}

// The ## sections of a directive's content (accordion, tabs, process, timeline items).
function sections(markdown: string): { title: string; markdown: string }[] {
  const found: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) { current = { title: heading[1].trim(), body: [] }; found.push(current); } else if (current) current.body.push(line);
  }
  return found.map((section) => ({ title: section.title, markdown: section.body.join('\n').trim() }));
}

// An asset a lesson refers to: copy it from (a path next to the lesson, or a URL) to assets/<to>.
export interface LessonAsset {
  from: string;
  to: string;
  external: boolean;
}

// Turns one LESSON.md lesson into an Elabora screen (blocks only). covers must be given: imported
// content has no plan, and the plan stays the contract.

export function lessonToScreen(text: string, { id, covers, title: forcedTitle }: { id: string; covers: string[]; title?: string }): { screen: Screen; assets: LessonAsset[]; losses: string[] } {
  const { title, blocks } = parseLessonMd(text);
  const losses: string[] = [];
  const out: Block[] = [];
  const assets: LessonAsset[] = [];
  let count = 0;
  const blockId = (): string => `${id}-${++count}`;
  const shiftHeadings = (markdown: string): string => markdown.replace(/^(#{1,4})\s/gm, (_, hashes: string) => `${'#'.repeat(Math.min(4, hashes.length + 1))} `);
  for (const directive of blocks) {
    const props = directive.props;
    switch (directive.type) {
      case 'text': out.push({ id: blockId(), type: 'text', props: { markdown: shiftHeadings(directive.content) || ' ' } }); break;
      case 'note': out.push({ id: blockId(), type: 'callout', props: { variant: 'info', markdown: directive.content || ' ' } }); break;
      case 'image': {
        const external = /^https?:/i.test(props.src || '');
        const asset = `images/${basename((props.src || 'image').split('?')[0]).replace(/[^A-Za-z0-9._-]/g, '-')}`;
        assets.push({ from: props.src, to: asset, external });
        out.push({ id: blockId(), type: 'image', props: { asset, ...(props.alt ? { alt: props.alt } : {}), ...(props.caption ? { caption: props.caption } : {}) } });
        if (external) losses.push(`image ${props.src}: download it into assets/${asset} (packages work offline)`);
        break;
      }
      case 'accordion':
      case 'tabs': {
        const items = sections(directive.content).map((section, k) => ({ id: `i${k + 1}`, title: section.title, markdown: section.markdown || ' ' }));
        if (items.length) out.push({ id: blockId(), type: 'accordion', props: { items, allowMultiple: props.allowmultiple === 'true' } });
        if (directive.type === 'tabs') losses.push('tabs imported as an accordion');
        break;
      }
      case 'knowledge-check': {
        if (props.type === 'fill-in-the-blank') { out.push({ id: blockId(), type: 'text', props: { markdown: `${props.question || ''}\n\n${directive.content}` } }); losses.push('fill-in-the-blank question imported as text (block type planned for 0.2)'); break; }
        const options = [...directive.content.matchAll(/^- \[( |x|X)\]\s+(.+)$/gm)].map((match, k) => ({ id: String.fromCharCode(97 + k), text: match[2].trim(), correct: match[1].toLowerCase() === 'x' }));
        const correctFeedback = props['correct-feedback'];
        const incorrectFeedback = props['incorrect-feedback'];
        out.push({ id: blockId(), type: 'quiz', props: {
          stem: props.question || 'Question', mode: props.type === 'multiple-select' ? 'multiple' : 'single',
          options: options.map((option) => ({ ...option, ...((option.correct ? correctFeedback : incorrectFeedback) ? { feedback: option.correct ? correctFeedback : incorrectFeedback } : {}) })),
          attempts: Math.min(5, Math.max(1, Number(props.maxattempts) || 1)), showCorrectAnswer: props.revealcorrectanswer === 'true'
        } });
        losses.push('knowledge check: write elaborated feedback per option (LESSON.md only has global feedback)');
        break;
      }
      case 'process':
      case 'timeline': {
        const items = sections(directive.content);
        out.push({ id: blockId(), type: 'text', props: { markdown: items.map((section, k) => `${k + 1}. **${section.title}** — ${section.markdown.replace(/^marker:.*\n?/m, '').replace(/\n+/g, ' ')}`).join('\n') || ' ' } });
        losses.push(`${directive.type} imported as an ordered list`);
        break;
      }
      case 'table': out.push({ id: blockId(), type: 'text', props: { markdown: directive.content } }); break;
      case 'video': case 'audio':
        out.push({ id: blockId(), type: 'callout', props: { variant: 'warning', title: `${directive.type === 'video' ? 'Vidéo' : 'Audio'} à intégrer`, markdown: `Source : ${props.src || '?'}${props.caption ? ` — ${props.caption}` : ''}. Ajoutez le fichier dans assets/, ${directive.type === 'video' ? 'les sous-titres WebVTT ' : ''}et la transcription, puis remplacez ce bloc par un bloc ${directive.type}.` } });
        losses.push(`${directive.type} ${props.src}: needs a local file${directive.type === 'video' ? ', captions' : ''} and a transcript`);
        break;
      default:
        if (directive.content) out.push({ id: blockId(), type: 'text', props: { markdown: shiftHeadings(directive.content) } });
        losses.push(`${directive.type} block imported as text`);
    }
  }
  if (!out.length) out.push({ id: blockId(), type: 'text', props: { markdown: title || ' ' } });
  const hasActivity = out.some((block) => block.type === 'quiz');
  return { screen: { $schema: schemaId('screen'), id, title: forcedTitle || title || id, covers, ...(hasActivity ? { completeWhen: 'interactions-done' } : {}), blocks: out }, assets, losses };
}
