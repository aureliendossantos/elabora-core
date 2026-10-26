import { dialogueData } from '../dialogue/data.ts';
import { dialogueScript, scriptMarkdown, scriptWords } from '../dialogue/script.ts';
import type { Event, Condition, Action } from '@elabora/format';
import { planIndex, resolveBlockProps, resolveTextRefs, screenOrder } from './load.ts';
import { describePlanVersions, planVersionsView } from './plan-versions.ts';
import type { Project, Block } from './model.ts';
import { markdownToText } from '../compile/markdown.ts';
import { getRegistry } from '../components/registry.ts';
import { fallbackBlocks } from '../components/fallback.ts';
import { isChartType, chartTable } from '../charts/index.ts';
import { fillInText, sortLines } from './activity-text.ts';
import { parseBlanks, replaceBlanks } from '@elabora/player/fill-in';
import { recordOf, recordsOf, textOf } from '../compile/values.ts';
import { listOf, objectsIn } from '../util/values.ts';

// Markdown projection of a course.
//   audience 'agent': ids, types, events and references, compact (an agent's map of the course)
//   audience 'client': what the learner sees and how it maps to the validated plan (review)
export function projectMarkdown(project: Project, { audience = 'agent', screen: only }: { audience?: 'agent' | 'client' | string; screen?: string } = {}): string {
  const { plan, course } = project;
  if (!course) return '# Course\n\ncourse.json is missing, does not parse or is not an object: run elabora validate.\n';
  const pidx = planIndex(plan);
  const reg = getRegistry(project);
  const agent = audience === 'agent';
  const L: string[] = [];
  const short = (s: unknown, n = 160): string => { const t = markdownToText(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

  if (!only) {
    L.push(`# ${course.title}${agent ? ` (\`${course.id}\` v${course.version})` : ''}`, '');
    if (agent) {
      const migration = project.migration ? ` (files in ${project.migration.from}, read migrated: \`elabora migrate\` writes them)` : '';
      L.push(`- format ${course.format}${migration} · language ${course.language} · navigation ${course.navigation?.mode || 'linear'}${course.navigation?.lockUntilComplete ? ' (locked until complete)' : ''}`);
      L.push(`- reportAs ${course.completion?.reportAs || 'completed-incomplete'}${course.completion?.masteryScore !== undefined ? ` · mastery ${course.completion.masteryScore} %` : ''}`);
      L.push(`- plan ${plan?.id} · ${describePlanVersions(planVersionsView(project))}`);
      const variables = objectsIn(course.variables);
      if (variables.length) L.push(`- variables: ${variables.map((v) => `\`${v.id}\` ${v.type}=${JSON.stringify(v.default)}`).join(', ')}`);
      L.push('');
    }
    L.push(agent ? '## Plan objectives' : '## Objectifs / Objectives', '');
    for (const o of objectsIn(plan?.objectives)) L.push(`- **${o.id}** ${o.statement}`);
    L.push('');
  }

  for (const sec of objectsIn(course.sections)) {
    const ids = listOf(sec.screens).filter((id) => !only || id === only);
    if (!ids.length) continue;
    if (!only) L.push(`## ${agent ? `Section \`${sec.id}\` — ` : ''}${sec.title}`, '');
    for (const id of ids) {
      const s = project.screens.get(id)?.data;
      if (!s) { L.push(`### \`${id}\` — MISSING FILE`, ''); continue; }
      const covers = listOf(s.covers).map((c) => (agent ? c : `${c} ${pidx.items.get(c)?.title || ''}`.trim())).join(', ');
      L.push(`### ${agent ? `\`${s.id}\` — ` : ''}${s.title}`, '');
      L.push(`_${agent ? `covers ${covers} · completeWhen ${s.completeWhen || 'viewed'}${s.required === false ? ' · optional' : ''}${s.layout ? ` · layout ${s.layout}${s.layoutProps ? ` ${JSON.stringify(s.layoutProps)}` : ''}` : ''}${s.style ? ` · style ${s.style}` : ''}` : `Plan : ${covers}`}_`, '');
      // An opening's head (D63): what the learner reads above the page.
      if (reg.get(s.layout ?? '')?.root === 'opening') {
        const head = recordOf(resolveTextRefs(s.layoutProps ?? {}, pidx));
        if (head.eyebrow && !agent) L.push(`_${head.eyebrow}_`, '');
        if (head.lead) L.push(agent ? `- opening lead: ${short(head.lead, 160)}` : short(head.lead, 2000), '');
      }
      const blockLines = (blocks: Block[] | undefined, indent = ''): void => {
        for (const b of objectsIn(blocks)) {
          const d = reg.get(b.type);
          // Course components: props for agents; for clients, what the learner reads (the fallback).
          if (d && !d.builtin && !d.root) {
            if (agent) {
              L.push(`${indent}- ${b.type} \`${b.id}\`${b.slot ? ` →${b.slot}` : ''}${b.style ? ` (style ${b.style})` : ''}${b.hidden ? ' (hidden)' : ''}: ${JSON.stringify(b.props || {}).slice(0, 220)}`);
              blockLines(b.blocks, `${indent}  `);
            } else blockLines(fallbackBlocks(reg, b, { resolve: (x) => resolveBlockProps(x, pidx, reg) }), indent);
            continue;
          }
          const p = resolveBlockProps(b, pidx, reg);
          const fork = d && !d.builtin ? ` (fork of ${d.root})` : '';
          const tag = agent ? `${b.type}${fork} \`${b.id}\`${b.slot ? ` →${b.slot}` : ''}${b.style ? ` (style ${b.style})` : ''}${b.hidden ? ' (hidden)' : ''}${p.textRef ? ` [locked ${p.textRef}]` : ''}${p.questionRef ? ` [plan ${p.questionRef}]` : ''}: ` : '';
          const root = d?.root || b.type;
          // Charts (D60): their takeaway and their data, as the table screen readers get.
          if (isChartType(root)) {
            const table = chartTable(root, p, { id: b.id, language: project.course?.language || 'en', tokens: {} });
            const data = table.rows.map((row) => row.filter(Boolean).join(' ')).join(' · ');
            const marks = [p.highlight ? `highlight ${p.highlight}` : '', p.mode === 'predict' ? `the learner predicts from ${recordOf(p.predict).from}` : ''].filter(Boolean).join(', ');
            if (agent) L.push(`${indent}- ${tag}${root} chart **${p.takeaway}**${marks ? ` (${marks})` : ''}: ${short(data, 220)}`);
            else {
              L.push(`${indent}- **${p.takeaway}**${p.context ? ` — ${short(p.context, 300)}` : ''}`);
              for (const row of table.rows) L.push(`${indent}  - ${row.filter(Boolean).join(' : ')}`);
            }
            continue;
          }
          switch (root) {
            case 'heading': L.push(`${indent}- ${tag}**${p.text}**`); break;
            case 'text': L.push(`${indent}- ${tag}${short(p.markdown, agent ? 160 : 2000)}`); if (p.aside) L.push(`${indent}  - ${agent ? 'aside: ' : ''}_${short(p.aside, agent ? 120 : 600)}_`); break;
            case 'statement': {
              const by = [p.author, p.role].filter(Boolean).join(', ');
              L.push(`${indent}- ${tag}${agent ? `statement${p.presentation && p.presentation !== 'statement' ? ` (${p.presentation})` : ''} ` : ''}« ${short(p.markdown, agent ? 160 : 600)} »${by ? ` — ${by}` : ''}`);
              break;
            }
            case 'divider': if (agent) L.push(`${indent}- ${tag}divider (${p.presentation || 'line'})`); break;
            case 'gallery':
              L.push(`${indent}- ${tag}${agent ? `gallery (${p.presentation || 'grid'}): ` : ''}${recordsOf(p.images).map((image) => `${agent ? `\`${image.asset}\` ` : ''}${image.decorative ? '(decorative)' : `"${image.alt}"`}${image.caption ? ` — ${image.caption}` : ''}`).join(' · ')}`);
              if (p.caption && !agent) L.push(`${indent}  _${p.caption}_`);
              break;
            case 'columns': if (agent) L.push(`${indent}- ${tag}columns (${p.count || 2}${p.widths && p.widths !== 'equal' ? `, ${p.widths}` : ''})`); break;
            // A steps block (« Étapes ») and an interactive picture (D63): their items in order.
            case 'steps': {
              const presentation = String(p.presentation || 'carousel');
              const ends = presentation === 'carousel' ? { intro: recordOf(p.intro), summary: recordOf(p.summary) } : { intro: {}, summary: {} };
              L.push(`${indent}- ${tag}${agent ? `steps (${presentation}${presentation === 'scroll' ? `, figure ${p.figure || 'replace'}` : ''}): ` : ''}${recordsOf(p.items).map((item) => item.title).join(' → ')}`);
              const line = (title: unknown, body: unknown, extra = '') => L.push(`${indent}  - ${extra}**${title}**${body ? ` ${short(body, agent ? 120 : 1200)}` : ''}`);
              if (ends.intro.title) line(ends.intro.title, ends.intro.markdown);
              if (!agent || presentation === 'timeline') recordsOf(p.items).forEach((item, index) => line(item.title, agent ? '' : item.markdown, item.date ? `${item.date} — ` : p.numbered !== false && presentation !== 'timeline' ? `${index + 1}. ` : ''));
              if (ends.summary.title) line(ends.summary.title, ends.summary.markdown);
              break;
            }
            case 'hotspots':
              L.push(`${indent}- ${tag}${agent ? `hotspots (${p.presentation || 'popover'}) \`${p.image}\` ` : ''}${p.decorative ? '(decorative)' : `"${p.alt}"`}${p.prompt ? ` — ${p.prompt}` : ''}`);
              recordsOf(p.items).forEach((item, index) => L.push(`${indent}  - ${index + 1}. **${item.title}**${agent ? ` (${item.x}, ${item.y})` : ` ${short(item.markdown, 1200)}`}`));
              break;
            case 'callout': L.push(`${indent}- ${tag}[${p.variant || 'info'}] ${p.title ? `**${p.title}** ` : ''}${short(p.markdown, agent ? 160 : 2000)}`); break;
            case 'image':
              L.push(`${indent}- ${tag}${agent ? `\`${p.asset}\` ` : ''}image${agent && p.presentation && p.presentation !== 'centered' ? ` (${p.presentation})` : ''}: ${p.decorative ? '(decorative)' : `"${p.alt}"`}${p.generated ? ' [AI-generated]' : ''}`);
              if (p.title || p.markdown) L.push(`${indent}  - ${p.title ? `**${p.title}** ` : ''}${short(p.markdown, agent ? 160 : 2000)}`);
              break;
            case 'video': case 'audio': L.push(`${indent}- ${tag}${b.type} "${p.title}"${p.decorative ? ' (decorative)' : ''}${p.generated ? ' [AI-generated]' : ''}`); break;
            case 'button': L.push(`${indent}- ${tag}button "${p.label}"`); break;
            case 'accordion': L.push(`${indent}- ${tag}accordion: ${recordsOf(p.items).map((i) => i.title).join(' · ')}`); break;
            case 'quiz': {
              L.push(`${indent}- ${tag}${agent ? '' : 'Question : '}${short(p.stem, 300)}${p.objective ? ` (${p.objective})` : ''}${p.scored === false ? ' — not scored' : ''}`);
              for (const o of recordsOf(p.options)) L.push(`${indent}  - [${o.correct ? 'x' : ' '}] ${agent ? `\`${o.id}\` ` : ''}${o.text}${!agent && o.feedback ? ` — _${short(o.feedback, 300)}_` : ''}`);
              break;
            }
            case 'math': L.push(`${indent}- ${tag}$$${p.tex}$$${p.caption ? ` — ${short(p.caption, 160)}` : ''}`); break;
            case 'numeric': {
              const tolerance = recordOf(p.tolerance);
              const tol = p.tolerance ? ('absolute' in tolerance ? ` ± ${tolerance.absolute}` : ` ± ${tolerance.percent} %`) : '';
              L.push(`${indent}- ${tag}${agent ? '' : 'Question : '}${short(p.stem, 300)} → **${p.answer}${tol}${p.unit ? ` ${p.unit}` : ''}**${p.objective ? ` (${p.objective})` : ''}${p.scored === false ? ' — not scored' : ''}`);
              for (const m of recordsOf(p.misconceptions)) L.push(`${indent}  - ${agent ? `\`${m.id}\` ` : ''}${m.value} — _${short(m.feedback, agent ? 100 : 300)}_`);
              break;
            }
            // D63's activities: a fill-in as its sentence and its answers, a sort as its items and where they go.
            case 'fill-in': {
              const blanks = parseBlanks(p.markdown);
              const distractors = Array.isArray(p.distractors) ? p.distractors.filter((word) => typeof word === 'string') : [];
              if (agent) L.push(`${indent}- ${tag}fill-in (${p.presentation || 'typed'}, ${blanks.length} blank${blanks.length === 1 ? '' : 's'})${p.objective ? ` (${p.objective})` : ''}${p.scored === false ? ' — not scored' : ''}: ${short(replaceBlanks(p.markdown, (_, blank) => `[[${blank.answers.join('|')}]]`), 220)}${distractors.length ? ` · distractors ${distractors.join(', ')}` : ''}`);
              else {
                L.push(`${indent}- Texte à trous : ${p.stem ? short(p.stem, 300) : ''}${p.scored === false ? ' — not scored' : ''}`.trimEnd());
                L.push(`${indent}  - ${fillInText(p.markdown).replace(/\s*\n\s*/g, ' ').trim()}`);
                if (distractors.length) L.push(`${indent}  - Mots en trop : ${distractors.join(', ')}`);
                const feedback = recordOf(p.feedback);
                if (feedback.incorrect) L.push(`${indent}  - _${short(feedback.incorrect, 300)}_`);
              }
              break;
            }
            case 'sort': {
              const lines = sortLines(p);
              L.push(`${indent}- ${tag}${agent ? `sort (${p.presentation || 'pairs'}) ` : 'Classer : '}${short(p.stem, 300)}${p.objective ? ` (${p.objective})` : ''}${p.scored === false ? ' — not scored' : ''}`.trimEnd());
              for (const line of lines) L.push(`${indent}  ${line.startsWith('- ') ? line : `- ${line}`}`);
              break;
            }
            case 'reflection': {
              const scale = recordOf(p.scale);
              L.push(`${indent}- ${tag}${agent ? `reflection (${p.presentation || 'text'}${p.presentation === 'scale' ? ` ${scale.min ?? 1}–${scale.max ?? 5}` : `, ${p.maxLength ?? 500} characters`}${p.download ? ', download' : ''}) ` : 'Réflexion : '}${short(p.prompt, 300)}`);
              if (p.presentation === 'scale' && (scale.minLabel || scale.maxLabel)) L.push(`${indent}  - ${scale.min ?? 1} ${scale.minLabel || ''} … ${scale.max ?? 5} ${scale.maxLabel || ''}`.replace(/\s+/g, ' '));
              if (p.model) L.push(`${indent}  - ${agent ? 'model' : "Réponse d'expert"} : _${short(p.model, agent ? 160 : 1000)}_`);
              break;
            }
            case 'decision':
              L.push(`${indent}- ${tag}${agent ? '' : 'Décision : '}${short(p.prompt, 300)}`);
              for (const o of recordsOf(p.options)) L.push(`${indent}  - ${agent ? `\`${o.id}\` ` : ''}${o.label}${o.correct ? ' (best)' : ''}${o.feedback ? ` → _${short(o.feedback, agent ? 100 : 300)}_` : ''}`);
              break;
            case 'dialogue': {
              // D61: for agents a summary (elabora dialogue show prints it whole), for clients the script.
              const data = dialogueData(p, { course: project.course });
              const decisions = data.nodes.filter((node) => node.options.length).length;
              if (agent) L.push(`${indent}- ${tag}dialogue **${data.title}** (${data.mode}, scoring ${data.scoring}${data.learner ? `, the learner plays ${data.learner}` : ''}): ${data.nodes.length} nodes, ${decisions} decisions${data.endings.length ? `, endings ${data.endings.map((ending) => ending.id).join(', ')}` : ''} — elabora dialogue show . ${b.id}`);
              else {
                const words = scriptWords(project.course?.language);
                for (const lineText of scriptMarkdown(dialogueScript(data, { id: b.id, screen: id, words }), words).split('\n')) if (lineText.trim()) L.push(`${indent}  ${lineText}`);
              }
              break;
            }
            case 'free-object': {
              const m = project.objects.get(textOf(p.object))?.manifest;
              L.push(`${indent}- ${tag}free object ${agent ? `\`${p.object}\`` : `« ${p.title} »`}${m ? ` — ${m.pedagogicalRole}, serves ${listOf(m.planRefs?.objectives).join(', ')}` : ''}`);
              if (agent && p.props && Object.keys(p.props).length) L.push(`${indent}  - props: ${JSON.stringify(p.props)}`);
              if (!agent) L.push(`${indent}  - Version texte : ${short(p.textAlternative, 600)}`);
              break;
            }
            case 'results': L.push(`${indent}- ${tag}results (score and status)${p.allowRetry ? ', retry allowed' : ''}`); break;
          }
          if (b.blocks?.length) blockLines(b.blocks, `${indent}  `);
        }
      };
      blockLines(s.blocks);
      for (const l of objectsIn(s.layers)) {
        L.push(`- ${agent ? `layer \`${l.id}\`` : 'Calque'} « ${l.title} »`);
        blockLines(l.blocks, '  ');
      }
      const events = objectsIn(s.events);
      if (agent && events.length) {
        L.push('', 'Events:');
        for (const e of events) L.push(`- \`${e.id}\`: ${describeEvent(e)}`);
      }
      L.push('');
    }
  }
  return L.join('\n');
}

