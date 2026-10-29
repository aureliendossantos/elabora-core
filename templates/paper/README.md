# Paper (Atelier) — a module template for Elabora

A cut-paper charter: kraft under everything, sheets of coloured paper taped onto it, each one casting the soft shadow of paper lifted a little above the one under it. Behind the screens, a paper theatre — hills cut from coloured paper along the bottom of the window, a sun, a cloud, a few leaves — that moves in stop motion when the learner moves on. A hand for the accents, a solid sans for reading.

For storytelling, primary school, associations and awareness campaigns: warm, handmade, readable from afar.

## The concept

- **One light, real shadows.** The light comes from the top left, so every shadow falls to the bottom right, in the stylesheet and in the backdrop's object alike. There are three heights of paper (`--pp-shadow-1`, `-2`, `-3` in `theme/theme.css`): a tag laid flat, a sheet, a sheet held up. The higher the paper, the longer and softer its shadow. A shadow never changes on its own: when a sheet is laid down on a new screen, it comes down in four poses and its shadow shrinks with it, because it really comes down.
- **Stop motion.** Nothing glides: moves are drawn in poses (12 a second by default in the backdrop, 4 poses for a sheet that is laid down), each paper piece trembling a little between two poses as if moved by hand, then still. At rest nothing moves and nothing is drawn.
- **The backdrop follows the course** (`objects/cutouts`, a decoration mounted once for the whole session):
  - at each screen the hills slide sideways like the scenery of a toy theatre, the near ones further than the far ones (to the left going forward, to the right going back); the sun stays where it is, far away;
  - at each part the scene is changed by hand: the last part's pieces are pulled out (the hills down, the sky up), the near ones first, then the new part's pieces are slid in, the far ones first. Each part has its own scene: a bright morning (opening), fields (part 1), the sea (part 2), autumn (part 3), a party (closing);
  - it keeps out of the player's bars (`ctx.safeArea`), and under reduced motion or on a slow machine the new scene is there at once;
  - on a phone (a frame narrower than 760 px) slides read as pages that scroll over the scene, so it draws nothing: the kraft, its fibres and the papers stay, the reading stays clear.
- **Type.** Figtree (a solid, friendly sans, weights 300–900) for titles and text; Caveat (a casual hand) only for accents: a part's number, the figures of key figures, the numbers of a list, tags, a sticky note's title, the quotation mark. Both under the SIL OFL, embedded in `theme/fonts/`.
- **Where the learner is** is said by the player's bars and by the part's own number, written large by hand on a cut-paper shape (component `part-number`); no line above the titles.

## The screens

The 14 screens common to Elabora's templates, in the same five sections and with the same plan. What Paper does with them:

| Screen | Made of |
|---|---|
| `cover` | layout `sheet` (cover): the title set large on a taped sheet, the lead, three handwritten tags (`text`, style `tags`) |
| `objectives` | layout `sheet` (stack), a numbered list whose numbers are written on paper discs (style `numbered`) |
| `part-one` | layout `sheet` (split): the title and lead on the sheet, the part's number on a scalloped mustard disc beside it (`part-number`) |
| `key-message` | a `statement` on a strip of mustard paper taped at both ends (style `banner`) |
| `text-and-picture` | an `image` beside its text: a cut-paper collage drawn from the tokens (`generators/paper.mjs`) |
| `cards` | `columns` of three coloured cards, taped down (style `cards`) |
| `key-figures` | `key-figures`, each figure on its sheet, written by hand |
| `practice` | a `quiz` on a sheet, compact feedback; backdrop `calm` |
| `steps` | `process` on a sheet, the numbers by hand; backdrop `calm` |
| `quote` | a `statement` quotation on the `night` backdrop |
| `comparison` | `columns` of two sheets, a plain one and a bright one (style `compare`) |
| `chart` | `bars` on a sheet; backdrop `calm` |
| `recap` | layout `sheet` (stack): the numbered list and a sticky note (`callout`) |
| `the-end` | layout `sheet` (cover) and handwritten tags |

