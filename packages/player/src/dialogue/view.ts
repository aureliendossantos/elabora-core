// The dialogue behaviour (D61, D14): a dialogue block in the page. The template gives the hooks
// (data-t-log, data-t-options; optionally data-t-group, data-t-stage, data-t-debrief, data-t-start,
// docs/components.md); the player owns the rest: the run and its saved progress, the score and SCORM,
// the thread and its focus, the voices, the characters, the events.
//
// The walk is pure (walk.ts, run.ts): every move of the learner (a choice, « Choisir autrement »,
// « Reprendre d'ici », « Recommencer ») or of the screen (goto-dialogue) gives a new run, whose beats
// extend those of the run before up to where they differ; the thread keeps what they share, lets
// the rest go in a fade, and presents the new beats one after the other: a line is inserted whole,
// said by its voice (its audio, its words lit as they are said, its character's mouth and
// gestures), then the next comes after a pause, or at a click (pace click); a decision shows its
// options in the reserved room under the thread. Back on the screen (or in the editor's canvas), the
// path is replayed and shown at once, without voices, events or animation.
//
// Not part of the pure walk: the core never imports this file.

import { element, uniqueId } from '../dom.ts';
import { icon } from '../icons.ts';
import type { CourseState, TriggerInfo } from '../course-state.ts';
import type { DialogueBlock, TriggerType } from '../course-data.ts';
import type { Labels } from '../labels.ts';
import type { Interaction } from '../scorm12.ts';
import { mountCharacter, textVoice, voiceAt } from '../character/index.ts';
import type { CharacterView } from '../character/index.ts';
import { nodeOf, optionOf, presentationOf, expressionsOf, replay as replayWalk } from './walk.ts';
import { explorePaths } from './paths.ts';
import type { Beat, DialogueWalk } from './walk.ts';
import { choose, canRetryLast, retryLast, canRevisit, revisit, canRestart, restart, jump, scoredDone, scoredResult, openDialogue } from './run.ts';
import type { DialogueRun } from './run.ts';
import type { DialogueAction, DialogueData, DialogueLineData, DialogueOptionData, LineVoiceData } from './types.ts';
import type { DialoguePresentation } from './walk.ts';
import { createClock, createLinePlayback, replayVoice, cueTime } from './playback.ts';
import type { DialogueClock, LinePlayback } from './playback.ts';
import {
  bubbleRow, typingRow, paintWords, showAllWords, noteRow, firstChoiceRow, retryRow, endRow, optionsContent, turnControls, syncTurnControls, endControls, debriefCard, speakerName
} from './thread.ts';
import type { BubbleRow, Side, ThreadContext, TurnControls, DebriefDecision } from './thread.ts';

// What the screen gives the dialogues of its blocks (screen-view.ts).
export interface DialogueHost {
  // Tests: the dialogues' clocks move only when told (__elabora.dialogues.advance).
  virtual: boolean;
  // The learner's speed, volume and « couper les voix », shared with the narration's bar.
  prefs(): { rate: number; volume: number; muted: boolean };
  // Two voices never overlap: while a dialogue speaks, the screen's narration is held.
  hold(reason: string): void;
  release(reason: string): void;
  // Presentation actions of options and cues (show and hide blocks and layers, media, object props,
  // a step), and what a replayed path leaves on the screen (no layer opens, no media plays).
  act(actions: readonly DialogueAction[]): void;
  present(presentation: DialoguePresentation): void;
  slides(): boolean;
  // « Texte : tout de suite » (« Affichage », D58).
  instantText(): boolean;
}

export interface DialoguesContext {
  courseState: CourseState;
  labels: Labels;
  language: string;
  formatLabel(label: string, values: Readonly<Record<string, unknown>>): string;
  announce(message: string): void;
  recordInteraction(interaction: Interaction): void;
  trigger(type: TriggerType, info: TriggerInfo): void;
  // The editor's canvas: the path shown at once, playable, without voices.
  still?: boolean;
  host?: DialogueHost;
}

// The state a test or the editor reads.
export interface DialogueViewState {
  phase: 'idle' | 'playing' | 'choosing' | 'ended';
  node: string;
  status: DialogueWalk['status'];
  presented: number;
  beats: number;
  line: string | null;
  time: number | null;
  paused: boolean;
  path: string[];
  scored: string[] | null;
  explored: string[];
  endings: string[];
  ending: string | null;
}

type Phase = DialogueViewState['phase'];

interface LineState {
  index: number;
  chars: number;
  line: DialogueLineData | null;
  speaker: string | undefined;
  row: BubbleRow;
  voice: LineVoiceData;
  playback: LinePlayback;
  paint: { said: number };
  whole: boolean;
  cues: { time: number; gesture?: string; expression?: string; do?: DialogueAction[]; fired: boolean }[];
  avatar: CharacterView | null;
}

// The bubble to come, waiting in the thread with « … », and the beat it announces.
type Typing = { index: number; node: HTMLElement } | null;

type Step =
  | { kind: 'line'; state: LineState }
  | { kind: 'wait'; until: number; typing: Typing }
  | { kind: 'click'; typing: Typing }
  | { kind: 'turn'; until: number; then: () => Step | null };

