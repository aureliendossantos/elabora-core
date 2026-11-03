// Follow the player's plural/select grammar: a branch's braces enclose words, not an argument.
// Visit every branch, including those the current values would never display.
export function messagePlaceholders(message: string): string[] {
  const names = new Set<string>();
  const closing = (text: string, start: number): number => {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
      if (text[index] === '{') depth++;
      else if (text[index] === '}' && --depth === 0) return index;
    }
    return -1;
  };
  const visit = (text: string): void => {
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== '{') continue;
      const end = closing(text, index);
      if (end < 0) break;
      const body = text.slice(index + 1, end);
      const match = /^\s*([A-Za-z_]\w*)\s*(?:,\s*(plural|select)\s*,([\s\S]*))?$/.exec(body);
      if (match) {
        names.add(match[1]);
        if (match[2]) {
          const branches = match[3];
          let position = 0;
          while (position < branches.length) {
            const selector = /\s*(=?[\w-]+)\s*\{/y;
            selector.lastIndex = position;
            const branch = selector.exec(branches);
            if (!branch) break;
            const start = branch.index + branch[0].length - 1;
            const finish = closing(branches, start);
            if (finish < 0) break;
            visit(branches.slice(start + 1, finish));
            position = finish + 1;
          }
        }
      }
      index = end;
    }
  };
  visit(message);
  return [...names].sort();
}
