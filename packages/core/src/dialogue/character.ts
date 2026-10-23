// A dialogue's character drawn as an SVG (docs/dialogues.md, characters; D61): what its root
// declares (the manifest the player, the validator and the app read) and how far it follows the
// convention. The root describes itself:
//   <svg viewBox="0 0 400 600" data-character="marc" data-expressions="neutre souriant inquiet"
//        data-default-expression="neutre" data-gestures="saluer:1.2 hocher:0.8" data-portrait="94 118 212 212">
// and the player sets the state on <g data-part="character">, showing the parts (data-mouth,
// data-expression, data-gesture) that match it.

import type { CharacterManifest } from '@elabora/player/dialogue/types';
import { inlineSvg } from '../render/svg-inline.ts';

export type { CharacterManifest } from '@elabora/player/dialogue/types';

// A character a page shows several times (the scene, an avatar) stays light.
export const CHARACTER_MAX_BYTES = 40 * 1024;
export const MOUTHS = ['closed', 'small', 'open', 'wide'] as const;
const GESTURE_SECONDS = 1;

interface Element { name: string; attributes: Map<string, string> }

// The elements of an SVG's markup, in order, with their attributes (its <style>, comments and CDATA
// left out): enough to read a character, not to render it.
function elementsOf(source: string): Element[] {
  const markup = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '<style></style>');
  const out: Element[] = [];
  for (const match of markup.matchAll(/<([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[2]!.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attributes.set(attribute[1]!, attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    out.push({ name: match[1]!, attributes });
  }
  return out;
}

const words = (value: string | undefined): string[] => (value ?? '').split(/\s+/).filter(Boolean);

// What a character's root declares; null when the file is not an SVG.
export function characterManifest(source: string): CharacterManifest | null {
  const root = elementsOf(source)[0];
  if (!root || root.name !== 'svg') return null;
  return manifestOf(root);
}

function manifestOf(root: Element): CharacterManifest {
  const expressions = words(root.attributes.get('data-expressions'));
  const gestures: Record<string, number> = {};
  for (const entry of words(root.attributes.get('data-gestures'))) {
    const [name, seconds] = entry.split(':');
    if (name) gestures[name] = Number(seconds) > 0 ? Number(seconds) : GESTURE_SECONDS;
  }
  const box = words(root.attributes.get('data-portrait')).map(Number);
  return {
    expressions,
    defaultExpression: root.attributes.get('data-default-expression') || expressions[0] || '',
    gestures,
    portrait: box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? box as [number, number, number, number] : null
  };
}

export interface CharacterProblem {
  // convention: what the player needs is missing (the state's group, the mouths, the declarations);
  // content: what the convention forbids (ids, text, the size).
  kind: 'convention' | 'content';
  message: string;
}

// How a character's SVG follows the convention, in words: what the player needs and does not find,
// and what the convention forbids (an id would repeat when the page shows it twice; text is not
// read, its name is in the bubbles).
export function characterProblems(source: string): CharacterProblem[] {
  const elements = elementsOf(source);
  const root = elements[0];
  if (!root || root.name !== 'svg') return [{ kind: 'convention', message: 'it is not an SVG drawing' }];
  const problems: CharacterProblem[] = [];
  const convention = (message: string) => problems.push({ kind: 'convention', message });
  const content = (message: string) => problems.push({ kind: 'content', message });
  const manifest = manifestOf(root);
  const parts = elements.slice(1);
  const group = parts.find((element) => element.attributes.get('data-part') === 'character');
  if (!group) convention('no <g data-part="character">, the group the player sets the state on (around everything that moves)');
  if (!root.attributes.has('data-expressions')) convention('its root declares no data-expressions (the expressions it shows, the first being its default)');
  else if (!manifest.expressions.length) convention('its data-expressions is empty');
  if (manifest.expressions.length && root.attributes.has('data-default-expression') && !manifest.expressions.includes(manifest.defaultExpression)) convention(`data-default-expression "${manifest.defaultExpression}" is not one of its data-expressions`);
  const mouths = new Set(parts.filter((element) => element.attributes.has('data-mouth') && !element.attributes.has('data-expression')).map((element) => element.attributes.get('data-mouth')));
  const missing = MOUTHS.filter((mouth) => !mouths.has(mouth));
  if (missing.length) convention(`it lacks the mouth${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (a part data-mouth="…" without data-expression for each of closed, small, open, wide)`);
  const shown = new Set(parts.map((element) => element.attributes.get('data-expression')).filter((name): name is string => !!name));
  const unseen = manifest.expressions.filter((name) => !shown.has(name));
  if (shown.size && unseen.length) convention(`nothing in the drawing shows the expression${unseen.length > 1 ? 's' : ''} ${unseen.join(', ')} (a part data-expression="…")`);
  const drawnGestures = new Set(parts.map((element) => element.attributes.get('data-gesture')).filter((name): name is string => !!name));
  const undeclared = [...drawnGestures].filter((name) => !(name in manifest.gestures));
  if (undeclared.length) convention(`its parts play the gesture${undeclared.length > 1 ? 's' : ''} ${undeclared.join(', ')}, which data-gestures does not declare (with its seconds: saluer:1.2)`);
  const ids = parts.filter((element) => element.attributes.has('id')).map((element) => element.attributes.get('id'));
  if (ids.length) content(`it has id${ids.length > 1 ? 's' : ''} (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '…' : ''}): a page shows a character more than once (the scene, an avatar), and ids would repeat; draw without gradients, clip paths, masks or filters`);
  if (parts.some((element) => element.name === 'text' || element.name === 'tspan' || element.name === 'textPath')) content('it has text (<text>): a character is decorative, its name is in the bubbles');
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > CHARACTER_MAX_BYTES) content(`it weighs ${Math.round(bytes / 1024)} KB (under ${CHARACTER_MAX_BYTES / 1024} KB: a page may show it several times)`);
  return problems;
}

// A character's SVG as the player mounts it: sanitized (D33) with the class t-character, its styles
// scoped to the speaker, and what its root declares.
export function characterInline(source: string, speaker: string): { inline: string; manifest: CharacterManifest; removed: string[] } | null {
  const manifest = characterManifest(source);
  if (!manifest) return null;
  const { html, removed } = inlineSvg(source, { prefix: `t-char-${speaker}`, decorative: true, kind: 'character' });
  return html ? { inline: html, manifest, removed } : null;
}
