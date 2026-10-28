// What a dialogue shows in the page (D61): the rows of its thread, its options, its turn's controls,
// its end and its debrief. Markup only; the behaviour (dialogue/view.ts) decides when.
//
// Three kinds of text never look alike: a character's bubble (on the left in messaging, beside its
// round portrait; the learner's on the right), a narration (centred, without a bubble), and the
// trainer's note (outside the conversation: its quality in an icon and a word, never colour alone). A
// bubble is inserted whole and never changed afterwards: its words are read once, from a copy for
// screen readers; what the voice brings (the ink of each word) is a layer hidden from them.

import { element, uniqueId } from '../dom.ts';
import { icon } from '../icons.ts';
import type { IconName } from '../icons.ts';
import { labelLanguages, labelsFor } from '../labels.ts';
import type { Labels } from '../labels.ts';
import { textWords } from '../character/voice.ts';
import type { DialogueData, DialogueOptionData, DialogueQuality, DialogueSpeakerData } from './types.ts';
import type { OfferedOption } from './walk.ts';
import type { ScoredDecision } from './run.ts';

export type Side = 'left' | 'right' | 'center';
export type RowRole = 'character' | 'learner' | 'narration' | 'note' | 'first-choice' | 'retry' | 'end' | 'debrief';

export interface ThreadContext {
  data: DialogueData;
  labels: Labels;
  language: string;
  format(label: string, values: Readonly<Record<string, unknown>>): string;
}

// A theme colour token (color.accent) as the CSS variable the player sets (--t-color-accent).
export const tokenVar = (token: string | undefined): string | null => (token && /^[a-zA-Z][\w.-]*$/.test(token) ? `var(--t-${token.replace(/\./g, '-').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)})` : null);

// « You », « Vous », « Sie »…: the learner's mention in each of the player's languages.
const SECOND_PERSON = new Set(labelLanguages().map((language) => labelsFor(language).dialogueYou.toLocaleLowerCase()));

// The name shown above a bubble, and read before its words. A learner whose own name already says
// « you » (a speaker named « You », « Vous ») is named once, not « You (you) ».
export function speakerName(context: ThreadContext, speaker: string | undefined, learner: boolean): string {
  const { data, labels, format } = context;
  if (learner) {
    const own = data.learner ? data.speakers[data.learner]?.name?.trim() : undefined;
    if (!own) return labels.dialogueYou;
    const plain = own.toLocaleLowerCase();
    return SECOND_PERSON.has(plain) || plain === labels.dialogueYou.toLocaleLowerCase() ? own : format(labels.dialogueLearnerName, { name: own });
  }
  return (speaker && data.speakers[speaker]?.name) || speaker || '';
}

// The visible words of a line: one span per word as the voice times them (character/voice.ts counts
// them as the core does), each with the punctuation and space that follow it (so that, in appear,
// nothing shows before its word); what comes before the first word goes with it. appear: each letter
// in a span of its own.
export function inkOf(text: string, language: string, letters: boolean): { ink: HTMLElement; words: HTMLElement[] } {
  const ink = element('span', { class: 't-dialogue-ink', 'aria-hidden': 'true' });
  const found = textWords(text, language);
  const words: HTMLElement[] = [];
  if (!found.length) { ink.textContent = text; return { ink, words }; }
  found.forEach((word, index) => {
    const from = index === 0 ? 0 : word.start;
    const to = index + 1 < found.length ? found[index + 1].start : text.length;
    const piece = text.slice(from, to);
    const span = element('span', { class: 't-w' });
    if (letters) for (const letter of [...piece]) span.append(element('span', { class: 't-l', text: letter }));
    else span.textContent = piece;
    ink.append(span);
    words.push(span);
  });
  return { ink, words };
}

export interface BubbleRow {
  row: HTMLElement;
  bubble: HTMLElement;
  text: HTMLElement;
  words: HTMLElement[];
  avatar: HTMLElement | null;
  tools: HTMLElement;
  listen: HTMLButtonElement | null;
  resume: HTMLButtonElement | null;
}

export interface BubbleOptions {
  role: 'character' | 'learner' | 'narration';
  side: Side;
  speaker?: string;
  text: string;
  // The first bubble of a series: its name above it, its portrait beside it.
  first: boolean;
  // A line said by a voice (its audio): a play button for when the browser refuses to play it.
  voiced: boolean;
  // A learner's choice the learner may go back to (« Reprendre d'ici »).
  resumable: boolean;
  letters: boolean;
  line?: string;
}

