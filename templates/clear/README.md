# Clear — an Elabora template

**Corporate sobriety, made with care.** A strict twelve-column grid, one neutral sans (Inter), one accent colour, and a single movement: a short accent rule under the top bar that travels to the part the learner is in. Made for compliance, procedures, HR and internal communication, and for classic presentations (slides, keyboard, one idea per view).

Licence: CC0 for the module (see `LICENSE.md`); Inter is embedded under the SIL OFL (`theme/fonts/inter/OFL.txt`). Nothing is loaded from the network.

![Cover](captures/cover-1600x900.png)

## The concept

- **The grid is visible, barely.** Twelve hairline columns, as wide as the wide column (`presentation.wideWidth`, 1240 px at 1600×900), sit behind every screen. Titles, text and cards start on those lines; text is held to eight columns. Titles keep the same place from one slide to the next; the content sits in the middle of the room left below them.
- **One accent.** `color.accent` is the only colour: the rule, the part numbers, the highlighted figure of a chart, the Next button, the panel of the cover. Everything else is ink, grey and white.
- **One movement, with a meaning.** The backdrop's rail has one hairline segment per part of the module. The accent rule underlines the current part:
  - to the next or the previous part, it **slides** (0.7 s, ease in-out);
  - for a longer jump (the outline, a relaunch), a slide across the window would be unrealistic, so it **fades out** where it was and **fades in** where it goes;
  - within a part, nothing moves;
  - with less motion requested, it is drawn at its place at once (still images); the variants of the backdrop only fade, and not at all under reduced motion.
