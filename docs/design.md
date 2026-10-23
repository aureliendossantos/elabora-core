# Design layer (prototype)

Agents design freely; content stays structured. An Elabora course separates **what is said and scored** (blocks: schema-checked, editable, translatable) from **how it looks** (CSS, layout templates, generated figures: free). Authors rework content and pick among the options the agent declared; changing the design itself is an agent or developer task, like free-object code.

| Layer | Files | What the agent writes freely | What an author edits without code |
|---|---|---|---|
| Theme | `course.json` `theme`, `theme/theme.css`, `theme/fonts/<id>/*` (fonts and their licence) | Any CSS, embedded fonts, custom tokens, named styles | Token values, the style of a block or screen (from a list) |
| Components | `components/<id>/` (component.json, template.html, component.css) | Block types and screen layouts: templates with slots, decoration, forks of built-in blocks (headless quizzes) | Props through a form, design props, slot contents; duplicate, detach |
| Figures | `generators/*.mjs` → `assets/` | Code that draws figures from the geometry, the tokens and the plan | Nothing in the figure; labels live in blocks next to it |
| Free objects | `objects/<id>/` | Interactive code (three.js, games) | Declared props |

The one rule: **words never live in CSS, templates or figures.** The validator reports them (`W_STYLE_TEXT`, `W_COMPONENT_TEXT`, `W_ASSET_SVG_TEXT`).

## 1. Theme

```json
"theme": {
  "tokens":  { "color.primary": "#0F2A47", "font.heading": "\"Space Grotesk\", system-ui, sans-serif", "radius": 12 },
  "custom":  { "color.blueprint": "#0B2440", "shadow.card": "0 8px 24px rgba(11,36,64,.08)" },
  "stylesheet": "theme/theme.css",
  "fonts":   [{ "family": "Space Grotesk", "src": "theme/fonts/space-grotesk/space-grotesk-latin-wght-normal.woff2", "weight": "300 700" }],
  "styles":  { "callout": { "ratio": "Card with a large figure" }, "screen": { "dark": "Dark background" } }
},
"presentation": { "mode": "slides", "contentWidth": 720, "wideWidth": 1160, "fit": { "reference": "1600x900", "minimum": "1280x720" } }
```