export function bubbleRow(context: ThreadContext, options: BubbleOptions): BubbleRow {
  const { labels } = context;
  const learner = options.role === 'learner';
  const name = options.role === 'narration' ? '' : speakerName(context, options.speaker, learner);
  const speaker: DialogueSpeakerData | undefined = options.speaker ? context.data.speakers[options.speaker] : undefined;
  const { ink, words } = inkOf(options.text, context.language, options.letters);
  const spoken = element('span', { class: 't-sr-only', text: name ? `${name}${labels.colon}${options.text}` : options.text });
  const color = tokenVar(speaker?.color);
  const text = element(options.role === 'narration' ? 'p' : 'p', { class: options.role === 'narration' ? 't-dialogue-narration' : 't-dialogue-text' }, spoken, ink);
  const bubble = options.role === 'narration'
    ? element('div', { class: 't-dialogue-said' }, text)
    : element('div', { class: 't-dialogue-bubble', style: color ? `--t-dl-speaker: ${color}` : undefined },
      name ? element('span', { class: 't-dialogue-name', 'aria-hidden': 'true', text: name }) : null, text);
  const listen = options.voiced ? element('button', { type: 'button', class: 't-dialogue-tool t-dialogue-listen', hidden: true, 'aria-label': labels.dialogueListen, title: labels.dialogueListen }, icon('play')) : null;
  const resume = options.resumable ? element('button', { type: 'button', class: 't-dialogue-tool t-dialogue-resume', hidden: true, 'aria-label': labels.dialogueResumeHere, title: labels.dialogueResumeHere }, icon('undo')) : null;
  // Tools are not part of what the thread says: they never speak when they appear. They sit beside
  // the bubble, out of the flow (dialogue.css): showing them moves nothing.
  const tools = element('span', { class: 't-dialogue-tools', 'aria-live': 'off' }, listen, resume);
  bubble.append(tools);
  const avatar = options.role === 'narration' ? null : element('span', { class: 't-dialogue-avatar', 'aria-hidden': 'true', 'data-speaker': options.speaker });
  const row = element('div', {
    class: 't-dialogue-row', 'data-role': options.role, 'data-side': options.side, 'data-speaker': options.speaker, 'data-line': options.line,
    'data-first': options.first || undefined, 'data-tools': options.voiced || options.resumable || undefined, style: color ? `--t-dl-speaker: ${color}` : undefined
  }, avatar, bubble);
  return { row, bubble, text, words, avatar, tools, listen, resume };
}

// Bubbles as wide as their lines: text-wrap: balance evens them out but leaves the box at the width
// they had before (room on the right of every line). Each text takes the width of its widest line,
// measured once inserted (and again when the thread's width or its text size changes); a text not
// shown (a scene's page turned) keeps the width it had. All widths are cleared, then all lines read,
// then all widths set: one layout for the lot.
export function fitLines(...texts: HTMLElement[]): void {
  const shown = texts.filter((text) => text.isConnected && text.classList.contains('t-dialogue-text') && text.getClientRects().length > 0);
  for (const text of shown) text.style.removeProperty('width');
  const widths = shown.map((text) => {
    const rects = [...(text.querySelector('.t-dialogue-ink') ?? text).getClientRects()];
    // One line is already as wide as it is.
    if (rects.length < 2) return null;
    const zoom = (text as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
    return Math.ceil((Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left))) / zoom) + 1;
  });
  shown.forEach((text, index) => { const width = widths[index]; if (width !== null) text.style.width = `${width}px`; });
}

// The bubble to come, its final size kept, with « … » in it (messaging, a line without a voice): it
// waits there, hidden from screen readers, then the bubble replaces it.
export function typingRow(context: ThreadContext, options: BubbleOptions): HTMLElement {
  const { row, bubble, tools } = bubbleRow(context, { ...options, voiced: false, resumable: false });
  tools.remove();
  row.classList.add('t-dialogue-typing');
  row.setAttribute('aria-hidden', 'true');
  row.removeAttribute('data-line');
  bubble.append(element('span', { class: 't-dialogue-dots' }, element('i'), element('i'), element('i')));
  return row;
}

