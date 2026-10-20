import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { compileInline } from '@elabora/format/schemas';
import { stripX, propValueSchema, objectPropErrors, controlProblems, enumLabelProblems, textContrasts, TEXT_CONTRAST } from './object-props.ts';
import { tokenNames, resolveTokens } from './theme.ts';
import { hasFile, isSourcePath, projectPath, readText } from '../project/files.ts';
import type { ProjectFiles } from '../project/files.ts';
import type { ObjectManifest, ProjectObject } from '../project/model.ts';
import { normalize, join, dirname } from '../util/paths.ts';
import { screenBlocks } from '../project/load.ts';
import type { CheckContext, CourseCheckContext, ScreenFile } from './context.ts';
import { list, fieldsOf, byId, hasId } from './guards.ts';

export const ALLOWED_THREE_ADDONS = ['loaders/GLTFLoader.js', 'controls/OrbitControls.js'];

// Globals a sandboxed free object must not touch: no network, no storage, no access to the
// host page, no dynamic code. The iframe sandbox and CSP enforce it at run time; this static
// check tells the agent before it ships.
const FORBIDDEN_GLOBALS = new Set(['parent', 'top', 'opener', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'eval', 'importScripts', 'caches', 'BroadcastChannel', 'SharedWorker']);
const FORBIDDEN_MEMBERS = [
  ['window', 'parent'], ['window', 'top'], ['window', 'opener'], ['window', 'open'], ['window', 'localStorage'], ['window', 'sessionStorage'], ['window', 'fetch'], ['self', 'fetch'],
  ['document', 'cookie'], ['navigator', 'sendBeacon'], ['window', 'postMessage'], ['globalThis', 'fetch'], ['document', 'domain']
];
const NONDETERMINISM = [['Math', 'random'], ['Date', 'now'], ['performance', 'now']];
const NONDETERMINISTIC_GLOBALS = new Set(['requestAnimationFrame', 'setInterval', 'setTimeout']);
// XML namespace names look like URLs but are never fetched (document.createElementNS).
const XML_NAMESPACES = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xhtml', 'http://www.w3.org/1999/xlink', 'http://www.w3.org/1998/Math/MathML', 'http://www.w3.org/XML/1998/namespace', 'http://www.w3.org/2000/xmlns/']);

