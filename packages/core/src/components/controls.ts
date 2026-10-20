import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { getRegistry, hooksOf } from './registry.ts';
import { renderTemplate } from './template.ts';
import { applyDefaults } from './props.ts';
import { planIndex, resolveBlockProps } from '../project/load.ts';
import type { PlanIndex } from '../project/load.ts';
import type { Project, Block } from '../project/model.ts';
import { isRecord } from '../util/values.ts';

// Controls of a block: what the learner activates in its template, by name. Buttons (data-t-click,
// unnamed or ="name", the name possibly bound to a prop: one marker per item of a list), tabs
// (data-t-tab="k") and disclosures (data-t-toggle="k"). Each fires the screen event "click" with its
// name; each has a visited state (saved with the learner's progress) that conditions can read.
export const CONTROL_HOOKS: readonly ControlHook[] = ['click', 'tab', 'toggle'];
export const CONTROL_NAME = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

export type ControlHook = 'click' | 'tab' | 'toggle';
type ParentNode = DefaultTreeAdapterMap['parentNode'];

// Names of the controls in rendered HTML → Map(name → hook); '' for an unnamed data-t-click.
export function controlsOf(html: unknown): Map<string, ControlHook> {
  const out = new Map<string, ControlHook>();
  const walk = (node: ParentNode) => {
    for (const c of node.childNodes || []) {
      if (!('tagName' in c)) continue;
      for (const a of c.attrs || []) {
        const m = /^data-t-(click|tab|toggle)$/.exec(a.name);
        if (m && !out.has(a.value)) out.set(a.value, m[1] as ControlHook);
      }
      walk('content' in c ? (c as DefaultTreeAdapterMap['template']).content : c);
    }
  };
  walk(parseFragment(String(html || '')));
  return out;
}

// Controls of a block of the project, from its template rendered with the block's props.
const cache = new WeakMap<Block, Map<string, ControlHook>>();
const pindex = new WeakMap<Pick<Project, 'components' | 'plan' | 'course'>, PlanIndex>();
export function blockControls(project: Pick<Project, 'components' | 'plan' | 'course'>, block: Block): Map<string, ControlHook> {
  // A block that is not an object fails the schema: it has no controls.
  if (!isRecord(block)) return new Map();
  const cached = cache.get(block);
  if (cached) return cached;
  const reg = getRegistry(project);
  const d = reg.get(block.type);
  let out = new Map<string, ControlHook>();
  if (d?.tpl && [...hooksOf(d)].some((h) => (CONTROL_HOOKS as readonly string[]).includes(h))) {
    let idx = pindex.get(project);
    if (!idx) { idx = planIndex(project.plan); pindex.set(project, idx); }
    try {
      const props = applyDefaults(d.schema, resolveBlockProps(block, idx, reg));
      out = controlsOf(renderTemplate(d.tpl, { props, schema: d.schema, id: block.id, language: project.course?.language }).html);
    } catch { /* props errors are reported by the validator */ }
  }
  cache.set(block, out);
  return out;
}

// Lock entity of a control: its visited state is saved under that key.
export const controlEntity = (blockId: string, name: string): string => (name ? `visit:${blockId}#${name}` : `visit:${blockId}`);
