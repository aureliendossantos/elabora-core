# Watercolour (`watercolor`)

A module template for the arts, care and sensitive subjects. Washes of water tones bloom on the paper behind every screen and spread from one screen to the next, like paint running into wet paper. Titles are set in an italic serif, the text in a warm humanist sans, on a cold-pressed paper.

Start a course from it:

```bash
elabora init my-course --template watercolor --id my-course --title "My course" --lang en
```

## The concept

- **Paint that carries on.** Each screen has its own washes around the edges of the window, and they thin out toward the middle, where one reads (the setting « Reading area », `clear`). The first wash of a screen sits where the second wash of the screen before was: moving on, a new wash spreads from a drop at the edge into the paper, while the washes of the screen before dry into pale stains. The learner sees the module go forward as paint spreading.
- **A tone per part.** Lagoon to open, then cerulean, sea glass and deep water for the three parts, and lagoon with blush and ochre to close. The water darkens as the module goes deeper, then warms at the end. The part's tone also colours the numerals, the drops before short facts, the charts' highlight and the guide's bubble (`--wc-part`, `--wc-pigment`).
- **Gentle motion only.** A wash spreads as water does, over 4.5 seconds: quick at first, then slower and slower, each stretch of its edge at its own pace, a damp halo drying around it as it comes to rest. The washes of the screen before dry into pale stains over 2.4 seconds, easing in and out. Nothing jumps, nothing ever grows past its place. Going back, nothing un-spreads (paint does not): the washes of the screen left fade out and those of the screen found again fade in. Under reduced motion, and on slow machines, every screen shows its washes already dry. The canvas is only drawn while something changes.
- **Out of the player's bars.** The washes are clipped to the room between the bars, which sit on the bare paper.

## What it is made of

| Part | Where | What it does |
|---|---|---|
| Tokens | `course.json` `theme.tokens`, `theme.custom` | Ink, paper, accent; the six wash tones (`color.wash-*`); the sheet and line of cards; the ink variant's ground and text |
| Fonts | `theme/fonts/` | EB Garamond (titles, italic) and Lato (text), SIL OFL, embedded |
| Stylesheet | `theme/theme.css` | The part's tone from the section's rank, the backdrop's layers (paper, ink ground, paper relief over the washes), the type, the styles |
| Backdrop object | `objects/bloom/` | The washes: a 2D canvas, `pedagogicalRole: "decoration"`; `wash.js` holds the geometry |
| Part opener | `components/watercolor-part/` | A fork of the opening: the part's number set very large in italic, over a pool of its wash |
| Figures | `generators/watercolor.mjs` | The paper relief and the illustration of `text-and-picture`, drawn from the wash tokens with the object's geometry (`elabora assets`) |

Styles an author picks in the editor:

| Type | Style | Look |
|---|---|---|
| screen | `cover` | The title set very large in italic (cover and end) |
| text | `lead` | A large italic paragraph |
| text | `objectives` | A numbered list under large italic numerals |
| text | `meta` | Short facts on one line, each after a drop of colour |
| text | `takeaways` | Numbered takeaways side by side, each numeral on a small pool |
| columns | `cards` | Each column on a sheet of paper, a wash pooled at its top (lagoon, cerulean, sea glass) |
| columns | `compare` | The first column left unpainted and muted, the second on a wash |

## The variants

Declared in `theme.backdrop.variants`; a screen picks one with `"backdrop": "<id>"`. Screens without one show the full washes.

| Variant | Look | Used on |
|---|---|---|
| *(none)* | Full washes in the part's tones | cover, part opener, key figures, quote, chart |
| `quiet` | Paler washes pushed further to the edges | dense screens: objectives, text and picture, cards, practice, steps, comparison |
| `ink` | A deep indigo ground, light washes, light text and bars | one sentence set large: key message |
| `dawn` | Blush and ochre washes | the closing part: recap, the end |

## The screens

The 14 screens every template has, in the same sections and order: `cover`, `objectives`, `part-one`, `key-message`, `text-and-picture`, `cards`, `key-figures`, `practice`, `steps`, `quote`, `comparison`, `chart`, `recap`, `the-end`. All are made of the core's blocks (opening, text, statement, image, columns, key figures, quiz, process, proportion, speech), so each text can be reworded from the editor. A part opener for the second and third parts is the `part-one` screen duplicated with `"number": "2"`. The texts are placeholders in English at their real length; the French translation is in `translations/fr.xlf`.

## Making it a brand's

Change tokens, never the stylesheet:

1. **Ink and paper.** `color.text` and `color.primary` (the ink: titles, text, buttons), `color.surface` (the paper), `color.muted`, `color.accent`. Keep the ink dark enough on the paper (`elabora validate` checks the tokens, `E_THEME_CONTRAST`).
2. **The water tones.** `color.wash-lagoon`, `-cerulean`, `-sea`, `-deep`, and the warm `-blush` and `-ochre` in `theme.custom`. The backdrop object reads them through its props (`x-token`), the stylesheet through `--t-color-wash-*`, the generator when you run `elabora assets .`. Brand colours work best as washes when lightened: keep them pale (lightness above about 75 %), so the text keeps its contrast where a wash runs behind it. For a single brand colour, give it to `lagoon` and `cerulean` and keep the others close to it.
3. **The ink variant.** `color.ink-ground`, `color.ink-text`, `color.ink-muted`.
4. **Cards.** `color.sheet` and `color.line`.
5. **Type.** `elabora font add . "<family>" --styles normal,italic --for heading` (an italic serif keeps the character: Lora, Source Serif 4, Libre Baskerville…), and `--for body` for the text.
6. **The bars.** `elabora player . --token player.accent=<ink>`; give a logo with `elabora player . --logo <asset>` and `--enable logo`.
7. **The washes' behaviour.** In the editor, on the backdrop object: pigment (how pale), washes per screen, spreading and drying times. Or in `course.json`: `"object": { "id": "bloom", "props": { "strength": 0.7, "count": 4 } }`.

Then check: `elabora assets .`, `elabora validate .`, `elabora fit .` (it measures the text against the washes) and `elabora fit . --language fr`.

## Licence

CC0 1.0 (see `LICENSE.md`); the fonts keep their SIL Open Font License beside them.