// Free objects: the course backdrop object, then each manifest and its code. Where they are placed
// is checked by checkObjectUsage and checkScreenObjects.
export function checkObjects(ctx: CourseCheckContext): void {
  const { project, reporter, planIndex } = ctx;
  checkBackdropObject(ctx);
  for (const object of project.objects.values()) {
    const manifestFile = `objects/${object.id}/object.manifest.json`;
    const manifest = object.manifest;
    if (!manifest) continue;
    if (manifest.id !== object.id) reporter.emit('E_OBJECT_ID_MISMATCH', { file: manifestFile, path: '/id', target: object.id, message: `Manifest id "${manifest.id}" in folder objects/${object.id}/.` });

    list(manifest.planRefs?.objectives).forEach((objective, i) => { if (project.plan && !planIndex.objectives.has(objective)) reporter.emit('E_PLAN_REFERENCE', { file: manifestFile, path: `/planRefs/objectives/${i}`, target: object.id, message: `Unknown objective "${objective}".` }); });
    list(manifest.planRefs?.items).forEach((item, i) => { if (project.plan && !planIndex.items.has(item)) reporter.emit('E_PLAN_REFERENCE', { file: manifestFile, path: `/planRefs/items/${i}`, target: object.id, message: `Unknown plan item "${item}".` }); });

    const declaredObjects = new Set(list(manifest.objects).map((part) => part?.id));
    for (const [name, propSchema] of Object.entries(manifest.props?.properties || {})) {
      const path = `/props/properties/${name}`;
      try {
        const validate = compileInline(propValueSchema(propSchema));
        if (!validate(propSchema.default)) reporter.emit('E_OBJECT_PROP_DEFAULT', { file: manifestFile, path: `${path}/default`, target: object.id, message: `Default of prop "${name}" is invalid: ${(validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`.trim()).join(', ')}.` });
        // The fields of a list's items give new items their values.
        for (const [field, fieldSchema] of Object.entries(fieldsOf(fieldsOf(propSchema.items).properties))) {
          const { default: value } = fieldsOf(fieldSchema);
          const validateField = compileInline(stripX(fieldsOf(fieldSchema)));
          if (value !== undefined && !validateField(value)) reporter.emit('E_OBJECT_PROP_DEFAULT', { file: manifestFile, path: `${path}/items/properties/${field}/default`, target: object.id, message: `Default of field "${field}" of prop "${name}" is invalid: ${(validateField.errors ?? []).map((e) => `${e.instancePath} ${e.message}`.trim()).join(', ')}.` });
        }
      } catch (error) {
        reporter.emit('E_SCHEMA', { file: manifestFile, path, target: object.id, message: `Prop "${name}" schema does not compile: ${error instanceof Error ? error.message : String(error)}` });
      }
      for (const problem of controlProblems(propSchema)) {
        const where = problem.path === '/items' ? ', its items' : problem.path ? `, field "${problem.path.split('/').pop()}"` : '';
        reporter.emit('W_OBJECT_PROP_CONTROL', { file: manifestFile, path: `${path}${problem.path}/x-control`, target: object.id, message: `Prop "${name}"${where}: ${problem.message}.` });
      }
      for (const problem of enumLabelProblems(name, propSchema)) reporter.emit('E_OBJECT_ENUM_LABELS', { file: manifestFile, path: `${path}${problem.path}`, target: object.id, message: `${problem.message[0].toUpperCase()}${problem.message.slice(1)}.` });
      const annotations = fieldsOf(propSchema);
      const token = annotations['x-token'];
      const knownTokens: readonly unknown[] = tokenNames(ctx.course);
      if (token && !knownTokens.includes(token)) reporter.emit('E_OBJECT_TOKEN', { file: manifestFile, path: `${path}/x-token`, target: object.id, message: `Token "${token}" does not exist. Known: ${tokenNames(ctx.course).join(', ')}.` });
      const part = annotations['x-object-id'];
      if (part && !hasId(declaredObjects, part)) reporter.emit('E_OBJECT_OBJECT_ID', { file: manifestFile, path: `${path}/x-object-id`, target: object.id, message: `x-object-id "${part}" is not declared in objects.` });
    }
    // Text colours with the defaults, read against the course's tokens.
    for (const found of textContrasts(manifest, {}, resolveTokens(ctx.course))) {
      reporter.emit('E_OBJECT_TEXT_CONTRAST', { file: manifestFile, path: `/props/properties/${found.prop}/${found.ratio === null ? 'x-text-on' : 'default'}`, target: object.id, ...(found.ratio === null ? {} : { measured: found.ratio, limit: TEXT_CONTRAST }), message: `${found.message[0].toUpperCase()}${found.message.slice(1)}.` });
    }
    // Prop values of the behaviour tests, as a block would give them.
    const testsFile = `objects/${object.id}/object.tests.json`;
    list(object.tests?.tests).forEach((test, i) => {
      for (const error of objectPropErrors(manifest, test?.props || {})) reporter.emit('E_OBJECT_PROP_VALUE', { file: testsFile, path: `/tests/${i}/props${error.path}`, target: object.id, message: `Test "${test?.name}": ${error.message}.` });
      list(test?.steps).forEach((step, j) => {
        if (step?.action !== 'set-props') return;
        for (const error of objectPropErrors(manifest, step.props || {})) reporter.emit('E_OBJECT_PROP_VALUE', { file: testsFile, path: `/tests/${i}/steps/${j}/props${error.path}`, target: object.id, message: `Test "${test?.name}", set-props: ${error.message}.` });
      });
    });
    const allowed = new Set(list(manifest.planRefs?.objectives));
    list(manifest.events).forEach((event, i) => {
      const objective = event?.tracking?.interaction?.objective;
      if (objective && !allowed.has(objective)) reporter.emit('E_OBJECT_TRACKING_OBJECTIVE', { file: manifestFile, path: `/events/${i}/tracking/interaction/objective`, target: object.id, message: `Event "${event.name}" tracks objective ${objective}, not in planRefs (${[...allowed].join(', ')}).` });
    });
    list(manifest.assets).forEach((asset, i) => {
      const resolved = projectPath(`${object.folder}/${asset?.file}`);
      if (resolved !== null && isSourcePath(resolved)) reporter.emit('E_SOURCE_REFERENCED', { file: manifestFile, path: `/assets/${i}/file`, target: object.id, message: `${asset?.file} points to ${resolved}, one of the author's sources, which are never published: copy what the object needs into objects/${object.id}/.` });
      else if (!hasFile(project.files, `${object.folder}/${asset?.file}`)) reporter.emit('E_ASSET_MISSING', { file: manifestFile, path: `/assets/${i}/file`, target: object.id, message: `objects/${object.id}/${asset?.file} not found.` });
    });
    if (manifest.pedagogicalRole === 'decoration' && manifest.persistState?.enabled) reporter.emit('E_OBJECT_DECORATION', { file: manifestFile, path: '/persistState', target: object.id, message: 'A decoration keeps no learner state.' });
    if (!object.tests) reporter.emit('W_OBJECT_TESTS_MISSING', { file: testsFile, target: object.id });
    if (!object.notes?.trim()) reporter.emit('W_OBJECT_NOTES_MISSING', { file: `objects/${object.id}/object.notes.md`, target: object.id });
    if (object.code != null) analyzeObjectCode(ctx, object, manifest, { code: object.code });
  }
}

