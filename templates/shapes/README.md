# Shapes — a Bauhaus template for Elabora

**Category:** Formes (`shapes`) · **For:** methods, frameworks, processes, young learners · **Licence:** CC0 (the module), SIL OFL (the font, `theme/fonts/archivo/OFL.txt`)

## The concept

Large flat circles, quarter circles, half discs and bars, as on a Bauhaus poster. They live around the edges of the slide and leave its middle to the text. Every part of the module has its own **tableau** (its own composition), and within a part each screen moves **one** shape: it turns, glides along its axis or changes size. Moving on, the learner sees the shapes rearrange one after the other. A new part brings a new tableau, and the screens of a part are variations of it. The motion carries meaning: the part changes, the module moves on.

- **Type:** Archivo, a bold grotesque (variable, 100–900, with italics), embedded with its licence. Titles are set in 800 with tight spacing, numbers in 900, body text in 400.
- **Colours:** soft primaries (vermilion, saffron, cobalt, ink) on a warm paper, with a faint print grain over the shapes.
- **Shapes in the content too:** the numbered lists (objectives, recap) number their items in a circle, a square and a quarter circle; the cards are topped by a shape; the « Part » mark (component `part-mark`) sets the number of a part inside a shape.

### What moves, and how

| Moment | What happens | Under « less motion » |
|---|---|---|
| A new screen in the same part | one shape turns 90°, glides about a tenth of the window or grows or shrinks; the others stay | the new tableau is shown at once (still image) |
| A new part | the seven shapes glide to the new tableau one after the other (1.4 s, ease-in-out, 50 ms apart) | at once |
| A shape whose new place is across the window | it fades out where it was and fades in where it goes, never flying over the text | at once |
| A variant (earth, mono) | the colours glide to the new palette; the ground fades | at once |
| While a screen is shown | nothing moves | nothing moves |

Nothing grows to fill the window, nothing moves the page (the backdrop is behind the course and never takes room), and there is no shadow. The first screen of a session (or a session resumed) shows its tableau at once. On a machine that draws slowly (frames over 90 ms), a rearrangement lands at once instead of freezing half-way.

## Files

| File | What it holds |
|---|---|
| `course.json` › `theme` | the tokens, the font, the named styles, the backdrop (layers, object, variants) |
| `theme/theme.css` | the charter's stylesheet: grounds, type, named styles, callouts and statements |
| `objects/tableau/` | the decoration: the shapes and their rearrangement (`object.js`), its settings (`object.manifest.json`), its tests and baselines |
| `components/poster/` | screen layout « Poster »: a large title and its lead, then the page; `stack` (text on the left, the tableau on the right) or `split` (title left, page right) |
| `components/part-mark/` | block « Part mark »: the number of a part in a flat shape (circle, quarter, half, square) and a colour token |
| `generators/shapes.mjs` | the paper grain of the backdrop and the composition of the « text and illustration » screen, drawn from the tokens |
| `screens/` | the 14 screens of the common set (below) |
| `translations/fr.xlf` | the French translation, made with Elabora's translation tools |
| `captures/` | `elabora look` captures of every screen at 1600×900 and 375×812 |

## The screens

| # | Screen | Blocks |
|---|---|---|
| 1 | `cover` — the cover and library thumbnail | layout `poster` (stack), text, text `meta` |
| 2 | `objectives` | layout `poster`, text `numbered` |
| 3 | `part-one` — part opener | layout `poster` (split), text, `part-mark` |
| 4 | `key-message` | statement |
| 5 | `text-and-picture` | image `beside` (generated composition) |
| 6 | `three-cards` | columns (3) `cards`, headings, texts |
| 7 | `key-figures` | chart `key-figures` |
| 8 | `practice` — the interaction | quiz (single choice, compact feedback), variant `mono` |
| 9 | `four-steps` | chart `process` |
| 10 | `quote` | statement `quote` with author, variant `earth` |
| 11 | `comparison` | columns (2) `compare`, headings, lists |
| 12 | `chart` | chart `bars`, variant `mono` |
| 13 | `recap` | layout `poster`, text `numbered`, callout |
| 14 | `the-end` | layout `poster`, text, text `meta` |

Every block is a core block or one of the two components: change, add or reword any of them from the inspector. A new screen inherits the theme, the backdrop and its motion with no copy.

