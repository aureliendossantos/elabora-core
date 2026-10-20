import type { PatchOperation } from '@elabora/format';

// JSON Patch (RFC 6902) for writing the plan (write_plan). Documents are plain JSON values, walked
// by key: arrays by index, objects by name.
type Container = Record<string, unknown> | unknown[];
const isContainer = (o: unknown): o is Container => o != null && typeof o === 'object';
const child = (o: Container, k: string): unknown => (Array.isArray(o) ? o[Number(k)] : o[k]);

function parse(ptr: string): string[] {
  if (ptr === '') return [];
  if (!ptr.startsWith('/')) throw new Error(`Invalid pointer "${ptr}"`);
  return ptr.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function parentOf(doc: unknown, parts: string[]): Container {
  let o = doc;
  for (const k of parts.slice(0, -1)) {
    if (!isContainer(o)) throw new Error(`Path not found at "${k}"`);
    o = child(o, k);
  }
  if (!isContainer(o)) throw new Error('Parent not found');
  return o;
}
function get(doc: unknown, parts: string[]): unknown {
  return parts.reduce<unknown>((o, k) => {
    if (o == null) throw new Error(`Path not found at "${k}"`);
    return (o as Record<string, unknown>)[Array.isArray(o) ? Number(k) : k];
  }, doc);
}
function add(doc: unknown, parts: string[], value: unknown): unknown {
  if (!parts.length) return value;
  const p = parentOf(doc, parts);
  const k = parts[parts.length - 1];
  if (Array.isArray(p)) {
    const i = k === '-' ? p.length : Number(k);
    if (!(i >= 0 && i <= p.length)) throw new Error(`Index ${k} out of range`);
    p.splice(i, 0, value);
  } else p[k] = value;
  return doc;
}
function remove(doc: unknown, parts: string[]): unknown {
  const p = parentOf(doc, parts);
  const k = parts[parts.length - 1];
  if (Array.isArray(p)) {
    const i = Number(k);
    if (!(i >= 0 && i < p.length)) throw new Error(`Index ${k} out of range`);
    return p.splice(i, 1)[0];
  }
  if (!(k in p)) throw new Error(`No property "${k}"`);
  const v = p[k];
  delete p[k];
  return v;
}
const fromOf = (op: PatchOperation): string => {
  if (typeof op.from !== 'string') throw new Error(`${op.op} at ${op.path} needs from`);
  return op.from;
};

export function applyPatch<T>(doc: T, ops: readonly PatchOperation[]): T {
  let d: unknown = doc;
  for (const op of ops) {
    const parts = parse(op.path);
    switch (op.op) {
      case 'add': d = add(d, parts, structuredClone(op.value)); break;
      case 'remove': remove(d, parts); break;
      case 'replace': remove(d, parts); d = add(d, parts, structuredClone(op.value)); break;
      case 'move': { const v = remove(d, parse(fromOf(op))); d = add(d, parts, v); break; }
      case 'copy': d = add(d, parts, structuredClone(get(d, parse(fromOf(op))))); break;
      case 'test': if (JSON.stringify(get(d, parts)) !== JSON.stringify(op.value)) throw new Error(`test failed at ${op.path}`); break;
      default: throw new Error(`Unknown op ${(op as { op: string }).op}`);
    }
  }
  return d as T;
}
