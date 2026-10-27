import type { Diagnostic } from '@elabora/core/diagnostics/index';

// Theme and component precedence (docs/decisions.md D32).
// Measured in the page that shows a screen (a look, the fit of a package): for every rule of a
// component stylesheet and every theme rule that match the same element and set the same property,
// the page is asked which one shows. A declaration is taken out of its rule for a moment and the
// computed value read again: if the value changes, that declaration was the one showing. So media
// and container queries, specificity, layers, !important and nesting are the browser's own, and
// nothing is guessed. Found:
//   component-overridden   a component's declaration that would show without a theme rule that
//                          does not name the component (the theme after the components, or a
//                          broad rule in @layer overrides)
//   theme-under-component  a theme rule that names a component (its classes) and would show
//                          without the component's own declaration (the theme before the
//                          components: it should be in @layer overrides)

export interface StyleConflict {
  kind: 'component-overridden' | 'theme-under-component';
  component: string; // the component whose stylesheet has the rule
  componentRule: string;
  componentSheet: string; // components/<id>/component.css
  themeRule: string;
  themeSheet: string; // the theme stylesheet (whose @layer overrides blocks a package keeps in elabora/overrides.css)
  themeLayer: 'elabora.theme' | 'elabora.overrides';
  properties: string[];
  blocks: string[]; // the blocks the elements are in (closest [data-block])
}

// Runs in the page (Playwright evaluate): self-contained.
export function pageStyleConflicts(): StyleConflict[] {
  interface Entry { rule: CSSStyleRule; selector: string; layer: string; sheet: string; component: string | null; classes: string[]; elements: Set<Element> | null }
  const entries: Entry[] = [];
  const base = new URL('.', location.href).href;
  const pathOf = (href: string | null) => (href ? decodeURI(href.startsWith(base) ? href.slice(base.length) : new URL(href).pathname.replace(/^\/+/, '')) : '');
  const splitList = (list: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) { parts.push(list.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(list.slice(start).trim());
    return parts.filter(Boolean);
  };
  const nest = (parent: string, child: string) => splitList(child).map((part) => (part.includes('&') ? part.replaceAll('&', `:is(${parent})`) : `:is(${parent}) ${part}`)).join(', ');
  const classesOf = (selector: string) => [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]);
  let order: string[] = [];
  let themePath = '';
  const walk = (list: CSSRuleList, layer: string, sheet: string, parent: string | null) => {
    if (layer === 'elabora.theme' && !themePath) themePath = sheet;
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) { try { walk(rule.styleSheet.cssRules, layer || rule.layerName || '', pathOf(rule.href ? new URL(rule.href, rule.parentStyleSheet?.href ?? location.href).href : null), parent); } catch { /* not readable */ } }
      } else if (rule instanceof CSSLayerStatementRule) {
        if (rule.nameList.includes('elabora.theme') && rule.nameList.includes('elabora.components')) order = [...rule.nameList];
      } else if (rule instanceof CSSLayerBlockRule) {
        walk(rule.cssRules, layer || rule.name, sheet, parent);
      } else if (rule instanceof CSSStyleRule) {
        const selector = parent ? nest(parent, rule.selectorText) : rule.selectorText;
        const component = /^components\/([^/]+)\/component\.css$/.exec(sheet)?.[1] ?? null;
        if (rule.style.length) entries.push({ rule, selector, layer, sheet, component, classes: classesOf(selector), elements: null });
        if (rule.cssRules.length) walk(rule.cssRules, layer, sheet, selector);
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule || rule instanceof CSSContainerRule) {
        walk(rule.cssRules, layer, sheet, parent);
      }
      // @starting-style, @scope, @keyframes, @font-face: nothing to compare.
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    const owner = sheet.ownerNode instanceof HTMLElement ? sheet.ownerNode : null;
    walk(rules, '', owner?.dataset.elaboraSheet ?? pathOf(sheet.href), null);
  }
  const themeFirst = order.indexOf('elabora.theme') >= 0 && order.indexOf('elabora.theme') < order.indexOf('elabora.components');
  const components = entries.filter((entry) => entry.layer === 'elabora.components' && entry.component);
  const themes = entries.filter((entry) => entry.layer === 'elabora.theme' || entry.layer === 'elabora.overrides');
  if (!components.length || !themes.length) return [];
  // The classes that name a component: its .t-block--<id> and .t-layout--<id>, and the classes of
  // its own stylesheet that are not the player's hooks.
  const names = new Map<string, Set<string>>();
  for (const entry of components) {
    const id = entry.component!;
    const set = names.get(id) ?? new Set([`t-block--${id}`, `t-layout--${id}`]);
    for (const name of entry.classes) if (!name.startsWith('t-')) set.add(name);
    names.set(id, set);
  }
  const namesComponent = (theme: Entry, id: string) => theme.classes.some((name) => names.get(id)!.has(name)) || theme.selector.includes(`"${id}"`);
  const elementsOf = (entry: Entry) => {
    if (!entry.elements) {
      try { entry.elements = new Set(document.querySelectorAll(entry.selector)); } catch { entry.elements = new Set(); }
    }
    return entry.elements;
  };
  // A declaration taken out and put back.
  const without = <T>(entries: { rule: CSSStyleRule }[], property: string, read: () => T): T => {
    const saved = entries.map(({ rule }) => ({ rule, value: rule.style.getPropertyValue(property), priority: rule.style.getPropertyPriority(property) }));
    for (const { rule } of saved) rule.style.removeProperty(property);
    try { return read(); } finally { for (const { rule, value, priority } of saved) rule.style.setProperty(property, value, priority); }
  };
  const found = new Map<string, StyleConflict & { set: Set<string>; blockSet: Set<string> }>();
  const add = (kind: StyleConflict['kind'], component: Entry, theme: Entry, property: string, element: Element) => {
    const key = `${kind}\u0000${component.selector}\u0000${theme.selector}`;
    let conflict = found.get(key);
    if (!conflict) {
      conflict = { kind, component: component.component!, componentRule: component.selector, componentSheet: component.sheet, themeRule: theme.selector, themeSheet: theme.layer === 'elabora.overrides' ? themePath || theme.sheet : theme.sheet, themeLayer: theme.layer as StyleConflict['themeLayer'], properties: [], blocks: [], set: new Set(), blockSet: new Set() };
      found.set(key, conflict);
    }
    conflict.set.add(property);
    const block = element.closest<HTMLElement>('[data-block]')?.dataset.block;
    if (block) conflict.blockSet.add(block);
  };
  const value = (element: Element, property: string) => getComputedStyle(element).getPropertyValue(property);
  for (const component of components) {
    const properties = Array.from(component.rule.style).filter((property) => component.rule.style.getPropertyValue(property) !== '');
    if (!properties.length) continue;
    for (const element of elementsOf(component)) {
      for (const theme of themes) {
        if (!elementsOf(theme).has(element)) continue;
        const named = namesComponent(theme, component.component!);
        for (const property of properties) {
          if (theme.rule.style.getPropertyValue(property) === '') continue;
          const shown = value(element, property);
          const withoutTheme = without([theme], property, () => value(element, property));
          if (withoutTheme !== shown) {
            // The theme's declaration shows. Is the component's the one it hides?
            const neither = without([theme, component], property, () => value(element, property));
            if (neither !== withoutTheme && !named) add('component-overridden', component, theme, property, element);
          } else if (named && themeFirst && theme.layer === 'elabora.theme') {
            // The theme's does not show. Would it, without the component's?
            const withoutComponent = without([component], property, () => value(element, property));
            if (withoutComponent === shown) continue;
            const neither = without([theme, component], property, () => value(element, property));
            if (neither !== withoutComponent) add('theme-under-component', component, theme, property, element);
          }
        }
      }
    }
  }
  return [...found.values()].map(({ set, blockSet, ...conflict }) => ({ ...conflict, properties: [...set].sort(), blocks: [...blockSet].sort() }));
}

