# Components (prototype)

Every block type is a **component**: a props schema, a template and a stylesheet. The native catalogue (heading, text, callout, quiz…) is a set of **built-in components** shipped with Elabora. A course adds its own in `components/<id>/`, at two levels:

- **block**: a block type placed on screens, in layers and in the slots of other components (a ratio card, a case-study card with a quiz inside, an image quiz);
- **screen**: a screen layout (`"layout": "<id>"` on a screen), with named slots for the blocks of the screen.

Authors edit instances through the props form, move blocks between slots, duplicate instances and pick styles. Agents and developers edit definitions. Nothing in a component runs JavaScript: what must be reliable (scoring, saved state, SCORM records, focus, keyboard, announcements) belongs to the player's **behaviours**, and templates only provide the markup.

```
components/ratio-card/
  component.json     manifest: props schema, slots, fallback, styles, examples, version, parent, origin
  template.html      HTML with bindings and behaviour hooks
  component.css      stylesheet (cascade layer elabora.components, over the theme's defaults)
  migrations.mjs     optional: steps that migrate instance props when the props shape changes
```

## 1. Manifest

```json
{
  "id": "ratio-card", "title": "Ratio card", "version": "1.0.0", "category": "content",
  "description": "A key ratio as a large figure…", "instructions": "Keep the label to one or two words…",
  "props": { "type": "object", "additionalProperties": false, "required": ["label", "value", "body"], "properties": {
    "label":  { "type": "string", "maxLength": 40, "x-translatable": true },
    "value":  { "type": "string", "maxLength": 16, "x-translatable": true },
    "body":   { "type": "string", "x-kind": "markdown", "x-translatable": true },
    "accent": { "type": "string", "x-kind": "token", "x-token-prefix": "color.", "x-group": "design", "default": "color.copper" }
  } },
  "fallback": [ { "type": "text", "props": { "markdown": "**{{label}}: {{value}}**\n\n{{body}}" } } ],
  "examples": [ { "title": "Reduction", "props": { "label": "Reduce", "value": "÷ 3.6", "body": "Ring held, the sun drives the carrier." } } ]
}
```

`props` is a JSON Schema of type object. Strings take an **`x-kind`**:

| x-kind | Value | In a template |
|---|---|---|
| `text` (default) | plain text | escaped text |
| `markdown` | Elabora Markdown, maths included | HTML in content (`| inline` without paragraph, `| text` as plain text), plain text in attributes |
| `tex` | a LaTeX equation | MathML (display; `| inline` for inline) |
| `asset` | a file of `assets/` | `assets/<path>` (shipped in the package, checked like image assets) |
| `token` | a theme token name (`color.copper`) | `var(--t-color-copper)`, only in `style="--x: {{prop}}"` |

Mark text `x-translatable`. `x-group: "design"` marks the settings authors may change without an agent (tokens, enums). The editor picks each setting's control from its schema; `x-control` asks for one as in free-object manifests: `textarea` (a few lines of text), `slider` (a number with `minimum` and `maximum`), `range` (a low and a high number: an array of two numbers whose items have `minimum` and `maximum`), `vec2` and `vec3` (an array of two or three numbers, X, Y and Z on one row), `color` (a string of `format: "color"`). In instances, a text or Markdown prop may be `{ "textRef": "TXT-2" }`: the locked text of the plan, used word for word and counted as used.

## 2. Template

```html
<div class="pg-ratio" style="--ratio-accent: {{accent}}">
  <p class="pg-ratio-label">{{label}}</p>
  <p class="pg-ratio-value">{{value}}</p>
  <div class="pg-ratio-body t-text">{{body}}</div>
</div>
```

| Syntax | Meaning |
|---|---|
| `{{path}}` | a prop (`label`, `item.field`); `{{.}}` the current item |
| `{{@index}}`, `{{@number}}`, `{{@count}}`, `{{@first}}`, `{{@last}}` | inside `data-each` |
| `{{@id}}` | id of the block (or screen): unique SVG ids, `id="g-{{@id}}"`, `fill="url(#g-{{@id}})"` |
| `data-if="expr"` | keep the element when `prop`, `!prop`, `prop == value` or `prop != value` holds |
| `data-each="list"` | repeat the element for each item (item fields in scope; `data-if` on the same element filters) |
| `data-slot="id"` | empty element receiving the blocks of a slot (not repeated, not conditional) |
| `data-title` | screen components only: where the screen title (h1) goes |
| `data-t-…` | behaviour hooks (§3) |

