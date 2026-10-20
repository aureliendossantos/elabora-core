---
name: elabora-visual-design
description: Design Elabora course tokens, typography, layouts, styles, responsive views, figures and visual checks. Load only for visual tasks.
---

# Visual design in Elabora

Keep learner-facing words in editable block props, **not** CSS, templates or figures. The theme is the course default; components own their styles. Use `elabora-components` for repeated structures and activity forks, `elabora-free-objects` for custom code.

## Task route
- **Tokens and fonts:** define `course.json` `theme.tokens` / `theme.custom`; use `elabora font list` and `font add` so font licenses ship with the course.
- **Layout and responsiveness:** native layouts first; for repeated arrangements create screen-level components with slots. Design at 1600×900, verify at 1280×720 and 375×812; use rem for scalable dimensions.
- **The player's bars:** `elabora player .` (MCP `elabora_player`) reads and sets their items and their `player.*` tokens from the charter; no CSS for what a token says.
- **Theme CSS and components:** use named styles and scoped component selectors. Override a component intentionally through a top-level `@layer overrides` block; prefer component custom properties.
- **Figures and backdrops:** write figure generators in `generators/` with labels in adjacent text blocks. Respect reduced motion and visual reading order.
- **Review:** `elabora look . --screen <id>` after visual edits; `elabora fit .` for overflow/contrast/shifts; built screenshots at desktop and phone sizes, plus `elabora test .` for accessibility.

For implementation details (fonts, cascade layers, scroll animation, safe areas, responsive layouts, screenshots and validator codes), read **`design-recipes`** only for the relevant work: `elabora tools skills elabora-visual-design design-recipes` or `elabora://skills/elabora-visual-design/references/design-recipes`.
