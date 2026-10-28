# Organic

Soft gradient blobs drift behind the screens, under a light grain. For soft skills, wellbeing, onboarding and HR. Font: Nunito, a rounded sans (SIL OFL, `theme/fonts/nunito/`).

## The charter

- **Each screen has its composition.** At a new screen the blobs migrate to new places in 2.4 s, without haste. A blob whose way would cross the window does not fly over the text: it fades out where it was and fades in where it goes.
- **Each part has its hue,** from warm to cool: peach for the opening, then gold, sage and lagoon, sky for the closing. The learner feels the module move on without reading anything. The part's hue also tints a few marks of the page (`--org-part`): the objectives' counters, the shapes above the cards, the part opener's number, the quotation mark.
- **A step revealed** moves the composition a little.
- **Less motion** asked: nothing drifts, each screen shows its composition at once, and the CSS layers stand still. A session resumed on a later screen shows its composition at once too.
- **No label above the titles.** A part opener (screen style `part`) shows its number in a soft blob of the part's hue.

The backdrop (`course.json` › `theme.backdrop`) is CSS layers (`ground`, `night`, two glows that hand over from warm to cool, `grain` over everything, in `theme/theme.css`) and the decoration object `objects/drift/`, a field of rounded lobes drawn on a small canvas the browser enlarges (the enlargement makes the blur). It follows `host.onContext` (screen, section, step, variant) and uses neither WebGL nor the network.

## Variants of the backdrop

A screen picks one with `"backdrop": "<variant>"` (« Décor » in the editor).

| Variant | When | What changes |
|---|---|---|
| *(none)* | Most screens | Bright, soft blobs on a cream ground, in the part's hue |
| `pastel` | Dense screens: cards, practice, steps, comparison | Paler, more transparent blobs; glows halved |
| `night` | A strong moment: the key message | A deep night ground (blue, not violet), glowing blobs, light text and bars |
| `mono` | A sober screen: a quotation, a sensitive subject | Tints of the ink (`color.primary`) only, no glow |
| `none` | A screen without a backdrop | The object stops |

## Named styles

| Block | Style | Look |
|---|---|---|
| screen | `part` | Part opener: the part's number in a soft blob above the title (`layoutProps.eyebrow`: the number) |
| text | `lead` | Large opening paragraph |
| text | `objectives` | Numbered list in soft round counters (objectives, takeaways) |
| text | `meta` | Short facts in soft pills (audience, format, what the part holds) |
| columns | `cards` | Each column on a soft rounded card topped by a blob |
| columns | `compare` | Two columns: the first muted, the second in the part's hue |

## Making it a brand's

Everything goes through the tokens of `course.json` › `theme`; the stylesheet holds no colour of its own.

1. **The brand's colours** (`theme.tokens`): `color.primary` and `color.text` are the ink (also the `mono` variant and the Next button, `player.accent`); `color.accent` is the strong colour of the charts and the character; `color.surface` the ground.
2. **The hues' journey** (`theme.custom`): `color.journey-warm` (the first part), `color.journey-middle`, `color.journey-cool` (the last). The parts between take the hues between them (OKLCH mix). For a monochrome brand, give three close tones; for a journey from cool to warm, swap them. Keep them light: `elabora fit` measures the text on them.
3. **The night:** `color.night`, `color.night-card`, `color.night-text`, `color.night-muted`.
4. **The illustration and the grain** follow the tokens: after a change, `elabora assets .` draws `images/organic-shapes.svg` and `images/grain.svg` again.
5. **The font:** `elabora font add . "<family>" --for body,heading`, a rounded or humanist sans (Nunito, Figtree, Source Sans 3).
6. **The sections.** The hues follow the sections' rank in the course: the blobs go from warm (the first section) to cool (the last); the marks of the text (`[data-section-index]` at the top of `theme/theme.css`) take the four tones of the first five sections, the fifth and after cool. Renaming or adding a section needs nothing more; a screen outside any section keeps the hue it had.
7. **The movement,** in `theme.backdrop.object.props`: `count` (3 to 7 blobs), `drift` (0 still, 1 the most), `transition` (seconds), `seed` (other compositions).