// The same conflict seen on several screens (fit) is one finding.
export function styleConflictDiagnostics(found: readonly { screen: string; conflicts: readonly StyleConflict[] }[]): Diagnostic[] {
  const groups = new Map<string, { conflict: StyleConflict; screens: string[]; properties: Set<string>; blocks: Set<string> }>();
  for (const { screen, conflicts } of found) {
    for (const conflict of conflicts) {
      const key = `${conflict.kind}\u0000${conflict.componentRule}\u0000${conflict.themeRule}\u0000${conflict.themeLayer}`;
      const group = groups.get(key) ?? { conflict, screens: [], properties: new Set(), blocks: new Set() };
      if (!group.screens.includes(screen)) group.screens.push(screen);
      for (const property of conflict.properties) group.properties.add(property);
      for (const block of conflict.blocks) group.blocks.add(block);
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(({ conflict, screens, properties, blocks }) => {
    const where = `${screens.length === 1 ? `Screen "${screens[0]}"` : `Screens ${screens.slice(0, 4).map((screen) => `"${screen}"`).join(', ')}${screens.length > 4 ? ` and ${screens.length - 4} more` : ''}`}${blocks.size ? ` (${[...blocks].slice(0, 3).join(', ')}${blocks.size > 3 ? '…' : ''})` : ''}`;
    const props = [...properties].sort().join(', ');
    const themeWhere = conflict.themeLayer === 'elabora.overrides' ? `${conflict.themeSheet || 'the theme stylesheet'}, @layer overrides` : conflict.themeSheet;
    if (conflict.kind === 'component-overridden') {
      const why = conflict.themeLayer === 'elabora.overrides' ? 'it is in @layer overrides without naming the component' : 'the theme comes after the components in this course (no theme.cascade: elabora theme upgrade)';
      return { code: 'W_STYLE_COMPONENT_OVERRIDDEN', severity: 'warning', target: screens[0], file: conflict.componentSheet, message: `${where}: ${conflict.component}'s rule "${conflict.componentRule}" sets ${props}, but the theme's "${conflict.themeRule}" (${themeWhere}) overrides it: ${why}.` } satisfies Diagnostic;
    }
    return { code: 'W_STYLE_THEME_UNDER_COMPONENT', severity: 'warning', target: screens[0], file: conflict.themeSheet || undefined, message: `${where}: the theme's "${conflict.themeRule}" names ${conflict.component} and sets ${props}, but ${conflict.component}'s rule "${conflict.componentRule}" (${conflict.componentSheet}) overrides it: the theme's rules come before the components; put it in @layer overrides.` } satisfies Diagnostic;
  });
}
