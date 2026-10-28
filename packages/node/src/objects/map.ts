import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from '../util/values.ts';

// ── A map of a free object ───────────────────────────────────────────
// What an agent reads before changing an object, without reading it all: each code file's sections
// (the « // ── Name ── » comments) with their lines and the functions in them, the manifest's props
// (type, choices, default), words, objects, state, events, and the names of the tests. Read the
// lines a change needs afterwards (sed -n '120,180p objects/<id>/object.js').

export interface ObjectMapFunction { name: string; line: number }
export interface ObjectMapSection { title: string; from: number; to: number; functions: ObjectMapFunction[] }
export interface ObjectMapFile { file: string; lines: number; about: string; sections: ObjectMapSection[] }

export interface ObjectMap {
  id: string;
  title: string;
  role: string;
  files: ObjectMapFile[];
  props: { key: string; type: string; default?: unknown }[];
  strings: string[];
  objects: string[];
  state: string[];
  events: string[];
  // Each test with its steps in short (step 10 · click boat · expect-state {…}).
  tests: { name: string; steps: number; outline: string }[];
  other: string[];
}

const SECTION = /^\s*\/\/\s*[─—-]{2,}\s*(.+?)\s*[─—-]{2,}/;
// A function at the top of the file or in mount() (two levels of indentation at most).
const FUNCTION = /^( {0,4}|\t{0,2})(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|^( {0,4}|\t{0,2})(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function\b)/;

export function mapCode(file: string, text: string): ObjectMapFile {
  const lines = text.split('\n');
  // The comment at the head of the file, in one line.
  const head: string[] = [];
  for (const line of lines) {
    const comment = /^\s*\/\/\s?(.*)$/.exec(line);
    if (!comment) { if (line.trim() === '' && !head.length) continue; break; }
    if (SECTION.test(line)) break;
    head.push(comment[1].trim());
  }
  const about = head.join(' ').replace(/\s+/g, ' ').slice(0, 240);
  const sections: ObjectMapSection[] = [{ title: '(top)', from: 1, to: lines.length, functions: [] }];
  for (const [index, line] of lines.entries()) {
    const section = SECTION.exec(line);
    if (section) {
      sections[sections.length - 1].to = index;
      sections.push({ title: section[1], from: index + 1, to: lines.length, functions: [] });
      continue;
    }
    const found = FUNCTION.exec(line);
    const name = found?.[2] || found?.[4];
    if (name) sections[sections.length - 1].functions.push({ name, line: index + 1 });
  }
  return { file, lines: lines.length, about, sections: sections.filter((section) => section.title !== '(top)' || section.functions.length || sections.length === 1) };
}

function propType(schema: unknown): string {
  if (!isRecord(schema)) return '?';
  if (Array.isArray(schema.enum)) return schema.enum.map(String).join('|');
  const type = Array.isArray(schema.type) ? schema.type.join('|') : String(schema.type ?? (schema.$ref ? 'ref' : '?'));
  const range = [schema.minimum, schema.maximum].some((value) => typeof value === 'number') ? ` ${schema.minimum ?? ''}..${schema.maximum ?? ''}` : '';
  if (type === 'array' && isRecord(schema.items)) return `array of ${isRecord(schema.items.properties) ? `{${Object.keys(schema.items.properties).join(', ')}}` : propType(schema.items)}`;
  return `${type}${range}${schema.format ? ` (${String(schema.format)})` : ''}`;
}

const keysOf = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : []);
const namesOf = (value: unknown, field: string): string[] => (Array.isArray(value) ? value.map((entry) => (isRecord(entry) ? String(entry[field] ?? '') : '')).filter(Boolean) : []);