// The words said so far (ink): each word whose start has passed. appear: the words not said yet are
// invisible, and the letters of the word being said come evenly between its start and its end.
export function paintWords(words: readonly HTMLElement[], times: readonly [string, number, number][], t: number, mode: 'ink' | 'appear' | 'instant', state: { said: number }): void {
  if (mode === 'instant' || !times.length) {
    if (state.said < words.length) { for (let i = state.said; i < words.length; i++) words[i].classList.add('is-said'); state.said = words.length; }
    return;
  }
  let said = 0;
  while (said < times.length && times[said][1] <= t) said++;
  // Words the voice never times (a text longer than its words) come with the last one.
  if (said >= times.length) said = words.length;
  if (said !== state.said) {
    for (let i = 0; i < words.length; i++) words[i].classList.toggle('is-said', i < said);
    state.said = said;
  }
  if (mode !== 'appear') return;
  const current = said - 1;
  const word = words[current];
  const time = times[current];
  if (!word || !time) return;
  const letters = word.children;
  const share = time[2] > time[1] ? Math.min(1, Math.max(0, (t - time[1]) / (time[2] - time[1]))) : 1;
  const shown = Math.ceil(share * letters.length);
  for (let i = 0; i < letters.length; i++) letters[i].classList.toggle('is-out', i >= shown);
}
export function showAllWords(words: readonly HTMLElement[], state: { said: number }): void {
  for (const word of words) { word.classList.add('is-said'); for (const letter of word.children) letter.classList.remove('is-out'); }
  state.said = words.length;
}

const QUALITY_ICON: Readonly<Record<DialogueQuality, IconName>> = { good: 'check', ok: 'half', bad: 'close' };
export function qualityLabel(labels: Labels, quality: DialogueQuality): string {
  return quality === 'good' ? labels.dialogueGood : quality === 'ok' ? labels.dialogueOk : labels.dialogueBad;
}
// The quality of a choice: its icon and its word (never colour alone).
export const qualityMark = (labels: Labels, quality: DialogueQuality): HTMLElement =>
  element('span', { class: 't-dialogue-quality', 'data-quality': quality }, icon(QUALITY_ICON[quality]), element('span', { text: qualityLabel(labels, quality) }));

// The trainer's note: the option's feedback, after its consequence. Its quality is all it shows of
// where it comes from; screen readers hear its name first.
export function noteRow(context: ThreadContext, option: DialogueOptionData, showQuality: boolean): HTMLElement {
  const { labels } = context;
  const quality = showQuality && option.quality ? option.quality : null;
  return element('div', { class: 't-dialogue-row', 'data-role': 'note', 'data-quality': quality ?? undefined },
    element('div', { class: 't-dialogue-note', role: 'note' },
      element('span', { class: 't-sr-only', text: `${labels.dialogueNote}${labels.colon}` }),
      quality ? element('p', { class: 't-dialogue-note-head' }, qualityMark(labels, quality)) : null,
      element('div', { class: 't-text t-dialogue-note-body', html: option.feedbackHtml ?? '' }, option.feedbackHtml ? null : option.feedback ?? '')));
}

// A first choice the learner went back on before the first end: kept in one grey line.
export function firstChoiceRow(context: ThreadContext, options: readonly DialogueOptionData[]): HTMLElement {
  const { labels } = context;
  return element('div', { class: 't-dialogue-row', 'data-role': 'first-choice' },
    options.map((option) => element('p', { class: 't-dialogue-first' }, icon('replay'),
      element('span', { class: 't-dialogue-first-label', text: `${labels.dialogueFirstChoice}${labels.colon}` }),
      element('span', { class: 't-dialogue-first-text', text: option.text ?? option.label ?? option.id }))));
}

export function retryRow(context: ThreadContext, onClick: () => void): HTMLElement {
  return element('div', { class: 't-dialogue-row', 'data-role': 'retry' },
    element('button', { type: 'button', class: 't-dialogue-link', onclick: onClick }, icon('undo'), element('span', { text: context.labels.dialogueChooseAgain })));
}

// Where the thread goes on after the learner went back: « Vous reprenez ici », or « Nouvel essai » at
// the top of a dialogue started over.
export function markerRow(context: ThreadContext, restarted: boolean): HTMLElement {
  const { labels } = context;
  return element('div', { class: 't-dialogue-row', 'data-role': 'marker' },
    element('p', { class: 't-dialogue-marker' }, icon(restarted ? 'replay' : 'undo'), element('span', { text: restarted ? labels.dialogueNewAttempt : labels.dialogueResumedHere })));
}

export function endRow(context: ThreadContext, title: string | null, html: string | null): HTMLElement {
  return element('div', { class: 't-dialogue-row', 'data-role': 'end' },
    element('p', { class: 't-dialogue-end' }, element('span', { text: title ?? context.labels.dialogueEnd })),
    html ? element('div', { class: 't-text t-dialogue-end-text', html }) : null);
}

