import { parseJSON } from '../util/json.ts';
import { readText, filesIn, foldersIn, getFile } from './files.ts';
import type { ProjectFiles, SyncArtefact, MediaStatus } from './files.ts';
import type { Project, Course, Plan, Screen, ScreenLayer, Block, ObjectManifest, ObjectTests, ComponentManifest, PlanVersion, PlanNote, TranslationApproval, PlanObjective, PlanItem, PlanSource, LockedText, PlanQuestion } from './model.ts';
import { getRegistry, rootOf, defaultSlotOf } from '../components/registry.ts';
import type { Registry, ComponentDescriptor } from '../components/registry.ts';
import { parseTemplate, analyzeTemplate } from '../components/template.ts';
import { isRecord, listOf, objectsIn } from '../util/values.ts';
import { checkFormat, newerMessage, outdatedMessage } from '../format/migrations/index.ts';
import { PLAN_NOTES_FILE, PLAN_VERSION_FILE, PLAN_VERSIONS_DIR } from './plan-versions.ts';

export { planContentHash } from './plan-versions.ts';

// A course project is a set of files:
//   course.json, plan.json, screens/<id>.json, objects/<id>/{object.manifest.json, object.js, object.tests.json, object.notes.md},
//   components/<id>/{component.json, template.html, component.css, migrations.mjs}, theme/…, generators/*.mjs,
//   assets/…, plan-versions/V<n>.json and notes.json, translations/<lang>.xlf, elabora.lock.json, AGENTS.md
// Loading never throws on content problems: parse errors become diagnostics. A document that parses
// but is not a JSON object is reported (E_SCHEMA) and left out like a file that does not parse;
// below that, documents are kept as they are and the validator reports what breaks their schema.
// A project in an older format is read migrated in memory (I_FORMAT_OUTDATED; project.files are the
// migrated files); one in a newer format is not read past its format (E_FORMAT_NEWER).

export interface LoadOptions {
  root?: string; // where the files come from, for messages and Node services
  artefacts?: readonly SyncArtefact[]; // sync-service files found next to the project's, reported
  media?: MediaStatus; // media jobs under way, unreadable media, probe tools missing
}

const byLocale = (a: string, b: string): number => a.localeCompare(b);

