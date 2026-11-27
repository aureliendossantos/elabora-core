---
npm/elabora: patch (Fixed)
npm/@elabora/core: patch (Fixed)
---

A component template's `style` takes numbers and tokens only (D141): a number prop, a list's `@index`, `@number` or `@count`, or a token prop whose value is a token's name. A text bound there (`style="--a: {{t}}"` with « red; background:url(…) ») is reported by the validator and left out of the render with its custom property, so a package never loads what a prop's text names. `<math>` in a template is refused and left out too: maths belong in Markdown props.