// The options of the decision waiting: the prompt, « Choix définitif » before a final one, then a
// button per option shown (greyed ones aria-disabled, in their place); an option explored before
// says so.
export function optionsContent(context: ThreadContext, prompt: string | undefined, offer: readonly OfferedOption[], { final, explored, previous = () => false, onChoose }: { final: boolean; explored(option: string): boolean; previous?(option: string): boolean; onChoose(option: string): void }): { nodes: HTMLElement[]; promptId: string | null } {
  const { labels } = context;
  const promptId = prompt ? uniqueId('t-dialogue-prompt') : null;
  const buttons = offer.map((offered) => {
    const option = offered.option;
    const greyed = !offered.enabled;
    const note = greyed && option.unavailableText ? option.unavailableText : null;
    return element('button', {
      type: 'button', class: 't-dialogue-choice', 'data-option': option.id, 'aria-disabled': greyed ? 'true' : undefined, 'data-reason': offered.reason,
      onclick: () => { if (!greyed) onChoose(option.id); }
    }, element('span', { class: 't-dialogue-choice-text', text: option.label ?? option.text ?? option.id }),
    previous(option.id) ? element('span', { class: 't-dialogue-explored t-dialogue-previous' }, icon('undo'), element('span', { text: labels.dialoguePreviousChoice }))
      : explored(option.id) ? element('span', { class: 't-dialogue-explored' }, icon('check'), element('span', { text: labels.dialogueExplored })) : null,
    note ? element('span', { class: 't-dialogue-unavailable', text: note }) : null);
  });
  return {
    promptId,
    nodes: [
      ...(final ? [element('p', { class: 't-dialogue-final' }, icon('lock'), element('span', { text: labels.dialogueFinal }))] : []),
      ...(prompt ? [element('p', { class: 't-dialogue-prompt', id: promptId!, text: prompt })] : []),
      element('div', { class: 't-dialogue-choices' }, buttons)
    ]
  };
}

// While a turn plays: pause, « couper les voix » when the dialogue has voices, and « Suite » (the next
// line, the one being said ending there).
export interface TurnControls {
  root: HTMLElement;
  pause: HTMLButtonElement;
  mute: HTMLButtonElement | null;
  next: HTMLButtonElement;
}
export function turnControls(context: ThreadContext, voiced: boolean, handlers: { pause(): void; mute(): void; next(): void }): TurnControls {
  const { labels } = context;
  const pause = element('button', { type: 'button', class: 't-dialogue-tool t-dialogue-pause', 'aria-label': labels.dialoguePause, title: labels.dialoguePause, onclick: handlers.pause }, icon('pause'));
  const mute = voiced ? element('button', { type: 'button', class: 't-dialogue-tool t-dialogue-mute', 'aria-label': labels.dialogueMute, title: labels.dialogueMute, 'aria-pressed': 'false', onclick: handlers.mute }, icon('volume')) : null;
  const next = element('button', { type: 'button', class: 't-dialogue-next', onclick: handlers.next }, element('span', { text: labels.dialogueNext }), icon('chevronRight'));
  return { root: element('div', { class: 't-dialogue-turn' }, pause, mute, element('span', { class: 't-dialogue-turn-space' }), next), pause, mute, next };
}
export function syncTurnControls(context: ThreadContext, controls: TurnControls, { paused, muted, waiting }: { paused: boolean; muted: boolean; waiting: boolean }): void {
  const { labels } = context;
  const pauseLabel = paused ? labels.dialoguePlay : labels.dialoguePause;
  if (controls.pause.getAttribute('aria-label') !== pauseLabel) {
    controls.pause.setAttribute('aria-label', pauseLabel);
    controls.pause.title = pauseLabel;
    controls.pause.replaceChildren(icon(paused ? 'play' : 'pause'));
  }
  if (controls.mute) {
    const label = muted ? labels.dialogueUnmute : labels.dialogueMute;
    if (controls.mute.getAttribute('aria-label') !== label) {
      controls.mute.setAttribute('aria-label', label);
      controls.mute.title = label;
      controls.mute.setAttribute('aria-pressed', String(muted));
      controls.mute.replaceChildren(icon(muted ? 'muted' : 'volume'));
    }
  }
  // « Suite » is quiet while the dialogue goes on by itself, and plain when it waits for the learner.
  controls.next.classList.toggle('is-waiting', waiting);
}

