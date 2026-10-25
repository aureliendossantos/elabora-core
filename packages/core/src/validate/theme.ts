import type { Course } from '../project/model.ts';
import type { CourseCheckContext } from './context.ts';

// Theme tokens (client charter) and WCAG 2.2 AA contrast checks.
export const DEFAULT_TOKENS: Readonly<Record<string, string | number>> = {
  'color.primary': '#1F4E8C',
  'color.onPrimary': '#FFFFFF',
  'color.accent': '#C2410C',
  'color.surface': '#FFFFFF',
  'color.text': '#1F2933',
  'color.muted': '#52606D',
  'color.success': '#1E7B45',
  'color.error': '#B42318',
  'color.focus': '#2563EB',
  'font.body': 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  'font.heading': 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  radius: 8
};
export const THEME_TOKENS = Object.keys(DEFAULT_TOKENS);

// Charter tokens (defaults + course.json theme.tokens) and custom tokens (theme.custom).
export function resolveTokens(course: Course | null | undefined): Record<string, string | number> {
  return { ...DEFAULT_TOKENS, ...(course?.theme?.tokens || {}), ...(course?.theme?.custom || {}) };
}

// The tokens generators draw with: the charter and the custom tokens, without the player's own
// (player.*, D58), which restyling the player must not make figures out of date for.
export function generatorTokens(course: Course | null | undefined): Record<string, string | number> {
  return Object.fromEntries(Object.entries(resolveTokens(course)).filter(([name]) => !name.startsWith('player.')));
}

// The tokens the player gets (D58): the text of its bottom bar defaults to the course's colour when
// it reads on the bar, else to the text colour; the player's stylesheet gives every other player.*
// token its default itself. Generators and objects get resolveTokens.
export function withPlayerTokens(tokens: Readonly<Record<string, string | number>>): Record<string, string | number> {
  return tokens['player.bottom.text'] === undefined ? { ...tokens, 'player.bottom.text': playerToken(tokens, 'player.bottom.text') } : { ...tokens };
}

// A player token as the player resolves it: the course's, else its default from the charter.
export function playerToken(tokens: Readonly<Record<string, string | number>>, name: string): string {
  const own = tokens[name];
  if (typeof own === 'string') return own;
  const color = (key: string) => String(tokens[key] ?? DEFAULT_TOKENS[key]);
  switch (name) {
    case 'player.top.background': return color('color.primary');
    case 'player.top.text': return color('color.onPrimary');
    case 'player.bottom.background': return color('color.surface');
    case 'player.bottom.text': {
      const background = playerToken(tokens, 'player.bottom.background');
      return isHex(color('color.primary')) && isHex(background) && contrastRatio(color('color.primary'), background) >= 4.5 ? color('color.primary') : color('color.text');
    }
    case 'player.accent': return color('color.primary');
    case 'player.onAccent': return color('color.onPrimary');
    case 'player.tooltip.background': return color('color.text');
    case 'player.tooltip.text': return color('color.surface');
    default: return color(name);
  }
}
const isHex = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

// Every player token as packages get it (elabora_player, the app's editor): the course's, else its
// default; player.progress without a value is the text colour of the bar it is in.
export function playerTokenValue(course: Course | null | undefined, name: string): string | number {
  const tokens = resolveTokens(course);
  if (name === 'player.radius') return typeof tokens[name] === 'number' ? tokens[name] : 999;
  if (name === 'player.density') return typeof tokens[name] === 'string' ? tokens[name] : 'comfortable';
  if (name === 'player.progress') return typeof tokens[name] === 'string' ? tokens[name] : 'the bar\'s text colour';
  return playerToken(tokens, name);
}

export function tokenNames(course: Course | null | undefined): string[] {
  return [...new Set([...THEME_TOKENS, ...Object.keys(course?.theme?.custom || {})])];
}