export function describeEvent(e: Event): string {
  const on: Partial<Event['on']> = e.on || {};
  const triggers: Record<string, string> = {
    'screen.enter': 'when the screen opens',
    click: `when \`${on.target}\`${on.name !== undefined ? ` (\`${on.name}\`)` : ''} is clicked`,
    'quiz.submitted': `when quiz \`${on.target}\` is submitted${on.result && on.result !== 'any' ? ` (${on.result})` : ''}`,
    'decision.selected': `when decision \`${on.target}\` gets option ${on.option ? `\`${on.option}\`` : 'any'}`,
    'object.event': `when object \`${on.target}\` emits ${on.name}${on.where ? ` where ${JSON.stringify(on.where)}` : ''}`,
    'variable.changed': `when \`${on.variable}\` changes`,
    'layer.closed': `when layer \`${on.target}\` closes`,
    'dialogue.started': `when dialogue \`${on.target}\` begins`,
    'dialogue.node': `when dialogue \`${on.target}\` enters ${on.node ? `node \`${on.node}\`` : 'a node'}`,
    'dialogue.line': `when dialogue \`${on.target}\` says ${on.line ? `line \`${on.line}\`` : 'a line'}`,
    'dialogue.chosen': `when dialogue \`${on.target}\` gets ${on.option ? `option \`${on.node ? `${on.node}.` : ''}${on.option}\`` : on.node ? `a choice in \`${on.node}\`` : 'a choice'}`,
    'dialogue.ended': `when dialogue \`${on.target}\` ends${on.ending ? ` on \`${on.ending}\`` : ''}`
  };
  const trig = triggers[on.type ?? ''] || on.type;
  const cond = objectsIn(e.if).map((c: Condition) => (c.visited !== undefined ? `\`${c.visited}\`${c.name !== undefined ? ` (\`${c.name}\`)` : ''} visited`
    : c.dialogue !== undefined ? `dialogue \`${c.dialogue}\` ${c.ending !== undefined ? `ended on ${c.ending}` : c.chosen !== undefined ? `chose ${c.chosen}` : c.score !== undefined ? `score ${c.score.op} ${c.score.value}` : c.done ? 'done' : 'not done'}`
    : `${c.variable} ${c.op} ${JSON.stringify(c.value)}`)).join(' and ');
  const act = (list: Action[] | undefined) => objectsIn(list).map((a) => [a.type, a.screen, a.type === 'hide-layer' && a.layer === undefined ? '(the open layer)' : a.layer, a.block, a.node, a.variable, a.value !== undefined ? `= ${JSON.stringify(a.value)}` : '', a.by !== undefined ? `by ${a.by}` : '', a.props ? JSON.stringify(a.props) : ''].filter(Boolean).join(' ')).join('; ');
  return `${trig}${cond ? ` if ${cond}` : ''} → ${act(e.do) || 'nothing'}${listOf(e.else).length ? ` else → ${act(e.else)}` : ''}`;
}

export function screenSummaries(project: Project) {
  return screenOrder(project).map(({ id, section }) => {
    const s = project.screens.get(id)?.data;
    const flat = (bs: Block[] | undefined): string[] => objectsIn(bs).flatMap((b) => [`${b.type}:${b.id}`, ...flat(b.blocks)]);
    return { id, section, title: s?.title, covers: s?.covers, blocks: flat(s?.blocks) };
  });
}
