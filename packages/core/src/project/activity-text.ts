import { replaceBlanks } from '@elabora/player/fill-in';
import { recordsOf, textOf } from '../compile/values.ts';

// The activities of D63 as native text, for what renders a course as words (the agent's and the
// client's views, LESSON.md): a fill-in as its sentence with its answers, a sort as its items and
// where they go, a reflection as its prompt and the expert's answer.

// The fill-in's Markdown with each blank's first answer in bold, the other accepted ones after it.
export function fillInText(markdown: unknown, { alternatives = true }: { alternatives?: boolean } = {}): string {
  return replaceBlanks(markdown, (_, blank) => {
    const [first, ...others] = blank.answers;
    return `**${first ?? '…'}**${alternatives && others.length ? ` (${others.join(', ')})` : ''}`;
  });
}

// A sort's lines: "item → target" for pairs and categories (by category, in the targets' order), the
// items numbered in their order for order.
export function sortLines(props: Record<string, unknown>): string[] {
  const label = (entry: Record<string, unknown>) => textOf(entry.text) || textOf(entry.alt) || textOf(entry.id);
  const items = recordsOf(props.items);
  if (props.presentation === 'order') return items.map((item, index) => `${index + 1}. ${label(item)}`);
  const targets = recordsOf(props.targets);
  if (props.presentation === 'categories') {
    return targets.map((target) => `- **${label(target)}** : ${items.filter((item) => item.target === target.id).map(label).join(', ') || '—'}`);
  }
  return items.map((item) => {
    const target = targets.find((candidate) => candidate.id === item.target);
    return `- ${label(item)} → ${target ? label(target) : '?'}`;
  });
}
