# Clear

Corporate sobriety, made with care: one neutral sans (Inter, SIL OFL, `theme/fonts/inter/`), one accent, a strict grid that is never drawn, and one movement that means something. For compliance, procedures, HR and internal communication, and for classic presentations.

## The charter

- **The grid holds, unseen.** Twelve columns as wide as the wide column (`presentation.wideWidth`): titles, text and cards start on their lines; text keeps to eight columns. Titles keep their place from one slide to the next and the content follows them; a screen without a visible title (the key message, the quotation) holds its statement in the middle of the room.
- **One accent.** `color.accent` is the only colour: the rule, the numbers, the highlighted figure of a chart, the Next button, the cover's panel. Everything else is ink, grey and white.
- **One movement.** Under the top bar, a rail has one hairline segment per part; a short accent rule underlines the part in progress. To the next or the previous part it slides (0.7 s, ease in-out); for a longer jump (the outline, a relaunch) a slide across the window would be unrealistic, so it fades out and in at its place. Within a part nothing moves. Less motion asked: it is drawn at its place at once.
- **No label above the titles.** A part opener (screen style `section`) sets its number large in the accent, as the objectives do.
- **No generic marks:** no coloured left border (notes and prompts sit on a flat card under a rule), no frosted glass, no violet, no shadow.

The backdrop is three CSS layers (`ground` for the dark variant, `tint`, `panel`) and the decoration object `objects/accent-rule/` (the rail).

## Variants of the backdrop

| Variant | When | What changes |
|---|---|---|
| *(none)* | Most screens | White ground, the rail and its rule |
| `feature` | The cover, part openers, the end (with the screen styles `cover` or `section`) | An accent panel from the eighth column to the window's edge, with one quarter circle |
| `tint` | The key message, a moment that stands out | A pale wash of the accent |
| `ink` | The quotation | The window turns dark (ground, bars, text); the accent and the rail take their tints for dark grounds; the logo gets a light plate |

On phones the panel is hidden (the text takes the whole width).

## Named styles

| Block | Style | Look |
|---|---|---|
| screen | `cover` | The copy on the left six columns, for the `feature` backdrop |
| screen | `section` | Part opener: the number (`layoutProps.eyebrow`: 01, 02…) large in the accent, the title on the left columns |
| text | `lead` | Large introductory paragraph, in grey |
| text | `agenda` | Numbered list with large accent numbers and hairlines (each item `**Title**`, a line break, one line) |
| text | `checklist` | Ticked list on hairlines (takeaways, recap) |
| text | `meta` | Short facts in a row, in small capitals, under a hairline |
| columns | `cards` | Flat grey cards under a 2 px ink rule, numbered 01, 02, 03 in the accent |
| columns | `compare` | The first column grey (the usual way), the second outlined in the accent |
| statement | `accent` | The statement set very large under a rule one column wide |

## Making it a brand's

1. **The accent:** `color.accent` in `theme.tokens` (4.5:1 on white for small text: the validator checks it), with `player.accent` and `color.focus`; in `theme.custom`, `color.accent-on-dark` (a lighter tint for `ink`) and `color.on-accent` (what is drawn over the panel).
2. **The ink:** `color.text`, `color.primary`, `color.muted`; for dark screens `color.ground-dark`, `color.paper-dark`, `color.text-on-dark`, `color.muted-on-dark`. Cards use `color.paper`.
3. **The figure:** `elabora assets .` draws it again from the tokens.
4. **The logo:** replace the placeholder (`elabora media import . <logo.svg> --to images --name logo`) and give its `alt` the organisation's name (`player.top.items[0].options`). A logo drawn for light grounds keeps a light plate on dark screens.
5. **The font:** `elabora font add . "<family>" --for body,heading`.
6. **The parts:** the rail has one segment per section of the object's `sections` prop (by default `opening`, `part-1`, `part-2`, `part-3`, `closing`). Adding, removing or renaming a section: update that list in the same order.
7. **The rail itself** (same props): `position` (`top` or `bottom`), `offset` (rem from the edge: 3.5 is the top bar's height), `width` (rem: `wideWidth ÷ 16`), `thickness`, `duration`.