// Objects placed on no screen (free-object blocks) and not the course backdrop.
export function checkObjectUsage(ctx: CourseCheckContext): void {
  const used = new Set<unknown>([...ctx.blocks.values()].filter(({ block }) => block.type === 'free-object').map(({ block }) => fieldsOf(block.props).object));
  used.add(ctx.course.theme?.backdrop?.object?.id);
  for (const object of ctx.project.objects.values()) {
    if (object.manifest && !used.has(object.id)) ctx.reporter.emit('W_OBJECT_UNUSED', { file: `objects/${object.id}/object.manifest.json`, target: object.id, message: `Free object "${object.id}" is not placed on any screen.` });
  }
}

// Free-object blocks of a screen that place a decoration (the first block of each id: a duplicate
// is reported once, by E_DUPLICATE_ID).
export function checkScreenObjects(ctx: CourseCheckContext, screen: ScreenFile): void {
  for (const { block, path } of screenBlocks(screen.data, screen.file)) {
    if (block === null || block === undefined || block.type !== 'free-object' || ctx.blocks.get(block.id)?.block !== block) continue;
    const objectId = fieldsOf(block.props).object;
    if (byId(ctx.project.objects, objectId)?.manifest?.pedagogicalRole === 'decoration') ctx.reporter.emit('E_OBJECT_DECORATION', { file: screen.file, path: `${path}/props/object`, target: block.id, message: `"${objectId}" is a decoration: it belongs in theme.backdrop.object, not in a block.` });
  }
}

// The backdrop variant a screen picks (theme.backdrop.variants).
export function checkScreenBackdrop(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { id, file, data } = screen;
  if (data.backdrop === undefined) return;
  const backdrop = ctx.course.theme?.backdrop;
  const variants = new Set(Object.keys(backdrop?.variants || {}));
  if (!backdrop) ctx.reporter.emit('E_BACKDROP_VARIANT', { file, path: '/backdrop', target: id, message: `Screen "${id}" sets a backdrop but the theme declares none (theme.backdrop).` });
  else if (data.backdrop !== 'none' && !variants.has(data.backdrop)) ctx.reporter.emit('E_BACKDROP_VARIANT', { file, path: '/backdrop', target: id, message: `Backdrop variant "${data.backdrop}" is not declared. Declared: none${[...variants].map((variant) => `, ${variant}`).join('')}.` });
}

// The decorative object of the course backdrop (theme.backdrop.object).
function checkBackdropObject(ctx: CourseCheckContext): void {
  const reference = ctx.course.theme?.backdrop?.object;
  if (!reference) return;
  const at = '/theme/backdrop/object';
  const manifest = ctx.project.objects.get(reference.id)?.manifest;
  if (!manifest) { ctx.reporter.emit('E_BACKDROP_OBJECT', { file: 'course.json', path: `${at}/id`, target: reference.id, message: `No free object "${reference.id}" in objects/.` }); return; }
  if (manifest.pedagogicalRole !== 'decoration') ctx.reporter.emit('E_BACKDROP_OBJECT', { file: 'course.json', path: `${at}/id`, target: reference.id, message: `"${reference.id}" has pedagogicalRole "${manifest.pedagogicalRole}": a backdrop object is a decoration.` });
  for (const error of objectPropErrors(manifest, reference.props || {})) ctx.reporter.emit('E_BACKDROP_OBJECT', { file: 'course.json', path: `${at}/props${error.path}`, target: reference.id, message: `Backdrop object ${reference.id}: ${error.message}.` });
}

