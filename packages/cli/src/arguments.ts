// Command-line arguments: positionals, and the flags a command declares. A boolean flag takes no
// value; a string or list flag takes the next argument (or --name=value), and a list splits it
// on commas and adds what each repetition gives; an optional flag takes the next argument when there is one (not a flag), else it is
// true. Undeclared flags are errors, so a mistyped flag is never silently ignored.

export type FlagKind = 'boolean' | 'string' | 'list' | 'optional';
export type FlagSpecs = Readonly<Record<string, FlagKind>>;

type FlagValue<Kind extends FlagKind> = Kind extends 'boolean' ? boolean : Kind extends 'list' ? string[] | undefined : Kind extends 'optional' ? string | true | undefined : string | undefined;
export type FlagValues<Specs extends FlagSpecs> = { [Name in keyof Specs]: FlagValue<Specs[Name]> };

export interface ParsedArguments<Specs extends FlagSpecs> {
  positionals: string[];
  flags: FlagValues<Specs>;
}

export class ArgumentError extends Error {}

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
    if (!kind) throw new ArgumentError(`Unknown option --${name}`);
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
    values[name] = kind === 'list' ? [...((values[name] as string[] | undefined) ?? []), ...splitList(value)] : value;
  }
  return { positionals, flags: values as FlagValues<Specs> };
}

export const splitList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);