## The variants

The default palette is the **soft primaries**. Two variants are declared in `theme.backdrop.variants`, for a screen to pick with `"backdrop": "<variant>"`:

- **`earth`** — terracotta, ochre, olive and umber shapes on sand (`color.earth-*`, `color.earth-ground`). Here on the quotation, as a warm pause.
- **`mono`** — monochrome and calmer: ink tints, a little smaller and kept closer to the edges (`color.mono-*`, `color.mono-ground`). For dense screens: here the question and the chart.
- `"backdrop": "none"` hides the backdrop on a screen.

To use a palette for the **whole module**, copy its four colours into `color.shape-1` … `color.shape-4` (and its ground into `color.surface` and `player.*.background`): the theme and the decoration follow.

## Adapting the charter to a brand

1. **Colours** — `course.json` › `theme.custom`:
   - `color.shape-1` (the large circles), `color.shape-2` (quarters, half discs, the callout), `color.shape-3` (kept to the edges, and the second column of the comparison: text sits on it in `color.onPrimary`), `color.shape-4` (bars, small marks). Use the brand's colours; keep `shape-1` and `shape-2` light enough for ink text (4.5:1) since the numbered lists and the part mark write on them, and `shape-3` dark enough for `color.onPrimary`.
   - The decoration binds every colour prop to these tokens (`x-token`): change a token and the shapes follow. A colour can still be set for the decoration alone in `theme.backdrop.object.props` (`colour1`…`colour4`, `earth1`…, `mono1`…).
   - `theme.tokens`: `color.surface` (paper), `color.text`/`color.primary` (ink), `color.accent` (chart highlight), `player.*` for the bars. `elabora validate` checks their contrast (`E_THEME_CONTRAST`); `elabora fit` measures the text against the shapes (`W_TEXT_CONTRAST_MEASURED`).
2. **Type** — replace Archivo with the brand's grotesque: `elabora font add . "<family>" --for body,heading` (a vetted font) or `--from <Fontsource package>` / `--file … --license …`. The stylesheet only reads `--t-font-heading` and `--t-font-body`.
3. **Parts** — the decoration gives each section of `course.json` the next tableau in the order of its setting **Parts, in order** (`parts`, default `opening, part-1, part-2, part-3, closing`). After adding, removing or renaming a section, update that list (`theme.backdrop.object.props.parts`); a section left out still gets a tableau, drawn from its id.
4. **Composition** — **Shuffle** (`shuffle`) gives each screen another shape to move; **Rearrangement** (`transition`, seconds) sets the pace. To draw other tableaux, edit `TABLEAUX` in `objects/tableau/object.js` (positions as fractions of the window, sizes as fractions of its height; keep the middle free), then run `elabora object test . tableau --update-snapshots`.
5. **Corners** — the theme is square (`radius` 0) with round buttons (`player.radius` 999). For rounded cards, raise `radius`.
6. **Logo** — `elabora player . --logo images/<logo>.svg` (with its `alt`).

## Checks (28 October 2026)

| Check | Result |
|---|---|
| `elabora validate .` | 0 errors; 2 warnings that belong to the author (`W_PLAN_DRAFT`: no plan version; `W_SPACING_MISSING`) |
| `elabora fit .` | 14/14 slides fit at 1600×900 and 1280×720; no measured contrast issue on the shapes |
| `elabora tools call elabora_check_fit . --args '{"language":"fr"}'` | 14/14 fit in French at both sizes, no finding |
| `elabora object test . tableau` | gates smoke, behaviour (9 tests), budget, visual, accessibility passed; boot 28 ms |
| `elabora test .` | 8/8 LMS runs, axe 0 violations on 28 screen states, slides fit |
| `elabora_test_package` (`language: "fr"`) | passed, axe 0 violations |

**About the captures.** `captures/NN-<screen>-1600x900.jpg` and `-375x812.jpg` come from `elabora look`, with the look server restarted before each screen (otherwise the decoration keeps the first screen's tableau, see `frictions.md` § 1). `look` does not set the backdrop's `data-variant`, so the sand and grey grounds of `earth` and `mono` are missing there: `captures/built/` holds `elabora screenshot` captures of the built package for those screens (and the question once answered). `captures/01-cover-1600x900-fr.jpg` is the cover in French.
