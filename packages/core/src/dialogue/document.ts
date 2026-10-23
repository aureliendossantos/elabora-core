// A dialogue for the client (D61): one HTML page, the map first, readable at a glance, then the
// script (who says what, each option with its quality, where it goes and its note), then the endings.
// It holds everything it needs (no script, no file to fetch); printed by Chromium it is the PDF
// (`elabora dialogue export --to pdf`, the plan's printer, D48). The app calls the same function.

import { escapeHtml } from '../util/html.ts';
import { renderMarkdown } from '../compile/markdown.ts';
import { dialogueMap, dialogueMapSvg } from './layout.ts';
import { dialogueScript, scriptWords } from './script.ts';
import type { ScriptLine, DialogueScript } from './script.ts';
import type { DialogueData } from '@elabora/player/dialogue/types';

export const DIALOGUE_DOCUMENT_FONT = 'Inter';

interface DocumentWords {
  dialogue: string;
  map: string;
  script: string;
  endings: string;
  chooses: string;
  then: string;
  feedback: string;
  final: string;
  legend: string;
  otherwise: string;
  qualities: Record<string, string>;
  settings: (data: DialogueData) => string[];
}

const WORDS: Readonly<Record<'fr' | 'en', DocumentWords>> = {
  fr: {
    dialogue: 'Dialogue', map: 'Carte du dialogue', script: 'Script', endings: 'Fins', chooses: 'choisit', then: 'puis', feedback: 'Note du formateur', final: 'Choix définitif',
    legend: 'Chaque case est un temps du dialogue ; les lettres sont les options de l\'apprenant. Les flèches en pointillés reviennent en arrière (réessayer, une boucle).', otherwise: 'sinon',
    qualities: { good: 'bonne', ok: 'moyenne', bad: 'mauvaise' },
    settings: (data) => [
      { practice: 'Pratique', assessment: 'Évaluation', exploration: 'Exploration' }[data.mode],
      { none: 'non noté', quality: 'noté sur la qualité des choix', points: 'noté en points', ending: 'noté selon la fin' }[data.scoring],
      { none: 'sans retour en arrière', retry: 'l\'apprenant peut réessayer un choix', 'after-end': 'l\'apprenant peut réessayer, puis revenir à un choix après la fin', anytime: 'l\'apprenant peut revenir à un choix à tout moment' }[data.revisit]
    ]
  },
  en: {
    dialogue: 'Dialogue', map: 'Map of the dialogue', script: 'Script', endings: 'Endings', chooses: 'chooses', then: 'then', feedback: 'Trainer\'s note', final: 'Final decision',
    legend: 'Each box is a moment of the dialogue; letters are the learner\'s options. Dashed arrows go back (a retry, a loop).', otherwise: 'otherwise',
    qualities: { good: 'good', ok: 'ok', bad: 'bad' },
    settings: (data) => [
      { practice: 'Practice', assessment: 'Assessment', exploration: 'Exploration' }[data.mode],
      { none: 'not scored', quality: 'scored on the quality of the choices', points: 'scored in points', ending: 'scored by its ending' }[data.scoring],
      { none: 'no going back', retry: 'the learner may retry a choice', 'after-end': 'the learner may retry, then go back to any choice after the end', anytime: 'the learner may go back to any choice at any time' }[data.revisit]
    ]
  }
};

export interface DialogueDocumentOptions {
  id: string;
  screen: string;
  course?: string;
  screenTitle?: string;
  language?: string;
  // @font-face rules (data URIs), so the page prints the same everywhere.
  fontFaces?: string;
}

// What a map has on an A4 page in portrait, its margins and the map's frame taken off (CSS px).
const PAGE = { width: 660, height: 900 };

