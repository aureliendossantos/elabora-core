// The room under a dialogue's thread (D61): a turn's controls while it plays, the options of the
// decision waiting and the learner's choice, the end's controls and the debrief (a panel over the
// thread in slides and scenes, under it in scroll pages). In slides the room keeps the height of the
// tallest set of options, so that nothing moves the slide. Not part of the pure walk.

import { element } from '../dom.ts';
import { nodeOf, optionOf } from './walk.ts';
import { choose, canRevisit, canRestart, restart, scoredDone, scoredResult } from './run.ts';
import type { DialogueRun } from './run.ts';
import { optionsContent, turnControls, syncTurnControls, endControls, debriefCard, closeButton } from './thread.ts';
import type { TurnControls, DebriefDecision } from './thread.ts';
import { cssPx } from './view-parts.ts';
import type { ViewParts, ViewState } from './view-parts.ts';
import type { ThreadBox } from './box.ts';
import type { DialogueModal } from './modal.ts';

export type Room = ReturnType<typeof createRoom>;

export function createRoom(parts: ViewParts, state: ViewState, { box, modal, move, next, pause, resume }: {
  box: ThreadBox;
  modal: DialogueModal;
  move(next: DialogueRun, options?: { chosen?: { node: string; option: string }; started?: boolean; keepRoom?: boolean }): void;
  next(): void;
  pause(): void;
  resume(): void;
}) {
  const { data, root, log, room, debriefHost, measureRoom, thread, labels, voiced, still, clock } = parts;
  const reduced = parts.reduced;
  const host = () => parts.host();

  let turn: TurnControls | null = null;
  // The options chosen from fade where they are before the turn's controls take the room.
  let roomHeldUntil = 0;
  let debriefOpen = true;

  function setRoom(kind: string, nodes: HTMLElement[], describedBy: string | null = null) {
    const focused = room.contains(document.activeElement) && document.activeElement !== room;
    room.dataset.tState = kind;
    room.replaceChildren(...nodes);
    if (describedBy) room.setAttribute('aria-describedby', describedBy); else room.removeAttribute('aria-describedby');
    // The focus never falls to the page: it stays on the group (« Votre réponse »).
    if (focused && !room.contains(document.activeElement)) room.focus({ preventScroll: true });
  }

  // ── While a turn plays: pause, « couper les voix », « Suite » ──
  function syncTurn() {
    if (state.phase === 'playing' && !still && clock.now() >= roomHeldUntil) {
      if (!turn || room.dataset.tState !== 'playing') {
        turn = turnControls(thread, voiced, { pause: () => (state.paused ? resume() : pause()), mute: () => { const prefs = host().prefs(); prefs.muted = !prefs.muted; syncTurn(); }, next });
        setRoom('playing', [turn.root]);
      }
      syncTurnControls(thread, turn, { paused: state.paused, muted: host().prefs().muted, waiting: state.step?.kind === 'click' });
    }
  }
  // A new run plays: the room empties (unless the options chosen from still fade there).
  function play(keepRoom: boolean) {
    if (!keepRoom) setRoom('playing', []);
    turn = null;
    // A turn's controls never steal the focus from the options' group.
    if (room.contains(document.activeElement) && document.activeElement !== room && !keepRoom) room.focus({ preventScroll: true });
  }

  // ── The decision waiting ──
  function showOptions() {
    const run = state.run;
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
  function chooseOption(option: string) {
    if (state.phase !== 'choosing') return;
    let moved: DialogueRun;
    try { moved = choose(state.run, option); } catch { return; }
    const node = state.run.walk.node;
    // The others fade where they are; the room keeps its height until the next options come.
    for (const button of room.querySelectorAll<HTMLElement>('.t-dialogue-choice')) button.classList.add(button.dataset.option === option ? 'is-chosen' : 'is-leaving');
    room.style.minHeight = room.style.minHeight || `${cssPx(room, room.getBoundingClientRect().height)}px`;
    room.dataset.tState = 'chosen';
    room.focus({ preventScroll: true });
    roomHeldUntil = still || reduced() ? 0 : clock.now() + 0.2;
    move(moved, { chosen: { node, option }, keepRoom: true });
  }

  // ── The end ──
  function showEnd() {
    if (!host().slides()) room.style.minHeight = '';
    const run = state.run;
    const result = scoredResult(run);
    const back = lastRevisitable();
    setRoom('ended', [endControls(thread, {
      found: result.endingsFound, total: result.endingsTotal,
      back: back === null ? null : () => focusResume(back),
      restart: canRestart(run) ? () => move(restart(run), { started: true }) : null,
      debrief: data.debrief && overlaidDebrief() ? () => setDebrief(true) : null
    })]);
    renderDebrief();
  }
  // The decision the learner may go back to last (« Revenir à un choix »).
  function lastRevisitable(): number | null {
    for (let i = state.run.walk.decisions.length - 1; i >= 0; i--) if (canRevisit(state.run, i)) return i;
    return null;
  }
  function focusResume(decision: number) {
    if (root.hasAttribute('data-t-debrief-open')) setDebrief(false);
    const button = log.querySelector<HTMLElement>(`.t-dialogue-row[data-decision="${decision}"] .t-dialogue-resume`);
    if (!button) return;
    button.closest('.t-dialogue-row')?.scrollIntoView?.({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    button.focus({ preventScroll: true });
  }

  // ── The debrief ──
  // In slides (and scenes) the debrief is a panel over the thread, open at the end, the rest of the
  // dialogue dimmed (modal.ts); « Voir le bilan » opens it again. In scroll pages, it comes under it.
  const overlaidDebrief = () => host().slides() || data.style === 'scene';
  const debriefToggle = () => room.querySelector<HTMLElement>('.t-dialogue-debrief-toggle');
  function setDebrief(open: boolean) {
    debriefOpen = open;
    renderDebrief(open);
  }
  function renderDebrief(asked = false) {
    const target = debriefHost;
    if (!data.debrief) return;
    if (state.phase !== 'ended') { closeDebrief(); if (target) { target.replaceChildren(); target.hidden = true; } return; }
    const card = debriefCard(thread, debriefOf());
    if (!target) {
      if (!log.querySelector('.t-dialogue-debrief-card')) box.insert(element('div', { class: 't-dialogue-row', 'data-role': 'debrief' }, card));
      return;
    }
    const over = overlaidDebrief();
    const focused = target.contains(document.activeElement);
    target.replaceChildren(...(over ? [closeButton(thread, () => setDebrief(false))] : []), card);
    if (focused) target.focus({ preventScroll: true });
    if (!over) { target.hidden = false; return; }
    // A panel that scrolls in its box: the keyboard reaches it.
    target.tabIndex = 0;
    target.setAttribute('role', 'dialog');
    target.setAttribute('aria-label', labels.dialogueDebrief);
    if (!debriefOpen) { closeDebrief(); target.hidden = true; return; }
    target.hidden = false;
    if (root.hasAttribute('data-t-debrief-open')) return;
    root.setAttribute('data-t-debrief-open', '');
    modal.show({ keep: [target], close: () => setDebrief(false), focus: target, asked });
  }
  function closeDebrief() {
    if (!root.hasAttribute('data-t-debrief-open')) return;
    root.removeAttribute('data-t-debrief-open');
    modal.hide(debriefToggle());
  }
  // The debrief of the run shown: the scored run's first choices (what counted), else the choices kept.
  function debriefOf() {
    const run = state.run;
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
  // A cut back: the debrief goes, and opens again at the next end.
  function clearDebrief() {
    closeDebrief();
    if (debriefHost) { debriefHost.replaceChildren(); debriefHost.hidden = true; }
    for (const row of log.querySelectorAll('.t-dialogue-row[data-role="debrief"]')) row.remove();
    debriefOpen = true;
  }

  // ── Slides: the room keeps the height of the tallest of its contents ──
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
    sets.push([endControls(thread, { found: 1, total: Math.max(1, data.endings.length), back: data.revisit !== 'none' ? () => {} : null, restart: data.revisit !== 'none' ? () => {} : null, debrief: data.debrief ? () => {} : null })]);
    if (!still) sets.push([turnControls(thread, voiced, { pause: () => {}, mute: () => {}, next: () => {} }).root]);
    for (const set of sets) {
      measureRoom.replaceChildren(...set);
      tallest = Math.max(tallest, cssPx(measureRoom, measureRoom.getBoundingClientRect().height));
    }
    measureRoom.replaceChildren();
    room.style.minHeight = `${Math.ceil(tallest)}px`;
  }

  return { setRoom, syncTurn, play, showOptions, chooseOption, showEnd, clearDebrief, reserveRoom };
}