// The end: the endings found (when there are several), back to a choice, start over, the debrief.
export function endControls(context: ThreadContext, { found, total, back, restart, debrief }: { found: number; total: number; back: (() => void) | null; restart: (() => void) | null; debrief: (() => void) | null }): HTMLElement {
  const { labels, format } = context;
  return element('div', { class: 't-dialogue-endbar' },
    total > 1 ? element('p', { class: 't-dialogue-count', text: format(labels.dialogueEndings, { found, total }) }) : null,
    element('div', { class: 't-dialogue-endbar-actions' },
      debrief ? element('button', { type: 'button', class: 't-dialogue-action t-dialogue-debrief-toggle', 'aria-haspopup': 'dialog', onclick: debrief }, element('span', { text: labels.dialogueShowDebrief })) : null,
      back ? element('button', { type: 'button', class: 't-dialogue-action', onclick: back }, icon('history'), element('span', { text: labels.dialogueBackToChoice })) : null,
      restart ? element('button', { type: 'button', class: 't-dialogue-action', onclick: restart }, icon('replay'), element('span', { text: labels.dialogueRestart })) : null));
}

export interface DebriefDecision {
  prompt?: string;
  option: DialogueOptionData;
  kept: DialogueOptionData | null;
  quality?: DialogueQuality;
  // « Changer ce choix »: back to this decision, when the dialogue allows it.
  change?: () => void;
}

// The debrief: the ending reached (its title, its text), the decisions with their quality (icon and
// word), their note and « Changer ce choix », the score when the dialogue is scored, the other
// outcomes, then « Recommencer ».
export function debriefCard(context: ThreadContext, { ending, decisions, score, others, restart = null }: { ending: { title?: string; textHtml?: string; text?: string } | null; decisions: readonly DebriefDecision[]; score: number | null; others: readonly { title: string; found: boolean }[]; restart?: (() => void) | null }): HTMLElement {
  const { labels } = context;
  const titleId = uniqueId('t-dialogue-debrief');
  return element('section', { class: 't-dialogue-debrief-card', 'aria-labelledby': titleId },
    element('p', { class: 't-dialogue-debrief-title', id: titleId }, element('span', { class: 't-sr-only', text: `${labels.dialogueDebrief}${labels.colon}` }), ending?.title ?? labels.dialogueEnd),
    ending?.textHtml ? element('div', { class: 't-text t-dialogue-debrief-text', html: ending.textHtml }) : ending?.text ? element('p', { class: 't-dialogue-debrief-text', text: ending.text }) : null,
    score !== null ? element('p', { class: 't-dialogue-score' }, `${labels.yourScore}${labels.colon}`, element('strong', { text: `${Math.round(score * 100)} %` })) : null,
    decisions.length ? element('p', { class: 't-dialogue-debrief-head', text: labels.dialogueDecisions }) : null,
    decisions.length ? element('ol', { class: 't-dialogue-decisions' }, decisions.map((decision) => element('li', { class: 't-dialogue-decision', 'data-quality': decision.quality },
      decision.prompt ? element('p', { class: 't-dialogue-decision-prompt', text: decision.prompt }) : null,
      element('p', { class: 't-dialogue-decision-choice' }, decision.quality ? qualityMark(labels, decision.quality) : null, element('span', { class: 't-dialogue-decision-text', text: decision.option.text ?? decision.option.label ?? decision.option.id })),
      decision.kept ? element('p', { class: 't-dialogue-decision-kept' }, `${labels.dialogueThen}${labels.colon}`, element('span', { text: decision.kept.text ?? decision.kept.label ?? decision.kept.id })) : null,
      decision.option.feedbackHtml ? element('div', { class: 't-text t-dialogue-decision-note', html: decision.option.feedbackHtml }) : null,
      decision.change ? element('button', { type: 'button', class: 't-dialogue-link t-dialogue-change', onclick: decision.change }, icon('undo'), element('span', { text: labels.dialogueChangeChoice })) : null))) : null,
    others.length ? element('p', { class: 't-dialogue-debrief-head', text: labels.dialogueOtherEndings }) : null,
    others.length ? element('ul', { class: 't-dialogue-others' }, others.map((other) => element('li', { 'data-found': other.found ? '' : undefined },
      element('span', { class: 't-dialogue-other-title', text: other.title }), element('span', { class: 't-dialogue-other-state', text: other.found ? labels.dialogueFound : labels.dialogueNotFound })))) : null,
    restart ? element('div', { class: 't-dialogue-debrief-foot' }, element('button', { type: 'button', class: 't-dialogue-action t-dialogue-restart', onclick: restart }, icon('replay'), element('span', { text: labels.dialogueRestart }))) : null);
}

// Closes a panel over the dialogue (the History, the debrief).
export const closeButton = (context: ThreadContext, onClick: () => void): HTMLButtonElement =>
  element('button', { type: 'button', class: 't-dialogue-close', 'aria-label': context.labels.close, title: context.labels.close, onclick: onClick }, icon('close'));

export type { ScoredDecision };
