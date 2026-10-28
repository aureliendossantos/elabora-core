# Flow

A dark field lit by two neons, luminous ribbons that undulate low in the window and particles that float across it. For tech, cybersecurity, product launches and sales; it serves classic presentations too. Fonts: Figtree, a geometric grotesque, and JetBrains Mono for everything that counts (SIL OFL, `theme/fonts/`).

## The charter

- **The movement says where the learner goes.** At each new screen the particles stretch into streaks and leap forward, then settle in a little over a second; going back, they leap the other way. A part's first screen leaps a little further and moves the palette from the first neon towards the second (cyan at the start, magenta at the end). A step revealed is a small nudge.
- **The cover is the backdrop's moment.** On the cover and the end (variant `hero`) the ribbons rise and sweep across the right half of the window, brighter, and fade out under the text on the left; leaving the cover, they settle back low as the module starts.
- **No label above the titles.** A part opener (component `flow-section`) sets its number large, in the monospaced font, lit by the two neons.
- Only `transform` and `opacity` move in CSS; the object draws in its own canvas. Less motion asked: still frames, dots, no leap.

The backdrop is three CSS layers (`field`: the neons' glows; `haze`: a luminous band flowing sideways, a mask painted with the neon tokens; `grain`) and the decoration object `objects/flow-field/`, which follows `host.onContext`.

## Variants of the backdrop

| Variant | When | What changes |
|---|---|---|
| *(none)* | Part openers, key message, most screens | The haze at half, every particle, the full leap |
| `hero` | The cover and the end | The ribbons rise across the right half, brighter |
| `calm` | Dense screens: objectives, cards, comparison, question, chart | The haze and glows step back, fewer and dimmer particles, half the leap |
| `ink` | A pause: the quotation, the recap | Light paper with ribbons and particles in ink; the screen's text follows (`theme.css`, « Ink ») while the bars stay dark |

Changing variant is a fade: the object fades out in 0.3 s, changes, and comes back.

## Components and named styles

| | Name | Look |
|---|---|---|
| layout | `flow-cover` | The cover and the end: a very large title, a lead and details on the left half; give the screen the variant `hero` |
| layout | `flow-section` | A part opener: `number` (01, 02…) set large, the title and a lead |
| text | `lead` | Large introductory paragraph |
| text | `meta` | A small monospaced line: a duration, an audience, a version |
| text | `list` | Numbered list with large monospaced numbers (objectives) |
| text | `recap` | A checklist on a card |
| columns | `cards` | Each column on its own card, numbered |
| columns | `versus` | Two columns face to face, the second lit in the accent |

## Making it a brand's

1. **The two neons:** `color.neon-a` and `color.neon-b` in `theme.custom`. The haze, the glows, the part number, the rules and the object (`colorA`, `colorB` are bound to them by `x-token`) follow. Keep two bright colours: they add up on the dark field.
2. **The interface's colours:** `color.primary` (buttons, numbers; `color.onPrimary` on it) and `color.accent` (the charts' highlight, « the better way », the quotation). Usually primary is neon A and accent neon B. The validator checks their contrast (`E_THEME_CONTRAST`); `elabora fit` measures the text on the backdrop's pixels.
3. **The field:** `color.field`, `color.field-deep`, the cards' `color.panel` and `color.panel-edge` (opaque: no frosted glass), and the bars' `player.top.background` and `player.bottom.background`, equal to `color.field`.
4. **The light variant:** `color.paper`, `color.ink`, `color.ink-muted`, `color.ink-a`, `color.ink-b`, `color.ink-panel`, `color.ink-edge`. For a module light from end to end, set the charter's tokens to the light values: the object draws in ink by itself when `color.field` is light.
5. **The fonts:** `elabora font add . "<family>" --for body,heading`; keep a monospaced font for `font.mono` (`--for mono`): it sets the figures.
6. **The movement,** in `theme.backdrop.object.props`: `density` (particles), `lines` (ribbons' brightness), `jump` (the leap; 0 for none). The leap goes forward or back with the course, and each part moves the palette a little further, by its rank: adding or renaming a section needs nothing more.
7. After a change of tokens, `elabora assets .` draws the haze's mask and `signal.svg` again.