- **No generic AI marks.** No coloured left borders (the player's callouts, asides, panel prompts and reflection models are restyled with a top rule on a flat card), no frosted glass, no violet, no shadows.

## What is in it

| Part | Where |
|---|---|
| Tokens (charter and custom) | `course.json` › `theme.tokens`, `theme.custom` |
| Stylesheet: grid, type, named styles, variants | `theme/theme.css` |
| Font: Inter, variable, normal and italic | `theme/fonts/inter/` |
| Backdrop: three CSS layers (`ground`, `grid`, `panel`) and a decoration object | `course.json` › `theme.backdrop`, `objects/accent-rule/` |
| Abstract figure drawn from the tokens | `generators/figures.mjs` → `assets/images/figure-grid.svg` |
| Logo placeholder (top bar) | `assets/images/logo.svg` |
| French translation | `translations/fr.xlf` |

### The screens (14)

| # | Screen | Blocks | Backdrop |
|---|---|---|---|
| 1 | `cover` — cover, also the library thumbnail | layout `opening`, text `meta` | `feature` |
| 2 | `agenda` — agenda and objective | text `agenda`, text `lead` | — |
| 3 | `part-intro` — part opener | layout `opening`, text `checklist` | `feature` |
| 4 | `key-message` — one big sentence | statement, style `accent` | — |
| 5 | `text-figure` — text and illustration | image `beside` (generated SVG) | — |
| 6 | `cards` — three cards | columns (3), style `cards` | — |
| 7 | `key-figures` | key-figures chart | — |
| 8 | `process` — steps | process chart | `calm` |
| 9 | `quote` | statement `quote` with author | `ink` |
| 10 | `compare` | columns (2), style `compare` | — |
| 11 | `check` — interaction, with a character | speech + quiz (compact feedback) | `calm` |
| 12 | `chart` | bars chart | `calm` |
| 13 | `recap` | text `checklist` | — |
| 14 | `end` | layout `opening`, text `meta` | `feature` |

Every screen is made of core blocks: an author changes a block, adds one or rewords any text from the inspector. A screen added later inherits the grid, the type and the backdrop; pick a style or a variant from the lists below.

### Named styles

| Type | Style | Look |
|---|---|---|
| screen | `cover` | Copy on the left six columns, for the `feature` backdrop (cover, end) |
| screen | `section` | Part opener: larger eyebrow, same layout as `cover` |
| text | `lead` | Large introductory paragraph, in grey |
| text | `agenda` | Numbered list: large accent numbers, hairlines between rows. Write each item as `**Title**` + line break + one line |
| text | `checklist` | Ticked list on hairlines (takeaways, recap) |
| text | `meta` | Short facts in a row, in small capitals, under a hairline |
| columns | `cards` | Flat grey cards, a 2 px ink rule on top, numbered 01, 02, 03 in the accent |
| columns | `compare` | First column grey (the usual way), second outlined in the accent (the recommended way) |
| statement | `accent` | The statement set very large, under a rule one column wide |

## The backdrop variants

Declared in `theme.backdrop.variants`; a screen picks one with `"backdrop": "<variant>"`, or `"none"` to hide the backdrop.

| Variant | What changes | Use it for |
|---|---|---|
| *(none set)* | White ground, grid hairlines, the rail and its rule | most screens |
| `feature` | An accent panel from the eighth column to the window's edge, with the grid in white hairlines and one quarter circle | cover, part openers, end (with the screen styles `cover` or `section`) |
| `calm` | No grid lines | charts, questions, dense screens |
| `ink` | The whole window turns dark (ground, bars, text); the accent and the rail take their tints for dark grounds; the logo gets a light plate | a quotation, a key message, a moment that stands apart |

On phones the panel and the grid are hidden (the text runs the full width); the rail keeps a margin.

## Adapting the charter to a brand

1. **The accent.** In `course.json` › `theme.tokens`, set `color.accent` to the brand colour (it must reach 4.5:1 on white for small text: the validator checks it). Set `player.accent` and `color.focus` to the same value. In `theme.custom`, set `color.accent-on-dark` to a lighter tint for the dark variant, and `color.on-accent` to the colour drawn over the panel (white for dark accents, ink for light ones).
2. **The ink.** `color.text`, `color.primary` (the same ink) and `color.muted`; for the dark variant `color.ground-dark`, `color.paper-dark`, `color.text-on-dark`, `color.muted-on-dark`. Cards use `color.paper`, the figure's outlines `color.line`.
3. **Redraw the figure**: `elabora assets .` (it reads the tokens).
4. **The logo.** Replace the placeholder: `elabora media import . <logo.svg> --to images --name logo` (or point the top bar's `logo` item, `player.top.items[0].options.asset`, to another file), and set its `alt` to the organisation's name. A logo for dark grounds only: add `"plate": true` to the item.
5. **The font.** `elabora font add . "<family>" --for body,heading` (a vetted font, or `--from` / `--file` for the brand's own, with its licence). The theme uses the tokens, nothing else to change.
6. **The parts.** The rail has one segment per section listed in `theme.backdrop.object.props.sections`. When you add, remove, rename or reorder a section, update that list in the same order (the decoration cannot read the module's sections; a section left out of the list keeps the rule where it was).
7. **The rail itself** (in the same `props`): `position` (`top` under the bar, or `bottom` above the bottom bar), `offset` (rem from the edge: 3.5 is the height of the top bar, 3 with `player.density: "compact"`), `width` (rem, keep it equal to `wideWidth ÷ 16`), `thickness` (px), `duration` (s).
8. **A fully dark module.** Either set `"backdrop": "ink"` on every screen, or swap the charter itself: `color.surface` `#11151B`, `color.text` and `color.primary` `#EEF1F5`, `color.muted` `#A9B1BD`, `color.onPrimary` `#11151B`, `color.accent` and `player.accent` `#8FB0FF`, `player.onAccent` `#11151B`, the four `player.top/bottom.*` tokens to the same pair, `color.paper` `#1B2029`; then pass the rail its colours (`ink: "#EEF1F5"`, `accent: "#8FB0FF"` in the object's props) and run `elabora validate .` and `elabora fit .`.

Check after any change: `elabora validate .`, `elabora fit .`, `elabora screenshot . --screen all --size 1600x900,375x812`, `elabora test .`.

## Checks

State at delivery (28 October 2026):

- `elabora validate .`: 0 errors, 3 warnings, all expected for a template: `W_PLAN_DRAFT` (no plan version: a person makes one), `W_SPACING_MISSING`, `W_EXPOSITION_STREAK` (the order of the common screen list puts five exposition screens in a row).
- `elabora fit .`: 14/14 screens fit at 1600×900 and 1280×720, in English and in French; no measured contrast warning.
- `elabora test . --parallel 1`: 8/8 LMS runs, axe 0 violations on 28 screen states. French package (`elabora_test_package` with `language: "fr"`): run and axe pass.
- `elabora object test . accent-rule`: gates smoke, behaviour (9 tests), budget, visual and accessibility pass; boot ≈ 30 ms.
- French: 94/94 units translated (`elabora translate status . --to fr`); the translated plan awaits a person's approval.

Captures in `captures/` were made with `elabora screenshot` (1600×900 and 375×812): `elabora look` does not show the backdrop's variant of the screen asked (see `frictions.md`).
