// The dialogue behaviour (D61, D14): a dialogue block in the page. The template gives the hooks
// (data-t-log, data-t-options; optionally data-t-group, data-t-stage, data-t-debrief, data-t-start,
// docs/components.md); the player owns the rest: the run and its saved progress, the score and SCORM,
// the thread and its focus, the voices, the characters, the events.
//
// The walk is pure (walk.ts, run.ts). This file makes each dialogue's view and plays it: one beat at
// a time, each waiting for its line to be said, a pause, a click or a page turn. Its parts:
//   box.ts    the thread in its box: where a row goes, the scene's pages and History, the slide's room;
//   cast.ts   the scene's backdrop and characters, the portraits, who speaks;
//   lines.ts  each beat in the thread: a line inserted whole and said by its voice, its ink and cues;
//   room.ts   the room under the thread: a turn's controls, the options, the end and the debrief;
//   moves.ts  every move of the learner or the screen: a new run, saved, the thread cut back to what
//             it shares with the one shown, a path shown at once;
//   modal.ts  a panel over the dialogue (the History, the debrief), the rest dimmed and inert.
//
// Not part of the pure walk: the core never imports this file.

import { element, uniqueId } from '../dom.ts';
import { icon } from '../icons.ts';
import type { CourseState, TriggerInfo } from '../course-state.ts';
import type { DialogueBlock, TriggerType } from '../course-data.ts';
import type { Labels } from '../labels.ts';
import type { Interaction } from '../scorm12.ts';
import { presentationOf } from './walk.ts';
import type { DialogueWalk } from './walk.ts';
import { canRestart, restart, jump, scoredDone, openDialogue } from './run.ts';
import type { DialogueData } from './types.ts';
import { createClock } from './playback.ts';
import type { DialogueClock } from './playback.ts';
import type { ThreadContext } from './thread.ts';
import { prefersLessMotion } from './view-parts.ts';
import type { DialogueHost, Phase, ViewParts, ViewState } from './view-parts.ts';
import { createThreadBox } from './box.ts';
import { createCast } from './cast.ts';
import { createLines } from './lines.ts';
import { createRoom } from './room.ts';
import { createMoves } from './moves.ts';
import { createModal } from './modal.ts';