export function loadProject(source: ProjectFiles, options: LoadOptions = {}): Project {
  const format = checkFormat(source);
  const files = format.status === 'outdated' ? format.migration.files : source;
  const project: Project = {
    root: options.root ?? '',
    files,
    course: null,
    plan: null,
    screens: new Map(),
    objects: new Map(),
    components: new Map(),
    planVersions: [],
    planNotes: [],
    translations: new Map(),
    loadErrors: [],
    ...(options.media ? { media: options.media } : {})
  };
  const fail = (code: string, file: string, message: string) => { project.loadErrors.push({ code, file, message }); };
  const exists = (rel: string) => getFile(files, rel) !== undefined;
  // The value of a JSON document, an object; null when it is not one (reported).
  const documentOf = (rel: string, schema: string, value: unknown): Record<string, unknown> | null => {
    if (isRecord(value)) return value;
    fail('E_SCHEMA', rel, `/: must be object (schema ${schema})`);
    return null;
  };
  // undefined: the file is missing; null: it does not parse or is not an object (reported).
  const readDocument = (rel: string, schema: string): Record<string, unknown> | null | undefined => {
    const text = readText(files, rel);
    if (text === null) return undefined;
    const r = parseJSON(text);
    if (r.error !== undefined) { fail('E_JSON_PARSE', rel, r.error); return null; }
    return documentOf(rel, schema, r.value);
  };
  const readRequired = (rel: string, schema: string): Record<string, unknown> | null => {
    if (!exists(rel)) { fail('E_FILE_MISSING', rel, `${rel} not found`); return null; }
    return readDocument(rel, schema) ?? null;
  };

  if (format.status === 'newer') {
    fail('E_FORMAT_NEWER', 'course.json', `${newerMessage(format.format)} Nothing else was loaded.`);
    return project;
  }
  if (format.status === 'outdated') {
    const { from, to, changed, notes } = format.migration;
    project.migration = { from, to, changed, notes };
    fail('I_FORMAT_OUTDATED', 'course.json', outdatedMessage(format.migration));
  }

  // The documents keep the types of the format: what does not match them is reported by the validator.
  project.course = readRequired('course.json', 'course') as Course | null;
  project.plan = readRequired('plan.json', 'plan') as Plan | null;

  for (const name of filesIn(files, 'screens').filter((n) => n.endsWith('.json'))) {
    const rel = `screens/${name}`;
    const data = readDocument(rel, 'screen');
    if (data === null || data === undefined) continue;
    project.screens.set(name.replace(/\.json$/, ''), { file: rel, data: data as Screen });
  }

  for (const id of foldersIn(files, 'objects').sort(byLocale)) {
    const rel = (f: string) => `objects/${id}/${f}`;
    const obj = { id, folder: `objects/${id}`, manifest: null as ObjectManifest | null, code: null as string | null, tests: null as ObjectTests | null, notes: null as string | null };
    if (!exists(rel('object.manifest.json'))) fail('E_FILE_MISSING', rel('object.manifest.json'), `${rel('object.manifest.json')} not found`);
    else obj.manifest = (readDocument(rel('object.manifest.json'), 'object-manifest') ?? null) as ObjectManifest | null;
    if (!exists(rel('object.js'))) fail('E_FILE_MISSING', rel('object.js'), `${rel('object.js')} not found`);
    else obj.code = readText(files, rel('object.js'));
    if (exists(rel('object.tests.json'))) obj.tests = (readDocument(rel('object.tests.json'), 'object-tests') ?? null) as ObjectTests | null;
    obj.notes = readText(files, rel('object.notes.md'));
    project.objects.set(id, obj);
  }

  // Course components (components/<id>/): block types and screen layouts defined by the course.
  for (const id of foldersIn(files, 'components').sort(byLocale)) {
    const rel = (f: string) => `components/${id}/${f}`;
    let manifest: ComponentManifest | null = null;
    const manifestText = readText(files, rel('component.json'));
    if (manifestText === null) fail('E_FILE_MISSING', rel('component.json'), `${rel('component.json')} not found`);
    else {
      let value: unknown;
      try { value = JSON.parse(manifestText); } catch (err) { fail('E_JSON_PARSE', rel('component.json'), err instanceof Error ? err.message : String(err)); }
      if (value !== undefined) manifest = documentOf(rel('component.json'), 'component', value) as ComponentManifest | null;
    }
    const migrationsSource = readText(files, rel('migrations.mjs'));
    project.components.set(id, {
      id, folder: `components/${id}`, manifest,
      template: readText(files, rel('template.html')), css: readText(files, rel('component.css')),
      migrations: migrationsSource !== null ? rel('migrations.mjs') : null, migrationsSource
    });
  }

  // The plan's versions, by their number; the validator reports one whose content does not hold
  // together, and only those that do count (usableVersions).
  for (const name of filesIn(files, PLAN_VERSIONS_DIR)) {
    const rel = `${PLAN_VERSIONS_DIR}/${name}`;
    const match = PLAN_VERSION_FILE.exec(rel);
    if (!match) continue;
    const data = readDocument(rel, 'plan-version');
    if (data === null || data === undefined) continue;
    project.planVersions.push({ file: rel, number: Number(match[1]), data: data as PlanVersion });
  }
  project.planVersions.sort((a, b) => a.number - b.number);
  const notes = readDocument(PLAN_NOTES_FILE, 'plan-notes');
  if (notes && Array.isArray(notes.notes)) project.planNotes = objectsIn(notes.notes as PlanNote[]).filter((note) => typeof note.target === 'string' && typeof note.text === 'string');

  // Translations are read by `elabora translate`, not validated with the course: their files are
  // kept as they are (a broken approval file is an error of the translate commands).
  for (const name of filesIn(files, 'translations').filter((n) => n.endsWith('.xlf'))) {
    const language = name.slice(0, -4);
    const approvalFile = `translations/${language}.approval.json`;
    const approvalText = readText(files, approvalFile);
    const approval = approvalText === null ? null : parseJSON(approvalText);
    project.translations.set(language, {
      language, file: `translations/${name}`, xliff: readText(files, `translations/${name}`) ?? '', approvalFile,
      approval: (approval?.value ?? null) as TranslationApproval | null, approvalError: approval?.error ?? null
    });
  }

  for (const a of options.artefacts || []) {
    fail('W_SYNC_CONFLICT_COPY', a.path, a.kind === 'cloud-placeholder'
      ? `${a.original ?? a.path} is only in the cloud (${a.path}): it is not loaded until it is downloaded.`
      : `${a.path} looks like a copy of ${a.original ?? 'another file'} made by a sync service after a conflict: it is not loaded.`);
  }
  return project;
}

