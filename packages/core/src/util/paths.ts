// POSIX path helpers for project-relative paths (the core has no node:path). They follow
// node:path's posix functions, so messages that show a normalised path stay the same.

export function normalize(p: string): string {
  if (p === '') return '.';
  const absolute = p.startsWith('/');
  const trailing = p.endsWith('/');
  const out: string[] = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else out.push(segment);
  }
  let result = out.join('/');
  if (!result && !absolute) result = '.';
  if (result && trailing) result += '/';
  return absolute ? `/${result}` : result;
}

export function join(...parts: string[]): string {
  const joined = parts.filter((x) => x !== '').join('/');
  return joined === '' ? '.' : normalize(joined);
}

export function dirname(p: string): string {
  if (p === '') return '.';
  const absolute = p.startsWith('/');
  let end = -1;
  let matchedSlash = true;
  for (let i = p.length - 1; i >= 1; i--) {
    if (p[i] === '/') {
      if (!matchedSlash) { end = i; break; }
    } else matchedSlash = false;
  }
  if (end === -1) return absolute ? '/' : '.';
  if (absolute && end === 1) return '//';
  return p.slice(0, end);
}

export function basename(p: string, ext?: string): string {
  let end = p.length;
  while (end > 0 && p[end - 1] === '/') end--;
  const base = p.slice(p.lastIndexOf('/', end - 1) + 1, end);
  return ext && base !== ext && base.endsWith(ext) ? base.slice(0, base.length - ext.length) : base;
}

export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 || base === '..' ? '' : base.slice(i);
}

export const isAbsolute = (p: string): boolean => p.startsWith('/');
