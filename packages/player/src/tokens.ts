// CSS custom properties of the design tokens, shared by the player page and free-object frames.
// Every token a.b is --t-a-b; charter tokens also keep short names (--t-primary, --t-font-body…).

import type { TokenValues } from './course-data.ts';

const SHORT: Readonly<Record<string, string>> = {
  'color.primary': '--t-primary', 'color.onPrimary': '--t-on-primary', 'color.accent': '--t-accent', 'color.surface': '--t-surface',
  'color.text': '--t-text', 'color.muted': '--t-muted', 'color.success': '--t-success', 'color.error': '--t-error', 'color.focus': '--t-focus',
  'font.body': '--t-font-body', 'font.heading': '--t-font-heading', radius: '--t-radius'
};

export function tokenCssVars(tokens: Readonly<TokenValues> | null | undefined): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const [name, raw] of Object.entries(tokens || {})) {
    const value = (name === 'radius' || name.endsWith('.radius')) && typeof raw === 'number' ? `${raw}px` : String(raw);
    if (/[;{}<>]/.test(value)) continue;
    properties[`--t-${name.replace(/\./g, '-').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = value;
    if (SHORT[name]) properties[SHORT[name]] = value;
  }
  return properties;
}

export const cssVarsRule = (tokens: Readonly<TokenValues> | null | undefined): string => `:root{${Object.entries(tokenCssVars(tokens)).map(([name, value]) => `${name}:${value}`).join(';')}}`;