// Screens in learner order, as listed by course.json sections.
export function screenOrder(project: Project): { id: string; section: string }[] {
  const out: { id: string; section: string }[] = [];
  for (const section of objectsIn(project.course?.sections)) for (const id of listOf(section.screens)) if (typeof id === 'string') out.push({ id, section: section.id });
  return out;
}

// A block with its location: path is the JSON pointer of the block in its screen file.
export interface BlockLocation {
  screen: Screen;
  file: string | undefined;
  layer: ScreenLayer | null;
  block: Block;
  path: string;
  parent: Block | null; // the component instance whose slots hold the block
}

// Every block of the course with its location, including blocks inside layers and blocks placed in
// the slots of component instances (parent: the instance holding them).
export function* iterateBlocks(project: Project): Generator<BlockLocation> {
  for (const { id } of screenOrder(project)) {
    const entry = project.screens.get(id);
    if (!entry) continue;
    yield* screenBlocks(entry.data, entry.file);
  }
}

// Blocks that are not objects fail the schema and are left out (paths keep their index).
export function* screenBlocks(screen: Screen, file?: string): Generator<BlockLocation> {
  function* walk(blocks: Block[] | undefined, base: string, layer: ScreenLayer | null, parent: Block | null): Generator<BlockLocation> {
    for (const [i, block] of listOf(blocks).entries()) {
      if (!isRecord(block)) continue;
      const p = `${base}/${i}`;
      yield { screen, file, layer, block, path: p, parent };
      if (Array.isArray(block.blocks)) yield* walk(block.blocks, `${p}/blocks`, layer, block);
    }
  }
  yield* walk(screen?.blocks, '/blocks', null, null);
  for (const [li, layer] of listOf(screen?.layers).entries()) if (isRecord(layer)) yield* walk(layer.blocks, `/layers/${li}/blocks`, layer, null);
}

export interface PlanIndex {
  objectives: Map<string, PlanObjective>;
  items: Map<string, PlanItem>;
  texts: Map<string, LockedText & { item: string }>;
  questions: Map<string, PlanQuestion & { item: string; objectives: string[] }>;
  sources: Map<string, PlanSource>;
}

