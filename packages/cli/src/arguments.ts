// Command-line arguments: positionals, and the flags a command declares. A boolean flag takes no
// value; a string or list flag takes the next argument (or --name=value), and a list splits it
// on commas and adds what each repetition gives (a repeat flag does not split: its values may hold commas); an optional flag takes the next argument when there is one (not a flag), else it is
// true. Undeclared flags are errors, so a mistyped flag is never silently ignored.

export type FlagKind = 'boolean' | 'string' | 'list' | 'repeat' | 'optional';
export type FlagSpecs = Readonly<Record<string, FlagKind>>;

type FlagValue<Kind extends FlagKind> = Kind extends 'boolean' ? boolean : Kind extends 'list' | 'repeat' ? string[] | undefined : Kind extends 'optional' ? string | true | undefined : string | undefined;
export type FlagValues<Specs extends FlagSpecs> = { [Name in keyof Specs]: FlagValue<Specs[Name]> };

export interface ParsedArguments<Specs extends FlagSpecs> {
  positionals: string[];
  flags: FlagValues<Specs>;
}

// hint: what to do instead (the flag it was close to), said after the message.
export class ArgumentError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

// Letters to add, remove or change to go from a to b (Levenshtein), for « did you mean ».
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

export function parseArguments<Specs extends FlagSpecs>(argv: readonly string[], specs: Specs): ParsedArguments<Specs> {
  const positionals: string[] = [];
  const values: Record<string, boolean | string | string[] | undefined> = {};
  for (const name of Object.keys(specs)) values[name] = specs[name] === 'boolean' ? false : undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) { positionals.push(argument); continue; }
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    const kind = Object.hasOwn(specs, name) ? specs[name] : undefined;
    if (!kind) {
      const near = Object.keys(specs).find((known) => editDistance(name, known) <= (name.length > 5 ? 2 : 1));
      throw new ArgumentError(`Unknown option --${name}`, near ? `Did you mean --${near}?` : undefined);
    }
    if (kind === 'boolean') {
      if (equals !== -1) throw new ArgumentError(`--${name} takes no value`);
      values[name] = true;
      continue;
    }
    let value: string;
    if (equals !== -1) value = argument.slice(equals + 1);
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) value = argv[++index];
    else if (kind === 'optional') { values[name] = true; continue; }
    else throw new ArgumentError(`--${name} needs a value`);
    // A list flag given again adds to it (--review-origin a --review-origin b).
    values[name] = kind === 'list' || kind === 'repeat' ? [...((values[name] as string[] | undefined) ?? []), ...(kind === 'list' ? splitList(value) : [value])] : value;
  }
  return { positionals, flags: values as FlagValues<Specs> };
}

export const splitList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);
