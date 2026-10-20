// ICU message format, the subset objects need: {name}, {n, plural, =0 {…} one {# orbit} other {# orbits}}
// and {kind, select, a {…} other {…}}, nested. Numbers follow the course language; # is the number
// of the enclosing plural. Strings passed as values are used as they are (pre-formatted numbers).
export function formatMessage(message: string, values: Readonly<Record<string, unknown>> = {}, locale = 'en'): string {
  let rules: Intl.PluralRules | undefined;
  let numbers: Intl.NumberFormat | undefined;
  const plural = (count: number) => (rules ||= new Intl.PluralRules(locale)).select(count);
  const formatValue = (value: unknown) => (typeof value === 'number' ? (numbers ||= new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })).format(value) : value == null ? '' : String(value));
  // Index of the brace closing the one at start, or -1.
  const closing = (text: string, start: number) => {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
      if (text[index] === '{') depth++;
      else if (text[index] === '}' && --depth === 0) return index;
    }
    return -1;
  };
  // The branches of a plural or select: { one: '# orbit', other: '# orbits' }.
  const branches = (text: string) => {
    const out: Record<string, string | undefined> = {};
    let index = 0;
    while (index < text.length) {
      const selector = /\s*(=?[\w-]+)\s*\{/y;
      selector.lastIndex = index;
      const match = selector.exec(text);
      if (!match) break;
      const start = match.index + match[0].length - 1;
      const end = closing(text, start);
      if (end < 0) break;
      out[match[1]] = text.slice(start + 1, end);
      index = end + 1;
    }
    return out;
  };
  // hash: the number of the enclosing plural, written for #.
  const run = (text: string, hash: unknown): string => {
    let out = '';
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '#' && hash !== undefined) { out += formatValue(hash); continue; }
      if (character !== '{') { out += character; continue; }
      const end = closing(text, index);
      if (end < 0) { out += text.slice(index); break; }
      const body = text.slice(index + 1, end);
      const match = /^\s*([A-Za-z_]\w*)\s*(?:,\s*(plural|select)\s*,([\s\S]*))?$/.exec(body);
      if (!match) out += `{${body}}`;
      else if (!match[2]) out += formatValue(values[match[1]]);
      else {
        const value = values[match[1]];
        const options = branches(match[3]);
        const branch = match[2] === 'plural' ? (options[`=${value}`] ?? options[plural(Number(value))] ?? options.other) : (options[String(value)] ?? options.other);
        out += branch === undefined ? '' : run(branch, match[2] === 'plural' ? value : hash);
      }
      index = end;
    }
    return out;
  };
  return run(String(message), undefined);
}
