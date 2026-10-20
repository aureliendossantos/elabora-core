import { normalize, join, dirname, basename } from '../util/paths.ts';
import { textFile } from '../project/files.ts';
import type { ProjectFiles, SourceFile } from '../project/files.ts';
import { formatJson } from '../ops/json.ts';
import type { Json } from '../ops/types.ts';

// When a media file under assets/ is converted to another format (clip.mov → clip.mp4), the files
// that name it must name the new file: JSON documents (block props name assets relative to assets/,
// course.json names fonts and stylesheets from the project root) and stylesheets (url() relative
// to the stylesheet). Pure: returns the text files that change, with their new text. The editing
// engine and `elabora media optimize` (command replaceMediaReferences) both use it.

export function rewriteAssetReferences(files: ProjectFiles, from: string, to: string): Map<string, SourceFile> {
  const changed = new Map<string, SourceFile>();
  if (from === to) return changed;
  const underAssets = from.startsWith('assets/') && to.startsWith('assets/');
  const replacement = new Map<string, string>([[from, to]]);
  if (underAssets) replacement.set(from.slice('assets/'.length), to.slice('assets/'.length));
  for (const [path, file] of files) {
    if (file.kind !== 'text') continue;
    if (path.endsWith('.json')) {
      if (![...replacement.keys()].some((name) => file.text.includes(JSON.stringify(name).slice(1, -1)))) continue;
      let value: Json;
      try {
        value = JSON.parse(file.text) as Json;
      } catch {
        continue; // reported by the validator; nothing to rewrite in it
      }
      const result = replaceStrings(value, replacement);
      if (result.count) changed.set(path, textFile(formatJson(result.value)));
    } else if (path.endsWith('.css')) {
      const text = rewriteCssUrls(path, file.text, from, to);
      if (text !== file.text) changed.set(path, textFile(text));
    }
  }
  return changed;
}

function replaceStrings(value: Json, replacement: ReadonlyMap<string, string>): { value: Json; count: number } {
  let count = 0;
  const walk = (node: Json): Json => {
    if (typeof node === 'string') {
      const next = replacement.get(node);
      if (next === undefined) return node;
      count++;
      return next;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(node)) {
      // Keys are names, never references; "__proto__" stays an own key.
      Object.defineProperty(out, key, { value: walk(node[key]), writable: true, enumerable: true, configurable: true });
    }
    return out;
  };
  const result = walk(value);
  return { value: result, count };
}

// url(...) targets of a stylesheet that resolve to `from` get the file name of `to` (a conversion
// keeps the folder).
function rewriteCssUrls(file: string, css: string, from: string, to: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole: string, quote: string, url: string) => {
    const target = url.split(/[?#]/)[0].trim();
    if (!target || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return whole;
    if (normalize(join(dirname(file), target)) !== from) return whole;
    const slash = target.lastIndexOf('/');
    const rewritten = `${slash >= 0 ? target.slice(0, slash + 1) : ''}${basename(to)}${url.trim().slice(target.length)}`;
    return `url(${quote}${rewritten}${quote})`;
  });
}
