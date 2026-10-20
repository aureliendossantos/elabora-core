// Heading levels of a screen in reading order, through templates and slots (layout slots, then the
// headings of each component template, then its slots). A heading of a template marked
// data-t-heading follows the page: its level is one more than the heading before the instance, so
// a component reads right under an h2 as under an h3. The validator checks the order with it
// (E_HEADING_ORDER) and the compiler renders templates with it.
import type { ComponentDescriptor, Registry } from './registry.ts';
import { renderTemplate } from './template.ts';
import { applyDefaults } from './props.ts';
import { readingOrder, resolveBlockProps } from '../project/load.ts';
import type { PlanIndex } from '../project/load.ts';
import type { Block } from '../project/model.ts';

export interface HeadingWalk {
  headings: { level: number; block: Block }[];
  // Level of the heading before each block (1: the screen title), by block id.
  before: Map<string, number>;
}

// start: the level the blocks follow (1 under the screen title, 2 in a layer under its title).
export function walkHeadings(registry: Registry, plan: PlanIndex, blocks: readonly (Block | null | undefined)[] | undefined, holder: ComponentDescriptor | null, start = 1): HeadingWalk {
  const headings: HeadingWalk['headings'] = [];
  const before = new Map<string, number>();
  let level = start;
  const visit = (list: readonly (Block | null | undefined)[] | undefined, owner: ComponentDescriptor | null) => {
    for (const block of readingOrder(list as Block[] | undefined, owner)) {
      if (block === null || block === undefined) continue;
      const component = registry.get(block.type);
      if (!component) continue;
      before.set(block.id, level);
      if (component.tpl) {
        try {
          const props = applyDefaults(component.schema, resolveBlockProps(block, plan, registry));
          for (const found of renderTemplate(component.tpl, { props, schema: component.schema, id: block.id, headingLevel: level }).headings) {
            headings.push({ level: found, block });
            level = found;
          }
        } catch { /* reported by the template checks */ }
      }
      if (block.blocks) visit(block.blocks, component);
    }
  };
  visit(blocks, holder);
  return { headings, before };
}
