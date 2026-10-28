// The room under a dialogue's thread (D61): a turn's controls while it plays, the options of the
// decision waiting and the learner's choice, the end's controls and the debrief. In slides the room
// keeps the height of the tallest set of options, so that nothing moves the slide. Not part of the
// pure walk.

import { element } from '../dom.ts';
import { nodeOf, optionOf } from './walk.ts';
import { choose, canRevisit, canRestart, restart, scoredDone, scoredResult } from './run.ts';
import type { DialogueRun } from './run.ts';
import { optionsContent, turnControls, syncTurnControls, endControls, debriefCard } from './thread.ts';
import type { TurnControls, DebriefDecision } from './thread.ts';
import { cssPx, phone } from './view-parts.ts';
import type { ViewParts, ViewState } from './view-parts.ts';
import type { ThreadBox } from './box.ts';

export type Room = ReturnType<typeof createRoom>;

export function createRoom(parts: ViewParts, state: ViewState, { box, move, next, pause, resume }: {
  box: ThreadBox;
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
      const step = state.step;
      syncTurnControls(thread, turn, { paused: state.paused, muted: host().prefs().muted, whole: step?.kind !== 'line' || step.state.whole, click: step?.kind === 'click' });
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
      debrief: data.debrief && overlaidDebrief() ? { open: debriefOpen, toggle: () => { debriefOpen = !debriefOpen; renderDebrief(); showEnd(); room.querySelector<HTMLElement>('.t-dialogue-debrief-toggle')?.focus(); } } : null
    })]);
    renderDebrief();
  }
  // The decision the learner may go back to last (« Revenir à un choix »).
  function lastRevisitable(): number | null {
    for (let i = state.run.walk.decisions.length - 1; i >= 0; i--) if (canRevisit(state.run, i)) return i;
    return null;
  }
  function focusResume(decision: number) {
    if (debriefOpen && overlaidDebrief()) { debriefOpen = false; renderDebrief(); showEnd(); }
    const button = log.querySelector<HTMLElement>(`.t-dialogue-row[data-decision="${decision}"] .t-dialogue-resume`);
    if (!button) return;
    button.closest('.t-dialogue-row')?.scrollIntoView?.({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    button.focus({ preventScroll: true });
  }

  // ── The debrief ──
  // In slides the debrief comes over the thread (its box keeps its size); in scroll pages, under it.
  const overlaidDebrief = () => host().slides() || data.style === 'scene';
  function renderDebrief() {
    const target = debriefHost;
    if (!data.debrief) return;
    if (state.phase !== 'ended') { if (target) { target.replaceChildren(); target.hidden = true; } root.removeAttribute('data-t-debrief-open'); return; }
    const card = debriefCard(thread, debriefOf());
    if (target) {
      target.replaceChildren(card);
      target.hidden = overlaidDebrief() && !debriefOpen;
      // Over the thread it scrolls in its box: a region the keyboard reaches.
      if (overlaidDebrief()) { target.tabIndex = 0; target.setAttribute('role', 'region'); target.setAttribute('aria-label', labels.dialogueDebrief); }
    }
    else if (!log.querySelector('.t-dialogue-debrief-card')) { const row = element('div', { class: 't-dialogue-row', 'data-role': 'debrief' }, card); box.insert(row); }
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
    if (debriefHost) { debriefHost.replaceChildren(); debriefHost.hidden = true; }
    for (const row of log.querySelectorAll('.t-dialogue-row[data-role="debrief"]')) row.remove();
    root.removeAttribute('data-t-debrief-open');
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
    sets.push([endControls(thread, { found: 1, total: Math.max(1, data.endings.length), back: data.revisit !== 'none' ? () => {} : null, restart: data.revisit !== 'none' ? () => {} : null, debrief: data.debrief ? { open: true, toggle: () => {} } : null })]);
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