- **Tokens** (`tokens`): the client charter, checked for WCAG contrast. **Custom tokens** (`custom`): any extra value. Every token `a.b` is the CSS variable `--t-a-b` (`color.blueprint` → `--t-color-blueprint`); charter tokens also keep short names (`--t-primary`, `--t-text`, `--t-font-body`…). Free objects get the same variables and can bind props to any token with `x-token`; generators receive them too. A material colour that only a free object uses (the brass of an instrument, a wood) is a colour prop of that object with a literal default, not a custom token (docs/free-object-contract.md, *Colours*).
- **Stylesheet**: free CSS in `theme/`. `url()` points to files inside the course (copied into the package); no `@import`, no external URL (`E_STYLE_RULE`). Hard-coded hex colours are reported (`W_STYLE_LITERAL_COLOR`): use tokens so a charter change propagates.
- **Fonts**: WOFF2 or WOFF files in `theme/`, declared in `theme.fonts` (the player writes their `@font-face` rules and sends them to free objects) and named in `font.body`, `font.heading` or any token. Add them with `elabora font add` (below) rather than by hand. A face split into subset files is one entry per file, each with its `unicodeRange` (CSS `unicode-range` syntax, `U+0100-02BA,U+1E00-1E9F`): one `@font-face` rule per file, and the browser downloads a file only for a page that uses one of its characters.
  - **The vetted fonts shipped with Elabora** (`@elabora/fonts`, there offline, in the desktop app too): 25 families under the SIL OFL, from EB Garamond, Lora and Merriweather to Inter, Source Sans 3, Atkinson Hyperlegible Next (low vision), Poppins, JetBrains Mono and display faces (Oswald, Bebas Neue, Caveat, Cinzel, UnifrakturMaguntia). `elabora font list [--category serif]` (MCP `elabora_list_fonts`) gives what each is good for, its weights, italics, subsets, size and pairings.
  - `elabora font add . "<family>" [--weights 400,700] [--styles normal,italic] [--for body,heading] [--subsets latin,latin-ext]` (MCP `elabora_add_font`, engine command `add_font`) copies its files and its licence into `theme/fonts/<id>/`, declares its faces and gives its stack (fallbacks included) to the tokens, in one undoable change: `body` and `heading` are `font.body` and `font.heading`, any other name a custom token (`mono` → `font.mono`, which the player uses for `code`, `kbd`, `samp` and `pre`; `display` → `font.display`, used as `var(--t-font-display)`), `none` sets none; by default the role the list gives the font. A variable file covers every weight of its range; `--weights` picks the files of a static family. Adding a family again replaces its faces. `theme.fonts` holds 24 faces at most (one per file: a variable family in two styles and two subsets takes 4).
  - **Any other font**, when nothing in the list fits (look for one: a brand font, a typeface for a period or a script): its Fontsource package (`npm pack @fontsource-variable/<id>` or `@fontsource/<id>`, then `elabora font add . --from <the .tgz, or its folder in node_modules>`: its files of the subsets, as for a vetted font, with the ranges of its `unicode.json`, the weight axis of a variable font, its LICENSE; `--subsets` names any subset the package has, `cyrillic`, `greek`, `vietnamese`…), or WOFF2 files with their licence (`elabora font add . --file a.woff2,b.woff2 --license OFL.txt [--family <name>]`; weights and style are read from the files; each file is embedded whole, without range). SIL OFL and Apache allow embedding; check any other licence (a client's web licence, an EULA). Convert TTF and OTF files to WOFF2 first. Japanese, Chinese and Korean come from Fontsource in a hundred numbered slices that `theme.fonts` cannot declare: take a font file.
  - **The licence travels with the font**: a licence file (`OFL.txt`, `LICENSE.txt`, `EULA.txt`…) in the folder of every font file, which the build copies into the package next to it (the build report lists them, `design.fontLicenses`). A font file without one is `W_FONT_LICENSE_MISSING`.
  - **Languages.** The vetted files come in two subsets: **latin** (the player's seven languages and the other Western European ones) and **latin-ext** (Polish, Czech, Slovak, Slovenian, Croatian, Bosnian, Hungarian, Romanian, Turkish, Azerbaijani, the Baltic languages, Maltese, Welsh, Esperanto, Māori…), which every family but UnifrakturMaguntia has. `elabora font add` takes latin, and latin-ext too when the language of the course or of one of its translations (`translations/<language>.xlf`) needs it; `--subsets` chooses. After adding a language to a course, add its fonts again. Letters that no embedded file holds (Greek, Cyrillic, Vietnamese, or latin-ext letters of a family without them) are drawn by the next fonts of the stack, and `elabora font add` says so: take a font of that script from its Fontsource package (`--from … --subsets cyrillic`) or its files (`--file`).
- **Styles** (`styles`): named styles per type (built-in or component) or `screen`, with a description for editors. A block or screen picks one with `"style": "rule"`; the player adds `data-style="rule"` and the class `t-s-rule`. Undeclared styles are errors. Styles of a type apply to its forks; components can declare their own. (Not the callout prop `variant`, which is info/tip/warning/important.)
- **Style or component?** A style changes the look of a block whose structure fits. When the structure itself differs (a figure that is not "the first bold text", fields of their own, a different markup for a quiz), make a component: authors then fill named fields instead of following a convention.
- **Presentation**: `scroll` (a document per screen) or `slides` (each screen is one view that must fit the window; see §2). `contentWidth` and `wideWidth` (px at the reference window, emitted in rem) set `--t-content-width` and `--t-wide-width`.

### Backdrop
A decorative background behind every screen, declared in the theme:

```json
"backdrop": {
  "layers": ["nebula", "far", "near"],
  "object": { "id": "starfield", "props": { "density": 0.4 } },
  "variants": { "dim": "Darker sky behind dense screens" }
}
```

- **Decoration only.** It carries no information, takes no focus and is hidden from screen readers. A scene the learner uses or learns from is a free-object block, with a role, objectives and a text version.
- **Layers**: empty elements behind the course (`.t-backdrop-layer[data-layer="far"]`), painted and animated by the stylesheet (animate `transform` and `opacity`). The backdrop element carries where the learner is, `.t-backdrop[data-screen][data-section][data-step][data-variant]`, so the stylesheet can move it with the course (a nebula that drifts at each section).
- **Object**: a free object with `pedagogicalRole: "decoration"`, mounted once for the whole session behind the course. It receives the same context (`ctx.context`, `host.onContext`); no events, no state, no controls; smaller budgets (30 draw calls, 60,000 triangles). Under reduced motion it renders still frames; on a machine below 24 frames per second it freezes.
- **Screens**: `"backdrop": "dim"` picks a declared variant, `"backdrop": "none"` hides it (the object stops).
- **Readability**: text over a backdrop must keep its contrast. `elabora fit` measures it against the pixels behind each line (`W_TEXT_CONTRAST_MEASURED`); fix it with a panel behind the text, a dimmer variant on that screen, or a lighter text colour.
- Keep the root background in the stylesheet (`html { background: … }`) and `body` transparent; a dark `color-scheme` on the root makes browsers paint an opaque box behind frames, so scope it to the panels that need it.

### The player

The bars around the screens are course.json `player` (D58, SPEC.md §4.8): two bars, `top` and `bottom`, each an ordered list of items (`logo`, `title`, `progress`, `spacer`, `outline`, `controls`, `resources`, `glossary`, `credits`, `display`, `language`, `previous`, `next`, `exit`), in the window or at the end of the page. Each bar has one `spacer` (« Espace flexible », always on): the items before it start the line, those after it end it; move it to change where the line splits. Read and change them with `elabora player .` (MCP `elabora_player`): it lists what shows and why not, the player tokens with their values, and the findings. A file from outside the course goes into the resources with `elabora player . --add-resource <file>` (MCP `elabora_player` `addResources`, engine command `add_resource`): copied into `assets/resources/`, titled by the PDF's own title or the file's name unless a title is given.

Fit the player to the theme with its tokens rather than CSS; each defaults to the charter and every pair is checked for contrast (`E_THEME_CONTRAST`):

| Token | Default | What it colours |
|---|---|---|
| `player.top.background`, `player.top.text` | `color.primary`, `color.onPrimary` | the top bar |
| `player.bottom.background`, `player.bottom.text` | `color.surface`, `color.primary` when it reads there (4.5:1), else `color.text` | the bottom bar and the outline |
| `player.accent`, `player.onAccent` | `color.primary`, `color.onPrimary` | Next, Play, the seek bar's playhead, the active speed |
| `player.progress` | the text colour of its bar | the progress bar |
| `player.tooltip.background`, `player.tooltip.text` | `color.text`, `color.surface` | the one tooltip |
| `player.radius` | 999 (pills) | the bars' buttons, chips and the progress bar (in px) |
| `player.density` | `comfortable` | `compact`: bars of 48 and 60 px instead of 56 and 72 at the reference size |

**Dialogues** (D61) have six tokens of their own, `dialog.bubble`, `dialog.learner`, `dialog.text`, `dialog.wordSpoken`, `dialog.wordUnspoken` and `dialog.note`, each with its default from the charter, checked for contrast once the course sets one ([Dialogues](dialogues.md#what-the-learner-sees)).

A light top bar with the text colour suits airy themes; the primary colour, a strong identity. Set `player.radius` to the theme's corners when they are square (`4`, `8`), give a logo (an image of `assets/` in the item's `options.asset`, with `alt`; `options.plate: true` puts it on a white plate when it does not read on the bar, which `W_PLAYER_LOGO_CONTRAST` says of an SVG logo), and keep the other defaults. The bars are in `elabora.base`; a theme may still restyle their hooks (DOM contract below) when a token does not say it, but `W_STYLE_*` checks apply as anywhere.

### Cascade layers
The design layer is ordered in cascade layers (docs/decisions.md D32). A later layer wins whatever the specificity:

`elabora.base` (`elabora/player.css`) < `elabora.theme` (the course stylesheet) < `elabora.components` (component stylesheets, parents before forks) < `elabora.overrides` (the course stylesheet's `@layer overrides` blocks)

- **The theme's rules are the course's defaults.** `.t-figure img { width: 100% }` sizes every figure of the course, until a component says otherwise for its own figures: a component's stylesheet is complete and travels to a library as it is.
- **`@layer overrides { … }`, at the top level of the theme stylesheet, holds what the theme overrides in components on purpose**: restyling a library component for this course, a layout's title the theme wants bigger. Name the component in those rules (`.t-block--<id> …`, `.t-layout--<id> …`). Several blocks are fine; one inside `@media` or another rule is a sub-layer of the theme and does not override anything (`W_STYLE_OVERRIDES_NESTED`): put the `@media` inside the block. A package keeps these rules in `elabora/overrides.css`.
- **Prefer what a component offers to overrides.** A component that expects the theme to tune it reads a custom property with its default, `gap: var(--atelier-gap, 1.5rem)`, and never sets it; the theme sets `--atelier-gap` (anywhere: custom properties cross layers). Tokens (`--t-*`) are read the same way.
- **Who wins is measured, not guessed.** `elabora look` and `elabora fit` take each rule of a component stylesheet and each theme rule that meet on an element and ask the page which one shows: a component's rule overridden by a theme rule that does not name it is `W_STYLE_COMPONENT_OVERRIDDEN`; a theme rule that names a component but gives way to it (outside `@layer overrides`) is `W_STYLE_THEME_UNDER_COMPONENT`.
- **Courses written before 13 October 2026** have no `theme.cascade` and keep the order of that time, `elabora.base` < `elabora.components` < `elabora.theme` < `elabora.overrides`: their theme wins over their components, they look as they did, and the validator says so (`I_THEME_CASCADE_OLD`). `elabora theme upgrade` (MCP `elabora_upgrade_theme`) sets `theme.cascade` to `components-over-theme` without changing their look: the theme's declarations of properties that some component stylesheet sets too go into an `@layer overrides` block, in order, in their rules and at-rules (properties that act on one another, a shorthand and its longhands, logical and physical sides, are moved together, so the theme's own rules keep their outcome among themselves); the others stay, under components that never set them. Then move out of that block the rules that are course-wide defaults. `elabora init` writes `components-over-theme`.
- The order is the statement `@layer elabora.base, elabora.theme, elabora.components, elabora.overrides;` (or the older one), first in `elabora/theme.css` and in the editor canvas; `elabora/player.css`, shared by every course, names `elabora.base` alone first. A browser orders layers where their names first appear.
- Until 6 October 2026 packages declared the prototype's `elabora.base, elabora.layout, elabora.theme`, so `elabora.components` came last and component stylesheets beat the theme; from 6 to 13 October the theme came last. See the [development history](development-history.md).

### DOM contract (stable hooks)
| Element | Hooks |
|---|---|
| App | `#elabora-app[data-presentation][data-density]` (`compact` with the token `player.density`), `.t-backdrop[data-screen][data-section][data-step][data-variant]` with `.t-backdrop-layer[data-layer]` and `.t-backdrop-object`, `#t-main.t-main[data-full-bleed]` (its own stacking context, so screen `z-index` values stay under the bars), `.t-banner` |
| Player (D58) | the bars `header.t-bar.t-bar--top` and `footer.t-bar.t-bar--bottom` (`[data-bar][data-position=window|page]`; a bar with nothing to show is not in the page), `.t-bar--controls` (a narrated screen's controls kept in the window when the bottom bar is at the end of the page); each item `.t-item.t-item--<id>[data-item]` (`.t-item--spacer`, `.t-item--plate` for a logo on its plate), `.t-bar[data-spacer]` when the bar has its spacer, else `.t-item--push` before the items that go to the end of the line; inside: `.t-logo`, `.t-course-title`, `.t-progress[role=progressbar]` > `.t-progress-bar` and `.t-progress-value`, `.t-outline-btn[aria-expanded]` (`.t-outline-label`) and the outline `nav.t-menu` (`.t-menu-where`, `.t-menu-section`, `.t-menu-item[aria-current][aria-disabled][data-state=done|open|locked]`, `.t-progress-note`), `.t-controls` (the narration's bar, below), `.t-chip` buttons `.t-resources-btn`, `.t-glossary-btn`, `.t-quit`, `.t-icon-btn.t-about-btn` (« IA et crédits », `.t-ai-mark` « IA » when something was made with AI), `.t-icon-btn.t-display-btn` (« Affichage ») + `.t-pop.t-display-menu` (`.t-display-size--normal|large|larger[role=radio]`, `.t-switch[role=switch]`, `.t-display-keys`), `.t-chip.t-language-btn` (« Langue ») + `.t-pop.t-language-menu` > `.t-pop-item[role=menuitemradio][lang]`; `#elabora-app[data-text-size=large|larger][data-captions=large]`, the learner's display choices; `.t-nav-btn.t-nav-btn--previous` and `.t-nav-btn--next[data-label=next|continue]` (`[aria-disabled]` greyed in place; `.t-nav-labels` > `.t-nav-label[data-for]`, both labels in one cell); the one tooltip `#t-tip.t-tip[role=tooltip][data-side]` (`.t-tip--wrap`); the side panels `section.t-sheet[data-sheet=resources|glossary|about|transcript]` > `.t-sheet-head` (`.t-sheet-title`, `.t-sheet-close`) and `.t-sheet-body`: `.t-resource-list` > `.t-resource[data-resource]` (`a[data-kind=link]` for a link; `.t-resource-title`, `.t-resource-description`, `.t-resource-info`), the preview of a PDF or an image `dialog.t-viewer[data-resource]` (`.t-viewer-head`, `.t-viewer-download`, `.t-viewer-tab`, `.t-viewer-frame`, `.t-viewer-image` or `.t-viewer-empty`), `.t-glossary-search` (`.t-glossary-input`), `.t-glossary-count`, `dl.t-glossary-list` > `.t-glossary-entry[data-term]` (`.t-glossary-term`, `.t-glossary-variants`), `.t-about-section[data-about=ai|credits]` (`.t-about-ai`, `.t-about-credits`); a word linked to the glossary `a.t-term[data-term]`; the confirmation of Quit `dialog.t-dialog` |
| Dialogue (D61) | the group `.t-dialogue-root[data-t-look=messaging|scene][data-t-reveal][data-t-paused][data-t-history][data-t-debrief-open]`; the thread `[data-t-log][role=log]` > `.t-dialogue-row[data-role=character|learner|narration|note|retry|end][data-side][data-speaker][data-line][data-decision][data-first]` (`.t-dialogue-avatar`, `.t-dialogue-bubble`, `.t-dialogue-name`, `.t-dialogue-ink` > `.t-w.is-said`, `.t-dialogue-tools`, `.t-dialogue-note`); the room `[data-t-options][role=group]` (`.t-dialogue-prompt`, `button.t-dialogue-choice[data-option][aria-disabled]`, `.t-dialogue-turn`, `.t-dialogue-endbar`); the cast `.t-dialogue-actor[data-speaker][data-position]`; `.t-dialogue-debrief-card`; the variables `--t-dialog-*` (tokens) and `--t-dialog-fill` (the thread's box in a slide) |
| Screen | `article.t-screen[data-screen][data-section][data-layout][data-style]`, `.t-s-<style>`, `.t-layout--<id>` (and `--<parent>` for forks), title `h1.t-screen-title` |
| Default column | `.t-blocks` (grid), blocks `.t-w-full|wide|half` |
| Slots | `[data-slot].t-slot` (screen layouts and component instances), `[data-empty]` when no block |
| Block | `.t-block.t-block--<type>[data-block][data-type][data-style][data-behavior]`, `.t-block--<parent>` and `[data-component]` for forks, `.t-s-<style>`; steps: `[data-t-pending]` (not revealed yet), `[data-t-revealed]` (revealed by Continue or `reveal-step`), `[data-t-current]` (the latest step shown); `[data-t-concealed]` (hidden until an event shows it); controls (buttons, tabs, disclosures): `[data-t-visited]` once used |
| Narrated screens (D24) | `#elabora-app[data-timeline=seen|free|none]` while one is shown; in the item `.t-controls` (D58): `.t-timeline[role=group][data-seek]`: `.t-timeline-btn` buttons `.t-timeline-play[data-state=playing|paused]`, `.t-timeline-replay`, the seek bar `.t-timeline-seek[role=slider]` (none when the controls' option `seekBar` is off or the screen says `seek: "none"`) > `.t-timeline-track` (dotted: not heard yet; `--t-timeline-at`, `--t-timeline-seen`: 0–1) > `.t-timeline-seen` (heard), `.t-timeline-played`, `.t-timeline-mark[data-step]` (a step's end), `.t-timeline-thumb`; `.t-timeline-time`; `.t-timeline-tools` > `.t-timeline-captions[aria-pressed]`, `.t-timeline-anchor` > `.t-timeline-settings-btn[aria-expanded]` (with `.t-timeline-rate-badge`, the speed when it is not 1×) + `.t-timeline-popup.t-timeline-settings` (`.t-timeline-speeds`, `.t-timeline-stop`, `.t-timeline-keys-btn`), `.t-timeline-volume` > `.t-timeline-mute[aria-pressed]` and `.t-timeline-volume-pop` > `.t-timeline-volume-range`, `.t-timeline-transcript-btn[aria-expanded]`, `.t-timeline-more` + `.t-timeline-more-menu` (what does not fit); `.t-timeline-icon--<name>`; the captions band `.t-timeline-band` > `.t-timeline-caption` (`.t-timeline-speaker`); the transcript, a side panel `.t-sheet.t-timeline-transcript` > `.t-timeline-generated` (« Voix générée par IA »), `.t-timeline-transcript-step` > `.t-timeline-line[data-line][aria-current]`, then `.t-timeline-credits` (the credits of the screen's voices; the module's are in « IA et crédits »); `.t-timeline-start` (`.t-timeline-start-circle`, `.t-timeline-start-label`), the large Play button when the browser refused sound. A narrated slide's own Continue: `.t-continue.t-continue--slot[data-t-waiting]` (its place kept at the end of the screen, hidden while a step plays). Hovering or dragging the seek bar, the player's tooltip quotes the words said there; the shortcuts list `.t-timeline-keys` (Shift+? on the bar, or « Raccourcis clavier » in the settings) |
| Timed blocks (D28) | `.t-block[data-t-timed=before|after]` while a block's timing keeps it hidden in its place (`visibility: hidden`, inert); effects are Web Animations on the block (`opacity`, `translate`, `scale`, `clip-path`, SVG strokes) set to the timeline's time. A stack: `.t-block--stack` > `.t-stack[data-transition][data-slot=items]`, its contents always in one grid cell (`.t-stack.t-slot > .t-block`), the size of the largest. A theme's effects: `@keyframes t-fx-<name>` (coming) and `t-fx-<name>-out` (going, else the first one backwards), declared in `theme.effects` |
| Inside built-in blocks | `.t-text`, `.t-callout.t-callout--<variant>`, `.t-callout-title`, `.t-figure`, `.t-math`, `.t-math-display`, `.t-quiz`, `.t-option`, `.t-numeric`, `.t-numeric-input`, `.t-decision`, `.t-choice`, `.t-object`, `.t-object-frame[data-ratio]`, `.t-object-loading`, `.t-results`, `.t-accordion`, `.t-dialog` (modal layer), `.t-panel` (panel layer), `.t-feedback` (`.t-feedback-head`, `.t-feedback-item` > `.t-feedback-option`, the chosen option's text; `[data-t-feedback-style="compact"]` on a quiz's group with compact feedback, where it is `.t-sr-only` and the head and the explanation run as one paragraph); activity states `.is-selected`, `.is-correct`, `.is-wrong`, `[data-t-result]`, `[data-t-final]` |

`.t-screen` is a CSS container (`container-type: inline-size`): layouts adapt with `@container (max-width: 820px) { … }`, which also works in narrow LMS frames.

## 2. Window sizes, slides and steps

### Size classes
Sizes are written in **rem**, and 1rem follows the window. The reference window is **1600×900**: there 1rem is the learner's default font size (16 px). A design written at that size keeps its proportions in smaller windows, like a slide scaled down, except that text reflows instead of shrinking with a picture.

| Class | Window (CSS px, inside the LMS frame) | 1rem | Body text (1.0625rem) |
|---|---|---|---|
| Reference | ≥ 1500 × 840 (designed at 1600×900) | 16 px | 17 px |
| Medium | ≥ 1360 × 760 | 15 px | 16 px |
| Compact | smaller desktop windows (1280×720, 1366×650…) | 14 px | 14.9 px |
| Phone, portrait tablet | ≤ 760 px wide, or portrait up to 1100 px | 15 px | 16 px |

- Write font sizes, padding, margins and gaps in rem (px ÷ 16 at the reference size); keep borders, radii, shadows and touch targets (44 px) in px. `clamp(1.875rem, 3.6vw, 2.75rem)` is fine. `W_STYLE_FIXED_FONT_SIZE` reports font sizes in px in course and component stylesheets.
- The classes are percentages of the learner's default size: a learner who set a larger default gets larger text everywhere. Text fields never go under 16 px (iOS would zoom on focus).
- Free objects: the host sets 1rem in the frame to 1rem of the page and updates it when the window changes class. Write the object's own UI in rem (the UI kit already is).
- Layouts still adapt with container queries in px (`@container (max-width: 820px)`): queries cannot read the page's rem.

### Presentation: scroll or slides
- **scroll**: a screen is a page (a lesson, as in Rise); long content scrolls. Nothing has to fit (see *Scroll pages* below).
- **slides**: a screen is one view. `presentation.fit` names the windows it must fit: `reference` (default `1600x900`; an overflow is a warning, `W_SLIDE_OVERFLOW`) and `minimum` (default `1280x720`; slides may scroll a little there, reported as info, `I_SLIDE_OVERFLOW_MINIMUM`). Below the minimum and on phones, slides read as a scrolling page. A slide is never scaled down as a picture.
- `elabora fit` (MCP `elabora_check_fit`) measures every screen with all its steps in a real browser at both sizes: the overflow in px and the blocks that end below the fold. `elabora test` runs it for slides and adds the results to the proof dossier.
- Each screen's measure is kept in the course's `.elabora/cache/fit/` with what it was made from: the screen as the player shows it (its blocks, the theme and the component stylesheets, the templates it uses, the code of the objects it places, the images and fonts it loads, the outline of the bars), the Elabora code, the browser, the system, the window size and the presentation. A screen unchanged since is not measured again: its measure is given with `reused` (its date). `--fresh` (MCP `fresh`) measures every screen again; `--screen <id>,…` (MCP `screens`) measures only those. After an edit, `elabora fit --screen <the screens it touched>` takes seconds.
- When a slide does not fit: split the screen (plan items are often already separate), put content side by side (layout slots), bound figures with `max-height` in rem, move secondary content to a layer or an accordion, give a free object `"aspectRatio": "fill"` so it takes the height that is left.

### Scroll pages
`"presentation": { "mode": "scroll" }` (the default) makes each screen a page of any length, read from top to bottom like a lesson of Rise. The tools follow the mode:
- `elabora fit` and `elabora test` report no overflow and no layout shift in scroll presentation: they give the length of each page in windows and measure the contrast of its text against what is behind it **down the whole page**, window by window (`W_TEXT_CONTRAST_MEASURED`). On a page where a scroll- or view-timeline animation runs, a second pass runs with animations on, down the page by a quarter of a window, and reads the text in the middle of the window (20 to 80 % of its height) wherever such an animation applies to it: text must be readable there at least once (an entrance may still be fading in as it enters the middle), and text a fade keeps too faint is reported "as the page scrolls". The text's colour counts the opacity of its ancestors. Only the reference size is measured unless `--reference`/`--minimum` are given.
- Activities do not reserve the room of their feedback (an answer below the question may push the page; the learner is reading there), concealed blocks and pending steps take no room, and a revealed step scrolls into view. Steps open with a Continue button in the page, or by themselves once the activities above are answered (*Steps* below).
- The player's labels say page, not screen ("Page 2 of 6"); `course.ui` rewords them ("Lesson {n} of {total}").
- Text density is read by stretch, not by screen: more than about 450 words to read in a row with nothing to do (an activity, a control, an accordion, media) is `W_TEXT_DENSITY`, and so is a page of more than about 1,500 words (two lessons rather than one). In slides it stays 250 words a screen.
- A screen layout with `fullBleed: true` owns the page: a tall opening band, then a reading column (`max-width: var(--t-content-width)`, `t-w-wide` blocks to `var(--t-wide-width)`). Example: `examples/medieval-charts`, layout `folio`.

**The player's motion.** The player's own pieces follow one set of rules (`packages/player/src/player.css`, « Motion »): menus open at once and shrink back toward their button; popovers, layers and the PDF viewer grow and go back; side sheets slide from their edge. Themes and components reuse its tokens rather than their own values:
- `--t-ease-out` for what comes or goes, `--t-ease-in-out` for what moves on screen, `--t-ease-drawer` for sheets; `ease` for a fade that must be seen; never `ease-in` on what answers the learner.
- `--t-dur-press` 160 ms, `--t-dur-tip` 200 ms, `--t-dur-pop` 200 ms, `--t-dur-modal` 250 ms, `--t-dur-drawer` 350 ms, `--t-dur-reveal` 400 ms.
- `--t-move` multiplies distances and scales (`translate: 0 calc(.5rem * var(--t-move))`): it is 0 when the learner asks for less motion, so that only fades stay.
- Only `opacity`, `translate` and `scale`.

**Scroll-driven design.** Themes and components may animate with the scroll in CSS: `animation-timeline: view()` for a block that rises into place as it enters the window, `scroll(root)` for a backdrop or an ornament that turns as the page goes down, named view timelines shared through `timeline-scope` for a figure that stays in view (`position: sticky`) and builds up as the stages of the text scroll past (component `workshop` of the sample). Write them as progressive enhancement: inside `@supports (animation-timeline: view())` and `@media (prefers-reduced-motion: no-preference)`, with the final state as the base style, so that browsers without them (Firefox today) and learners who reduce motion see everything in place. The player turns animations off under reduced motion; captures, `elabora fit` and `elabora test` run with reduced motion, so they see the finished page.
- Free objects follow the scroll with `host.onView` (docs/free-object-contract.md, *View*): an entrance as the learner scrolls to them.
- Check motion down the page with a filmstrip of scroll positions: `elabora screenshot . --screen <id> --scroll 0,25%,50%,75%` (px or percentages of the page; animations on; one contact sheet). A full-page capture shows the page as it is at the top; free objects below the window are captured once scrolled into view and laid in place, and sticky figures appear where they start.

### Nothing moves when the learner answers
In slides, an interaction must not push content around: a slide that jumps when an answer appears feels broken.
- **Reserved room.** Each activity (quiz, numeric, decision, results) reserves from the start the height of its tallest outcome (feedback, flags, messages), measured at its real width: it grows inside that room. Fit checks therefore measure the answered slide too. A component whose feedback floats over its content opts out with `data-t-reserve="off"` in its template.
- **Concealed blocks keep their place**, like pending steps: a block shown by an event appears where its room already was.
- **Longer content goes into a layer.** `"presentation": "panel"` opens over part of the screen, which stays usable (like a Storyline layer): feedback that needs a table, a hint, a debrief over a 3D lab. `"dialog"` (default) is modal.
- **Room is a design budget**: tight feedback (a head line and two or three lines) keeps slides small; long explanations belong in the next step or a panel.
- `elabora fit` shows every slide as it is once answered and reports what still moves (`W_SLIDE_SHIFT`: a block that grows, the blocks it pushes); `elabora screenshot --state answered` shows it.

### Steps
`"step": 2` on a block of a screen holds it back until the learner presses **Continue**. Steps are numbers; gaps do not matter.
- **scroll**: a pending step takes no room. A **Continue button in the page**, where the shown content ends, opens the next step (the continue dividers of Rise); revealed blocks appear below and scroll into view. Next, in the bottom bar, only goes to the next page.
- **slides**: Continue is the Next button, relabelled while steps remain.
- **slides**: a pending step keeps its place (the view does not move, like the builds of a presentation), so a slide must fit with all its steps.
- **How each step opens** (screen `steps`, keyed by step number): `"opens": "continue"` (default), or `"opens": "answered"`: the step opens by itself once every activity of the steps above is answered, right or wrong (a quiz, a numeric answer, a decision, a free object completed), like the rest of a Rise lesson shown after a knowledge check. It opens without taking the focus, so the learner reads the feedback first. `"label"` words its Continue button (`"steps": { "2": { "label": "Test yourself" }, "3": { "opens": "answered" } }`). A step that opens once answered needs an activity above it (`E_STEP_UNREACHABLE`); settings for a step the screen does not have, or for its first step, are `W_STEP_SETTING_UNUSED`.
- With `navigation.lockUntilComplete`, Continue waits for the activities shown above it (the button says why).
- The bottom bar's `position: "page"` (course.json `player`, D58) puts it at the end of the page, after its content, instead of at the bottom of the window; in scroll presentation it appears once the last step is shown, and a narrated screen's controls stay in the window in a strip of their own.
- Focus moves to the first revealed block (screen readers read it). Revealed blocks fade in and rise a little; with reduced motion, they only fade.
- With `navigation.lockUntilComplete`, the activities of the revealed steps must be done before Continue.
- A screen counts as viewed once its last step is shown. Back on a screen left part-way (Previous, the outline, a relaunch), the learner finds the step reached, saved in the suspend data; a screen seen to the end shows all its steps.
- Steps apply to the blocks of the screen. In scroll presentation the reading order (layout slots, then block order) must not go back to an earlier step (`W_STEP_ORDER`); steps on blocks nested in a component or in a layer are ignored (`W_STEP_PLACEMENT`).
- Previews: `elabora screenshot --step 1`, MCP `elabora_preview_screenshot` with `step`; both show every step by default.

**Click to reveal** (the builds of a Storyline slide): a click in the slide can reveal the next step instead of Continue. Give the button (a `button` block, or a component with a `data-t-click` button such as a marker over a figure) a click event `{ "type": "reveal-step", "step": 3 }`: it reveals every step up to 3, and selected again later it only brings step 3 back into focus. Next appears after the last step; back on the screen later, the learner finds the step reached.
- Continue still reveals the same steps by default: a second path that always works with a keyboard. When the screen should be explored through its own triggers (every marker selected before going on), set `"continueRevealsSteps": false` on the screen: the button reads Next and, with `navigation.lockUntilComplete`, waits for the last step ("Explore this screen to continue"). Every step must then be reached by a `reveal-step` (`E_STEP_UNREACHABLE`); markers are buttons, so the keyboard path stays.
- Put each marker in the step before the one it reveals; the blocks of the latest step shown carry `data-t-current`, so the marker to select next can call for a click (a pulse, still under reduced motion) and the selected ones settle.
- A figure that builds up is a stack of blocks in one frame (a layout slot whose blocks are drawn over each other): the base image with its caption, then layers revealed by step. Layers animate in CSS from `[data-t-pending]` to revealed (a registered custom property in a transition draws a path or turns a layer); on a visited screen they are drawn at once.
- Order the blocks so that the first block of each step is what it shows (focus goes there and screen readers read its text alternative), then the marker to select next: Tab leads from one to the other. Text of the step can fade in after the figure (`transition-delay` on `[data-t-revealed]`).
- Example: `examples/orbital-rendezvous`, screen `orbits` (components `hotspot` and `orbit-flight`, layout `split` with `figure: "stack"`).

**Narrated steps** (D24): a screen's `narration.lines` give it a voice, and each step a stretch of it. The bar of a narrated screen is the player's `controls` item (in the bottom bar by default; a bar shows on every screen as soon as one screen is narrated, so a slide's room never changes), and the screen keeps the place of its own Continue at its end, so a narrated slide must fit with that place (`elabora fit` and looks measure it there); its captions show in a band laid over the bottom of the screen, which moves nothing, and its transcript in a panel over the screen. While the voice plays a step, its blocks are shown (pending before, as any step); seeking back hides the blocks of later steps again without changing the step reached. Put on screen what the voice does not say (a figure, keywords): `W_NARRATION_DUPLICATED` reports text that reads a line again. Look at a moment with `elabora look . --screen <id> --at l2` (`l2:end`: as the line ends; `l2:imprimante` as the word is said; `12.5` a time) or a filmstrip `elabora screenshot . --screen <id> --at l1,l2:imprimante,step1:end`; `elabora timeline . <id>` gives the times as text.

**Timed blocks** (D28): `block.timing` brings a block in on a word of the voice and takes it away later, with an effect relative to its place (fade, rise, slide, zoom, wipe, draw, or the theme's own `@keyframes t-fx-<name>`). A timed block keeps its place while it is not there, as a step does: lay the slide out with every block shown (looks without `--at` show the end of the screen; with a moment, the screen as it is then). Several contents in one place go into a `stack`: it takes the size of the largest. Keep effects short (0.3 to 0.8 s) and rare enough that learners can follow them (`W_MOTION_LONG` past five seconds of movement), and keep text shown long enough to be read (`W_TEXT_TOO_FAST`).

**Explore in any order** (click each tab or marker, then Next): every control of a block (its buttons, tabs and disclosures) is visited once the learner has used it, saved with the progress and styled through `[data-t-visited]` (a check, a dimmed marker). A tab or disclosure counts once its content is shown, so the tab open at first counts as soon as its block is in view.
- One block can hold every marker: name the buttons in the template (`<button data-each="markers" data-t-click="{{id}}">`) and give each name its own event: `{ "on": { "type": "click", "target": "figure-markers", "name": "engine" }, "do": [{ "type": "show-layer", "layer": "engine" }] }` (a panel layer keeps the figure in view).
- Unlock Next when all are visited: `"completeWhen": "action"` on the screen, with `navigation.lockUntilComplete`, and an event on the block's clicks `{ "on": { "type": "click", "target": "figure-markers" }, "if": [{ "visited": "figure-markers" }], "do": [{ "type": "complete-screen" }] }`. Several blocks: one such event per block, each with every `visited` condition. `{ "visited": "figure-markers", "name": "engine" }` reads one control.

## 3. Layouts and components
Screen layouts are **screen-level components** (`components/<id>/` with `"level": "screen"`); block types of the course are block-level components. Both are templates with named slots, written in reading order, with decoration only and words in props. See [components.md](components.md).

```json
{ "id": "figure-split", "title": "Figure and explanation", "version": "1.0.0", "level": "screen",
  "slots": [ { "id": "figure", "label": "Figure and legend", "accepts": ["image", "text"], "maxBlocks": 4 },
             { "id": "body", "label": "Explanation", "default": true } ] }
```
```html
<div class="pg-split">
  <div class="pg-split-head" data-title></div>
  <div class="pg-split-figure"><div class="pg-split-card" data-slot="figure"></div></div>
  <div class="pg-split-body" data-slot="body"></div>
</div>
```

- A screen uses it with `"layout": "figure-split"` (and `"layoutProps"` when the layout declares props); each block chooses `"slot": "figure"`; blocks without slot go to the default slot. The title goes into the `data-title` element (or before the template).
- `fullBleed: true` removes the page padding and width so bands can span the window.
- Scope layout CSS with `.t-layout--<id>`, component CSS with `.t-block--<id>`.

## 4. Figures and generators
Figures with words cannot be translated, edited or reflowed on phones. Draw numbers, symbols and markers; put labels in a block next to the figure (a numbered list styled as a legend, a caption, a slot).

Check them at a glance with `elabora assets . --sheet assets.png` (MCP `elabora_build_assets` with `sheet: true`): every asset each generator wrote, on the course's surface colour, with its name and size.

Figures drawn by code live in `generators/<name>.mjs` (helpers: `generators/_<name>.mjs` or sub-folders):

```js
import { gearset } from '../objects/planetary-lab/gear.js';           // share geometry with a free object
export const meta = { description: 'Gearset illustrations' };
export default async function ({ tokens, course, plan, language, write, read }) {
  write('images/gearset.svg', svgFrom(gearset('30-78'), tokens['color.copper']));
}
```

`elabora assets` (MCP `elabora_build_assets`) runs them and writes `generators/provenance.json` (generator, hash of its inputs: its code, the files it imports, the tokens and the language; hash of each output). `elabora validate` reports stale assets (`W_GENERATED_ASSET_STALE`: a generator, an imported file or a token changed) and hand-edited ones (`W_GENERATED_ASSET_EDITED`). The proof dossier lists generated assets. Generators run on the author's machine with Node, like npm scripts: review them like any code.

**Drawings in the page** (D33). An image block shows an `<img>`, which neither the page's CSS nor the timeline's `draw` effect can reach inside. `inline: true` on an image block whose asset is an SVG (generated or local) puts the drawing in the page instead, as `figure.t-figure > svg.t-figure-svg[data-t-svg="t-svg-<block>"]`: `draw` then traces its strokes (each subpath of a path from its start, so the hatching of an engraving grows line by line), and the theme's CSS and `currentColor` reach its shapes. The build writes it from the file, sanitized: only SVG elements that draw (no script, foreignObject, link or iframe), no event handler, no reference out of the drawing (`#fragments` and `data:` images only), its ids prefixed with the block's, its own `<style>` scoped to it (`@keyframes` renamed, no `@import` nor `@font-face`). It is named by the block's `alt` (`role="img"`, `aria-label`) or hidden from screen readers when decorative, as the `<img>` was. What was removed is `W_SVG_INLINE_SANITIZED`, an inline bitmap `W_IMAGE_INLINE_NOT_SVG`, a drawing over 256 KB `W_IMAGE_INLINE_HEAVY` (it is part of the course data), and `draw` on an image the page cannot trace `W_TIMING_DRAW_IMAGE`. Rules of the theme for `.t-figure img` do not reach it: style `.t-figure :is(img, .t-figure-svg)`. Captures without a moment show the drawing finished; under reduced motion `draw` is a short fade. Keep animations inside the drawing for the theme or the timeline (an SVG's own `@keyframes` run once, at load, whatever the learner is doing).

## 5. Free objects in the design
- Size: `aspectRatio` (`16:9`, `21:9`, `3:2`, `4:3`, `1:1`, `3:4`, `2:3`, `9:16`, `auto`, `fill`), `narrowAspectRatio` under 640 px, `minHeight`, `maxHeight`. `auto`: the object calls `ctx.host.requestHeight(px)`; `fill`: the frame takes the height its layout slot gets (in slides, the height left by the rest of the screen when the layout lets the slot grow).
- Text: 1rem in the frame is 1rem of the page (size classes, §2).
- Look: the frame receives the `--t-*` variables, the course fonts and the UI kit (`t-ui`, `t-ui-panel`, `t-ui-card`, `t-ui-eyebrow`, `t-ui-title`, `t-ui-btn`, `t-ui-btn--primary`, `t-ui-seg` + `t-ui-seg-options`, `t-ui-meters` + `t-ui-meter`, `t-ui-status` (`is-ok`, `is-ko`), `t-ui-badge`). See [free-object-contract.md](free-object-contract.md).

## 6. Checks on the rendered course
`elabora test` runs axe-core on every screen (contrast of the real CSS, not only of the tokens), loads every screen at 375 px to report horizontal overflow (`W_RENDER_OVERFLOW`, with the widest element) and, for slides, measures the fit at the reference and minimum windows (§2). The run that audits accessibility requests reduced motion, so scroll-driven entrances do not leave offscreen text partly transparent during the audit; other LMS runs keep normal motion. Fit and free-object gates check animated layouts separately. `elabora fit` also measures the contrast of text against the pixels behind it, where tokens cannot tell (backdrops, images, gradients).

**Looking while designing.** `elabora look . --screen <id>` (MCP `elabora_look`) shows a screen in well under a second once warm, for the look-and-fix loop: a look server kept for the course renders it from the files as they are, without a build, in one browser drawing with the GPU, as the editor canvas does, with the player's bars (so a slide has the room it has in a package) and its free objects; an object the edit did not touch keeps running. It writes a JPEG (PNG on request), says whether a slide fits at that size or how long a page is, and with `--json` where every block is. On a scroll page, `--scroll 100%` (px, a share of the page or a block's id) shows the window there with its animations, `--sheet` the page down its length, `--block <id> --scale 2` a close-up of one block; they report what each block in the window does (visible, clipped, its animations, their timeline and progress) and the scroll-driven animations that cannot finish because the page ends before their range (`elabora fit` reports them too, W_SCROLL_ANIMATION_UNFINISHED). `--block <object> --act click:<text>` drives a free object from inside its frame and reports its state and events. `elabora look . --url` prints a page that follows the looks and every saved file, for a browser pane; `elabora preview .` serves the whole course and reloads after each rebuild. Both load free objects from a second port of their server (another origin of the same site, sandboxed with `allow-same-origin`), because the in-app browsers of agent apps refuse frames of an opaque origin, which packages use. Looks are for iterating; the captures below, built like the package, are the check.

`elabora screenshot` and MCP `elabora_preview_screenshot` build the package and wait for images and free objects; agents should check each designed screen at 1600×900, 1280×720 and 375 px. One command captures many shots with one build and one browser:

```
elabora look . --screen intro --size 1600x900,375x812                 # while designing: well under a second once warm
elabora screenshot . --screen all --size 1600x900,1280x720,375x812 --state initial,answered --out-dir shots/
elabora screenshot . --screen intro --at 0,2000,4000 --viewport        # filmstrip of the animations, one contact sheet
elabora screenshot . --screen workshop --scroll 0,20%,40%,60%,80%     # filmstrip down a scroll page
elabora object replay . chart-table --test "Voyage 1"                 # an object test, replayed in the course page
elabora assets . --sheet assets.png                                   # what the generators wrote, on one sheet
```

`--state answered` shows every activity with its tallest feedback; `--at` sets CSS animations to each time and lets free objects run, then lays the frames out on one sheet; `--motion` keeps animations on (by default captures use reduced motion, so steps and transitions are settled).

## Not in this prototype
A visual editor for components, slots and styles; theme packs shared between courses (component libraries exist); right-to-left layouts.
