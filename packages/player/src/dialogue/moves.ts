// A dialogue's run in the thread (D61): every move of the learner (a choice, « Choisir autrement »,
// « Reprendre d'ici », « Changer ce choix », « Recommencer ») or of the screen (goto-dialogue) gives a
// new run, which is saved (its first end records the scored interactions once); the thread keeps the
// beats it shares with the run shown, lets the rest go in a fade, and the new beats are presented.
// Going back says where the thread goes on (« Vous reprenez ici », « Nouvel essai ») and marks the
// choice taken back among the options; « Recommencer » starts the whole dialogue again. Back on the
// screen (or in the editor's canvas), the path is replayed and shown at once. Not part of the pure walk.

import type { CourseState, TriggerInfo } from '../course-state.ts';
import type { TriggerType } from '../course-data.ts';
import type { Interaction } from '../scorm12.ts';
import { nodeOf, optionOf, expressionsOf, replay as replayWalk } from './walk.ts';
import type { DialogueWalk } from './walk.ts';
import { explorePaths } from './paths.ts';
import { choose, canRetryLast, retryLast, canRevisit, revisit, jump, scoredResult, openDialogue } from './run.ts';
import type { DialogueRun } from './run.ts';
import { retryRow, markerRow, speakerName } from './thread.ts';
import type { ViewParts, ViewState } from './view-parts.ts';
import type { ThreadBox } from './box.ts';
import type { Cast } from './cast.ts';
import type { Lines } from './lines.ts';
import type { Room } from './room.ts';

export type Moves = ReturnType<typeof createMoves>;

export interface MoveOptions {
  chosen?: { node: string; option: string };
  started?: boolean;
  live?: boolean;
  keepRoom?: boolean;
  // The learner went back: « Choisir autrement » (retry), « Changer ce choix » or « Reprendre d'ici »
  // (revisit), « Recommencer » (restart, the whole dialogue again).
  back?: 'retry' | 'revisit' | 'restart';
}

