// A dialogue's characters (D61): the scene's backdrop and its cast standing on the stage (style
// scene), the round portraits beside the first bubble of a series, their expressions, and who speaks,
// who listens and how the mouth moves while a line is said. Not part of the pure walk.

import { element } from '../dom.ts';
import { mountCharacter } from '../character/index.ts';
import type { CharacterView } from '../character/index.ts';
import type { DialogueData } from './types.ts';
import type { BubbleRow, Side } from './thread.ts';
import type { ViewParts, ViewState } from './view-parts.ts';

type Mouth = 'closed' | 'small' | 'open' | 'wide';

export type Cast = ReturnType<typeof createCast>;

export function createCast(parts: ViewParts, state: ViewState) {
  const { data, stage, learnerSpeaker } = parts;
  const reduced = parts.reduced;
  const avatars: CharacterView[] = [];
  const actors = new Map<string, CharacterView>();
  // Each character's expression now (a line's, a cue's), from the beats shown.
  let expressions: Record<string, string> = {};

  // ── Scene: the backdrop and the cast (style scene) ──
  let backdrop: HTMLImageElement | null = null;
  let cast: { speaker: string; position: Side }[] = [];
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

  // ── Where a bubble goes ──
  const sideOf = (role: 'character' | 'learner' | 'narration', speaker: string | undefined): Side => {
    if (role === 'narration') return 'center';
    if (data.style === 'scene') {
      const member = cast.find((candidate) => candidate.speaker === (role === 'learner' ? learnerSpeaker ?? speaker : speaker));
      if (member) return member.position;
    }
    return role === 'learner' ? 'right' : 'left';
  };

  // ── Characters ──
  function characterState(view: CharacterView, speaker: string, speaking: string | undefined, talking: boolean, mouth: Mouth) {
    const own = speaker === speaking;
    view.set({
      speaking: own, talking: own && talking, mouth: own && !reduced() ? mouth : 'closed', listening: !!speaking && !own,
      expression: expressions[speaker] ?? view.manifest.defaultExpression, paused: state.paused, reducedMotion: reduced()
    });
  }
  // The speaker of the line said (undefined: nobody), talking or not, its mouth; the others listen.
  function speak(speaker: string | undefined, talking: boolean, mouth: Mouth, avatar: CharacterView | null) {
    for (const [id, view] of actors) characterState(view, id, speaker, talking, mouth);
    if (avatar && speaker) characterState(avatar, speaker, speaker, talking, mouth);
  }
  function rest() {
    for (const [id, view] of actors) characterState(view, id, undefined, false, 'closed');
    for (const view of avatars) view.set({ speaking: false, talking: false, mouth: 'closed', listening: false, paused: state.paused, reducedMotion: reduced() });
  }
  function gesture(speaker: string, name: string, avatar: CharacterView | null) {
    actors.get(speaker)?.gesture(name);
    avatar?.gesture(name);
  }
  // The portrait beside the first bubble of a series.
  function mountAvatar(built: BubbleRow, speaker: string | undefined): CharacterView | null {
    if (!built.avatar || !built.row.hasAttribute('data-first') || !speaker) return null;
    const character = data.speakers[speaker];
    if (!character) return null;
    const view = mountCharacter(built.avatar, character, { portrait: true });
    view.set({ expression: expressions[speaker] ?? view.manifest.defaultExpression, reducedMotion: reduced(), paused: state.paused });
    avatars.push(view);
    return view;
  }
  function setPaused(paused: boolean) {
    for (const view of [...actors.values(), ...avatars]) view.set({ paused });
  }
  function dispose() {
    for (const view of [...actors.values(), ...avatars]) view.dispose();
  }

  return {
    setScene, sideOf, speak, rest, gesture, mountAvatar, setPaused, dispose,
    express(speaker: string, expression: string) { expressions[speaker] = expression; },
    // The expressions the beats shown leave (a cut back).
    setExpressions(next: Record<string, string>) { expressions = next; }
  };
}