Templates are rendered **at build time**; the player inserts the HTML, fills the slots and binds the behaviours. The validator refuses (`E_COMPONENT_TEMPLATE`): script, style, iframe, object, form, select, textarea, link, a (links live in Markdown props), media (place a video block in a slot), event handler attributes, external or script URLs, `href`/`src` other than SVG fragments, `<img>` whose `src` is not a single asset binding or without `alt` (bind it to a text prop, or `alt=""` when decorative), buttons and inputs without a hook, `h1`, `style` other than custom properties bound to props, bindings to undeclared props. It warns about words in the template (`W_COMPONENT_TEXT`: make them props or player labels), SVG without `aria-hidden` (`W_COMPONENT_DECORATION`), fixed ids (`W_COMPONENT_ID_ATTR`) and props bound nowhere (`W_COMPONENT_PROP_UNUSED`).

Write templates in reading order; heading order is checked through templates and slots (`E_HEADING_ORDER`).

## 3. Behaviours (headless) and primitives

A fork of `quiz`, `numeric`, `decision`, `dialogue` or `results` keeps its **behaviour**: the player scores it, saves its state under the same key (`quiz:<id>`), records SCORM interactions, announces feedback and manages focus. The template only has to provide the hooks.

| Behaviour | Required hooks | Optional hooks |
|---|---|---|
| `quiz` | `data-t-stem`, `data-t-option="{{id}}"` on a `<label>` repeated with `data-each="options"`, `data-t-submit` (button), `data-t-feedback` | `data-t-group` (default: the template root), `data-t-input` (an `<input>` in the option; created if absent), `data-t-option-feedback` and `data-t-flag` (inside the option, or next to it as `="{{id}}"` in the same repetition) |
| `numeric` | `data-t-stem`, `data-t-input` (input), `data-t-submit`, `data-t-feedback` | `data-t-input-label` (label), `data-t-unit`, `data-t-expected`, `data-t-group` |
| `decision` | `data-t-prompt`, `data-t-choice="{{id}}"` (button, repeated over `options`), `data-t-feedback` | `data-t-group` |
| `results` | at least one of `data-t-score`, `data-t-status`, `data-t-message` | `data-t-retry` (button) |
| `dialogue` | `data-t-log` (the thread the player fills), `data-t-options` (the options' room) | `data-t-group`, `data-t-stage` (style scene: the backdrop and the cast), `data-t-debrief` (the debrief card), `data-t-start` (button: the start card's, `begins: "click"`) |

Empty hooks receive the player's labels in the course language (Submit, Your answer, Correct answer…): templates stay without words. For styling, options get `is-selected`, `is-correct`, `is-wrong`; the group gets `data-t-result="correct|incorrect"` (decision: the option id) and `data-t-final` once the answer is final.

**Room for answers (slides).** The player renders every possible outcome of an activity (each option's feedback, misconceptions, retry messages, results statuses) on hidden copies at the block's width and reserves the tallest as the block's `min-height`: answering never moves the slide. Keep the room small: short option feedback, and on slides `feedbackStyle: "compact"` on a quiz (its feedback without repeating the chosen option's text, which stays marked where it is and is read to screen readers: about half the room of the feedback; `elabora fit` names the quizzes it would help when a slide scrolls). A quiz fork's template may set `data-t-feedback-style="compact"` on its group to be compact by design. A template whose feedback floats over its own content (an overlay, a popover) opts out with `data-t-reserve="off"` on any element. `elabora fit` and `elabora screenshot --state answered` show the tallest outcome.

**Primitives**, for any template:

