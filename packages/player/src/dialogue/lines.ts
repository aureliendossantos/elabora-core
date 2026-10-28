// A dialogue's beats in the thread (D61): each line inserted whole and said by its voice (its audio,
// its words lit as they are said, its character's mouth and gestures, its cues), the learner's
// answer, the trainer's note, the end; then the pause, the click or the page turn before the next
// beat. Not part of the pure walk.

import { textVoice, voiceAt } from '../character/index.ts';
import type { TriggerInfo } from '../course-state.ts';
import type { TriggerType } from '../course-data.ts';
import { nodeOf, optionOf } from './walk.ts';
import type { Beat } from './walk.ts';
import type { DialogueLineData, DialogueOptionData, LineVoiceData } from './types.ts';
import { createLinePlayback, replayVoice, cueTime } from './playback.ts';
import { bubbleRow, typingRow, paintWords, showAllWords, noteRow, firstChoiceRow, endRow } from './thread.ts';
import type { BubbleRow } from './thread.ts';
import { clamp, phone } from './view-parts.ts';
import type { LineState, Step, Typing, ViewParts, ViewState } from './view-parts.ts';
import type { ThreadBox } from './box.ts';
import type { Cast } from './cast.ts';

export type Lines = ReturnType<typeof createLines>;

export function createLines(parts: ViewParts, state: ViewState, { box, cast, shownBeat, record, revisit, trigger, next, pause, resume, setHolding }: {
  box: ThreadBox;
  cast: Cast;
  // What each beat shown put in the thread (moves.ts): a beat begins, its nodes.
  shownBeat(index: number): void;
  record(index: number, ...nodes: HTMLElement[]): void;
  // « Reprendre d'ici » on a past answer of the learner.
  revisit(decision: number): void;
  trigger(type: TriggerType, info: TriggerInfo): void;
  next(): void;
  pause(): void;
  resume(): void;
  setHolding(on: boolean): void;
}) {
  const { block, data, log, root, thread, language, learnerSpeaker, still, clock } = parts;
  const { instant, rate } = parts;
  const host = () => parts.host();
  let stopReplay: (() => void) | null = null;
  // The bubble to come, waiting in the thread: handed to the line it announces.
  let pendingTyping: Typing = null;

  // The last bubble of the thread: a series goes on while the same speaker speaks.
  const lastRow = (): HTMLElement | null => {
    const rows = log.querySelectorAll<HTMLElement>(':scope > .t-dialogue-row:not(.t-dialogue-typing):not(.is-leaving)');
    return rows[rows.length - 1] ?? null;
  };
  const continues = (role: string, speaker: string | undefined) => {
    const last = lastRow();
    return !!last && last.dataset.role === role && (last.dataset.speaker ?? '') === (speaker ?? '');
  };

  // A line's row (and the choice bubble of the learner, which is a line of theirs without id).
  function lineRow(index: number, role: 'character' | 'learner' | 'narration', speaker: string | undefined, text: string, voice: LineVoiceData, options: { decision?: number; line?: string }): BubbleRow {
    const first = role !== 'narration' && !continues(role, speaker);
    const built = bubbleRow(thread, {
      role, side: cast.sideOf(role, speaker), speaker, text, first, voiced: !!voice.src && !still, resumable: options.decision !== undefined, letters: data.reveal === 'appear', line: options.line
    });
    if (options.decision !== undefined) built.row.dataset.decision = String(options.decision);
    built.row.dataset.beat = String(index);
    if (built.replay) built.replay.addEventListener('click', () => replay(voice, built));
    if (built.listen) built.listen.addEventListener('click', () => { const step = state.step; if (step?.kind === 'line' && step.state.row === built) { step.state.playback.playAudio(); built.listen!.hidden = true; } else replay(voice, built); });
    if (built.resume) built.resume.addEventListener('click', () => revisit(Number(built.row.dataset.decision)));
    // A click on a bubble: the whole line, then the next one (as « Suite »).
    built.bubble.addEventListener('click', () => { const step = state.step; if (step?.kind === 'line' && step.state.row === built) next(); else if (step?.kind === 'click') next(); });
    return built;
  }
  const voiceOf = (line: { text: string; voice?: LineVoiceData }): LineVoiceData => line.voice ?? textVoice(line.text, undefined, language);

  // The next beat waits: a pause after a line (the voice's breath, or the time to read it), a click
  // in pace click; before a decision or the end, a short pause.
  function after(index: number, chars: number, voicedLine: boolean): Step | null {
    if (still) return null;
    const following = state.beats[index + 1];
    if (!following) return null;
    const toOptions = following.type === 'decision' || following.type === 'end';
    if (data.pace === 'click' && !toOptions && following.type === 'line') return { kind: 'click', typing: typingFor(index + 1) };
    const seconds = toOptions ? 0.45 : voicedLine ? clamp(0.4, 0.3 + chars * 0.004, 0.8) : clamp(0.6, 0.4 + 0.02 * chars, 2);
    return { kind: 'wait', until: clock.now() + seconds / rate(), typing: typingFor(index + 1) };
  }
  // « … » in the box of the bubble to come: messaging, a character's line without a voice (the next
  // line, past the beats that show nothing).
  function typingFor(from: number): Typing {
    const beats = state.beats;
    let index = from;
    while (beats[index] && (beats[index].type === 'node' || beats[index].type === 'jump' || beats[index].type === 'actions')) index++;
    const beat = beats[index];
    if (!beat || beat.type !== 'line' || beat.role !== 'character' || still || instant()) return null;
    if (data.style === 'scene' && !phone()) return null;
    if (beat.line.voice?.src) return null;
    const node = typingRow(thread, { role: 'character', side: cast.sideOf('character', beat.line.speaker), speaker: beat.line.speaker, text: beat.line.text, first: !continues('character', beat.line.speaker), voiced: false, resumable: false, letters: false });
    box.insert(node);
    return { index, node };
  }

  // A beat in the thread: live (played: its voice, its events, its pause after), or at rest (a path
  // shown at once).
  function present(index: number, live: boolean, typing: HTMLElement | null = null): Step | null {
    const beat = state.beats[index];
    shownBeat(index);
    switch (beat.type) {
      case 'node': {
        const node = nodeOf(data, beat.node);
        if (node?.scene) cast.setScene(node.scene, live);
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
        if (box.paging() && live && !box.fits(node)) return box.turnPage(() => { box.insert(node); record(index, node); return noteWait(index, option); });
        box.insert(node);
        record(index, node);
        if (!live) return null;
        return noteWait(index, option);
      }
      case 'retry': return live ? { kind: 'wait', until: clock.now() + 0.3 / rate(), typing: null } : null;
      case 'decision': {
        const decision = state.run.walk.decisions[beat.decision];
        const replaced = decision?.tries.filter((attempt) => attempt.by === 'return').map((attempt) => optionOf(data, beat.node, attempt.option)).filter((option): option is DialogueOptionData => !!option) ?? [];
        if (replaced.length) { const node = firstChoiceRow(thread, replaced); node.dataset.beat = String(index); box.insert(node); record(index, node); }
        return null;
      }
      case 'end': {
        const ending = state.run.walk.ending;
        const node = endRow(thread, ending?.title ?? null, data.debrief ? null : ending?.textHtml ?? null);
        node.dataset.beat = String(index);
        box.insert(node);
        record(index, node);
        if (live) trigger('dialogue.ended', { target: block.id, ending: ending?.id ?? null });
        return null;
      }
    }
  }
  const roleOf = (beat: Extract<Beat, { type: 'line' }>): 'character' | 'learner' | 'narration' => beat.role;
  function noteWait(index: number, option: DialogueOptionData): Step | null {
    const chars = (option.feedback ?? '').length;
    const following = state.beats[index + 1];
    if (!following || still) return null;
    if (data.pace === 'click' && following.type === 'line') return { kind: 'click', typing: typingFor(index + 1) };
    return { kind: 'wait', until: clock.now() + clamp(1, 0.5 + 0.025 * chars, 3.5) / rate(), typing: typingFor(index + 1) };
  }

  function presentLine(index: number, line: DialogueLineData | null, role: 'character' | 'learner' | 'narration', speaker: string | undefined, live: boolean, typing: HTMLElement | null, extra: { line?: string; decision?: number; text?: string; voice?: LineVoiceData | null; silent?: boolean }): Step | null {
    const text = line?.text ?? extra.text ?? '';
    const voice = extra.voice ?? (line ? voiceOf(line) : textVoice(text, undefined, language));
    const built = lineRow(index, role, speaker, text, voice, { decision: extra.decision, line: extra.line });
    const begin = (): Step | null => {
      if (typing && !typing.isConnected) typing = null;
      box.insert(built.row, typing);
      record(index, built.row);
      if (line?.speaker && line.expression) cast.express(line.speaker, line.expression);
      const avatar = cast.mountAvatar(built, role === 'learner' ? learnerSpeaker : speaker);
      if (!live || extra.silent) {
        showAllWords(built.words, { said: 0 });
        if (line?.speaker) for (const cue of line.cues ?? []) if (cue.expression) cast.express(line.speaker, cue.expression);
        return null;
      }
      if (line) trigger('dialogue.line', { target: block.id, line: line.id });
      if (state.disposed) return null;
      const playback = createLinePlayback({
        voice, clock, silent: host().virtual || still, instant: instant(), host: root,
        rate, volume: () => host().prefs().volume, muted: () => host().prefs().muted,
        onRefused: () => { if (built.listen) built.listen.hidden = false; },
        onPlaying: () => { if (built.listen) built.listen.hidden = true; }
      });
      const said: LineState = {
        index, line, chars: text.length, speaker: role === 'learner' ? learnerSpeaker : speaker, row: built, voice, playback, paint: { said: 0 }, whole: false, avatar,
        cues: (line?.cues ?? []).map((cue) => ({ time: cueTime(cue, voice), gesture: cue.gesture, expression: cue.expression, do: cue.do, fired: false }))
      };
      setHolding(true);
      return { kind: 'line', state: said };
    };
    if (live && box.paging() && !box.fits(built.row)) return box.turnPage(begin);
    return begin();
  }

  // A line, frame by frame: its words, its cues, its character; done once its voice has said it.
  function tickLine(said: LineState): boolean {
    const { playback } = said;
    playback.sync();
    const t = playback.time();
    if (said.whole || parts.revealMode() === 'instant') showAllWords(said.row.words, said.paint);
    else paintWords(said.row.words, said.voice.words, t, parts.revealMode(), said.paint);
    for (const cue of said.cues) {
      if (cue.fired || cue.time > t + 1e-6) continue;
      cue.fired = true;
      if (cue.expression && said.speaker) cast.express(said.speaker, cue.expression);
      if (cue.gesture && said.speaker) cast.gesture(said.speaker, cue.gesture, said.avatar);
      if (cue.do?.length) host().act(cue.do);
      if (state.disposed) return true;
    }
    const sounding = voiceAt(said.voice, t);
    const talking = !playback.ended && !state.paused && sounding.talking;
    cast.speak(said.speaker, talking, sounding.mouth, said.avatar);
    if (!playback.ended) return false;
    showAllWords(said.row.words, said.paint);
    playback.dispose();
    cast.rest();
    return true;
  }

  // « Réécouter »: the line's voice again, beside the flow (the dialogue waits meanwhile).
  function replay(voice: LineVoiceData, built: BubbleRow) {
    stopReplay?.();
    const wasPaused = state.paused;
    if (state.phase === 'playing' && !wasPaused) pause();
    built.row.classList.add('is-replaying');
    const prefs = host().prefs();
    setHolding(true);
    stopReplay = replayVoice(voice, root, { rate: prefs.rate || 1, volume: prefs.volume, muted: prefs.muted }, () => {
      built.row.classList.remove('is-replaying');
      stopReplay = null;
      if (state.phase !== 'playing') setHolding(false);
      if (!wasPaused && state.phase === 'playing') resume();
    });
  }

  return {
    present, after, tickLine, typingFor,
    // The bubble announced by a wait or a click goes to the line it announces.
    consumeTyping(done: Extract<Step, { kind: 'wait' | 'click' }>) { if (done.typing) { pendingTyping?.node.remove(); pendingTyping = done.typing; } },
    takeTyping(index: number): HTMLElement | null {
      if (pendingTyping?.index !== index) return null;
      const node = pendingTyping.node;
      pendingTyping = null;
      return node;
    },
    dropTyping() { pendingTyping?.node.remove(); pendingTyping = null; },
    // A cut back: the line said stops, the bubbles announced go.
    drop() {
      const step = state.step;
      if (step?.kind === 'line') step.state.playback.dispose();
      if (step && 'typing' in step) step.typing?.node.remove();
      pendingTyping?.node.remove();
      pendingTyping = null;
      state.step = null;
    },
    dispose() { stopReplay?.(); }
  };
}