export { tokenCssVars } from '@elabora/player/tokens';

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const PAIRS: readonly (readonly [foreground: string, background: string, minimum: number, what: string])[] = [
  ['color.text', 'color.surface', 4.5, 'body text'],
  ['color.muted', 'color.surface', 4.5, 'secondary text'],
  ['color.onPrimary', 'color.primary', 4.5, 'text on primary buttons'],
  ['color.primary', 'color.surface', 3, 'primary-coloured controls and outlines'],
  ['color.success', 'color.surface', 4.5, 'correct feedback'],
  ['color.error', 'color.surface', 4.5, 'incorrect feedback'],
  ['color.focus', 'color.surface', 3, 'focus ring']
];

// The player's colours (D58), read against what they sit on. The token reported is the course's own
// when it set it, else the charter token it comes from.
const PLAYER_PAIRS: readonly (readonly [foreground: string, background: string, minimum: number, what: string])[] = [
  ['player.top.text', 'player.top.background', 4.5, 'text and icons of the player\'s top bar'],
  ['player.bottom.text', 'player.bottom.background', 4.5, 'text and icons of the player\'s bottom bar'],
  ['player.onAccent', 'player.accent', 4.5, 'text on the player\'s filled controls (Next, Play)'],
  ['player.accent', 'player.bottom.background', 3, 'the player\'s filled controls and seek bar on the bottom bar'],
  ['player.tooltip.text', 'player.tooltip.background', 4.5, 'the player\'s tooltips']
];
const PLAYER_SOURCES: Readonly<Record<string, string>> = {
  'player.top.background': 'color.primary', 'player.top.text': 'color.onPrimary', 'player.bottom.background': 'color.surface',
  'player.accent': 'color.primary', 'player.onAccent': 'color.onPrimary', 'player.tooltip.background': 'color.text', 'player.tooltip.text': 'color.surface'
};

// A dialogue's colour (D61) as dialogue.css draws it: the course's, else its default from the charter
// (the bubbles are mixes of it, color-mix in sRGB).
export function dialogToken(tokens: Readonly<Record<string, string | number>>, name: string): string {
  const own = tokens[name];
  if (typeof own === 'string') return own;
  const color = (key: string) => String(tokens[key] ?? DEFAULT_TOKENS[key]);
  switch (name) {
    case 'dialog.bubble': return mix(color('color.text'), color('color.surface'), 0.05);
    case 'dialog.learner': return mix(color('color.accent'), color('color.surface'), 0.12);
    case 'dialog.text': return color('color.text');
    case 'dialog.wordSpoken': return dialogToken(tokens, 'dialog.text');
    case 'dialog.wordUnspoken': return color('color.muted');
    case 'dialog.note': return color('color.primary');
    default: return color(name);
  }
}
// color-mix(in srgb, a share, b): each channel mixed as written.
function mix(a: string, b: string, share: number): string {
  if (!isHex(a) || !isHex(b)) return a;
  const channels = (hex: string) => [0, 2, 4].map((at) => parseInt(hex.slice(1 + at, 3 + at), 16));
  const [x, y] = [channels(a), channels(b)];
  return `#${x.map((value, index) => Math.round(value * share + y[index] * (1 - share)).toString(16).padStart(2, '0')).join('')}`;
}

// The dialogue's colours, read when the course sets one of them: text and both kinds of words on
// both bubbles, the notes' marker on the page.
const DIALOG_PAIRS: readonly (readonly [foreground: string, background: string, minimum: number, what: string])[] = [
  ['dialog.text', 'dialog.bubble', 4.5, 'text of a character\'s bubble'],
  ['dialog.text', 'dialog.learner', 4.5, 'text of the learner\'s bubble'],
  ['dialog.wordSpoken', 'dialog.bubble', 4.5, 'words said in a character\'s bubble'],
  ['dialog.wordSpoken', 'dialog.learner', 4.5, 'words said in the learner\'s bubble'],
  ['dialog.wordUnspoken', 'dialog.bubble', 4.5, 'words still to be said in a character\'s bubble'],
  ['dialog.wordUnspoken', 'dialog.learner', 4.5, 'words still to be said in the learner\'s bubble'],
  ['dialog.note', 'color.surface', 3, 'the marker of the trainer\'s notes']
];

