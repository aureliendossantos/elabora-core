// A dialogue's character in the page (docs/dialogues.md, characters): the speaker's SVG, sanitized
// by the compiler (D33, class t-character), or its pictures, and the state the player pushes to it.
// No global DOM and no dependency: the player's dialogues, the canvas and tests mount it alike.
//
// The state is set on <g data-part="character"> (a descendant of the root, which the sanitizer's
// scoped <style> can reach): data-speaking, data-talking, data-mouth, data-expression,
// data-gesture, data-listening, data-paused, data-reduced-motion. A part is shown when each of its
// data-gesture, data-expression and data-mouth matches the state, and hidden otherwise; a mouth that
// also names an expression wins over the generic mouth of the same shape. So a character works
// without a single rule of its own; its <style> only moves it (breathing, blinking, gestures).
// character.css hides data-part="eyes-closed" until the character's blink shows it, and pauses
// every animation under data-paused (stops them under data-reduced-motion).

import type { CharacterManifest, DialogueSpeakerData } from '../dialogue/types.ts';
import type { Mouth } from './voice.ts';

export type { Mouth } from './voice.ts';
export { voiceAt, textVoice, textWords, textMouth, MOUTH_FPS, MOUTH_LETTERS, SPEECH_GAP } from './voice.ts';

export interface CharacterState {
  // Its line is being said.
  speaking: boolean;
  // The voice is sounding (not in a pause of the line).
  talking: boolean;
  mouth: Mouth;
  expression: string;
  // The gesture being played (removed after its duration).
  gesture: string | null;
  // Someone else is speaking.
  listening: boolean;
  paused: boolean;
  reducedMotion: boolean;
}

export interface CharacterView {
  // The SVG (or the picture's box) mounted in the host.
  readonly element: Element;
  readonly manifest: CharacterManifest;
  readonly state: Readonly<CharacterState>;
  set(state: Partial<CharacterState>): void;
  // Plays a gesture the character declares, again from its start when it is already playing, and
  // removes it after its duration (data-gestures), a duration that stops while paused.
  gesture(name: string): void;
  dispose(): void;
}

// The default duration of a gesture a character does not time, in seconds.
const GESTURE_SECONDS = 1;

const STATE_FLAGS: readonly [keyof CharacterState, string][] = [
  ['speaking', 'data-speaking'], ['talking', 'data-talking'], ['listening', 'data-listening'], ['paused', 'data-paused'], ['reducedMotion', 'data-reduced-motion']
];

// What a character's SVG root declares, when the compiler gave no manifest.
export function readManifest(root: Element | null): CharacterManifest {
  const list = (name: string) => (root?.getAttribute(name) ?? '').split(/\s+/).filter(Boolean);
  const expressions = list('data-expressions');
  const gestures: Record<string, number> = {};
  for (const entry of list('data-gestures')) {
    const [name, seconds] = entry.split(':');
    if (name) gestures[name] = Number(seconds) > 0 ? Number(seconds) : GESTURE_SECONDS;
  }
  const box = list('data-portrait').map(Number);
  return {
    expressions,
    defaultExpression: root?.getAttribute('data-default-expression') || expressions[0] || '',
    gestures,
    portrait: box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? box as [number, number, number, number] : null
  };
}

