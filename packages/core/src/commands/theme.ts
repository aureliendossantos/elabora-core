import type { Course } from '../project/model.ts';
import { isRecord } from '../util/values.ts';
import { cascadeOf, CURRENT_CASCADE, upgradeTheme, type Cascade } from '../render/cascade.ts';
import { CommandError, Draft, type CommandContext, type CommandOutput } from './context.ts';

export interface UpgradeThemeResult {
  upgraded: boolean; // false: the course had the current cascade already
  from: Cascade;
  to: Cascade;
  // What went into the theme's `@layer overrides` block (none without a theme stylesheet).
  families: string[];
  moved: number;
  rules: string[];
}

// A course whose theme comes after its components (no theme.cascade: the order before D32) is put
// in the current order, its look kept: course.json theme.cascade, and the theme's declarations of
// properties the components also set moved into a `@layer overrides` block (render/cascade.ts
// upgradeTheme). Every component stylesheet of the course counts, used or not.
export function upgradeThemeCascade(context: CommandContext): CommandOutput<UpgradeThemeResult> {
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  const from = cascadeOf(course);
  if (from === CURRENT_CASCADE) return { files: context.files, result: { upgraded: false, from, to: from, families: [], moved: 0, rules: [] } };
  const theme = isRecord(course.theme) ? course.theme : {};
  let families: string[] = [];
  let moved = 0;
  let rules: string[] = [];
  if (typeof theme.stylesheet === 'string' && theme.stylesheet) {
    const css = draft.text(theme.stylesheet);
    if (css === null) throw new CommandError(`${theme.stylesheet} (course.json theme.stylesheet) is missing: fix it first.`, [], 'E_ASSET_MISSING');
    const components = [...context.files.keys()].filter((path) => /^components\/[^/]+\/component\.css$/.test(path)).sort().map((path) => draft.text(path) ?? '');
    const upgrade = upgradeTheme(css, components);
    if (upgrade.moved || upgrade.css !== css) draft.writeText(theme.stylesheet, upgrade.css);
    ({ families, moved, rules } = upgrade);
  }
  course.theme = { ...theme, cascade: CURRENT_CASCADE };
  draft.writeJson('course.json', course);
  return { files: draft.files(), result: { upgraded: true, from, to: CURRENT_CASCADE, families, moved, rules } };
}
