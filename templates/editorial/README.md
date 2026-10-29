# Editorial

The magazine page, for long reads: culture, history, management. Warm paper with a fine grain, ink rules, folios and drop caps; a display serif (Fraunces, roman and italic) over a reading sans (Source Sans 3), both under the SIL OFL in `theme/fonts/`. Each part of the module has its own colour plate, as a magazine has its sections.

## The concept

- **One plate per part.** The sections take the colours `color.plate-1` to `color.plate-5` in their order (vermilion, Prussian blue, green, ochre, oxblood; a sixth section starts again from the first). The plate is the part's identity: its thumb tab at the page edge, its plate on the part opener, its drop caps, its part number, the highlight of its charts, the short rules of its lists.
- **The thumb index.** On every page, the right edge carries one tab per part, like the cut edge of a magazine: the tab of the part in progress stands out, the others are slivers. Tabs never travel: as the reader moves on, the next tab comes forward where it always was.
- **The plate unfolds.** On a part opener the part's tab unfolds into a colour plate on the right of the page, its number set very large on it in italic serif; leaving the opener, the plate folds back into its tab. On the cover and the last screen every part's plate shows side by side: the whole issue at a glance, and the library's thumbnail.
- **Rules and folio.** A heavy and a fine rule under the top bar, a fine rule at the foot of the page, both ending where a plate begins. The folio (the page number) sits at the foot: on the left on even pages, on the right on odd ones, as verso and recto. At each new screen it turns inside its slot, through a mask: up going forward, down going back.
- **Masks.** Titles, texts and blocks come up through a mask when a page opens, one after another; pictures are uncovered from the left; the part number rises on its plate.
- **The motion rules.** Everything is a mask or a fold along its own edge (0.9 s, ease in-out): nothing crosses the page, nothing grows to the window, no shadow, nothing moves when the reader answers. Under reduced motion, captures and slow machines, every page is drawn as it ends, at once.
- **No label above titles.** The folio, the thumb tab and the large part number say where the reader is. No coloured side rule (notes sit on deeper paper under a rule), no frosted glass, no violet.

The backdrop is three CSS layers (`paper`, `ink` for the black spread, `grain` over everything, z-index 2) and the decoration object `objects/folio/` (tabs, plates, rules, folio), which follows the course by its context (rank of the screen and of the section, direction) and keeps out of the player's bars.

## Variants of the backdrop

| Variant | When | What changes |
|---|---|---|
| `paper` (default) | Most screens | Paper and grain, the rules, the folio, the thumb index |
| `plate` | Part openers (with the layout `editorial-opener` and the screen style `opener`); the first and last screens (with the screen style `cover`) | The part's plate on the right of the page (from `--ed-plate-x`, 58 % of the window); every plate side by side on the first and last screens |
| `ink` | The quotation, or a pause | The black spread: ink ground, paper-coloured text, rules and bars; the accent lightens |

On phones (under 640 px) the plates become a slim strip along the right edge, the rules and the folio step aside (the page scrolls), and the part number goes above the title in the part's colour.

## The component

`editorial-opener` (screen layout, a fork of the opening): the part's title, its standfirst (`lead`) and a short page on the left, the `number` (1, 2, 3… or I, II, III) on the plate. Use it with the screen style `opener` and the backdrop `plate`.

## Named styles

| Block | Style | Look |
|---|---|---|
| screen | `cover` | The large serif title on the left of the page, for the `plate` backdrop |
| screen | `opener` | Part opener, with the layout `editorial-opener` |
| text | `dek` | Standfirst: a large italic serif paragraph |
| text | `dropcap` | Opening paragraph with a three-line drop cap in the part's colour |
| text | `contents` | Contents: large italic numerals in the part's colour, rules between rows (each item `**Title**`, a line break, one line) |
| text | `ledger` | One point per row between hairlines, a short rule of the part's colour before each (takeaways, recap) |
| text | `colophon` | Short facts in small capitals between two rules (duration, audience, edition) |
| columns | `spread` | Magazine columns: a heavy rule on top, fine column rules between, a coloured initial |
| columns | `versus` | Face to face: the first on deeper paper, the second under a rule in the part's colour |
| statement | `pull` | Pull quote: very large serif between a heavy and a fine rule; *italic words* take the part's colour |
| image | `plate` | Figure beside its text: hairline caption, the text under a heavy rule and opening with a drop cap |

## Making it a brand's

1. **The plates:** `color.plate-1` … `color.plate-5` in `theme.custom`, in the order of the sections. Keep each at 4.5:1 against `color.paper` (drop caps and chart highlights are drawn on paper) and against `color.on-plate` (the part number and the folio on a plate). Two brand colours are enough: alternate them.
2. **The paper and the ink:** `color.paper`, `color.paper-deep` (notes, the first column of `versus`), `color.grain` (the grain's tint), `color.text` and `color.muted`; for the black spread `color.ink-ground`, `color.text-on-ink`, `color.muted-on-ink`, `color.accent-on-ink`. A white paper works too: set `color.paper` and `color.surface` to white and lower the grain (`.t-backdrop-layer[data-layer="grain"] { opacity }`).
3. **The accent:** `color.accent` (links, the default highlight outside the parts), with `color.focus`. The bars follow the `player.*` tokens (paper bars, ink Next button).
4. **The figures:** `elabora assets .` draws the grain and the printed plate again from the tokens.
5. **The fonts:** `elabora font add . "<family>" --for heading` (a serif with an italic suits the part numbers and standfirsts) and `--for body`.
6. **The plate's width:** the object's `plateStart` (in `theme.backdrop.object.props`) and `--ed-plate-x` in `theme/theme.css` must say the same (0.58 and 58vw).
7. **The decoration's settings** (`theme.backdrop.object.props`): `tabWidth` (rem), `measure` (the width of the rules in rem: `wideWidth ÷ 16`), `folio` (false hides the folio and the foot rule), `duration` (seconds of a fold and of the folio's turn). Its colours are bound to the tokens above.
8. **The parts:** the tabs follow the sections of the module, whatever their number and names; a new part opener is a copy of `part-one` with its `number`.

## Seeing it

`elabora look . --screen <id>` shows a screen as learners see it, its backdrop included: the decoration takes the screen's rank in the module and the room of the player's bars. To see the plates fold and the folio turn from one screen to the next, use `elabora object replay . folio` (the object's tests behind the course) or the built package (`elabora screenshot . --screen all --size 1600x900,375x812 --out-dir <folder>`).
