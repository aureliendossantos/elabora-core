// What the precompiled validators (validators.generated.ts, meta-validator.generated.ts) and the
// interpreter for inline schemas (inline-schema.ts) share. No code is generated at run time: a
// Cloudflare Worker forbids `new Function` and `eval`, and the room that validates a cloud project
// runs there (D80).

// multipleOf with decimals (a slider's step of 0.05): 0.6 / 0.05 is 11.999… in floating point, so the
// quotient is compared with an integer to this many decimals.
export const MULTIPLE_OF_PRECISION = 9;

// An error as the validators report it (the fields of Ajv's ErrorObject that the core reads).
export interface ErrorObject {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, any>;
  message?: string;
  propertyName?: string;
}

// A compiled schema: true when the data is valid, else `errors` says why.
export interface ValidateFunction {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
}

// Deep equality of JSON values (const, enum, uniqueItems).
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = a.length; i-- !== 0;) if (!equal(a[i], b[i])) return false;
      return true;
    }
    if (Array.isArray(b)) return false;
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length) return false;
    for (const k of keys) if (!Object.hasOwn(y, k) || !equal(x[k], y[k])) return false;
    return true;
  }
  return a !== a && b !== b;
}

// The length of a string in code points, not UTF-16 units (minLength, maxLength).
export function ucs2length(str: string): number {
  const len = str.length;
  let length = 0;
  let pos = 0;
  while (pos < len) {
    length++;
    const value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      // high surrogate: a low surrogate after it makes one code point
      if ((str.charCodeAt(pos) & 0xfc00) === 0xdc00) pos++;
    }
  }
  return length;
}

// format "date-time" (RFC 3339, the time zone required), as ajv-formats checks it (MIT licence,
// © 2020 Evgeny Poberezkin); the differential test compares the two.
const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
const DATE_TIME_SEPARATOR = /t|\s/i;
const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

function isDate(str: string): boolean {
  const matches = DATE.exec(str);
  if (!matches) return false;
  const year = +matches[1]!;
  const month = +matches[2]!;
  const day = +matches[3]!;
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]!);
}

function isTime(str: string): boolean {
  const matches = TIME.exec(str);
  if (!matches) return false;
  const hr = +matches[1]!;
  const min = +matches[2]!;
  const sec = +matches[3]!;
  const zone = matches[4];
  const sign = matches[5] === '-' ? -1 : 1;
  const zoneHours = +(matches[6] || 0);
  const zoneMinutes = +(matches[7] || 0);
  if (zoneHours > 23 || zoneMinutes > 59 || !zone) return false;
  if (hr <= 23 && min <= 59 && sec < 60) return true;
  // a leap second
  const utcMin = min - zoneMinutes * sign;
  const utcHr = hr - zoneHours * sign - (utcMin < 0 ? 1 : 0);
  return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
}

export function isDateTime(str: string): boolean {
  const parts = str.split(DATE_TIME_SEPARATOR);
  return parts.length === 2 && isDate(parts[0]!) && isTime(parts[1]!);
}
