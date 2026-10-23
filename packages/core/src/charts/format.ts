// Numbers as a chart writes them: in the course's language, with its unit. The player counts with
// the same rules (packages/player/src/charts/kit.ts), so a value counted up lands on the text the
// build wrote.

export interface NumberFormat {
  unit?: string;
  decimals?: number;
}

const NARROW_SPACE = ' ';

export function formatValue(value: number, format: NumberFormat, language: string): string {
  const decimals = Math.max(0, Math.min(3, format.decimals ?? 0));
  const options = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  if (format.unit === '%') return new Intl.NumberFormat(language || 'en', { style: 'percent', ...options }).format(value / 100);
  const number = new Intl.NumberFormat(language || 'en', options).format(value);
  return format.unit ? `${number}${NARROW_SPACE}${format.unit}` : number;
}

// Minutes said as people say a duration: « 25 min », « 4 h 10 » (the language's hour sign).
export function formatMinutes(minutes: number, language: string): string {
  const total = Math.round(minutes);
  if (total < 60) return `${total}${NARROW_SPACE}min`;
  const hour = language.startsWith('de') ? 'Std.' : 'h';
  const rest = total % 60;
  return rest ? `${Math.floor(total / 60)}${NARROW_SPACE}${hour}${NARROW_SPACE}${String(rest).padStart(2, '0')}` : `${total / 60}${NARROW_SPACE}${hour}`;
}

// A number as a CSS length or fraction, short and stable (no exponent, at most 4 decimals).
export function n(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 10000) / 10000);
}
