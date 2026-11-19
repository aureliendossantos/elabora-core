// Numbers spelt out as a voice says them (docs/decisions.md D27), in French and English: the words a character-level model
// can align ("9 h 30" → neuf heures trente). Hyphenated forms are returned as separate words.

const FR_UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const FR_TENS: Record<number, string> = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante' };

function frBelow100(n: number): string[] {
  if (n <= 16) return [FR_UNITS[n]];
  if (n < 20) return ['dix', FR_UNITS[n - 10]];
  if (n < 70) {
    const t = Math.floor(n / 10);
    const u = n % 10;
    if (u === 0) return [FR_TENS[t]];
    if (u === 1) return [FR_TENS[t], 'et', 'un'];
    return [FR_TENS[t], FR_UNITS[u]];
  }
  if (n < 80) return n === 71 ? ['soixante', 'et', 'onze'] : ['soixante', ...frBelow100(n - 60)];
  if (n === 80) return ['quatre', 'vingts'];
  return ['quatre', 'vingt', ...frBelow100(n - 80)];
}

function frBelow1000(n: number): string[] {
  const c = Math.floor(n / 100);
  const r = n % 100;
  const rest = r ? frBelow100(r) : [];
  if (c === 0) return frBelow100(r);
  const head = c === 1 ? ['cent'] : [FR_UNITS[c], r === 0 ? 'cents' : 'cent'];
  return [...head, ...rest];
}

export function frenchCardinal(n: number): string[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Not a natural number: ${n}`);
  if (n < 1000) return frBelow1000(n);
  if (n < 1_000_000) {
    const k = Math.floor(n / 1000);
    const r = n % 1000;
    const head = k === 1 ? ['mille'] : [...frBelow1000(k).map((w) => (w === 'cents' || w === 'vingts' ? w.slice(0, -1) : w)), 'mille'];
    return r ? [...head, ...frBelow1000(r)] : head;
  }
  if (n < 1_000_000_000) {
    const m = Math.floor(n / 1_000_000);
    const r = n % 1_000_000;
    const head = [...frenchCardinal(m), m === 1 ? 'million' : 'millions'];
    return r ? [...head, ...frenchCardinal(r)] : head;
  }
  return digitByDigit(String(n), 'fr');
}

export function frenchOrdinal(n: number, feminine = false): string[] {
  if (n === 1) return [feminine ? 'première' : 'premier'];
  const words = frenchCardinal(n);
  const last = words[words.length - 1];
  let ordinal: string;
  if (last === 'un') ordinal = 'unième';
  else if (last === 'cinq') ordinal = 'cinquième';
  else if (last === 'neuf') ordinal = 'neuvième';
  else if (last === 'cents' || last === 'vingts') ordinal = `${last.slice(0, -1)}ième`;
  else if (last.endsWith('e')) ordinal = `${last.slice(0, -1)}ième`;
  else ordinal = `${last}ième`;
  return [...words.slice(0, -1), ordinal];
}

const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enBelow1000(n: number): string[] {
  const c = Math.floor(n / 100);
  const r = n % 100;
  const out: string[] = c ? [EN_UNITS[c], 'hundred'] : [];
  if (r === 0) return out.length ? out : ['zero'];
  if (r < 20) out.push(EN_UNITS[r]);
  else { out.push(EN_TENS[Math.floor(r / 10)]); if (r % 10) out.push(EN_UNITS[r % 10]); }
  return out;
}

export function englishCardinal(n: number): string[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Not a natural number: ${n}`);
  if (n < 1000) return enBelow1000(n);
  const groups: [number, string][] = [[1_000_000_000, 'billion'], [1_000_000, 'million'], [1000, 'thousand']];
  const out: string[] = [];
  let rest = n;
  for (const [size, name] of groups) {
    if (rest >= size) { out.push(...enBelow1000(Math.floor(rest / size)), name); rest %= size; }
  }
  if (rest) out.push(...enBelow1000(rest));
  return out;
}

const EN_ORDINAL: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

export function englishOrdinal(n: number): string[] {
  const words = englishCardinal(n);
  const last = words[words.length - 1];
  const ordinal = EN_ORDINAL[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words.slice(0, -1), ordinal];
}

export function digitByDigit(digits: string, language: 'fr' | 'en'): string[] {
  return Array.from(digits, (d) => (language === 'fr' ? FR_UNITS : EN_UNITS)[Number(d)]);
}

export const cardinal = (n: number, language: 'fr' | 'en'): string[] => (language === 'fr' ? frenchCardinal(n) : englishCardinal(n));

// A run of digits as said: "04" digit by digit, "12" as a number.
export function sayDigits(digits: string, language: 'fr' | 'en'): string[] {
  if (digits.length > 1 && digits.startsWith('0')) return digitByDigit(digits, language);
  if (digits.length > 9) return digitByDigit(digits, language);
  return cardinal(Number(digits), language);
}