export function planIndex(plan: Plan | null | undefined): PlanIndex {
  const idx: PlanIndex = { objectives: new Map(), items: new Map(), texts: new Map(), questions: new Map(), sources: new Map() };
  if (!plan) return idx;
  for (const o of objectsIn(plan.objectives)) idx.objectives.set(o.id, o);
  for (const s of objectsIn(plan.sources)) idx.sources.set(s.id, s);
  for (const item of objectsIn(plan.items)) {
    idx.items.set(item.id, item);
    for (const t of objectsIn(item.lockedTexts)) idx.texts.set(t.id, { ...t, item: item.id });
    for (const q of objectsIn(item.questions)) {
      const own = listOf(q.objectives);
      idx.questions.set(q.id, { ...q, item: item.id, objectives: [...(own.length ? own : listOf(item.objectives))] });
    }
  }
  return idx;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// Resolve plan references of a block so renderers and projections see final content.
// Built-in roots: textRef (text, callout, heading) and questionRef (quiz, numeric), also for their
// forks. Component props of kind text or markdown may be { "textRef": "TXT-n" } anywhere.
// With questionRef, a quiz may still give per-option presentation fields (an image, a code) keyed by
// option id: the plan's text, correctness and feedback always win.
export function resolveBlockProps(block: { type: string; props?: Record<string, unknown> }, pidx: PlanIndex, reg?: Registry | null): Record<string, unknown> {
  const root = reg ? rootOf(reg, block.type) : block.type;
  const p: Record<string, unknown> = { ...(isRecord(block.props) ? block.props : {}) };
  const text = pidx.texts.get(str(p.textRef) ?? '');
  if ((root === 'text' || root === 'callout') && p.textRef && text) p.markdown = text.text;
  if (root === 'heading' && p.textRef && text) p.text = text.text;
  const q = pidx.questions.get(str(p.questionRef) ?? '');
  if (root === 'numeric' && p.questionRef && q) {
    for (const k of ['stem', 'answer', 'tolerance', 'unit', 'feedback', 'misconceptions'] as const) if (q[k] !== undefined) p[k] = q[k];
    if (!p.objective && q.objectives?.length) p.objective = q.objectives[0];
  }
  if (root === 'quiz' && p.questionRef && q) {
    const given = Array.isArray(p.options) ? (p.options as unknown[]) : [];
    const extra = new Map(given.map((o) => [(o as { id?: unknown } | null)?.id, o as Record<string, unknown> | null]));
    p.stem = q.stem;
    p.mode = q.mode;
    p.options = objectsIn(q.options).map((o) => ({ ...(extra.get(o.id) || {}), ...o }));
    if (!p.objective && q.objectives?.length) p.objective = q.objectives[0];
  }
  if (reg && !reg.get(block.type)?.builtin) return resolveTextRefs(p, pidx) as Record<string, unknown>;
  return p;
}

// { "textRef": "TXT-n" } → the locked text, anywhere in a value.
export function resolveTextRefs(value: unknown, pidx: PlanIndex): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveTextRefs(v, pidx));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'textRef' && typeof record.textRef === 'string') return pidx.texts.get(record.textRef)?.text ?? value;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, resolveTextRefs(v, pidx)]));
}

export interface PlanRef {
  kind: 'textRef' | 'questionRef';
  id: string;
  path: string;
}

// Every textRef / questionRef in a block's props, with its JSON pointer below props.
export function planRefs(props: unknown, base = ''): PlanRef[] {
  const out: PlanRef[] = [];
  const walk = (v: unknown, p: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}/${i}`));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'textRef' || k === 'questionRef') && typeof x === 'string') out.push({ kind: k, id: x, path: `${p}/${k}` });
      else walk(x, `${p}/${k}`);
    }
  };
  walk(props, base);
  return out;
}

// Blocks of a screen (or of a component instance) in reading order: slots follow the order of the
// template, and blocks keep their relative order inside a slot. Without slots, the block order.
export function readingOrder(blocks: Block[] | undefined, component: ComponentDescriptor | null | undefined): Block[] {
  const list = objectsIn(blocks);
  if (!component?.tpl || !component.slots?.length) return list;
  const order = templateSlotOrder(component);
  const def = component.defaultSlot;
  const rank = (b: Block) => { const i = order.indexOf(b.slot || def || ''); return i < 0 ? order.length : i; };
  return list.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i).map((x) => x.b);
}

const slotOrders = new WeakMap<ComponentDescriptor, string[]>();
export function templateSlotOrder(component: ComponentDescriptor | null | undefined): string[] {
  if (!component?.tpl) return [];
  let order = slotOrders.get(component);
  if (!order) { order = analyzeTemplate(component.tpl, component.schema).slots.map((s) => s.id); slotOrders.set(component, order); }
  return order;
}

// The screen layout (a screen-level component) of a screen, or null.
export function screenLayout(project: Project, screen: Screen | null | undefined): ComponentDescriptor | null {
  if (!screen?.layout) return null;
  const d = getRegistry(project).get(screen.layout);
  return d && d.level === 'screen' ? d : null;
}

export { getRegistry, defaultSlotOf, parseTemplate };
