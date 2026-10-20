import { textFile } from '@elabora/core/project/files';
import type { SourceFile } from '@elabora/core/project/files';

// Seeded mutations of a project's files, the way agents break them: a JSON value replaced by one of
// another type, removed or duplicated, a whole document replaced by a value that is not an object,
// forbidden markup in templates, stylesheets and object code, files deleted. Every document still
// parses: a project that does not parse is a loading error, not what these tests look for.

export type Random = () => number;

// xorshift32: the same seed gives the same mutations on every machine.
export function seededRandom(seed: number): Random {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

const MARKUP = ['<button>x</button>', '<a href="http://x.org">l</a>', '<h1>t</h1>', '<p>{{nope}}</p>', '<img src="x.png">', '<div data-slot="zz">t</div>', '<button data-t-click="Bad Name">b</button>', '<span data-t-tab="k">k</span>', '<svg><text>Label</text></svg>', '<div data-t-label="nope"></div>', '<p data-each="nope">{{x}}</p>', '<p data-if="==">x</p>', '{{', '<template>'];
const CSS = ['@import url(x.css);', 'a { color: #123456; font-size: 13px; }', '.x::before { content: "Hello"; }', '.y { background: url(http://e.org/a.png); }', '.w { background: url(missing.png); }'];
const CODE = ['fetch("x");', 'Math.random();', 'import "lodash";', 'window.parent.x = 1;', 'syntax error here(', 'ctx.t("undeclaredKey");', 'import x from "./missing.js";'];
const TEXT = ['<', '</target>', '&', '<x>', '\n:::\n', '"'];
const DOCUMENTS = [null, 42, 'x', [], [null], true];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = (string | number)[];

const isContainer = (value: Json): value is Json[] | { [key: string]: Json } => typeof value === 'object' && value !== null;

// Applies one to three mutations to the files (in place) and returns what it did.
export function mutate(files: Map<string, SourceFile>, random: Random): string[] {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const texts = (test: (path: string) => boolean) => [...files.keys()].filter((path) => test(path) && files.get(path)?.kind === 'text');
  const textOf = (path: string): string => { const file = files.get(path); return file?.kind === 'text' ? file.text : ''; };
  const insert = (path: string, snippet: string) => { const text = textOf(path); const at = Math.floor(random() * (text.length + 1)); files.set(path, textFile(text.slice(0, at) + snippet + text.slice(at))); };
  const jsonFiles = texts((path) => path.endsWith('.json'));
  // Strings of the project (ids, references): replacing a value by one of them makes references cross.
  const pool: string[] = [];
  const collect = (value: Json) => { if (typeof value === 'string') { if (value.length < 40) pool.push(value); } else if (isContainer(value)) Object.values(value).forEach(collect); };
  for (const path of jsonFiles) { try { collect(JSON.parse(textOf(path))); } catch { /* not JSON */ } }
  const value = (): Json => pick<Json>([null, 0, 42, -1, 2, 1.5, '', 'x', true, false, [], {}, [null], { id: 'x' }, [{}], [42], pick(pool), pick(pool), pick(pool), 'x'.repeat(300), '$\\frac{1}{$', '![i](http://e.org/i.png)', 'learning styles', '__proto__', 'toString', 'a(b', '{{x}}']);

  const log: string[] = [];
  const count = 1 + Math.floor(random() * 3);
  for (let n = 0; n < count; n++) {
    const r = random();
    if (r < 0.06) { const list = texts((path) => path.endsWith('.html')); if (list.length) { const path = pick(list); const snippet = pick(MARKUP); insert(path, snippet); log.push(`template ${path}: ${snippet}`); } continue; }
    if (r < 0.09) { const list = texts((path) => path.endsWith('.css')); if (list.length) { const path = pick(list); files.set(path, textFile(`${textOf(path)}\n${pick(CSS)}`)); log.push(`stylesheet ${path}`); } continue; }
    if (r < 0.12) { const list = texts((path) => /\.m?js$/.test(path)); if (list.length) { const path = pick(list); files.set(path, textFile(`${textOf(path)}\n${pick(CODE)}`)); log.push(`code ${path}`); } continue; }
    if (r < 0.14) { const list = texts((path) => /\.(xlf|md)$/.test(path)); if (list.length) { const path = pick(list); insert(path, pick(TEXT)); log.push(`text ${path}`); } continue; }
    if (r < 0.16) { const path = pick([...files.keys()]); files.delete(path); log.push(`delete ${path}`); continue; }
    const path = pick(jsonFiles);
    if (!path || !files.has(path)) continue;
    let document: Json;
    try { document = JSON.parse(textOf(path)); } catch { continue; }
    if (r < 0.19) { const replacement = pick(DOCUMENTS); files.set(path, textFile(JSON.stringify(replacement))); log.push(`${path} = ${JSON.stringify(replacement)}`); continue; }
    const paths: Path[] = [];
    const walk = (node: Json, at: Path) => { if (at.length) paths.push(at); if (isContainer(node)) for (const [key, child] of Object.entries(node)) walk(child, [...at, Array.isArray(node) ? Number(key) : key]); };
    walk(document, []);
    if (!paths.length) continue;
    const target = pick(paths);
    const key = target[target.length - 1];
    let parent: Json = document;
    for (const step of target.slice(0, -1)) parent = isContainer(parent) ? (Array.isArray(parent) ? parent[Number(step)] : parent[String(step)]) : null;
    if (!isContainer(parent)) continue;
    const kind = random();
    if (Array.isArray(parent) && typeof key === 'number') {
      if (kind < 0.3) parent.splice(key, 1);
      else if (kind < 0.42) parent.splice(key, 0, structuredClone(parent[key]));
      else parent[key] = value();
    } else if (!Array.isArray(parent)) {
      if (kind < 0.3) delete parent[String(key)];
      else parent[String(key)] = value();
    }
    log.push(`${path} ${target.join('/')}`);
    files.set(path, textFile(JSON.stringify(document, null, 2)));
  }
  return log;
}
