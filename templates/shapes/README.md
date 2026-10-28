# Shapes

Large flat circles, quarter circles, half discs and bars, as on a Bauhaus poster, in soft primaries on a warm paper with a faint print grain. For methods, frameworks, processes and young learners. Font: Archivo, a bold grotesque (SIL OFL, `theme/fonts/archivo/`).

## The charter

- **A tableau for each part.** The shapes live around the edges of the window and leave its middle to the text. Each part has its own composition; within a part, each screen moves one shape: it turns, glides along its axis or changes size.
- **The shapes never touch the text.** On the parts' screens, a shape that would reach the content column (the object's `column` prop, plus a margin) moves out towards its edge of the window. The opening and closing tableaux, behind the `poster` layout whose text keeps the left half, hold the right of the window.
- **A new part:** the shapes glide to the new tableau one after the other (1.4 s, ease in-out, 50 ms apart). A shape whose new place is across the window fades out where it was and fades in where it goes, never flying over the text. A variant's colours glide to the new palette.
- While a screen is shown, nothing moves. Less motion asked, a session resumed or a slow machine: the tableau stands at once.
- **Shapes in the content too:** numbered lists number their items in a circle, a square and a quarter circle; cards are topped by a shape; a part opener sets its number inside a shape (component `part-mark`).

The backdrop is CSS layers (the grounds of the palettes and a grain) and the decoration object `objects/tableau/`, which follows `host.onContext`.

## Variants of the backdrop

| Variant | When | What changes |
|---|---|---|
| *(none)* | Most screens | Soft primaries: vermilion, saffron, cobalt and ink on warm paper |
| `earth` | A warm pause: the quotation | Terracotta, ochre, olive and umber on sand |
| `mono` | Dense screens: the question, the chart | Ink tints, a little smaller and closer to the edges, on light grey |

To use a palette for the whole module, copy its four colours into `color.shape-1` … `color.shape-4` (and its ground into `color.surface` and the bars).

## Components and named styles

| | Name | Look |
|---|---|---|
| layout | `poster` | A large title and its lead, then the page: `stack` (text on the left, the tableau on the right) or `split` (title left, page right) |
| block | `part-mark` | A part's number in a flat shape (circle, quarter, half, square) and a colour token |
| text | `lead` | Large opening paragraph |
| text | `numbered` | Numbered list, each number in a flat shape |
| text | `meta` | Short facts set as bold tags |
| columns | `cards` | Each column on a flat card topped by a shape |
| columns | `compare` | The first column on paper, the second on the blue shape colour |

## Making it a brand's

1. **Colours** (`theme.custom`): `color.shape-1` (the large circles), `color.shape-2` (quarters, half discs, the callout), `color.shape-3` (the comparison's second column, text in `color.onPrimary` on it), `color.shape-4` (bars, small marks). Keep `shape-1` and `shape-2` light enough for ink text (4.5:1), `shape-3` dark enough for `color.onPrimary`. The object binds its colours to these tokens (`x-token`); `earth*` and `mono*` set the variants.
2. **Type:** `elabora font add . "<family>" --for body,heading`, a bold grotesque.
3. **Parts:** the object follows the sections by their rank in the course: the first takes the opening tableau, the last the closing one, the parts between the three others in turn. Adding, removing or renaming a section needs nothing more.
4. **The content column:** keep the object's `column` equal to `presentation.wideWidth ÷ 16` (65 rem: the wide column is narrower than in the other templates, to leave the shapes their margins): the shapes keep clear of it.
5. **Composition:** `shuffle` gives each screen another shape to move, `transition` sets the pace. To draw other tableaux, edit `TABLEAUX` in `objects/tableau/object.js` (positions as fractions of the window, sizes as fractions of its height, the middle kept free), then `elabora object test . tableau --update-snapshots`.
6. **Corners:** square (`radius` 0) with round buttons (`player.radius` 999); raise `radius` for rounded cards.
7. **Logo:** `elabora player . --logo images/<logo>.svg` with its `alt`.