export function checkTheme(ctx: CourseCheckContext): void {
  const tokens = resolveTokens(ctx.course);
  const own = ctx.course?.theme?.tokens ?? {};
  if (Object.keys(own).some((name) => name.startsWith('dialog.'))) {
    for (const [foreground, background, minimum, what] of DIALOG_PAIRS) {
      const a = dialogToken(tokens, foreground);
      const b = dialogToken(tokens, background);
      if (!isHex(a) || !isHex(b)) continue;
      const ratio = contrastRatio(a, b);
      if (ratio >= minimum) continue;
      const token = foreground in own ? foreground : background in own ? background : foreground;
      ctx.reporter.emit('E_THEME_CONTRAST', {
        file: 'course.json', path: `/theme/tokens/${token}`, target: token,
        measured: Math.round(ratio * 100) / 100, limit: minimum,
        message: `${what}: ${foreground} ${a} on ${background} ${b} has a contrast of ${ratio.toFixed(2)}:1.`
      });
    }
  }
  // A player pair whose colours all come from charter tokens already checked above says nothing new.
  const charterPair = (foreground: string, background: string) => !(foreground in own) && !(background in own) && foreground !== 'player.bottom.text' && background !== 'player.bottom.text';
  for (const [foreground, background, minimum, what] of PLAYER_PAIRS) {
    const a = playerToken(tokens, foreground);
    const b = playerToken(tokens, background);
    if (!isHex(a) || !isHex(b)) continue;
    const ratio = contrastRatio(a, b);
    if (ratio >= minimum || (charterPair(foreground, background) && PAIRS.some(([f, g]) => f === PLAYER_SOURCES[foreground] && g === PLAYER_SOURCES[background]))) continue;
    const token = foreground in own || !PLAYER_SOURCES[foreground] ? foreground : background in own ? background : PLAYER_SOURCES[foreground];
    ctx.reporter.emit('E_THEME_CONTRAST', {
      file: 'course.json', path: `/theme/tokens/${token}`, target: token,
      measured: Math.round(ratio * 100) / 100, limit: minimum,
      message: `${what}: ${foreground} ${a} on ${background} ${b} has a contrast of ${ratio.toFixed(2)}:1.`
    });
  }
  const progress = own['player.progress'];
  if (typeof progress === 'string' && isHex(progress)) {
    for (const bar of ['top', 'bottom'] as const) {
      const background = playerToken(tokens, `player.${bar}.background`);
      const ratio = contrastRatio(progress, background);
      if (isHex(background) && ratio < 3) ctx.reporter.emit('E_THEME_CONTRAST', { file: 'course.json', path: '/theme/tokens/player.progress', target: 'player.progress', measured: Math.round(ratio * 100) / 100, limit: 3, message: `the player's progress: player.progress ${progress} on the ${bar} bar ${background} has a contrast of ${ratio.toFixed(2)}:1.` });
    }
  }
  for (const [foreground, background, minimum, what] of PAIRS) {
    const a = tokens[foreground];
    const b = tokens[background];
    // A colour that is not a string fails the schema; its contrast means nothing.
    if (typeof a !== 'string' || typeof b !== 'string') continue;
    const ratio = contrastRatio(a, b);
    if (ratio < minimum) {
      ctx.reporter.emit('E_THEME_CONTRAST', {
        file: 'course.json', path: `/theme/tokens/${foreground}`, target: foreground,
        measured: Math.round(ratio * 100) / 100, limit: minimum,
        message: `${what}: ${foreground} ${a} on ${background} ${b} has a contrast of ${ratio.toFixed(2)}:1.`
      });
    }
  }
  for (const key of ['font.body', 'font.heading']) {
    if (/url\(|https?:/i.test(String(tokens[key]))) ctx.reporter.emit('E_EXTERNAL_RESOURCE', { file: 'course.json', path: `/theme/tokens/${key}`, message: `${key} must be a font stack, not a URL.` });
  }
}