export function dialogueDocumentHtml(data: DialogueData, options: DialogueDocumentOptions): string {
  const language = options.language ?? 'en';
  const words = /^fr\b/i.test(language) ? WORDS.fr : WORDS.en;
  const scriptLanguage = scriptWords(language);
  const script = dialogueScript(data, { id: options.id, screen: options.screen, words: scriptLanguage });
  // The map that reads best on a portrait page: its layers going right while they fit across it, else
  // going down (a long dialogue), never drawn larger than itself.
  const fit = (candidate: ReturnType<typeof dialogueMap>) => Math.min(1, PAGE.width / candidate.width, PAGE.height / candidate.height);
  const across = dialogueMap(data, { words: scriptLanguage });
  const down = dialogueMap(data, { words: scriptLanguage, direction: 'down' });
  const map = fit(down) > fit(across) * 1.15 ? down : across;
  const svg = dialogueMapSvg(map, { title: `${words.map} · ${data.title}`, qualities: words.qualities });
  const head = [
    '<!doctype html>',
    `<html lang="${escapeHtml(language)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:; img-src data:">',
    '<meta name="generator" content="Elabora">',
    `<title>${escapeHtml(`${data.title} · ${words.dialogue}`)}</title>`,
    `<style>${options.fontFaces ?? ''}\n${CSS}</style>`,
    '</head>'
  ].join('\n');
  const kicker = [options.course, options.screenTitle].filter(Boolean).map((part) => escapeHtml(part!)).join(' · ');
  const body = [
    '<body>',
    '<header class="doc-head">',
    kicker ? `<p class="kicker">${kicker}</p>` : '',
    `<h1>${escapeHtml(data.title)}</h1>`,
    `<p class="meta">${words.settings(data).map(escapeHtml).join(' · ')}</p>`,
    '</header>',
    '<section class="map">',
    `<h2>${escapeHtml(words.map)}</h2>`,
    `<div class="map-frame">${svg}</div>`,
    `<p class="legend">${escapeHtml(words.legend)}</p>`,
    '</section>',
    `<section class="script"><h2>${escapeHtml(words.script)}</h2>`,
    scriptHtml(script, words),
    '</section>',
    script.endings.length ? `<section class="endings"><h2>${escapeHtml(words.endings)}</h2>${script.endings.map((ending) => `<div class="ending"><p class="ending-title"><strong>${escapeHtml(ending.title ?? ending.id)}</strong>${ending.score !== null ? ` · ${ending.score}` : ''}${ending.condition ? ` <span class="cond">${escapeHtml(scriptLanguage.when(ending.condition))}</span>` : ''}</p>${ending.text ? `<div class="text">${renderMarkdown(ending.text)}</div>` : ''}</div>`).join('\n')}</section>` : '',
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');
  return `${head}\n${body}\n`;
}

function lineHtml(line: ScriptLine): string {
  const cond = line.condition ? ` <span class="cond">[${escapeHtml(line.condition)}]</span>` : '';
  if (line.role === 'narration') return `<p class="line narration">${cond}${escapeHtml(line.text)}</p>`;
  return `<div class="line ${line.role}"><p class="who">${escapeHtml(line.who ?? '')}${line.direction ? ` <span class="direction">(${escapeHtml(line.direction)})</span>` : ''}${cond}</p><p class="say">${escapeHtml(line.text)}</p></div>`;
}

function scriptHtml(script: DialogueScript, words: DocumentWords): string {
  return script.nodes.map((node) => {
    const parts: string[] = [`<article class="node" id="n-${escapeHtml(node.id)}">`, `<h3><span class="n">${node.number}</span> ${escapeHtml(node.title ?? node.id)}${node.final ? ` <span class="final">${escapeHtml(words.final)}</span>` : ''}</h3>`];
    for (const line of node.lines) parts.push(lineHtml(line));
    if (node.options.length) {
      parts.push(`<p class="chooses"><span class="who">${escapeHtml(script.learner)}</span> ${escapeHtml(words.chooses)}${node.prompt ? ` · ${escapeHtml(node.prompt)}` : ''}</p>`, '<div class="options">');
      for (const option of node.options) {
        const quality = option.quality ? `<span class="quality q-${option.quality}">${escapeHtml(words.qualities[option.quality] ?? option.quality)}</span>` : '';
        const marks = [option.points ? `${option.points > 0 ? '+' : ''}${option.points}` : '', ...option.marks].filter(Boolean).map(escapeHtml).join(', ');
        parts.push('<div class="option">',
          `<p class="opt"><span class="letter">${option.letter}</span> « ${escapeHtml(option.text)} »${quality}${marks ? ` <span class="marks">${marks}</span>` : ''}${option.condition ? ` <span class="cond">[${escapeHtml(option.condition)}]</span>` : ''}</p>`,
          ...option.reply.map(lineHtml),
          option.feedback ? `<div class="feedback"><span class="label">${escapeHtml(words.feedback)}</span>${renderMarkdown(option.feedback)}</div>` : '',
          `<p class="then">${escapeHtml(words.then)} ${escapeHtml(option.then)}</p>`,
          '</div>');
      }
      parts.push('</div>');
    } else parts.push(`<p class="then">${escapeHtml(words.then)} ${escapeHtml(node.then)}</p>`);
    parts.push('</article>');
    return parts.filter(Boolean).join('\n');
  }).join('\n');
}

const CSS = `
@page { size: A4; margin: 16mm 14mm 18mm; }
:root { --ink: #1d1d1f; --muted: #5f6368; --line: #e3e3e6; --soft: #f5f5f7; --good: #1f7a4d; --ok: #8a5a00; --bad: #b3261e; --accent: #3557d4; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 860px; padding: 32px 24px 48px; font: 14px/1.55 "${DIALOGUE_DOCUMENT_FONT}", system-ui, sans-serif; color: var(--ink); background: #fff; }
.kicker { margin: 0 0 4px; color: var(--muted); font-size: 12px; letter-spacing: .02em; }
h1 { margin: 0 0 6px; font-size: 26px; line-height: 1.2; letter-spacing: -.01em; }
h2 { margin: 36px 0 12px; font-size: 18px; }
h3 { margin: 26px 0 10px; font-size: 15px; break-after: avoid; }
h3 .n { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 4px; }
.meta { margin: 0; color: var(--muted); }
.map-frame { border: 1px solid var(--line); border-radius: 12px; padding: 8px; background: var(--soft); overflow: auto; break-inside: avoid; }
.map-frame svg { display: block; width: auto; max-width: 100%; height: auto; margin: 0 auto; }
.legend { color: var(--muted); font-size: 12px; }
.dm rect { fill: #fff; stroke: var(--line); }
.dm-ending rect { fill: var(--soft); }
.dm-final rect { stroke: var(--ink); stroke-width: 1.5; }
.dm text { font: 12px "${DIALOGUE_DOCUMENT_FONT}", system-ui, sans-serif; fill: var(--ink); }
.dm .dm-title { font-weight: 600; }
.dm .dm-number, .dm .dm-letter { fill: var(--muted); font-weight: 600; }
.dm .dm-option { fill: #3c4043; }
.dm .dm-quality { fill: var(--muted); font-size: 10px; }
.dm .dm-good .dm-quality { fill: var(--good); }
.dm .dm-ok .dm-quality { fill: var(--ok); }
.dm .dm-bad .dm-quality { fill: var(--bad); }
.dm-edge { fill: none; stroke: #9aa0a6; stroke-width: 1.25; }
.dm-back { stroke-dasharray: 4 4; }
.dm-arrowhead { fill: #9aa0a6; }
.dm .dm-label { fill: var(--muted); font-size: 11px; }
.dm .dm-way { font-weight: 600; font-size: 10px; }
.node { break-inside: avoid-page; }
.line { margin: 0 0 10px 30px; }
.who { margin: 0; font-size: 12px; font-weight: 600; color: #3c4043; }
.direction, .cond { font-weight: 400; color: var(--muted); }
.say { margin: 1px 0 0; }
.narration { margin: 0 0 10px 30px; font-style: italic; color: #3c4043; }
.learner .who { color: var(--accent); }
.chooses { margin: 14px 0 6px 30px; }
.options { margin-left: 30px; }
.option { padding: 8px 12px; margin: 0 0 6px -12px; border-radius: 10px; background: var(--soft); break-inside: avoid; }
.opt { margin: 0 0 6px; }
.letter { font-weight: 700; color: var(--muted); margin-right: 4px; }
.quality { margin-left: 8px; font-size: 12px; font-weight: 600; }
.q-good { color: var(--good); } .q-ok { color: var(--ok); } .q-bad { color: var(--bad); }
.quality::before { content: "● "; }
.marks { color: var(--muted); font-size: 12px; margin-left: 6px; }
.option .line { margin-left: 18px; }
.feedback { margin: 4px 0 4px 18px; padding-left: 10px; border-left: 3px solid var(--line); color: #3c4043; }
.feedback .label { display: block; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.feedback p { margin: 2px 0; }
.then { margin: 4px 0 0 18px; color: var(--muted); font-size: 13px; }
.node > .then { margin-left: 30px; }
.final { font-size: 11px; font-weight: 600; color: var(--bad); margin-left: 6px; }
.ending { margin: 0 0 12px; }
.ending-title { margin: 0; }
.ending .text p { margin: 2px 0; }
`;