// Mounts a speaker's character at the end of host. portrait: the round avatar (messaging, phones):
// the SVG framed on its data-portrait box (the whole drawing without one), or the portrait picture.
export function mountCharacter(host: HTMLElement, speaker: DialogueSpeakerData, options: { portrait?: boolean } = {}): CharacterView {
  const doc = host.ownerDocument;
  const look = speaker.look ?? {};
  let element: Element;
  let group: Element;
  let manifest: CharacterManifest;
  let picture: HTMLImageElement | null = null;
  const svg = look.inline ? parseSvg(doc, look.inline) : null;
  if (svg) {
    element = svg;
    manifest = look.manifest ?? readManifest(svg);
    if (options.portrait) {
      if (manifest.portrait) svg.setAttribute('viewBox', manifest.portrait.join(' '));
      svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      svg.classList.add('t-character-portrait');
    }
    group = svg.querySelector('[data-part="character"]') ?? svg;
  } else {
    // Pictures, or the speaker's initial: the state goes on the box all the same.
    manifest = look.manifest ?? { expressions: Object.keys(look.expressions ?? {}), defaultExpression: '', gestures: {}, portrait: null };
    const box = doc.createElement('span');
    box.className = `t-character t-character-picture${options.portrait ? ' t-character-portrait' : ''}`;
    box.setAttribute('aria-hidden', 'true');
    box.setAttribute('data-part', 'character');
    if (look.portrait || look.expressions) {
      picture = doc.createElement('img');
      picture.alt = '';
      picture.decoding = 'async';
      picture.draggable = false;
      box.append(picture);
    } else {
      box.classList.add('t-character-initial');
      box.textContent = [...speaker.name.trim()][0]?.toUpperCase() ?? '';
    }
    element = box;
    group = box;
  }
  host.append(element);

  // The parts the state shows and hides, read once: the drawing does not change.
  const parts = svg ? [...group.querySelectorAll('[data-mouth],[data-expression],[data-gesture]')] : [];
  const state: CharacterState = { speaking: false, talking: false, mouth: 'closed', expression: manifest.defaultExpression, gesture: null, listening: false, paused: false, reducedMotion: false };
  let shown: string | null = null;

  const apply = () => {
    group.setAttribute('data-expression', state.expression);
    group.setAttribute('data-mouth', state.mouth);
    for (const [key, attribute] of STATE_FLAGS) group.toggleAttribute(attribute, state[key] === true);
    if (state.gesture) group.setAttribute('data-gesture', state.gesture);
    else group.removeAttribute('data-gesture');
    if (picture) {
      const src = (state.expression && look.expressions?.[state.expression]) || look.portrait || Object.values(look.expressions ?? {})[0] || '';
      if (src !== shown) { picture.src = src; shown = src; }
      return;
    }
    const specific = parts.some((part) => part.getAttribute('data-mouth') === state.mouth && part.getAttribute('data-expression') === state.expression);
    for (const part of parts) {
      let show = true;
      if (part.hasAttribute('data-gesture')) show &&= part.getAttribute('data-gesture') === state.gesture;
      if (part.hasAttribute('data-expression')) show &&= part.getAttribute('data-expression') === state.expression;
      if (part.hasAttribute('data-mouth')) show &&= part.getAttribute('data-mouth') === state.mouth && (part.hasAttribute('data-expression') || !specific);
      const style = (part as SVGElement | HTMLElement).style;
      if (style) style.display = show ? '' : 'none';
    }
  };

  // The gesture's end: a timer that stops while the character is paused.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remaining = 0;
  let since = 0;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const stopTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const startTimer = () => {
    stopTimer();
    if (remaining <= 0 || state.paused || !state.gesture) return;
    since = now();
    timer = setTimeout(() => { timer = null; remaining = 0; set({ gesture: null }); }, remaining);
  };

  const set = (patch: Partial<CharacterState>) => {
    const wasPaused = state.paused;
    let changed = false;
    for (const key of Object.keys(patch) as (keyof CharacterState)[]) {
      const value = patch[key];
      if (value === undefined || state[key] === value) continue;
      (state as unknown as Record<string, unknown>)[key] = value;
      changed = true;
    }
    if ('gesture' in patch && patch.gesture === null) { stopTimer(); remaining = 0; }
    if (state.paused !== wasPaused) {
      if (state.paused && timer !== null) { remaining = Math.max(0, remaining - (now() - since)); stopTimer(); }
      else if (!state.paused) startTimer();
    }
    if (changed) apply();
  };

  const view: CharacterView = {
    element,
    manifest,
    get state() { return { ...state }; },
    set,
    gesture(name: string) {
      if (Object.keys(manifest.gestures).length && !(name in manifest.gestures)) return;
      // Replayed from its start: the attribute removed, the layout forced, the attribute set again.
      if (state.gesture) {
        state.gesture = null;
        apply();
        (group as Element).getBoundingClientRect();
      }
      state.gesture = name;
      apply();
      remaining = (manifest.gestures[name] ?? GESTURE_SECONDS) * 1000;
      startTimer();
    },
    dispose() {
      stopTimer();
      element.remove();
    }
  };
  apply();
  return view;
}

// The sanitized SVG, parsed in the host's document (an HTML fragment, as the compiler writes it).
function parseSvg(doc: Document, markup: string): SVGSVGElement | null {
  const template = doc.createElement('template');
  template.innerHTML = markup.trim();
  const root = template.content.firstElementChild;
  if (!root || root.localName !== 'svg') return null;
  const svg = doc.importNode(root, true) as SVGSVGElement;
  svg.classList.add('t-character');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}