// Neutral greys (lights, shadows) are not brand colours.
function isGrey(hex: string): boolean {
  const h = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return h.slice(0, 2).toLowerCase() === h.slice(2, 4).toLowerCase() && h.slice(2, 4).toLowerCase() === h.slice(4, 6).toLowerCase();
}

interface CodeFile {
  code: string;
  rel?: string; // path in the object folder
  entry?: boolean; // object.js, not a file it imports
  seen?: Set<string>;
}

const nameOf = (node: acorn.AnyNode): string | undefined => (node.type === 'Identifier' || node.type === 'PrivateIdentifier' ? node.name : undefined);

// object.js and the relative files it imports are analysed with the same rules.
export function analyzeObjectCode(ctx: Pick<CheckContext, 'project' | 'reporter'>, object: ProjectObject, manifest: ObjectManifest, { code, rel = 'object.js', entry = true, seen = new Set() }: CodeFile): void {
  const { reporter } = ctx;
  const file = `objects/${object.id}/${rel}`;
  seen.add(rel);
  let ast: acorn.Program;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (error) {
    reporter.emit('E_OBJECT_PARSE', { file, target: object.id, message: `object.js: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  const at = (node: acorn.Node) => `line ${node.loc?.start.line}`;
  const found = (code: string, node: acorn.Node, message: string) => reporter.emit(code, { file, path: at(node), target: object.id, message });

  let exportsMount = false;
  const literalColors: acorn.Literal[] = [];
  const shadowed = new Set<string>();
  // Parameters are local bindings too: function mesh(geo, mat, parent) is not window.parent.
  const addPattern = (pattern: acorn.Pattern | null | undefined): void => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') shadowed.add(pattern.name);
    else if (pattern.type === 'AssignmentPattern') addPattern(pattern.left);
    else if (pattern.type === 'RestElement') addPattern(pattern.argument);
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(addPattern);
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((property) => addPattern(property.type === 'Property' ? property.value : property.argument));
  };
  walk.full(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') shadowed.add(node.id.name);
    if (node.type === 'FunctionDeclaration' && node.id) shadowed.add(node.id.name);
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') for (const parameter of node.params || []) addPattern(parameter);
    if (node.type === 'CatchClause' && node.param) addPattern(node.param);
  });

  walk.fullAncestor(ast, (node, _state, ancestors) => {
    const parent = ancestors[ancestors.length - 2];
    switch (node.type) {
      case 'ImportDeclaration': {
        const source = String(node.source.value);
        if (source.startsWith('./') || source.startsWith('../')) {
          const target = normalize(join(dirname(rel), source));
          const imported = target.startsWith('..') ? null : readText(ctx.project.files, `${object.folder}/${target}`);
          if (target.startsWith('..')) found('E_OBJECT_IMPORT', node, `Import "${source}" leaves the object folder: copy the file into objects/${object.id}/.`);
          else if (!seen.has(target) && imported !== null) analyzeObjectCode(ctx, object, manifest, { code: imported, rel: target, entry: false, seen });
        }
        const allowed = source === 'three' || source.startsWith('./') || source.startsWith('../') || (source.startsWith('three/addons/') && ALLOWED_THREE_ADDONS.includes(source.slice('three/addons/'.length)));
        if (!allowed) found('E_OBJECT_IMPORT', node, `Import "${source}" is not allowed. Allowed: "three", ${ALLOWED_THREE_ADDONS.map((addon) => `"three/addons/${addon}"`).join(', ')}, and relative files.`);
        if ((source === 'three' || source.startsWith('three/')) && !manifest.requires?.three) found('E_OBJECT_IMPORT', node, 'The code imports three.js but the manifest has no requires.three ("r186").');
        break;
      }
      case 'ImportExpression':
        found('E_OBJECT_FORBIDDEN_API', node, 'Dynamic import() is not allowed in free objects.');
        break;
      case 'ExportNamedDeclaration':
        if (node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === 'mount') exportsMount = true;
        if (node.declaration?.type === 'VariableDeclaration' && node.declaration.declarations.some((declarator) => nameOf(declarator.id) === 'mount')) exportsMount = true;
        if (node.specifiers?.some((specifier) => nameOf(specifier.exported) === 'mount')) exportsMount = true;
        break;
      case 'Identifier': {
        const isProperty = parent && ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed) || (parent.type === 'Property' && parent.key === node && !parent.computed) || parent.type === 'MethodDefinition');
        if (isProperty || shadowed.has(node.name)) break;
        if (FORBIDDEN_GLOBALS.has(node.name)) found('E_OBJECT_FORBIDDEN_API', node, `"${node.name}" is not available to free objects.`);
        if (NONDETERMINISTIC_GLOBALS.has(node.name)) found('E_OBJECT_NONDETERMINISM', node, `"${node.name}": use host.onFrame(fn) for animation and time.`);
        if (node.name === 'Function' && parent?.type === 'NewExpression') found('E_OBJECT_FORBIDDEN_API', node, 'new Function() is not allowed.');
        break;
      }
      case 'MemberExpression': {
        if (node.computed || node.object.type !== 'Identifier') break;
        const pair = [node.object.name, nameOf(node.property)];
        if (FORBIDDEN_MEMBERS.some(([a, b]) => a === pair[0] && b === pair[1])) found('E_OBJECT_FORBIDDEN_API', node, `"${pair.join('.')}" is not available to free objects.`);
        if (NONDETERMINISM.some(([a, b]) => a === pair[0] && b === pair[1])) found('E_OBJECT_NONDETERMINISM', node, `"${pair.join('.')}": use host.${pair[1] === 'random' ? 'random()' : 'now()'} so tests can replay the object.`);
        break;
      }
      case 'NewExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) found('E_OBJECT_NONDETERMINISM', node, '"new Date()": use host.now().');
        break;
      case 'CallExpression': {
        // ctx.t('key') or t('key'): the key must be a declared string.
        const callee = node.callee;
        const isTranslation = (callee.type === 'Identifier' && callee.name === 't') || (callee.type === 'MemberExpression' && !callee.computed && nameOf(callee.property) === 't');
        const key = node.arguments[0];
        if (isTranslation && key?.type === 'Literal' && typeof key.value === 'string' && !manifest.strings?.[key.value]) reporter.emit('W_OBJECT_STRING_UNDECLARED', { file, path: at(node), target: object.id, message: `ctx.t("${key.value}"): no string "${key.value}" in the manifest.` });
        break;
      }
      case 'Literal': {
        const raw = node.raw ?? '';
        if (typeof node.value === 'string') {
          if (/^(https?:)?\/\//i.test(node.value) && !XML_NAMESPACES.has(node.value)) found('E_EXTERNAL_RESOURCE', node, `URL "${node.value.slice(0, 60)}" in object code: assets go through host.asset().`);
          if (/^#[0-9a-f]{6}$|^#[0-9a-f]{3}$/i.test(node.value) && !isGrey(node.value.slice(1))) literalColors.push(node);
        } else if (typeof node.value === 'number' && /^0x[0-9a-f]{6}$/i.test(raw) && !isGrey(raw.slice(2))) literalColors.push(node);
        break;
      }
    }
  });
  if (!entry) {
    if (literalColors.length) reporter.emit('W_OBJECT_LITERAL_COLOR', { file, path: literalColors.slice(0, 5).map(at).join(', '), target: object.id, measured: literalColors.length, message: `${literalColors.length} hard-coded colour(s) in ${rel}.` });
    return;
  }
  if (!exportsMount) reporter.emit('E_OBJECT_CODE_MISSING_MOUNT', { file, target: object.id });
  if (literalColors.length) {
    reporter.emit('W_OBJECT_LITERAL_COLOR', { file, path: literalColors.slice(0, 5).map(at).join(', '), target: object.id, measured: literalColors.length, message: `${literalColors.length} hard-coded colour(s) in object.js (${literalColors.slice(0, 5).map((literal) => literal.raw).join(', ')}${literalColors.length > 5 ? '…' : ''}).` });
  }
  const allCode = code + relativeSources(ctx.project.files, object, code);
  for (const name of Object.keys(manifest.props?.properties || {})) {
    if (!new RegExp(`\\b${name}\\b`).test(allCode)) reporter.emit('W_OBJECT_PROP_UNUSED', { file, target: object.id, message: `Prop "${name}" is declared but never read in object.js.` });
  }
}

// Source of the relative files imported by object.js (one level), for prop usage.
function relativeSources(files: ProjectFiles, object: ProjectObject, code: string): string {
  let out = '';
  for (const match of code.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
    const source = readText(files, `${object.folder}/${match[1]}`);
    if (source !== null) out += `\n${source}`;
  }
  return out;
}
