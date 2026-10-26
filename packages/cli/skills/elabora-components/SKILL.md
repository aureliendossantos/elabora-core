---
name: elabora-components
description: Create, fork and maintain Elabora components (components/<id>/): block types and screen layouts rendered from a props schema and a template, headless forks of quiz/numeric/fill-in/sort/reflection/decision, fallbacks, migrations and libraries. Use when a structure or look repeats across screens, when an activity needs a different markup, or when editing component.json, template.html or component.css.
---

# Components in Elabora

A component is a block type (or a screen layout) the course defines: a **props schema** authors fill in, a **template** you write, a **stylesheet**. The built-in blocks are components too, and you can fork them. Reference: `docs/components.md`.

## Decide first
- One-off look, same structure → a **named style** on a built-in block (`theme.styles`), not a component.
- A structure that repeats, with its own fields (a ratio card, a case-study card, a step timeline) → a **component** (`elabora_create_component`).
- An activity that must look different (image options, cards, a slider-like numeric) → **fork** `quiz`, `numeric`, `fill-in`, `sort`, `reflection` or `decision` (`elabora_fork_component`): the player keeps scoring, saved state, SCORM records, focus and feedback; you only write the markup with its hooks.
- Before writing panels, tabs, flip cards, a carousel of images or a character in a bubble, try the built-ins: `accordion` (`presentation` `accordion`, `tabs`, `cards`, `stack`), `gallery` (`carousel`, `zoom`) and `speech`. A `speech` fork keeps its behaviour: each `data-t-line="{{id}}"` in `data-each="lines"` reads « Name: … », the player writes the name in `data-t-speaker` and mounts the portrait in `data-t-portrait`.
- A screen arrangement (hero band, figure and explanation, dark stage) → a **screen-level** component (`level: "screen"`), used as `screen.layout`.
- Needs code (simulation, 3D, drag physics) → a free object, not a component.

## Order of work
1. `elabora_get_component <parent>` (for a fork) or decide the props: named fields with `x-kind` (`markdown` for rich text, `asset` for files, `token` for colours, `tex` for equations); `x-translatable` on text; `x-group: "design"` on settings authors may change; `required` and `maxLength`.
2. Template in reading order: `{{prop}}`, `data-each="list"`, `data-if="prop"` / `"prop == value"`, empty `data-slot="id"` elements for blocks, `{{@id}}` in SVG ids. No words: make them props, or `data-t-label` for player labels. Decorative SVG `aria-hidden="true"`; `<img src="{{assetProp}}" alt="{{altProp}}">` or `alt=""`. Headings: mark them `data-t-heading` (`<h3 data-t-heading>`) so they follow the page, one level under the heading before the instance, wherever it is placed.
3. Interactive parts without scoring: buttons `data-t-click` (name them, `data-t-click="{{id}}"` in `data-each`, when the block holds several: markers over a figure), tabs `data-t-tabs`/`data-t-tab`/`data-t-panel`, disclosures `data-t-toggle`/`data-t-part`. Each fires `click` with its name and becomes `[data-t-visited]` once used; events filter on `name`, conditions read `{ "visited": "<block>" }`. Things shown one at a time or on demand use the player's primitives (docs/components.md §3) rather than CSS tricks: `data-t-sequence` with `data-t-item="{{id}}"`, `data-t-prev`, `data-t-next` (and optional `data-t-goto="{{id}}"`, `data-t-position`) for one item at a time; `data-t-card="{{id}}"` with `data-t-face="front"`/`"back"` and a `data-t-flip="{{id}}"` button for flip cards; `data-t-zoom` on a button holding the `<img>` (and `data-t-caption`) for the lightbox; `data-t-exclusive` (or `="popover"`) around toggles kept one open; `<details data-t-details="{{id}}">`; `data-t-reveal="{{id}}"` for what counts once seen; `data-t-follow` around reveals for a figure that follows the scroll (the player writes `--t-current`, the rank of the reveal crossing the middle of the window: show a layer with `opacity: clamp(0, calc(var(--t-current) - var(--layer) + 1), 1)` and `style="--layer: {{@number}}"`, only under `[data-t-following]` and with motion). Before writing one, see whether the built-in `steps` (carousel, timeline, scroll) or `hotspots` (popover, side, below, tour) already does it: fork them to change the markup. The player reserves the room of the tallest item or face, so nothing moves; leave the buttons empty and it words them.
4. Forks of activities: keep every required hook (`data-t-stem`, `data-t-option="{{id}}"` on a `<label>` in `data-each="options"`, `data-t-submit`, `data-t-feedback`…). Add fields with `propsExtend`, never by replacing `props`. With `questionRef`, add presentation fields per option id only.
5. Stylesheet scoped with `.t-block--<id>` (or `.t-layout--<id>`), colours through `var(--t-…)`, responsive with `@container`. Style states: `.is-selected`, `.is-correct`, `.is-wrong`, `[data-t-final]`, `[data-t-visited]`; keep a visible focus (`:has(input:focus-visible)`).
6. `fallback`: native blocks that carry every text prop (`W_COMPONENT_FALLBACK_LOSS` tells what is dropped). Add 1–3 `examples`.
7. Check: `elabora_validate`, `elabora_preview_component <id>` at 1280 and 375 px, then the screens that use it: `elabora_look` while you iterate on its CSS and template (well under a second once warm), `elabora_preview_screenshot` at the end; `elabora test` for axe.

## Changing a component later
- Compatible change (new optional prop, CSS, template): raise the minor version.
- Shape change (rename, split, retype a prop): raise the major version, add a step to `migrations.mjs` (`'2.0.0': (props) => newProps`), run `elabora_migrate_components`; nothing is written unless every instance passes.
- A copy from a library (`origin`): do not edit it in place; fork it, or change the library and `elabora component add --upgrade`.

## Instances
`elabora_add_block` with `type: "<component id>"` and `blocks` for its slots (or `parent` + `slot` later); `elabora_duplicate_block` copies an instance with new ids; `elabora_detach_block` turns it back into native blocks (same first id, learner state kept).