export type { DialogueHost };

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
  phase: Phase;
  node: string;
  status: DialogueWalk['status'];
  presented: number;
  beats: number;
  line: string | null;
  time: number | null;
  paused: boolean;
  // The dialogue waits for the learner (« Suite »).
  waiting: boolean;
  path: string[];
  scored: string[] | null;
  explored: string[];
  endings: string[];
  ending: string | null;
}

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
    let startButton = find('start') as HTMLButtonElement | null;
    const measureLog = element('div', { class: `${log.className} t-dialogue-measure`, 'aria-hidden': 'true' });
    const measureRoom = element('div', { class: `${room.className} t-dialogue-measure`, 'aria-hidden': 'true' });
    root.append(measureLog, measureRoom);

    const state: ViewState = { run: courseState.dialogueRun(block), beats: [], presented: 0, phase: 'idle', step: null, paused: false, disposed: false };
    state.beats = state.run.walk.beats;
    let holding = false;
    const reduced = () => prefersLessMotion();
    const instant = () => still || reduced() || host().instantText() || data.reveal === 'instant';
    const parts: ViewParts = {
      block, data, wrap, root, log, room, stage, debriefHost: find('debrief'), measureLog, measureRoom, thread, labels, language,
      learnerSpeaker: data.learner ?? undefined, voiced, still, clock, host,
      reduced, instant, revealMode: () => (instant() ? 'instant' : data.reveal), rate: () => host().prefs().rate || 1
    };

    const modal = createModal(root);
    const box = createThreadBox(parts, { modal, reserveRoom: (scene) => roomView.reserveRoom(scene), disposed: () => state.disposed });
    const cast = createCast(parts, state);
    cast.setScene(data.scene, false);
    box.syncLogFocusable();
    const roomView = createRoom(parts, state, { box, modal, move: (next, options) => moves.move(next, options), next, pause, resume });
    const lines = createLines(parts, state, {
      box, cast, trigger, next, setHolding,
      shownBeat: (index) => moves.shownBeat(index), record: (index, ...nodes) => moves.record(index, ...nodes), revisit: (decision) => moves.revisit(decision)
    });
    const moves = createMoves(parts, state, { courseState, recordInteraction, trigger, box, cast, lines, room: roomView, play: () => { tick(); loop(); } });

    // ── The loop: one step at a time, beats in order ──
    function tick() {
      if (state.disposed) return;
      if (!wrap.isConnected) { dispose(); return; }
      roomView.syncTurn();
      if (state.phase !== 'playing' || state.paused) return;
      for (let guard = 0; guard < 400 && state.phase === 'playing'; guard++) {
        const step = state.step;
        if (step) {
          if (step.kind === 'line') {
            if (!lines.tickLine(step.state)) return;
            const done = step.state;
            state.step = lines.after(done.index, done.chars, !!done.voice.src);
            continue;
          }
          if (step.kind === 'wait') { if (clock.now() < step.until) return; lines.consumeTyping(step); state.step = null; continue; }
          if (step.kind === 'turn') { if (clock.now() < step.until) return; const then = step.then; state.step = null; state.step = then(); continue; }
          if (step.kind === 'click') { roomView.syncTurn(); return; }
        }
        if (state.presented >= state.beats.length) { settle(); return; }
        const index = state.presented++;
        state.step = lines.present(index, true, lines.takeTyping(index));
        if (state.disposed) return;
      }
    }

    // Every beat presented: a decision waits, or the dialogue has ended.
    function settle() {
      setHolding(false);
      state.step = null;
      lines.dropTyping();
      if (state.run.walk.status === 'choosing') { state.phase = 'choosing'; roomView.showOptions(); }
      else { state.phase = 'ended'; roomView.showEnd(); }
      moves.syncTools();
      moves.syncRetry();
    }

    // « Suite » (or Entrée, or a click on a bubble while the dialogue waits): the line being said ends
    // there (its voice stops, its words all in ink, its cues come), and the next beat comes. Quiet while
    // the dialogue goes on by itself, it still answers: a learner who has read ahead never waits.
    function next() {
      if (state.phase !== 'playing') return;
      if (state.paused) resume();
      const step = state.step;
      if (step?.kind === 'line') {
        step.state.playback.stop();
        lines.tickLine(step.state);
        state.step = null;
      } else if (step?.kind === 'wait' || step?.kind === 'click') { lines.consumeTyping(step); state.step = null; }
      tick();
      loop();
    }
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target !== log && target !== room && target !== root) return;
      if (state.phase !== 'playing') return;
      event.preventDefault();
      next();
    });

    function pause() {
      if (state.paused || state.phase !== 'playing') return;
      state.paused = true;
      clock.pause();
      if (state.step?.kind === 'line') state.step.state.playback.pause();
      cast.setPaused(true);
      root.toggleAttribute('data-t-paused', true);
      roomView.syncTurn();
    }
    function resume() {
      if (!state.paused) return;
      state.paused = false;
      clock.resume();
      if (state.step?.kind === 'line') state.step.state.playback.resume();
      cast.setPaused(false);
      root.toggleAttribute('data-t-paused', false);
      roomView.syncTurn();
      loop();
    }
    function setHolding(on: boolean) {
      if (still || on === holding) return;
      holding = on;
      if (on) host().hold(`dialogue:${block.id}`); else host().release(`dialogue:${block.id}`);
    }

    // ── Beginning ──
    function begin() {
      if (state.phase !== 'idle' || state.disposed) return;
      startButton?.closest('.t-dialogue-start')?.setAttribute('hidden', '');
      if (startButton) startButton.hidden = true;
      if (still) { moves.renderAll(); return; }
      trigger('dialogue.started', { target: block.id });
      if (state.disposed) return;
      state.phase = 'playing';
      // The first bubble's « … » (messaging without a voice).
      const typing = state.presented === 0 ? lines.typingFor(0) : null;
      if (typing) state.step = { kind: 'wait', until: clock.now() + 0.7 / parts.rate(), typing };
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
      if (state.phase !== 'idle' || data.begins !== 'auto') return;
      if (shownNow() && (inView || !observer || visibleNow())) begin();
    }

    // Saved progress: the path shown at once (back on the screen); the editor shows the first turn.
    const resumed = state.run.progress.path.length > 0 || state.run.walk.status === 'ended';
    if (resumed || still) {
      if (startButton) { startButton.hidden = true; startButton.closest('.t-dialogue-start')?.setAttribute('hidden', ''); }
      moves.renderAll();
    } else {
      roomView.setRoom('idle', []);
      if (data.begins === 'click') {
        if (!startButton) { startButton = element('button', { type: 'button', class: 't-btn t-btn--primary t-dialogue-start-btn' }) as HTMLButtonElement; roomView.setRoom('idle', [element('div', { class: 't-dialogue-start' }, startButton)]); }
        startButton.type = 'button';
        if (!startButton.textContent?.trim()) startButton.append(icon('play'), element('span', { text: labels.dialogueStart }));
        // The dialogue's name above it (the dialogue is already named for screen readers).
        if (startButton.parentElement && !startButton.parentElement.querySelector('.t-dialogue-start-title')) startButton.before(element('p', { class: 't-dialogue-start-title', 'aria-hidden': 'true', text: data.title }));
        startButton.addEventListener('click', () => { begin(); room.focus({ preventScroll: true }); });
      } else if (startButton) { startButton.hidden = true; startButton.closest('.t-dialogue-start')?.setAttribute('hidden', ''); }
      observer?.observe(wrap);
    }

    function afterShow() {
      box.observe();
      box.layout();
      document.fonts?.ready.then(() => box.layout());
      // What a resumed path left on the screen: blocks shown or hidden, props, the step (no layer opens).
      if (resumed && !still) host().present(presentationOf({ beats: state.beats.slice(0, state.presented) }));
      checkBegin();
    }

    function dispose() {
      if (state.disposed) return;
      state.disposed = true;
      if (state.step?.kind === 'line') state.step.state.playback.dispose();
      setHolding(false);
      observer?.disconnect();
      box.dispose();
      cast.dispose();
      controllers.delete(block.id);
    }

    const controller: Controller = {
      block, wrap, clock,
      // Waiting for « Suite », nothing moves: no frame until the learner goes on.
      active: () => !state.disposed && state.phase === 'playing' && !state.paused && state.step?.kind !== 'click',
      tick, begin, checkBegin, afterShow,
      goto(node: string) { try { moves.move(jump(state.run, node)); } catch { /* not a node of this dialogue (the validator says so) */ } },
      restartRun() {
        const run = state.run;
        if (canRestart(run)) { moves.move(restart(run), { started: true }); return; }
        // Outside its policy, the screen may start it over once its first run is done: the scored run stays.
        if (scoredDone(run)) moves.move(openDialogue(data, { ...run.progress, path: [], scored: run.progress.scored ?? run.progress.path.slice() }, run.env), { started: true });
      },
      pause,
      showPath: moves.showPath,
      showLine: moves.showLine,
      state(): DialogueViewState {
        const { run, step } = state;
        return {
          phase: state.phase, node: run.walk.node, status: run.walk.status, presented: state.presented, beats: state.beats.length,
          line: step?.kind === 'line' ? step.state.line?.id ?? null : null, time: step?.kind === 'line' ? step.state.playback.time() : null, paused: state.paused, waiting: step?.kind === 'click',
          path: run.progress.path.slice(), scored: run.progress.scored?.slice() ?? null, explored: run.progress.explored.slice(), endings: run.progress.endings.slice(), ending: run.walk.ending?.id ?? null
        };
      },
      transcript: moves.transcript,
      next,
      choose: roomView.chooseOption,
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