export function objectMap(dir: string, id: string): ObjectMap | { error: string } {
  const objectDir = path.join(dir, 'objects', id);
  const manifestFile = path.join(objectDir, 'object.manifest.json');
  if (!fs.existsSync(manifestFile)) {
    const known = fs.existsSync(path.join(dir, 'objects')) ? fs.readdirSync(path.join(dir, 'objects')).filter((name) => fs.existsSync(path.join(dir, 'objects', name, 'object.manifest.json'))) : [];
    return { error: `No free object "${id}" in objects/.${known.length ? ` Objects: ${known.join(', ')}.` : ''}` };
  }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (error) { return { error: `objects/${id}/object.manifest.json is not valid JSON: ${(error as Error).message}` }; }
  let tests: unknown = null;
  try { tests = JSON.parse(fs.readFileSync(path.join(objectDir, 'object.tests.json'), 'utf8')); } catch { /* none */ }
  const entries = fs.readdirSync(objectDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  // object.js first, then its modules.
  const code = entries.filter((name) => /\.(m?js)$/.test(name)).sort((a, b) => (a === 'object.js' ? -1 : b === 'object.js' ? 1 : a.localeCompare(b)));
  const props = isRecord(manifest.props) && isRecord(manifest.props.properties) ? manifest.props.properties : {};
  return {
    id, title: String(manifest.title ?? id), role: String(manifest.pedagogicalRole ?? '?'),
    files: code.map((name) => mapCode(name, fs.readFileSync(path.join(objectDir, name), 'utf8'))),
    props: Object.entries(props).map(([key, schema]) => ({ key, type: propType(schema), ...(isRecord(schema) && schema.default !== undefined && typeof schema.default !== 'object' ? { default: schema.default } : {}) })),
    strings: keysOf(manifest.strings),
    objects: namesOf(manifest.objects, 'id'),
    state: isRecord(manifest.state) ? keysOf(manifest.state.properties) : [],
    events: namesOf(manifest.events, 'name'),
    tests: isRecord(tests) && Array.isArray(tests.tests) ? tests.tests.filter(isRecord).map((test) => ({ name: String(test.name ?? ''), steps: Array.isArray(test.steps) ? test.steps.length : 0, outline: testOutline(test) })) : [],
    other: entries.filter((name) => !code.includes(name) && !name.startsWith('.'))
  };
}

// A test's steps on one line, values cut short.
function testOutline(test: Record<string, unknown>): string {
  const short = (value: unknown) => { const text = JSON.stringify(value) ?? ''; return text.length > 60 ? `${text.slice(0, 57)}…` : text; };
  const steps = Array.isArray(test.steps) ? test.steps.filter(isRecord) : [];
  const setup = ['props', 'context', 'size', 'reducedMotion'].filter((key) => test[key] !== undefined).map((key) => `${key} ${short(test[key])}`);
  return [...setup, ...steps.map((step) => {
    const { action, ...rest } = step;
    const detail = Object.entries(rest).map(([key, value]) => (typeof value === 'string' || typeof value === 'number' ? `${key === 'name' || key === 'object' || key === 'frames' || key === 'key' ? '' : `${key} `}${value}` : `${key} ${short(value)}`)).join(' ');
    return `${String(action)}${detail ? ` ${detail}` : ''}`;
  })].join(' · ');
}

export function objectMapText(map: ObjectMap, { tests = false }: { tests?: boolean } = {}): string {
  const out = [`${map.id} — ${map.title} (${map.role})`];
  for (const file of map.files) {
    out.push('', `${file.file} (${file.lines} lines)${file.about ? `: ${file.about}` : ''}`);
    for (const section of file.sections) {
      const functions = section.functions.map((fn) => `${fn.name} ${fn.line}`).join(', ');
      out.push(`  ${`${section.from}–${section.to}`.padEnd(11)} ${section.title}${functions ? `: ${functions}` : ''}`);
    }
  }
  if (map.props.length) out.push('', `props: ${map.props.map((prop) => `${prop.key} ${prop.type}${prop.default !== undefined ? ` = ${JSON.stringify(prop.default)}` : ''}`).join('; ')}`);
  if (map.strings.length) out.push(`strings (${map.strings.length}): ${map.strings.join(', ')}`);
  if (map.objects.length) out.push(`objects: ${map.objects.join(', ')}`);
  if (map.state.length) out.push(`state: ${map.state.join(', ')}`);
  out.push(`events: ${map.events.join(', ') || 'none'}`);
  if (map.tests.length && tests) out.push('', `tests (${map.tests.length}):`, ...map.tests.map((test) => `- ${test.name}: ${test.outline}`));
  else if (map.tests.length) out.push(`tests (${map.tests.length}): ${map.tests.map((test) => `${test.name} [${test.steps}]`).join(' | ')} (--tests: their steps)`);
  if (map.other.length) out.push(`other files: ${map.other.join(', ')}`);
  return out.join('\n');
}