| Hook | Behaviour |
|---|---|
| `data-t-click` on a button | fires the screen event `click` with the block as target (like the built-in button; `W_DEAD_BUTTON` without event). `data-t-click="name"` names it, and events can listen to that name only; the name may be bound to a prop (`data-each="markers"` with `data-t-click="{{id}}"`: one marker per item) |
| `data-t-toggle="k"` on a button + `data-t-part="k"` | disclosure: `aria-expanded`, `aria-controls`, part hidden until opened (`data-t-open` shows it first); fires `click` with the name `k` |
| `data-t-tabs` containing `data-t-tab="k"` buttons and `data-t-panel="k"` | tabs: roles, selection, arrow keys, Home/End (`data-t-selected` picks the first); selecting a tab fires `click` with the name `k` |
| `data-t-label="submit"` | the player label of that id (see `packages/player/src/labels.ts`) |
| `data-t-bleed` on a root element of the template | the block goes edge to edge, as `width: "bleed"` does (D63): the window's width in scroll presentation, the slide's in slides, its slot's in a layout's slot; the player adds `t-w-bleed` to the block. Keep text inside at the reading width: `padding-inline: var(--t-bleed-gutter)` |
| `data-t-compare` on a container of two elements (before, then after), with optional `data-t-compare-label` inside each | before and after (D63): the player adds a native range over the container (`.t-compare-range`, 0 to 100, arrows, Home, End, Page Up and Down) that writes where the line is to `--t-compare` on the container (`50%` at first); the stylesheet clips the second element there. It is named by the two labels (else the player's Before and After) and says how much of each shows |
| `data-t-heading` on an `<h2>`–`<h6>` | a heading that follows the page: rendered one level under the heading before the instance in reading order (the screen title is level 1), the other headings of the template marked so keeping their distance to the first. A card with an `<h3 data-t-heading>` reads as an h2 at the top of a screen and as an h3 under an h2; `E_HEADING_ORDER` follows the same levels |

**Screen layouts** may also use what the player writes about the screen, in the course's words (D63): `data-t-section` (the title of the screen's section), `data-t-lesson` (« Leçon 2 sur 6 », the screen's rank among the screens, label `lessonOf`), `data-t-duration` (« 6 min », the page's reading time that the build computes: the plan's estimate, D50, plus the media played there; named « Temps de lecture » for screen readers). Each fills an empty element; a template leaves it out with `data-if` when it is not wanted. The built-in layout `opening` uses all three.

**Controls.** The buttons, tabs and disclosures of a block are its controls, named by their hook value (an unnamed `data-t-click` has no name). Each is **visited** once the learner has used it (a tab or disclosure: once its content is shown, so the tab open at first counts when its block comes into view): the player sets `data-t-visited` on it, saves it with the learner's progress (a key per control in `elabora.lock.json`, a few characters of suspend data each) and conditions read it (`{ "visited": "<block id>" }` for all its controls, `"name"` for one). Names are lowercase letters, digits, `-`, `_`, `.`; the validator checks literal names in the template and bound ones on each instance.

`<details>`/`<summary>` are allowed for native disclosure (no visited state). Components are not scored by themselves: to score inside a component, fork an activity or place activity blocks in its slots.

**Built-in screen layouts.** A screen names a built-in layout in `layout` as it names a course layout: `opening` (« Ouverture », D63), whose props are in `layouts/opening.schema.json` and whose slots are `question` and `body`. Its template is `packages/core/src/components/builtin/opening.html`, its stylesheet part of the player's (`elabora.base`, under the theme: `.t-opening`, `.t-layout--opening`). A course component cannot take its name; it may fork it (`extends: { "component": "opening" }`, `level: "screen"`) to change its markup, and keeps its stylesheet.

## 4. Slots, styles and the DOM

```json
"slots": [ { "id": "figure", "label": "Figure and legend", "accepts": ["image", "text"], "maxBlocks": 4 },
           { "id": "body", "label": "Explanation", "default": true } ]
```

An instance carries the blocks of its slots in `blocks`, each with `slot` (default slot otherwise):

```json
{ "id": "case-1", "type": "case-card", "props": { "client": "Kestrel" },
  "blocks": [ { "id": "case-1-q", "type": "quiz", "slot": "check", "props": { "questionRef": "Q-4" } } ] }
```

`accepts` lists types; a fork is accepted where its parent is. Blocks in slots are ordinary blocks: events target them, activities count for completion and scoring.

Named styles: `styles` in component.json (inherited by forks) and `theme.styles.<id>` in course.json. A style declared for a type applies to its forks.

DOM: every block is `div.t-block.t-block--<id>` plus `t-block--<parent>` for each parent (a fork keeps the parent's CSS), `[data-type="<id>"]`, `[data-component="<id> <parent>…"]` for forks, `[data-behavior]`, `[data-style]`. A screen layout adds `.t-layout.t-layout--<id>` and `[data-layout]` on `article.t-screen`. Scope component CSS with `.t-block--<id>` (or `.t-layout--<id>`). Stylesheets are cascade layer `elabora.components`, after the player (`elabora.base`) and the course theme's rules (`elabora.theme`), before the theme's `@layer overrides` blocks (`elabora.overrides`); parents' stylesheets load before their forks'. A component's rule wins over the theme's defaults whatever their specificity, so its stylesheet is complete: where the template uses a player hook the theme styles (`.t-screen-title`, `.t-text`, `.t-figure img`), give the component's own value in `component.css`. A value the theme should be able to tune is a custom property read with its default (`var(--<id>-gap, 1.5rem)`), never set by the component (docs/design.md, Cascade layers; D32). In a course without `theme.cascade` (written before 13 October 2026) the theme still comes after the components.

## 5. Fallback

Every component can be expressed with native blocks. Exports (LESSON.md), the client review (`elabora project --client`), text views, translation tools, editors that do not know the component and **detach** use it.

```json
"fallback": [
  { "type": "heading", "props": { "text": "{{title}}", "level": 3 } },
  { "$if": "body", "type": "text", "props": { "markdown": "{{body}}{{#steps}}\n- {{label}}{{/steps}}" } },
  { "$each": "faq", "type": "callout", "props": { "title": "{{q}}", "markdown": "{{a}}" } },
  { "type": "accordion", "props": { "items": { "$each": "panels", "as": { "id": "p{{@number}}", "title": "{{title}}", "markdown": "{{body}}" } } } },
  { "$slot": "check" }
]
```

Strings take `{{path}}`, `{{#list}}…{{/list}}` (repeat; "if" for a value) and `{{^path}}…{{/path}}`. A string that is a single `{{path}}` keeps the raw value: a `{ "textRef" }` stays a plan link. Slot contents go where `$slot` says, otherwise after. Without `fallback`, Elabora generates one from the props (text and Markdown in a text block, lists as bullet lists, assets as decorative images, TeX as equations). Forks of a built-in fall back to the built-in with the props it knows (a fork of quiz becomes a quiz; with `questionRef`, the plan question).

Checks: each fallback block must be valid (`E_COMPONENT_FALLBACK`); text of an instance that the fallback drops is reported (`W_COMPONENT_FALLBACK_LOSS`).

## 6. Forks

```json
{ "id": "config-quiz", "title": "Configuration question", "version": "1.0.0",
  "extends": { "component": "quiz", "version": "0.1.0" },
  "propsExtend": { "properties": {
    "legend":  { "type": "array", "items": { … } },
    "options": { "items": { "properties": { "figure": { "type": "string", "x-kind": "asset" } } } } } } }
```

`elabora component fork quiz config-quiz` (MCP `elabora_fork_component`) copies the template so it can change and records the parent and its version. Until the fork declares them, props, slots, styles, fallback and template come from the parent; `propsExtend` merges into the parent's props (a fork of an activity cannot replace them). The parent's stylesheet still applies. `I_COMPONENT_PARENT_CHANGED` tells when the parent moved on.

With a plan question (`questionRef`), a quiz fork may still add presentation fields per option, keyed by option id: the plan's text, correctness and feedback always win, and options that try to change them are refused (`E_QUIZ_SOURCE`).

```json
{ "id": "assessment-q3", "type": "config-quiz", "props": { "questionRef": "Q-3",
  "options": [ { "id": "a", "figure": "images/config-sun-carrier.svg" }, … ] } }
```

Video, audio and free objects are rendered by code: place them in slots, do not fork them.

## 7. Duplicate, detach, move

- `elabora block duplicate <block>` (MCP `elabora_duplicate_block`): a copy of the instance and of the blocks of its slots, with new ids (`<id>-copy`), after the original or at a given place. Learner state never carries over: copies are new activities.
- `elabora block detach <block>` (`elabora_detach_block`): replaces the instance with its fallback, then the blocks of its slots. The first block keeps the id, so events and learner state still point at it. Undoable like every edit.
- `elabora_move_block` with `parent` and `slot` moves blocks into and out of slots; `elabora_add_block` with `parent` adds into a slot.

## 8. Versions and migrations

`elabora.lock.json` records, per component, the version its instances were written for. When the shape of the props changes, raise `version` and add a step:

```js
// components/key-card/migrations.mjs
export default {
  '2.0.0': ({ title, ...rest }) => ({ ...rest, heading: title })
};
```

`elabora validate` reports `E_COMPONENT_MIGRATION_PENDING` until `elabora component migrate` (MCP `elabora_migrate_components`) runs the steps on every instance and layout, checks every result against the new schema and writes them in one undoable edit; nothing is written if one instance fails. Versions without migration steps (compatible changes) are recorded by the next build.

## 9. Libraries

A library is a folder shared by several courses (a client's design system): `library.json` (`{ "id", "title" }`) and `components/<id>/`.

- `elabora component add <id> --library <dir> [--as <id>]`: copies the component into the course with `origin` (library, version, hash). The course is pinned: it never changes when the library does.
- `elabora component add <id> --library <dir> --upgrade`: replaces the copy with the library's version (then `elabora component migrate` if the props changed). Refused when the copy was edited locally (`W_COMPONENT_DIVERGED`) unless `--force`.
- `elabora component publish <id> --library <dir>`: copies a course component into the library (refused if the library has the same version with other content).

## 10. Review

A component is reviewed like a design, not like a contract: screenshots and checks. `elabora component preview <id> --width 1280|375` (MCP `elabora_preview_component`) renders its `examples` on a specimen screen; examples are checked like instances (`E_COMPONENT_EXAMPLE`). The build report lists components with version, parent, library origin and instance count. `I_COMPONENT_SINGLE_USE`: a component used once is often better as a native block with a named style; `W_COMPONENT_UNUSED`: never used.

## 11. Who changes what

| | Authors (editor, no code) | Agents and developers |
|---|---|---|
| Instances | props through the form, design props (tokens, enums), style, slot contents, duplicate, detach, move | everything |
| Definitions | — | manifest, template, stylesheet, fallback, migrations, forks, library operations |
