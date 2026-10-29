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
- **Theme CSS and components:** use named styles and scoped component selectors. Override a component intentionally through a top-level `@layer overrides` block; prefer component custom properties. Tell cards, callouts and notes apart by tint, type and space, never by a coloured rule down their side: it is a mark of generic interfaces, and the player draws none.
- **Titles stand alone:** no eyebrow, the small line above a title (a lesson number, a section, a category). Learners arriving on a page skip it, and it looks generic. Where the learner is belongs to the module's UI; a style that numbers its parts does it in its own way (a part opener's large number, a counter of the theme), never as a line over every title.
- **Figures and backdrops:** write figure generators in `generators/` with labels in adjacent text blocks. Respect reduced motion and visual reading order.
- **Review:** `elabora look . --screen <id>` after visual edits; on a scroll page, `--scroll 100%` (or a block's id) to see the window there with its animations, `--sheet` for the page down its length, `--block <id> --scale 2` to close in on a detail; the report says what moves and which scroll-driven animations cannot finish; `elabora fit .` for overflow/contrast/shifts and the scroll-driven animations a page ends before (W_SCROLL_ANIMATION_UNFINISHED), `--screen <ids>` after an edit; built screenshots at desktop and phone sizes, plus `elabora test .` for accessibility.

For implementation details (fonts, cascade layers, scroll animation, safe areas, responsive layouts, screenshots and validator codes), read **`design-recipes`** only for the relevant work: `elabora tools skills elabora-visual-design design-recipes` or `elabora://skills/elabora-visual-design/references/design-recipes`.