export function createMoves(parts: ViewParts, state: ViewState, { courseState, recordInteraction, trigger, box, cast, lines, room, play }: {
  courseState: CourseState;
  recordInteraction(interaction: Interaction): void;
  trigger(type: TriggerType, info: TriggerInfo): void;
  box: ThreadBox;
  cast: Cast;
  lines: Lines;
  room: Room;
  // The dialogue plays from where it is (view.ts: its loop).
  play(): void;
}) {
  const { block, data, root, log, thread, learnerSpeaker, still, clock } = parts;
  const reduced = parts.reduced;
  // What each beat shown put in the thread, by its key (a key changes when the beat would show otherwise).
  const shown: { key: string; nodes: HTMLElement[] }[] = [];
  let retry: HTMLElement | null = null;
  let leavingCount = 0;
  // « Vous reprenez ici »: where the path shown begins again, before the beat at (one at a time: the
  // last place the learner went back to).
  let marker: { node: HTMLElement; at: number } | null = null;

  const keyOf = (walk: DialogueWalk, index: number): string => {
    const beat = walk.beats[index];
    switch (beat.type) {
      case 'node': case 'jump': return `${beat.type}:${beat.node}`;
      case 'line': return `l:${beat.node}:${beat.option ?? ''}:${beat.line.id}:${beat.line.text}`;
      case 'sound': return `s:${beat.node}:${beat.option ?? ''}:${beat.line.id}`;
      case 'decision': return `d:${beat.decision}:${beat.node}:${walk.decisions[beat.decision]?.tries.filter((attempt) => attempt.by === 'return').map((attempt) => attempt.option).join(',') ?? ''}`;
      case 'choice': return `c:${beat.decision}:${beat.node}.${beat.option}`;
      case 'actions': case 'feedback': return `${beat.type}:${beat.node}.${beat.option}`;
      case 'retry': return `r:${beat.decision}:${beat.node}.${beat.option}`;
      case 'end': return `e:${beat.ending ?? ''}`;
    }
  };
  const shownBeat = (index: number) => { shown[index] = { key: keyOf(state.run.walk, index), nodes: [] }; };
  const record = (index: number, ...nodes: HTMLElement[]) => { (shown[index] ??= { key: keyOf(state.run.walk, index), nodes: [] }).nodes.push(...nodes); };

  // A new run: saved (its first end records the scored interactions once), the beats it shares with
  // the one shown kept, the rest gone in a fade, the new ones presented.
  function move(next: DialogueRun, { chosen, started, live = !still, keepRoom = false, back }: MoveOptions = {}) {
    const saved = courseState.saveDialogue(block.id, next);
    if (saved.finished) recordInteractions(saved.interactions);
    const before = state.run;
    state.run = next;
    state.beats = next.walk.beats;
    let common = 0;
    // « Recommencer » says the whole dialogue again, from its first line.
    if (back !== 'restart') while (common < shown.length && common < state.beats.length && shown[common]?.key === keyOf(next.walk, common)) common++;
    // What extends the run shown (a choice) keeps every beat; anything else cuts back.
    const cutting = state.presented > common || shown.length > common;
    if (cutting) cut(common, live && back ? markerRow(thread, back === 'restart') : null);
    state.previous = back === 'retry' || back === 'revisit' ? previousOf(before, next) : null;
    if (chosen) trigger('dialogue.chosen', { target: block.id, node: chosen.node, option: chosen.option });
    if (started) trigger('dialogue.started', { target: block.id });
    if (state.disposed) return;
    syncTools();
    syncRetry();
    if (!live) { renderAll(); return; }
    if (back && cutting) parts.signal('back', { kind: back });
    state.phase = 'playing';
    room.play(keepRoom);
    // Gone bubbles take their fade before the new ones come.
    if (!state.step && leavingCount > 0 && !reduced()) state.step = { kind: 'wait', until: clock.now() + 0.2, typing: null };
    play();
  }
  // The thread cut back to the beat common; a move back puts its marker there, where the path goes on.
  function cut(common: number, mark: HTMLElement | null = null) {
    lines.drop();
    cast.rest();
    const leaving = shown.slice(common).flatMap((entry) => entry?.nodes ?? []);
    if (marker && (marker.at >= common || mark)) { leaving.push(marker.node); marker = null; }
    if (mark) {
      const first = leaving.find((node) => node.isConnected && node.parentElement === log);
      if (first) first.before(mark); else box.insert(mark);
      marker = { node: mark, at: common };
    }
    leave(leaving);
    // The learner sees where the thread goes on while what came after fades: the thread (or the
    // page) brings the marker into view.
    if (mark) showMarker(mark);
    shown.length = Math.min(shown.length, common);
    state.presented = Math.min(state.presented, common);
    cast.setExpressions(expressionsOf({ beats: state.beats.slice(0, state.presented) }));
    retry?.remove();
    retry = null;
    room.clearDebrief();
    if (box.paging()) box.repage();
  }
  // What leaves the thread fades where it is; then the rows kept glide to where they now stand (the
  // thread anchored at its bottom comes back down), unless less motion is asked.
  function leave(nodes: HTMLElement[]) {
    const going = nodes.filter((node) => node.isConnected);
    if (!going.length) return;
    if (still || reduced()) { for (const node of going) node.remove(); if (box.paging()) box.repage(); return; }
    leavingCount++;
    for (const node of going) node.classList.add('is-leaving');
    setTimeout(() => {
      leavingCount--;
      if (state.disposed) { for (const node of going) node.remove(); return; }
      // Tests' pages run no animation: what would glide stays where it is.
      const glide = !parts.host().virtual && !reduced();
      const kept = glide ? [...log.children].filter((row): row is HTMLElement => row instanceof HTMLElement && !going.includes(row) && !row.classList.contains('is-leaving')) : [];
      const tops = kept.map((row) => row.getBoundingClientRect().top);
      for (const node of going) node.remove();
      // A scene's page: the last rows kept that fit, the marker with them.
      if (box.paging()) box.repage();
      kept.forEach((row, i) => {
        const by = tops[i] - row.getBoundingClientRect().top;
        if (Math.abs(by) > 0.5) row.animate?.([{ translate: `0 ${by}px` }, { translate: '0 0' }], { duration: 280, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
      });
    }, 200);
  }
  function showMarker(mark: HTMLElement) {
    const smooth = !still && !reduced() && !parts.host().virtual;
    if (getComputedStyle(log).overflowY === 'auto') {
      const bottom = mark.getBoundingClientRect().bottom - log.getBoundingClientRect().top + log.scrollTop;
      log.scrollTo?.({ top: Math.max(0, bottom - log.clientHeight), behavior: smooth ? 'smooth' : 'auto' });
    // A scroll page brings it into the window; a scene's page shows it once what leaves is gone.
    } else if (!parts.host().slides() && !box.paging()) mark.scrollIntoView?.({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  }
  // The choice taken back, when its decision waits again.
  function previousOf(before: DialogueRun, next: DialogueRun): ViewState['previous'] {
    const waiting = next.walk.status === 'choosing' ? next.walk.decisions.at(-1) : undefined;
    const old = waiting ? before.walk.decisions[waiting.index] : undefined;
    return waiting && old?.node === waiting.node && old.choice ? { node: old.node, option: old.choice } : null;
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
      button.hidden = !(Number.isInteger(decision) && canRevisit(state.run, decision) && state.phase !== 'playing');
    }
  }
  function syncRetry() {
    const walk = state.run.walk;
    const last = [...walk.decisions].reverse().find((decision) => decision.closed && !decision.auto);
    const wanted = !!last && last.choice !== null && canRetryLast(state.run) && state.phase !== 'playing';
    if (!wanted || !last) { retry?.remove(); retry = null; return; }
    // After the beats of its consequence (up to the next node).
    const choice = walk.beats.findIndex((beat) => beat.type === 'choice' && beat.decision === last.index && !beat.auto && beat.option === last.choice);
    if (choice < 0) { retry?.remove(); retry = null; return; }
    let end = choice;
    while (end + 1 < walk.beats.length && !['node', 'jump', 'end', 'decision'].includes(walk.beats[end + 1].type)) end++;
    if (end >= state.presented) return;
    const anchor = [...shown.slice(choice, end + 1)].reverse().flatMap((entry) => entry?.nodes ?? []).find((node) => node.isConnected);
    if (!anchor) return;
    if (!retry) retry = retryRow(thread, () => { if (canRetryLast(state.run)) move(retryLast(state.run), { back: 'retry' }); });
    if (anchor.nextElementSibling !== retry) anchor.after(retry);
  }

  // ── Showing at once: back on the screen, the editor's canvas, a jump of the canvas ──
  function renderAll() {
    // Shown at once: no row comes in a fade.
    root.setAttribute('data-t-quiet', '');
    requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute('data-t-quiet')));
    for (; state.presented < state.beats.length; state.presented++) lines.present(state.presented, false);
    cast.speak(undefined, false, 'closed', null);
    box.repage();
    box.scrollLog(false);
    if (state.run.walk.status === 'choosing') { state.phase = 'choosing'; room.showOptions(); } else { state.phase = 'ended'; room.showEnd(false); }
    syncTools();
    syncRetry();
  }
  // The editor's canvas: the dialogue after these choices (option ids, in order), at a node.
  function showPath(choices: readonly string[], node?: string) {
    let next = openDialogue(data, { path: [], scored: null, explored: [], endings: [] }, state.run.env);
    for (const option of choices) { try { next = choose(next, option); } catch { break; } }
    if (node && next.walk.node !== node && nodeOf(data, node)) next = jump(next, node);
    state.phase = 'idle';
    cut(0);
    log.replaceChildren();
    state.run = next;
    state.beats = next.walk.beats;
    state.presented = 0;
    shown.length = 0;
    renderAll();
  }
  // The Review (docs/review-bridge.md): a line of the dialogue, a node's or a reply's (or an option
  // the learner's voice says, <node>.<option>), shown at rest where it comes: on the thread when it
  // is there, else after the choices of the first path that says it.
  function showLine(line: string): boolean {
    const says = (walk: DialogueWalk) => walk.beats.some((beat) => (beat.type === 'line' && beat.line.id === line) || (beat.type === 'choice' && `${beat.node}.${beat.option}` === line));
    const there = () => log.querySelector<HTMLElement>(`.t-dialogue-row[data-line="${CSS.escape(line)}"]`);
    if (!there() || state.phase === 'playing') {
      const path = says(state.run.walk) ? { entries: state.run.walk.entries } : explorePaths(data, { env: state.run.env, limit: 200 }).paths.find((candidate) => says(candidate.walk));
      if (!path) return false;
      let count = 0;
      while (count < path.entries.length && !says(replayWalk(data, path.entries.slice(0, count), state.run.env))) count++;
      showPath(path.entries.slice(0, count).map((entry) => entry.slice(entry.lastIndexOf('.') + 1)));
    }
    const row = there();
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    return true;
  }
  // The path shown, for the screen's transcript.
  function transcript(): { title: string; lines: { speaker?: string; text: string }[] } | null {
    const said: { speaker?: string; text: string }[] = [];
    for (const beat of state.beats.slice(0, state.presented)) {
      if (beat.type === 'line') said.push({ ...(beat.role === 'narration' ? {} : { speaker: speakerName(thread, beat.line.speaker, beat.role === 'learner') }), text: beat.line.text });
      else if (beat.type === 'choice') { const option = optionOf(data, beat.node, beat.option); if (option?.text) said.push({ speaker: speakerName(thread, learnerSpeaker, true), text: option.text }); }
      else if (beat.type === 'sound' && beat.line.caption) said.push({ text: beat.line.caption });
    }
    return said.length ? { title: data.title, lines: said } : null;
  }

  return {
    shownBeat, record, move, renderAll, showPath, showLine, transcript, syncTools, syncRetry,
    revisit(decision: number) { if (canRevisit(state.run, decision)) move(revisit(state.run, decision), { back: 'revisit' }); }
  };
}