const clamp = (low: number, value: number, high: number) => Math.min(high, Math.max(low, value));
const PHONE = '(max-width: 760px)';
const prefersLessMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const phone = () => typeof matchMedia === 'function' && matchMedia(PHONE).matches;
// Boxes in the CSS px of the page under the learner's text size (a CSS zoom on #t-main).
const cssPx = (node: Element, px: number) => px / ((node as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1);

export type Dialogues = ReturnType<typeof createDialogues>;

export function createDialogues(context: DialoguesContext) {
  const { courseState, labels, language, formatLabel, trigger, recordInteraction } = context;
  const still = !!context.still;
  const controllers = new Map<string, Controller>();
  const host = (): DialogueHost => context.host ?? NO_HOST;
  let frame = 0;

  function loop() {
    cancelAnimationFrame(frame);
    if (host().virtual || still) return;
    if (![...controllers.values()].some((controller) => controller.active())) return;
    frame = requestAnimationFrame(() => { for (const controller of [...controllers.values()]) controller.tick(); loop(); });
  }

  interface Controller {
    block: DialogueBlock;
    wrap: HTMLElement;
    clock: DialogueClock;
    active(): boolean;
    tick(): void;
    begin(): void;
    checkBegin(): void;
    afterShow(): void;
    goto(node: string): void;
    restartRun(): void;
    pause(): void;
    showPath(choices: readonly string[], node?: string): void;
    showLine(line: string): boolean;
    state(): DialogueViewState;
    transcript(): { title: string; lines: { speaker?: string; text: string }[] } | null;
    next(): void;
    choose(option: string): void;
    dispose(): void;
  }

  function bind(wrap: HTMLElement, block: DialogueBlock): void {
    controllers.get(block.id)?.dispose();
    const controller = createController(wrap, block);
    controllers.set(block.id, controller);
  }

  function createController(wrap: HTMLElement, block: DialogueBlock): Controller {
    const data: DialogueData = block.props;
    const find = (hook: string) => wrap.querySelector<HTMLElement>(`[data-t-${hook}]`);
    const root = find('group') ?? (wrap.firstElementChild as HTMLElement | null) ?? wrap;
    const log = find('log')!;
    const room = find('options')!;
    const thread: ThreadContext = { data, labels, language, format: formatLabel };
    const learnerSpeaker = data.learner ?? undefined;
    const voiced = [...data.nodes].some((node) => node.lines.some((line) => !!line.voice?.src) || node.options.some((option) => option.reply.some((line) => !!line.voice?.src) || !!option.voice?.src));
    const clock = createClock(host().virtual);
    root.setAttribute('data-t-look', data.style);
    root.setAttribute('data-t-reveal', data.reveal);
    root.classList.add('t-dialogue-root');
    const learnerLook = data.learner ? data.speakers[data.learner]?.look : undefined;
    root.toggleAttribute('data-t-learner-look', !!(learnerLook && (learnerLook.inline || learnerLook.portrait || learnerLook.expressions)));
    wrap.classList.add(`t-dialogue-look--${data.style}`);

    // ── The parts the template gives (or that the player makes when a fork leaves them out) ──
    log.id ||= uniqueId('t-dialogue-log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-relevant', 'additions');
    log.setAttribute('aria-label', data.title || labels.dialogueLog);
    room.setAttribute('role', 'group');
    room.setAttribute('aria-label', labels.yourAnswer);
    room.tabIndex = -1;
    let stage = find('stage');
    if (data.style === 'scene' && !stage) { stage = element('div', { class: 't-dialogue-stage' }); log.before(stage); }
    if (stage) stage.setAttribute('aria-hidden', 'true');
    const debriefHost = find('debrief');
    let startButton = find('start') as HTMLButtonElement | null;
    // A hidden copy of the thread and of the room, at their width: what fits, how tall the room must be.
    const measureLog = element('div', { class: `${log.className} t-dialogue-measure`, 'aria-hidden': 'true' });
    const measureRoom = element('div', { class: `${room.className} t-dialogue-measure`, 'aria-hidden': 'true' });
    root.append(measureLog, measureRoom);
    const newMessage = element('button', { type: 'button', class: 't-dialogue-new', hidden: true, onclick: () => { scrollLog(true); newMessage.hidden = true; } }, icon('chevronDown'), element('span', { text: labels.dialogueNewMessage }));
    log.after(newMessage);
    // The thread follows its last bubble until the learner scrolls up it; back at the bottom, it follows again.
    let following = true;
    const scrolledByLearner = () => { following = pinned(); if (following) newMessage.hidden = true; };
    log.addEventListener('wheel', () => requestAnimationFrame(scrolledByLearner), { passive: true });
    log.addEventListener('touchmove', () => requestAnimationFrame(scrolledByLearner), { passive: true });
    log.addEventListener('keydown', (event) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) requestAnimationFrame(scrolledByLearner); });
    log.addEventListener('scroll', () => { if (pinned()) { following = true; newMessage.hidden = true; } }, { passive: true });

    // ── State ──
    let run: DialogueRun = courseState.dialogueRun(block);
    let beats: Beat[] = run.walk.beats;
    // What each beat shown put in the thread, by its key (a key changes when the beat would show otherwise).
    const shown: { key: string; nodes: HTMLElement[] }[] = [];
    let presented = 0;
    let phase: Phase = 'idle';
    let step: Step | null = null;
    let userPaused = false;
    let holding = false;
    let disposed = false;
    let expressions: Record<string, string> = {};
    let debriefOpen = true;
    let retry: HTMLElement | null = null;
    let stopReplay: (() => void) | null = null;
    const avatars: CharacterView[] = [];
    const actors = new Map<string, CharacterView>();
    const reduced = () => prefersLessMotion();
    const instant = () => still || reduced() || host().instantText() || data.reveal === 'instant';
    const revealMode = (): 'ink' | 'appear' | 'instant' => (instant() ? 'instant' : data.reveal);
    const rate = () => host().prefs().rate || 1;

    // ── Scene: the backdrop and the cast (style scene) ──
    let backdrop: HTMLImageElement | null = null;
    let cast: { speaker: string; position: Side }[] = [];
    const historyButton = data.style === 'scene' ? element('button', { type: 'button', class: 't-dialogue-history-btn', 'aria-expanded': 'false', 'aria-controls': log.id, onclick: () => setHistory(!root.hasAttribute('data-t-history')) }, icon('history'), element('span', { text: labels.dialogueHistory })) : null;
    if (historyButton) { stage!.before(historyButton); }
    function setHistory(open: boolean) {
      root.toggleAttribute('data-t-history', open);
      historyButton?.setAttribute('aria-expanded', String(open));
      if (open) { scrollLog(false); log.tabIndex = 0; } else { syncLogFocusable(); repage(); }
    }
    root.addEventListener('keydown', (event) => { if (event.key === 'Escape' && root.hasAttribute('data-t-history')) { event.preventDefault(); setHistory(false); historyButton?.focus(); } });
    function setScene(scene: DialogueData['scene'] | undefined, animate: boolean) {
      if (!stage || !scene) return;
      if (scene.background && scene.background !== backdrop?.getAttribute('src')) {
        const next = element('img', { class: 't-dialogue-backdrop', src: scene.background, alt: '', decoding: 'async', draggable: 'false' });
        const before = backdrop;
        stage.prepend(next);
        if (before) {
          if (animate && !reduced()) { before.classList.add('is-leaving'); setTimeout(() => before.remove(), 260); } else before.remove();
        }
        backdrop = next;
      }
      if (scene.cast?.length) {
        cast = scene.cast.map((member) => ({ speaker: member.speaker, position: member.position }));
        for (const [id, view] of actors) if (!cast.some((member) => member.speaker === id)) { view.element.parentElement?.remove(); view.dispose(); actors.delete(id); }
        for (const member of cast) {
          const speaker = data.speakers[member.speaker];
          const existing = actors.get(member.speaker);
          if (existing) { existing.element.parentElement?.setAttribute('data-position', member.position); continue; }
          if (!speaker?.look || (!speaker.look.inline && !speaker.look.portrait && !speaker.look.expressions)) continue;
          const holder = element('div', { class: 't-dialogue-actor', 'data-position': member.position, 'data-speaker': member.speaker });
          stage.append(holder);
          const view = mountCharacter(holder, speaker);
          view.set({ reducedMotion: reduced(), expression: expressions[member.speaker] ?? view.manifest.defaultExpression });
          actors.set(member.speaker, view);
        }
      }
    }
    setScene(data.scene, false);

    // ── Where a bubble goes ──
    const sideOf = (role: 'character' | 'learner' | 'narration', speaker: string | undefined): Side => {
      if (role === 'narration') return 'center';
      if (data.style === 'scene') {
        const member = cast.find((candidate) => candidate.speaker === (role === 'learner' ? learnerSpeaker ?? speaker : speaker));
        if (member) return member.position;
      }
      return role === 'learner' ? 'right' : 'left';
    };
    // The last bubble of the thread: a series goes on while the same speaker speaks.
    const lastRow = (): HTMLElement | null => {
      const rows = log.querySelectorAll<HTMLElement>(':scope > .t-dialogue-row:not(.t-dialogue-typing):not(.is-leaving)');
      return rows[rows.length - 1] ?? null;
    };
    const continues = (role: string, speaker: string | undefined) => {
      const last = lastRow();
      return !!last && last.dataset.role === role && (last.dataset.speaker ?? '') === (speaker ?? '');
    };

    // ── The thread in its box (slides): anchored at the bottom, scrolled by the learner ──
    const pinned = () => log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    function scrollLog(smooth: boolean) {
      log.scrollTo?.({ top: log.scrollHeight, behavior: smooth && !reduced() && !still ? 'smooth' : 'auto' });
    }
    // Scroll pages: the page follows the new bubble only when the learner was at the bottom of the dialogue.
    const followingPage = () => {
      const box = room.getBoundingClientRect();
      const height = window.innerHeight || document.documentElement.clientHeight;
      return box.top < height + 40;
    };
    function insert(node: HTMLElement, replace: HTMLElement | null = null) {
      const scrolls = getComputedStyle(log).overflowY === 'auto';
      const followed = !host().slides() && followingPage();
      if (replace?.isConnected) replace.replaceWith(node); else log.append(node);
      if (scrolls) {
        if (following) scrollLog(true);
        else if (!root.hasAttribute('data-t-debrief-open')) newMessage.hidden = false;
      } else if (followed && !still) {
        (room.lastElementChild as HTMLElement | null ?? room).scrollIntoView?.({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      }
    }
    function syncLogFocusable() {
      // A box that scrolls is reached with the keyboard (its arrows scroll it).
      if (host().slides() || root.hasAttribute('data-t-history')) log.tabIndex = 0; else log.removeAttribute('tabindex');
    }
    syncLogFocusable();

    // ── Scene pages: two or three bubbles near the characters, then the page turns ──
    const paging = () => data.style === 'scene' && !phone() && !root.hasAttribute('data-t-history');
    const visibleRows = () => [...log.querySelectorAll<HTMLElement>(':scope > .t-dialogue-row:not([data-t-paged])')];
    function fits(node: HTMLElement): boolean {
      measureLog.style.width = `${cssPx(log, log.getBoundingClientRect().width)}px`;
      measureLog.replaceChildren(...visibleRows().map((row) => row.cloneNode(true)), node.cloneNode(true));
      const fit = measureLog.scrollHeight <= cssPx(log, log.clientHeight) + 1;
      measureLog.replaceChildren();
      return fit;
    }
    // The bubbles shown are the last ones that fit (back on the screen, a phone turned, History closed).
    function repage() {
      const rows = [...log.querySelectorAll<HTMLElement>(':scope > .t-dialogue-row')];
      if (!paging()) { for (const row of rows) row.removeAttribute('data-t-paged'); return; }
      for (const row of rows) row.removeAttribute('data-t-paged');
      const limit = log.clientHeight;
      if (!limit) return;
      let height = 0;
      let keep = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        height += rows[i].getBoundingClientRect().height + (i < rows.length - 1 ? 12 : 0);
        if (height > limit + 1 && i < rows.length - 1) break;
        keep = i;
      }
      rows.slice(0, keep).forEach((row) => row.setAttribute('data-t-paged', ''));
    }

    // ── Characters ──
    function characterState(view: CharacterView, speaker: string, speaking: string | undefined, talking: boolean, mouth: 'closed' | 'small' | 'open' | 'wide') {
      const own = speaker === speaking;
      view.set({
        speaking: own, talking: own && talking, mouth: own && !reduced() ? mouth : 'closed', listening: !!speaking && !own,
        expression: expressions[speaker] ?? view.manifest.defaultExpression, paused: userPaused, reducedMotion: reduced()
      });
    }
    function restCharacters() {
      for (const [id, view] of actors) characterState(view, id, undefined, false, 'closed');
      for (const view of avatars) view.set({ speaking: false, talking: false, mouth: 'closed', listening: false, paused: userPaused, reducedMotion: reduced() });
    }

    // ── Presenting the beats ──
    const keyOf = (walk: DialogueWalk, index: number): string => {
      const beat = walk.beats[index];
      switch (beat.type) {
        case 'node': case 'jump': return `${beat.type}:${beat.node}`;
        case 'line': return `l:${beat.node}:${beat.option ?? ''}:${beat.line.id}:${beat.line.text}`;
        case 'decision': return `d:${beat.decision}:${beat.node}:${walk.decisions[beat.decision]?.tries.filter((attempt) => attempt.by === 'return').map((attempt) => attempt.option).join(',') ?? ''}`;
        case 'choice': return `c:${beat.decision}:${beat.node}.${beat.option}`;
        case 'actions': case 'feedback': return `${beat.type}:${beat.node}.${beat.option}`;
        case 'retry': return `r:${beat.decision}:${beat.node}.${beat.option}`;
        case 'end': return `e:${beat.ending ?? ''}`;
      }
    };
    const record = (index: number, ...nodes: HTMLElement[]) => { (shown[index] ??= { key: keyOf(run.walk, index), nodes: [] }).nodes.push(...nodes); };

    // A line's row (and the choice bubble of the learner, which is a line of theirs without id).
    function lineRow(index: number, role: 'character' | 'learner' | 'narration', speaker: string | undefined, text: string, voice: LineVoiceData, options: { decision?: number; line?: string }): BubbleRow {
      const first = role !== 'narration' && !continues(role, speaker);
      const built = bubbleRow(thread, {
        role, side: sideOf(role, speaker), speaker, text, first, voiced: !!voice.src && !still, resumable: options.decision !== undefined, letters: data.reveal === 'appear', line: options.line
      });
      if (options.decision !== undefined) built.row.dataset.decision = String(options.decision);
      built.row.dataset.beat = String(index);
      if (built.replay) built.replay.addEventListener('click', () => replay(voice, built));
      if (built.listen) built.listen.addEventListener('click', () => { if (step?.kind === 'line' && step.state.row === built) { step.state.playback.playAudio(); built.listen!.hidden = true; } else replay(voice, built); });
      if (built.resume) built.resume.addEventListener('click', () => { const decision = Number(built.row.dataset.decision); if (canRevisit(run, decision)) move(revisit(run, decision)); });
      // A click on a bubble: the whole line, then the next one (as « Suite »).
      built.bubble.addEventListener('click', () => { if (step?.kind === 'line' && step.state.row === built) next(); else if (step?.kind === 'click') next(); });
      return built;
    }
    function mountAvatar(built: BubbleRow, speaker: string | undefined): CharacterView | null {
      if (!built.avatar || !built.row.hasAttribute('data-first') || !speaker) return null;
      const data_ = data.speakers[speaker];
      if (!data_) return null;
      const view = mountCharacter(built.avatar, data_, { portrait: true });
      view.set({ expression: expressions[speaker] ?? view.manifest.defaultExpression, reducedMotion: reduced(), paused: userPaused });
      avatars.push(view);
      return view;
    }
    const roleOf = (beat: Extract<Beat, { type: 'line' }>): 'character' | 'learner' | 'narration' => beat.role;
    const voiceOf = (line: { text: string; voice?: LineVoiceData }): LineVoiceData => line.voice ?? textVoice(line.text, undefined, language);

    // The next beat waits: a pause after a line (the voice's breath, or the time to read it), a click
    // in pace click; before a decision or the end, a short pause.
    function after(index: number, chars: number, voicedLine: boolean): Step | null {
      if (still) return null;
      const following = beats[index + 1];
      if (!following) return null;
      const toOptions = following.type === 'decision' || following.type === 'end';
      if (data.pace === 'click' && !toOptions && following.type === 'line') return { kind: 'click', typing: typingFor(index + 1) };
      const seconds = toOptions ? 0.45 : voicedLine ? clamp(0.4, 0.3 + chars * 0.004, 0.8) : clamp(0.6, 0.4 + 0.02 * chars, 2);
      return { kind: 'wait', until: clock.now() + seconds / rate(), typing: typingFor(index + 1) };
    }
    // « … » in the box of the bubble to come: messaging, a character's line without a voice (the next
    // line, past the beats that show nothing).
    function typingFor(from: number): Typing {
      let index = from;
      while (beats[index] && (beats[index].type === 'node' || beats[index].type === 'jump' || beats[index].type === 'actions')) index++;
      const beat = beats[index];
      if (!beat || beat.type !== 'line' || beat.role !== 'character' || still || instant()) return null;
      if (data.style === 'scene' && !phone()) return null;
      if (beat.line.voice?.src) return null;
      const node = typingRow(thread, { role: 'character', side: sideOf('character', beat.line.speaker), speaker: beat.line.speaker, text: beat.line.text, first: !continues('character', beat.line.speaker), voiced: false, resumable: false, letters: false });
      insert(node);
      return { index, node };
    }

    function present(index: number, live: boolean, typing: HTMLElement | null = null): Step | null {
      const beat = beats[index];
      shown[index] = { key: keyOf(run.walk, index), nodes: [] };
      switch (beat.type) {
        case 'node': {
          const node = nodeOf(data, beat.node);
          if (node?.scene) setScene(node.scene, live);
          if (live) trigger('dialogue.node', { target: block.id, node: beat.node });
          return null;
        }
        case 'jump': return null;
        case 'line': return presentLine(index, beat.line, roleOf(beat), beat.line.speaker, live, typing, { line: beat.line.id });
        case 'choice': {
          const option = optionOf(data, beat.node, beat.option);
          if (!option?.text) return null;
          const voice = option.voice && data.learnerVoice ? option.voice : null;
          const role = 'learner' as const;
          // The learner's own words: whole at once (a voice only with learnerVoice).
          const step = presentLine(index, null, role, learnerSpeaker, live, null, { decision: beat.auto ? undefined : beat.decision, text: option.text, voice, silent: !voice });
          if (!live || voice) return step;
          if (step) return { kind: 'turn', until: (step as Extract<Step, { kind: 'turn' }>).until, then: () => { (step as Extract<Step, { kind: 'turn' }>).then(); return { kind: 'wait', until: clock.now() + 0.8 / rate(), typing: typingFor(index + 1) }; } };
          return { kind: 'wait', until: clock.now() + 0.8 / rate(), typing: typingFor(index + 1) };
        }
        case 'actions':
          if (live) host().act(beat.actions);
          return null;
        case 'feedback': {
          const option = optionOf(data, beat.node, beat.option);
          if (!option) return null;
          const node = noteRow(thread, option, data.feedback !== 'debrief');
          node.dataset.beat = String(index);
          if (paging() && live && !fits(node)) return turnPage(() => { insert(node); record(index, node); return noteWait(index, option); });
          insert(node);
          record(index, node);
          if (!live) return null;
          return noteWait(index, option);
        }
        case 'retry': return live ? { kind: 'wait', until: clock.now() + 0.3 / rate(), typing: null } : null;
        case 'decision': {
          const decision = run.walk.decisions[beat.decision];
          const replaced = decision?.tries.filter((attempt) => attempt.by === 'return').map((attempt) => optionOf(data, beat.node, attempt.option)).filter((option): option is DialogueOptionData => !!option) ?? [];
          if (replaced.length) { const node = firstChoiceRow(thread, replaced); node.dataset.beat = String(index); insert(node); record(index, node); }
          return null;
        }
        case 'end': {
          const ending = run.walk.ending;
          const node = endRow(thread, ending?.title ?? null, data.debrief ? null : ending?.textHtml ?? null);
          node.dataset.beat = String(index);
          insert(node);
          record(index, node);
          if (live) trigger('dialogue.ended', { target: block.id, ending: ending?.id ?? null });
          return null;
        }
      }
    }
    function noteWait(index: number, option: DialogueOptionData): Step | null {
      const chars = (option.feedback ?? '').length;
      const following = beats[index + 1];
      if (!following || still) return null;
      if (data.pace === 'click' && following.type === 'line') return { kind: 'click', typing: typingFor(index + 1) };
      return { kind: 'wait', until: clock.now() + clamp(1, 0.5 + 0.025 * chars, 3.5) / rate(), typing: typingFor(index + 1) };
    }
    function turnPage(then: () => Step | null): Step {
      const leaving = visibleRows();
      for (const row of leaving) row.classList.add('is-turning');
      return { kind: 'turn', until: clock.now() + (reduced() ? 0 : 0.2), then: () => { for (const row of leaving) { row.classList.remove('is-turning'); row.setAttribute('data-t-paged', ''); } return then(); } };
    }

    function presentLine(index: number, line: DialogueLineData | null, role: 'character' | 'learner' | 'narration', speaker: string | undefined, live: boolean, typing: HTMLElement | null, extra: { line?: string; decision?: number; text?: string; voice?: LineVoiceData | null; silent?: boolean }): Step | null {
      const text = line?.text ?? extra.text ?? '';
      const voice = extra.voice ?? (line ? voiceOf(line) : textVoice(text, undefined, language));
      const built = lineRow(index, role, speaker, text, voice, { decision: extra.decision, line: extra.line });
      const begin = (): Step | null => {
        if (typing && !typing.isConnected) typing = null;
        insert(built.row, typing);
        record(index, built.row);
        if (line?.speaker && line.expression) expressions[line.speaker] = line.expression;
        const avatar = mountAvatar(built, role === 'learner' ? learnerSpeaker : speaker);
        if (!live || extra.silent) {
          showAllWords(built.words, { said: 0 });
          if (line?.speaker) for (const cue of line.cues ?? []) if (cue.expression) expressions[line.speaker] = cue.expression;
          return null;
        }
        if (line) trigger('dialogue.line', { target: block.id, line: line.id });
        if (disposed) return null;
        const playback = createLinePlayback({
          voice, clock, silent: host().virtual || still, instant: instant(), host: root,
          rate, volume: () => host().prefs().volume, muted: () => host().prefs().muted,
          onRefused: () => { if (built.listen) built.listen.hidden = false; },
          onPlaying: () => { if (built.listen) built.listen.hidden = true; }
        });
        const state: LineState = {
          index, line, chars: text.length, speaker: role === 'learner' ? learnerSpeaker : speaker, row: built, voice, playback, paint: { said: 0 }, whole: false, avatar,
          cues: (line?.cues ?? []).map((cue) => ({ time: cueTime(cue, voice), gesture: cue.gesture, expression: cue.expression, do: cue.do, fired: false }))
        };
        setHolding(true);
        return { kind: 'line', state };
      };
      if (live && paging() && !fits(built.row)) return turnPage(begin);
      return begin();
    }

    // A line, frame by frame: its words, its cues, its character; done once its voice has said it.
    function tickLine(state: LineState): boolean {
      const { playback } = state;
      playback.sync();
      const t = playback.time();
      if (state.whole || revealMode() === 'instant') showAllWords(state.row.words, state.paint);
      else paintWords(state.row.words, state.voice.words, t, revealMode(), state.paint);
      for (const cue of state.cues) {
        if (cue.fired || cue.time > t + 1e-6) continue;
        cue.fired = true;
        if (cue.expression && state.speaker) expressions[state.speaker] = cue.expression;
        if (cue.gesture && state.speaker) { actors.get(state.speaker)?.gesture(cue.gesture); state.avatar?.gesture(cue.gesture); }
        if (cue.do?.length) host().act(cue.do);
        if (disposed) return true;
      }
      const sounding = voiceAt(state.voice, t);
      const talking = !playback.ended && !userPaused && sounding.talking;
      for (const [id, view] of actors) characterState(view, id, state.speaker, talking, sounding.mouth);
      if (state.avatar && state.speaker) characterState(state.avatar, state.speaker, state.speaker, talking, sounding.mouth);
      if (!playback.ended) return false;
      showAllWords(state.row.words, state.paint);
      playback.dispose();
      restCharacters();
      return true;
    }

    // ── The loop: one step at a time, beats in order ──
    function tick() {
      if (disposed) return;
      if (!wrap.isConnected) { dispose(); return; }
      syncTurn();
      if (phase !== 'playing' || userPaused) return;
      for (let guard = 0; guard < 400 && phase === 'playing'; guard++) {
        if (step) {
          if (step.kind === 'line') {
            if (!tickLine(step.state)) return;
            const done = step.state;
            step = after(done.index, done.chars, !!done.voice.src);
            continue;
          }
          if (step.kind === 'wait') { if (clock.now() < step.until) return; consumeTyping(step); step = null; continue; }
          if (step.kind === 'turn') { if (clock.now() < step.until) return; const then = step.then; step = null; step = then(); continue; }
          if (step.kind === 'click') return;
        }
        if (presented >= beats.length) { settle(); return; }
        const index = presented++;
        let typing: HTMLElement | null = null;
        if (pendingTyping?.index === index) { typing = pendingTyping.node; pendingTyping = null; }
        step = present(index, true, typing);
        if (disposed) return;
      }
    }
    // The bubble to come, waiting in the thread: handed to the line it announces.
    let pendingTyping: Typing = null;
    function consumeTyping(done: Extract<Step, { kind: 'wait' | 'click' }>) { if (done.typing) { pendingTyping?.node.remove(); pendingTyping = done.typing; } }

    // Every beat presented: a decision waits, or the dialogue has ended.
    function settle() {
      setHolding(false);
      step = null;
      pendingTyping?.node.remove();
      pendingTyping = null;
      if (run.walk.status === 'choosing') { phase = 'choosing'; showOptions(); }
      else { phase = 'ended'; showEnd(); }
      syncTools();
      syncRetry();
    }

    // ── The room under the thread ──
    let turn: TurnControls | null = null;
    function setRoom(state: string, nodes: HTMLElement[], describedBy: string | null = null) {
      const focused = room.contains(document.activeElement) && document.activeElement !== room;
      room.dataset.tState = state;
      room.replaceChildren(...nodes);
      if (describedBy) room.setAttribute('aria-describedby', describedBy); else room.removeAttribute('aria-describedby');
      // The focus never falls to the page: it stays on the group (« Votre réponse »).
      if (focused && !room.contains(document.activeElement)) room.focus({ preventScroll: true });
    }
    // The options chosen from fade where they are before the turn's controls take the room.
    let roomHeldUntil = 0;
    function syncTurn() {
      if (phase === 'playing' && !still && clock.now() >= roomHeldUntil) {
        if (!turn || room.dataset.tState !== 'playing') {
          turn = turnControls(thread, voiced, { pause: () => (userPaused ? resume() : pause()), mute: () => { const prefs = host().prefs(); prefs.muted = !prefs.muted; syncTurn(); }, next });
          setRoom('playing', [turn.root]);
        }
        syncTurnControls(thread, turn, { paused: userPaused, muted: host().prefs().muted, whole: step?.kind !== 'line' || step.state.whole, click: step?.kind === 'click' });
      }
    }
    function showOptions() {
      const node = nodeOf(data, run.walk.node);
      const exploring = scoredDone(run) || data.revisit === 'anytime';
      const { nodes, promptId } = optionsContent(thread, node?.prompt, run.walk.offer, {
        final: !!node?.final,
        explored: (option) => exploring && run.progress.explored.includes(`${run.walk.node}.${option}`),
        onChoose: chooseOption
      });
      if (!host().slides()) room.style.minHeight = '';
      setRoom('choosing', nodes, promptId);
    }
    function showEnd() {
      if (!host().slides()) room.style.minHeight = '';
      const result = scoredResult(run);
      const back = lastRevisitable();
      setRoom('ended', [endControls(thread, {
        found: result.endingsFound, total: result.endingsTotal,
        back: back === null ? null : () => focusResume(back),
        restart: canRestart(run) ? () => move(restart(run), { started: true }) : null,
        debrief: data.debrief && overlaidDebrief() ? { open: debriefOpen, toggle: () => { debriefOpen = !debriefOpen; renderDebrief(); showEnd(); room.querySelector<HTMLElement>('.t-dialogue-debrief-toggle')?.focus(); } } : null
      })]);
      renderDebrief();
    }
    // In slides the debrief comes over the thread (its box keeps its size); in scroll pages, under it.
    const overlaidDebrief = () => host().slides() || data.style === 'scene';
    function renderDebrief() {
      const target = debriefHost;
      if (!data.debrief) return;
      if (phase !== 'ended') { if (target) { target.replaceChildren(); target.hidden = true; } root.removeAttribute('data-t-debrief-open'); return; }
      const card = debriefCard(thread, debriefOf());
      if (target) {
        target.replaceChildren(card);
        target.hidden = overlaidDebrief() && !debriefOpen;
        // Over the thread it scrolls in its box: a region the keyboard reaches.
        if (overlaidDebrief()) { target.tabIndex = 0; target.setAttribute('role', 'region'); target.setAttribute('aria-label', labels.dialogueDebrief); }
      }
      else if (!log.querySelector('.t-dialogue-debrief-card')) { const row = element('div', { class: 't-dialogue-row', 'data-role': 'debrief' }, card); insert(row); }
      root.toggleAttribute('data-t-debrief-open', !!target && overlaidDebrief() && debriefOpen);
      placeDebrief();
    }
    // Over the thread and the room's free part, down to the end's controls (slides, messaging).
    function placeDebrief() {
      if (!root.hasAttribute('data-t-debrief-open') || data.style === 'scene' && !phone()) { root.style.removeProperty('--t-dl-debrief-height'); return; }
      const bar = room.querySelector<HTMLElement>('.t-dialogue-endbar');
      const gap = parseFloat(getComputedStyle(root).rowGap) || 0;
      const bottom = room.offsetTop + room.offsetHeight - (bar?.offsetHeight ?? 0) - gap;
      root.style.setProperty('--t-dl-debrief-height', `${Math.max(log.offsetHeight, bottom - log.offsetTop)}px`);
    }
    // The debrief of the run shown: the scored run's first choices (what counted), else the choices kept.
    function debriefOf() {
      const walk = run.walk;
      const result = scoredResult(run);
      const scoredRun = run.scoredWalk === run.walk;
      const decisions: DebriefDecision[] = scoredRun
        ? result.decisions.map((decision) => ({ prompt: decision.prompt, option: optionOf(data, decision.node, decision.option)!, kept: decision.kept ? optionOf(data, decision.node, decision.kept) ?? null : null, quality: decision.quality })).filter((decision) => !!decision.option)
        : walk.decisions.filter((decision) => decision.closed && !decision.auto && decision.choice).map((decision) => {
          const option = optionOf(data, decision.node, decision.choice)!;
          return { prompt: nodeOf(data, decision.node)?.prompt, option, kept: null, quality: option?.quality };
        }).filter((decision) => !!decision.option);
      const reached = walk.ending?.id ?? null;
      const others = data.endings.filter((ending) => ending.id !== reached).map((ending) => ({ title: ending.title ?? ending.id, found: run.progress.endings.includes(ending.id) }));
      return { ending: walk.ending, decisions, score: scoredRun ? result.score : null, others };
    }

    // ── The learner's moves ──
    function chooseOption(option: string) {
      if (phase !== 'choosing') return;
      let moved: DialogueRun;
      try { moved = choose(run, option); } catch { return; }
      const node = run.walk.node;
      // The others fade where they are; the room keeps its height until the next options come.
      for (const button of room.querySelectorAll<HTMLElement>('.t-dialogue-choice')) button.classList.add(button.dataset.option === option ? 'is-chosen' : 'is-leaving');
      room.style.minHeight = room.style.minHeight || `${cssPx(room, room.getBoundingClientRect().height)}px`;
      room.dataset.tState = 'chosen';
      room.focus({ preventScroll: true });
      roomHeldUntil = still || reduced() ? 0 : clock.now() + 0.2;
      move(moved, { chosen: { node, option }, keepRoom: true });
    }
    // The decision the learner may go back to last (« Revenir à un choix »).
    function lastRevisitable(): number | null {
      for (let i = run.walk.decisions.length - 1; i >= 0; i--) if (canRevisit(run, i)) return i;
      return null;
    }
    function focusResume(decision: number) {
      if (debriefOpen && overlaidDebrief()) { debriefOpen = false; renderDebrief(); showEnd(); }
      const button = log.querySelector<HTMLElement>(`.t-dialogue-row[data-decision="${decision}"] .t-dialogue-resume`);
      if (!button) return;
      button.closest('.t-dialogue-row')?.scrollIntoView?.({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      button.focus({ preventScroll: true });
    }

    // A new run: saved (its first end records the scored interactions once), the beats it shares with
    // the one shown kept, the rest gone in a fade, the new ones presented.
    function move(next: DialogueRun, { chosen, started, live = !still, keepRoom = false }: { chosen?: { node: string; option: string }; started?: boolean; live?: boolean; keepRoom?: boolean } = {}) {
      const saved = courseState.saveDialogue(block.id, next);
      if (saved.finished) recordInteractions(saved.interactions);
      run = next;
      beats = next.walk.beats;
      let common = 0;
      while (common < shown.length && common < beats.length && shown[common]?.key === keyOf(next.walk, common)) common++;
      // What extends the run shown (a choice) keeps every beat; anything else cuts back.
      if (presented > common || shown.length > common) cut(common);
      if (chosen) trigger('dialogue.chosen', { target: block.id, node: chosen.node, option: chosen.option });
      if (started) trigger('dialogue.started', { target: block.id });
      if (disposed) return;
      syncTools();
      syncRetry();
      if (!live) { renderAll(); return; }
      phase = 'playing';
      if (!keepRoom) setRoom('playing', []);
      turn = null;
      // A turn's controls never steal the focus from the options' group.
      if (room.contains(document.activeElement) && document.activeElement !== room && !keepRoom) room.focus({ preventScroll: true });
      // Gone bubbles take their fade before the new ones come.
      if (!step && leavingCount > 0 && !reduced()) step = { kind: 'wait', until: clock.now() + 0.2, typing: null };
      tick();
      loop();
    }
    let leavingCount = 0;
    function cut(common: number) {
      if (step?.kind === 'line') step.state.playback.dispose();
      if (step && 'typing' in step) step.typing?.node.remove();
      pendingTyping?.node.remove();
      pendingTyping = null;
      step = null;
      restCharacters();
      for (let i = shown.length - 1; i >= common; i--) for (const node of shown[i]?.nodes ?? []) leave(node);
      shown.length = Math.min(shown.length, common);
      presented = Math.min(presented, common);
      expressions = expressionsOf({ beats: beats.slice(0, presented) });
      retry?.remove();
      retry = null;
      if (debriefHost) { debriefHost.replaceChildren(); debriefHost.hidden = true; }
      for (const row of log.querySelectorAll('.t-dialogue-row[data-role="debrief"]')) row.remove();
      root.removeAttribute('data-t-debrief-open');
      debriefOpen = true;
      if (paging()) repage();
    }
    function leave(node: HTMLElement) {
      if (still || reduced() || !node.isConnected) { node.remove(); return; }
      leavingCount++;
      node.classList.add('is-leaving');
      setTimeout(() => { node.remove(); leavingCount--; }, 200);
    }
    function recordInteractions(interactions: ReturnType<typeof scoredResult>['interactions']) {
      for (const interaction of interactions) {
        const node = nodeOf(data, interaction.node);
        const ids = node?.options.filter((option) => !option.fallback).map((option) => option.id) ?? [];
        // SCORM 1.2 names choices by single characters: the options' ids when they are, else letters by place.
        const single = ids.every((id) => /^[a-z0-9]$/.test(id));
        const name = (id: string) => (single ? id : String.fromCharCode(97 + Math.max(0, ids.indexOf(id))));
        const good = node?.options.filter((option) => option.quality === 'good').map((option) => name(option.id)) ?? [];
        recordInteraction({
          id: `${block.id}.${interaction.id}`, type: 'choice', objective: interaction.objective, weight: data.weight,
          response: name(interaction.response), correctPattern: good.length ? good.join(',') : undefined, result: interaction.result
        });
      }
    }

    // « Reprendre d'ici » on the past choices that allow it; « Choisir autrement » under the last consequence.
    function syncTools() {
      for (const button of log.querySelectorAll<HTMLButtonElement>('.t-dialogue-resume')) {
        const decision = Number(button.closest<HTMLElement>('.t-dialogue-row')?.dataset.decision);
        button.hidden = !(Number.isInteger(decision) && canRevisit(run, decision) && phase !== 'playing');
      }
    }
    function syncRetry() {
      const walk = run.walk;
      const last = [...walk.decisions].reverse().find((decision) => decision.closed && !decision.auto);
      const wanted = !!last && last.choice !== null && canRetryLast(run) && phase !== 'playing';
      if (!wanted || !last) { retry?.remove(); retry = null; return; }
      // After the beats of its consequence (up to the next node).
      const choice = walk.beats.findIndex((beat) => beat.type === 'choice' && beat.decision === last.index && !beat.auto && beat.option === last.choice);
      if (choice < 0) { retry?.remove(); retry = null; return; }
      let end = choice;
      while (end + 1 < walk.beats.length && !['node', 'jump', 'end', 'decision'].includes(walk.beats[end + 1].type)) end++;
      if (end >= presented) return;
      const anchor = [...shown.slice(choice, end + 1)].reverse().flatMap((entry) => entry?.nodes ?? []).find((node) => node.isConnected);
      if (!anchor) return;
      if (!retry) retry = retryRow(thread, () => { if (canRetryLast(run)) move(retryLast(run)); });
      if (anchor.nextElementSibling !== retry) anchor.after(retry);
    }

    // « Réécouter »: the line's voice again, beside the flow (the dialogue waits meanwhile).
    function replay(voice: LineVoiceData, built: BubbleRow) {
      stopReplay?.();
      const wasPaused = userPaused;
      if (phase === 'playing' && !wasPaused) pause();
      built.row.classList.add('is-replaying');
      const prefs = host().prefs();
      setHolding(true);
      stopReplay = replayVoice(voice, root, { rate: prefs.rate || 1, volume: prefs.volume, muted: prefs.muted }, () => {
        built.row.classList.remove('is-replaying');
        stopReplay = null;
        if (phase !== 'playing') setHolding(false);
        if (!wasPaused && phase === 'playing') resume();
      });
    }

    // « Suite » (or a click on the bubble, or Entrée): the whole line first, the voice going on; then the next.
    function next() {
      if (phase !== 'playing') return;
      if (userPaused) resume();
      if (step?.kind === 'line') {
        if (!step.state.whole && revealMode() !== 'instant') { step.state.whole = true; showAllWords(step.state.row.words, step.state.paint); syncTurn(); return; }
        step.state.playback.stop();
        tickLine(step.state);
        step = null;
      } else if (step?.kind === 'wait' || step?.kind === 'click') { consumeTyping(step); step = null; }
      tick();
      loop();
    }
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target !== log && target !== room && target !== root) return;
      if (phase !== 'playing') return;
      event.preventDefault();
      next();
    });

    function pause() {
      if (userPaused || phase !== 'playing') return;
      userPaused = true;
      clock.pause();
      if (step?.kind === 'line') step.state.playback.pause();
      for (const view of [...actors.values(), ...avatars]) view.set({ paused: true });
      root.toggleAttribute('data-t-paused', true);
      syncTurn();
    }
    function resume() {
      if (!userPaused) return;
      userPaused = false;
      clock.resume();
      if (step?.kind === 'line') step.state.playback.resume();
      for (const view of [...actors.values(), ...avatars]) view.set({ paused: false });
      root.toggleAttribute('data-t-paused', false);
      syncTurn();
      loop();
    }
    function setHolding(on: boolean) {
      if (still || on === holding) return;
      holding = on;
      if (on) host().hold(`dialogue:${block.id}`); else host().release(`dialogue:${block.id}`);
    }

    // ── Showing at once: back on the screen, the editor's canvas, a jump of the canvas ──
    function renderAll() {
      // Shown at once: no row comes in a fade.
      root.setAttribute('data-t-quiet', '');
      requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute('data-t-quiet')));
      for (; presented < beats.length; presented++) present(presented, false);
      for (const [id, view] of actors) characterState(view, id, undefined, false, 'closed');
      repage();
      scrollLog(false);
      if (run.walk.status === 'choosing') { phase = 'choosing'; showOptions(); } else { phase = 'ended'; showEnd(); }
      syncTools();
      syncRetry();
    }

    // ── Beginning ──
    function begin() {
      if (phase !== 'idle' || disposed) return;
      startButton?.closest('.t-dialogue-start')?.setAttribute('hidden', '');
      if (startButton) startButton.hidden = true;
      if (still) { renderAll(); return; }
      trigger('dialogue.started', { target: block.id });
      if (disposed) return;
      phase = 'playing';
      // The first bubble's « … » (messaging without a voice).
      const typing = presented === 0 ? typingFor(0) : null;
      if (typing) step = { kind: 'wait', until: clock.now() + 0.7 / rate(), typing };
      tick();
      loop();
    }
    const shownNow = () => wrap.isConnected && !wrap.closest('[data-t-pending], [data-t-concealed], [data-t-timed], [inert], [hidden]') && !(wrap.closest('dialog') && !wrap.closest('dialog[open]'));
    let inView = false;
    const observer = typeof IntersectionObserver === 'function' && !still ? new IntersectionObserver((entries) => { inView = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.2); checkBegin(); }, { threshold: [0, 0.25, 0.5] }) : null;
    // In view: a quarter of it at least (or of the window), read from its box (the observer's
    // callbacks may come late) or from the observer (the learner scrolled to it).
    const visibleNow = () => {
      const box = wrap.getBoundingClientRect();
      const height = window.innerHeight || document.documentElement.clientHeight;
      const seen = Math.min(box.bottom, height) - Math.max(box.top, 0);
      return box.height > 0 && seen >= Math.min(box.height, height) * 0.25;
    };
    function checkBegin() {
      if (phase !== 'idle' || data.begins !== 'auto') return;
      if (shownNow() && (inView || !observer || visibleNow())) begin();
    }

    // Saved progress: the path shown at once (back on the screen); the editor shows the first turn.
    const resumed = run.progress.path.length > 0 || run.walk.status === 'ended';
    if (resumed || still) {
      if (startButton) { startButton.hidden = true; startButton.closest('.t-dialogue-start')?.setAttribute('hidden', ''); }
      renderAll();
    } else {
      setRoom('idle', []);
      if (data.begins === 'click') {
        if (!startButton) { startButton = element('button', { type: 'button', class: 't-btn t-btn--primary t-dialogue-start-btn' }) as HTMLButtonElement; setRoom('idle', [element('div', { class: 't-dialogue-start' }, startButton)]); }
        startButton.type = 'button';
        if (!startButton.textContent?.trim()) startButton.append(icon('play'), element('span', { text: labels.dialogueStart }));
        // The dialogue's name above it (the dialogue is already named for screen readers).
        if (startButton.parentElement && !startButton.parentElement.querySelector('.t-dialogue-start-title')) startButton.before(element('p', { class: 't-dialogue-start-title', 'aria-hidden': 'true', text: data.title }));
        startButton.addEventListener('click', () => { begin(); room.focus({ preventScroll: true }); });
      } else if (startButton) { startButton.hidden = true; startButton.closest('.t-dialogue-start')?.setAttribute('hidden', ''); }
      observer?.observe(wrap);
    }

    // ── Slides: the box keeps its size, filling the room the slide leaves; the room keeps the
    // height of the tallest set of options ──
    const main = () => wrap.closest<HTMLElement>('.t-main');
    let sizing = false;
    function layout() {
      if (disposed || !wrap.isConnected) return;
      syncLogFocusable();
      const slides = host().slides();
      const scene = data.style === 'scene' && !phone();
      const placeOverlays = () => {
        // Where the thread is in the dialogue: the start card, the debrief over it, « Nouveau message ».
        root.style.setProperty('--t-dl-log-top', `${log.offsetTop}px`);
        root.style.setProperty('--t-dl-log-height', `${log.offsetHeight}px`);
      };
      if (!slides) { root.style.removeProperty('--t-dialog-fill'); room.style.minHeight = ''; placeOverlays(); return; }
      const container = main();
      const article = wrap.closest<HTMLElement>('.t-screen');
      if (!container || !article || sizing) return;
      sizing = true;
      try {
        // The room first: the box takes what is left once the room has the height of the tallest options.
        reserveRoom(scene);
        // What the slide leaves: the page scrolls by what is too much, or the screen has room to spare.
        const box = scene ? stage : log;
        if (!box) return;
        const zoom = (box as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
        const page = document.documentElement;
        const overflow = page.scrollHeight - window.innerHeight;
        let delta: number;
        if (overflow > 0.5) delta = -overflow;
        else {
          const styles = getComputedStyle(container);
          const mainZoom = (container as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
          const room = container.getBoundingClientRect().height - (parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom)) * mainZoom;
          delta = room - article.getBoundingClientRect().height;
        }
        const current = box.getBoundingClientRect().height / zoom;
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const [low, high] = scene ? [15 * rem, 60 * rem] : [12 * rem, 32 * rem];
        if (Math.abs(delta) < 1 && root.style.getPropertyValue('--t-dialog-fill')) { placeOverlays(); return; }
        const fill = Math.round(clamp(low, current + delta / zoom, high));
        root.style.setProperty('--t-dialog-fill', `${fill}px`);
        placeOverlays();
      } finally { sizing = false; }
      repage();
    }
    function reserveRoom(scene: boolean) {
      if (scene || room.getBoundingClientRect().width === 0) { room.style.minHeight = ''; return; }
      measureRoom.style.width = `${cssPx(room, room.getBoundingClientRect().width)}px`;
      let tallest = 0;
      const sets: HTMLElement[][] = [];
      for (const node of data.nodes) {
        const offer = node.options.filter((option) => !option.fallback).map((option) => ({ option, enabled: true }));
        if (!offer.length) continue;
        sets.push(optionsContent(thread, node.prompt, offer, { final: !!node.final, explored: () => data.revisit !== 'none', onChoose: () => {} }).nodes);
      }
      sets.push([endControls(thread, { found: 1, total: Math.max(1, data.endings.length), back: data.revisit !== 'none' ? () => {} : null, restart: data.revisit !== 'none' ? () => {} : null, debrief: data.debrief ? { open: true, toggle: () => {} } : null })]);
      if (!still) sets.push([turnControls(thread, voiced, { pause: () => {}, mute: () => {}, next: () => {} }).root]);
      for (const set of sets) {
        measureRoom.replaceChildren(...set);
        tallest = Math.max(tallest, cssPx(measureRoom, measureRoom.getBoundingClientRect().height));
      }
      measureRoom.replaceChildren();
      room.style.minHeight = `${Math.ceil(tallest)}px`;
    }
    const resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
    let observed = false;
    function afterShow() {
      if (!observed && resizer) { const container = main(); if (container) { resizer.observe(container); resizer.observe(wrap.closest('.t-screen') ?? wrap); observed = true; } }
      layout();
      document.fonts?.ready.then(() => layout());
      // What a resumed path left on the screen: blocks shown or hidden, props, the step (no layer opens).
      if (resumed && !still) host().present(presentationOf({ beats: beats.slice(0, presented) }));
      checkBegin();
    }
    const phoneQuery = typeof matchMedia === 'function' ? matchMedia(PHONE) : null;
    const onPhone = () => { layout(); repage(); };
    phoneQuery?.addEventListener?.('change', onPhone);

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (step?.kind === 'line') step.state.playback.dispose();
      stopReplay?.();
      setHolding(false);
      observer?.disconnect();
      resizer?.disconnect();
      phoneQuery?.removeEventListener?.('change', onPhone);
      for (const view of [...actors.values(), ...avatars]) view.dispose();
      controllers.delete(block.id);
    }

    const controller: Controller = {
      block, wrap, clock,
      active: () => !disposed && phase === 'playing' && !userPaused,
      tick, begin, checkBegin, afterShow,
      goto(node: string) { try { move(jump(run, node)); } catch { /* not a node of this dialogue (the validator says so) */ } },
      restartRun() {
        if (canRestart(run)) { move(restart(run), { started: true }); return; }
        // Outside its policy, the screen may start it over once its first run is done: the scored run stays.
        if (scoredDone(run)) move(openDialogue(data, { ...run.progress, path: [], scored: run.progress.scored ?? run.progress.path.slice() }, run.env), { started: true });
      },
      pause,
      // The editor's canvas: the dialogue after these choices (option ids, in order), at a node.
      showPath(choices: readonly string[], node?: string) {
        let next = openDialogue(data, { path: [], scored: null, explored: [], endings: [] }, run.env);
        for (const option of choices) { try { next = choose(next, option); } catch { break; } }
        if (node && next.walk.node !== node && nodeOf(data, node)) next = jump(next, node);
        phase = 'idle';
        cut(0);
        log.replaceChildren();
        run = next;
        beats = next.walk.beats;
        presented = 0;
        shown.length = 0;
        renderAll();
      },
      // The Review (docs/review-bridge.md): a line of the dialogue, a node's or a reply's (or an option
      // the learner's voice says, <node>.<option>), shown at rest where it comes: on the thread when it
      // is there, else after the choices of the first path that says it.
      showLine(line: string): boolean {
        const says = (walk: DialogueWalk) => walk.beats.some((beat) => (beat.type === 'line' && beat.line.id === line) || (beat.type === 'choice' && `${beat.node}.${beat.option}` === line));
        const there = () => log.querySelector<HTMLElement>(`.t-dialogue-row[data-line="${CSS.escape(line)}"]`);
        if (!there() || phase === 'playing') {
          const path = says(run.walk) ? { entries: run.walk.entries } : explorePaths(data, { env: run.env, limit: 200 }).paths.find((candidate) => says(candidate.walk));
          if (!path) return false;
          let count = 0;
          while (count < path.entries.length && !says(replayWalk(data, path.entries.slice(0, count), run.env))) count++;
          controller.showPath(path.entries.slice(0, count).map((entry) => entry.slice(entry.lastIndexOf('.') + 1)));
        }
        const row = there();
        row?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        return true;
      },
      state(): DialogueViewState {
        return {
          phase, node: run.walk.node, status: run.walk.status, presented, beats: beats.length,
          line: step?.kind === 'line' ? step.state.line?.id ?? null : null, time: step?.kind === 'line' ? step.state.playback.time() : null, paused: userPaused,
          path: run.progress.path.slice(), scored: run.progress.scored?.slice() ?? null, explored: run.progress.explored.slice(), endings: run.progress.endings.slice(), ending: run.walk.ending?.id ?? null
        };
      },
      transcript() {
        const lines: { speaker?: string; text: string }[] = [];
        for (const beat of beats.slice(0, presented)) {
          if (beat.type === 'line') lines.push({ ...(beat.role === 'narration' ? {} : { speaker: speakerName(thread, beat.line.speaker, beat.role === 'learner') }), text: beat.line.text });
          else if (beat.type === 'choice') { const option = optionOf(data, beat.node, beat.option); if (option?.text) lines.push({ speaker: speakerName(thread, learnerSpeaker, true), text: option.text }); }
        }
        return lines.length ? { title: data.title, lines } : null;
      },
      next,
      choose: chooseOption,
      dispose
    };
    return controller;
  }

  return {
    bind,
    // The screen showed its blocks: each dialogue sizes its box, applies what a resumed path left and
    // begins when it may.
    afterShow(): void { for (const controller of [...controllers.values()]) controller.afterShow(); },
    noteShown(): void { for (const controller of [...controllers.values()]) controller.checkBegin(); },
    // Actions of the screen (D61): start-dialogue, goto-dialogue, restart-dialogue.
    start(blockId: string): void { controllers.get(blockId)?.begin(); },
    goto(blockId: string, node: string): void { controllers.get(blockId)?.goto(node); },
    restart(blockId: string): void { controllers.get(blockId)?.restartRun(); },
    // Another voice starts (the narration played, a sound or a video): the dialogues pause.
    pauseAll(): void { for (const controller of controllers.values()) controller.pause(); },
    // The editor's canvas: a dialogue after these choices, at a node.
    // The Review: the line being said (and when in it), a line shown.
    current(): { block: string; line: string; time?: number } | null {
      for (const [id, controller] of controllers) {
        if (!controller.wrap.isConnected) continue;
        const now = controller.state();
        if (now.line) return { block: id, line: now.line, ...(now.time !== null ? { time: now.time } : {}) };
      }
      return null;
    },
    show(blockId: string, line: string): boolean { return controllers.get(blockId)?.showLine(line) ?? false; },
    showPath(blockId: string, choices: readonly string[], node?: string): boolean {
      const controller = controllers.get(blockId);
      if (!controller) return false;
      controller.showPath(choices, node);
      return true;
    },
    // The paths shown, for the screen's transcript.
    transcripts(): { title: string; lines: { speaker?: string; text: string }[] }[] {
      return [...controllers.values()].filter((controller) => controller.wrap.isConnected).map((controller) => controller.transcript()).filter((section): section is NonNullable<typeof section> => section !== null);
    },
    get blocks(): string[] { return [...controllers.keys()]; },
    state(blockId: string): DialogueViewState | null { return controllers.get(blockId)?.state() ?? null; },
    next(blockId: string): void { controllers.get(blockId)?.next(); },
    choose(blockId: string, option: string): void { controllers.get(blockId)?.choose(option); },
    // Tests: moves every dialogue's virtual clock (in small steps, so that cues keep their order).
    advance(seconds: number): void {
      if (!host().virtual) return;
      let left = seconds;
      while (left > 1e-6) {
        const step = Math.min(0.05, left);
        for (const controller of [...controllers.values()]) { controller.clock.advance(step); controller.tick(); }
        left -= step;
      }
    },
    forget(blockId: string): void { controllers.get(blockId)?.dispose(); },
    dispose(): void { for (const controller of [...controllers.values()]) controller.dispose(); cancelAnimationFrame(frame); }
  };
}

// Without a screen (a component preview): nothing to hold, no actions.
const NO_HOST: DialogueHost = {
  virtual: false, prefs: () => ({ rate: 1, volume: 1, muted: false }), hold: () => {}, release: () => {}, act: () => {}, present: () => {},
  slides: () => document.getElementById('elabora-app')?.dataset.presentation === 'slides', instantText: () => document.getElementById('elabora-app')?.hasAttribute('data-text-instant') ?? false
};