Every screen is made of the core's blocks: change a block, add one or reword any text from the editor. A screen added later takes the charter as it is: a `callout` becomes a sticky note, a `quiz`, a `bars` or a `process` chart lands on a sheet, `columns` take the styles `cards` or `compare`, a `text` the styles `lead`, `numbered` or `tags`.

## The backdrop and its variants

`theme.backdrop` in `course.json`: four CSS layers (`kraft`, `calm`, `night`, and `grain`, the paper's fibres laid over the ground and the cut-outs alike) and the object `cutouts`.

| Variant | What it shows | Used on |
|---|---|---|
| *(default)* | Kraft, the scene of the part in bright papers | most screens |
| `calm` | A pale sheet instead of the kraft, the hills lowered and flattened, the sky cleared: for dense screens | `practice`, `steps`, `chart` |
| `night` | Deep blue paper, blue and teal hills, a paper moon and stars; the text turns pale (`#elabora-app[data-backdrop="night"]`) | `quote` |

A screen picks one with `"backdrop": "calm"` or `"night"`, or turns it off with `"none"`. Changing variant is a change of scene: the pieces are pulled out and others slid in, the ground faded in a few poses.

The object's settings (block of `theme.backdrop.object.props`, or the inspector): the papers (each bound to a theme token), `band` (how high the hills rise; 0.75 by default, keep it at or under 1 so that `elabora fit` finds nothing behind the sheets), `pan` (how far they slide at each screen; 0 keeps them still), `travel` (seconds a move takes), `fps` (poses a second: fewer is more handmade) and `boil` (how much the pieces tremble while they move).

## Making it a brand's

1. **Colours.** Every colour is a token of `course.json`:
   - `theme.tokens`: `color.text` and `color.primary` (the ink), `color.surface` (the white paper of the bars), `color.accent`, the player's bars (`player.*`);
   - `theme.custom`: the ground (`color.kraft`, `color.calm`, `color.night`), the papers (`color.paper`, `color.paper-coral`, `-mustard`, `-teal`, `-sky`, `-leaf`, `-pink`, `color.night-paper`), the ink on papers (`color.ink`), the pale text at night (`color.night-text`, `color.night-muted`), the shadows' and fibres' tint (`color.fibre`) and the tape (`color.tape`).

   Swap the papers for the brand's palette (keep them light enough for ink text: `elabora fit` and `elabora test` measure it), then run `elabora assets .` to redraw the collage, the fibres and the masks. The backdrop's papers follow the tokens by themselves.
2. **Ground.** A brand with a white world: set `color.kraft` to an off-white and lower the grain's opacity in `theme/theme.css` (`.t-backdrop-layer[data-layer="grain"]`). A dark brand: make `night` the default (`"default": "night"` in `theme.backdrop`).
3. **Type.** `elabora font add . "<family>" --for body,heading` for the brand's sans; keep a hand for `font.display` or set another display face (`--for display`).
4. **Logo.** `elabora player . ` and the item `logo` (an SVG of `assets/`, with its `alt`).
5. **Motion.** Calmer: `pan: 0` (the scene changes only with the part), or a larger `fps` and `boil: 0` for smoother moves. The sheets' entrance is `--pp-lay` in `theme/theme.css` (`none` to remove it).

## Files

- `theme/theme.css`: the charter (shadows, grounds, type, styles, sheets, charts).
- `components/sheet/`: the screen layout « Paper sheet » (cover, stack, split), its paper and tilt as design props.
- `components/part-number/`: a part's number on a cut-paper shape (disc, scalloped disc, star).
- `objects/cutouts/`: the backdrop's decoration, its tests and baselines.
- `generators/paper.mjs`: the collage, the fibres and the masks of the shapes, coloured from the tokens.
- `translations/fr.xlf`: the French translation.

Licence: CC0 1.0 for the module (`LICENSE.md`); the fonts keep their SIL OFL beside them.
