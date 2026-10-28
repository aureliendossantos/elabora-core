---
name: elabora-blocks
description: Choose the starter block and presentation for what the learner does on a scroll page (panels, cards, steps, an interactive picture, a gallery, a statement, a sort, a fill-in, a reflection), apply the recipes (Do's and Don'ts, Myth vs Fact, Key words, Lesson intro, Persona), and convert a block into another form instead of rewriting it.
---

# Starter blocks: what the learner does

`elabora_get_schema("<type>")` gives the props; `docs/decisions/D63.md` the conventions (items, `presentation`, `focus`, `optional`).

## Learner does → block
| The learner… | Block | Presentation |
|---|---|---|
| reads the one idea to keep | `statement` | `statement`, `ruled`; `quote` with `author`; `image` over a photo |
| opens detail in any order | `accordion` | `accordion` (3–7), `tabs` (2–5 short labels) |
| recalls before turning over | `accordion` | `cards` (with `prompt`), `stack` |
| follows a process or a story | `steps` | `carousel` (with `intro`, `summary`), `timeline` (dated), `scroll` (a figure that changes) |
| finds parts on one picture | `hotspots` | `popover`; `tour` when the parts have an order |
| compares pictures | `gallery` | `grid`, `mosaic`, `carousel`, `compare` (before/after, 2 images) |
| reads side by side | `columns` | `count` 2 or 3, its slots `first`, `second`, `third` |
| meets someone | `speech` | a speaker of `course.json` |
| pauses between parts | `divider` | `line`, `number`, `space` |
| tells cases apart, links, orders | `sort` | `categories`, `pairs`, `order` |
| recalls a word in its sentence | `fill-in` | `typed`, `menus`, `bank` |
| connects it to their work | `reflection` | `text` (with `model`), `scale` |
| starts a lesson | screen `layout: "opening"` | `title`, `band`, `split`, `cover`; a pre-question in slot `question` |

## Recipes
- **Do's and Don'ts**: `columns` of two `callout`s (`tip`, `warning`).
- **Myth vs Fact**: `accordion` `cards`, the myth in front, the fact behind, a `prompt` (« Vrai ou faux ? Décidez avant de retourner »).
- **Key words**: `accordion` `stack`, a word in front, its meaning behind.
- **Lesson intro**: layout `opening` with a `lead` and a `quiz` or `reflection` in `question`, unscored.
- **Persona**: `image` `beside` (the person, a few sentences), then a `statement` `quote` in their words.

## Sizes that read well (Rise courses in the wild)
4 panels, 3 tabs, 4 or 5 steps, 4 markers, 3 to 6 cards, 2 to 5 gallery images. Titles of a few words (tabs 24 characters at most, markers about 15), bodies of two or three sentences (120 to 270 characters).

## Guardrails
- Revealing is not practice: after panels, cards or markers the learner must remember, ask a question (`quiz`, `fill-in`, `sort`). Better still, ask first: a pre-question before the content.
- No more than 7 tabs or carousel steps, 8 markers, 12 cards (`W_ITEMS_MANY`).
- `steps.<n>.opens: "explored"` on the step after a block makes Continue wait until it is explored; mark a block the learner may skip `optional: true`.
- Give pictures `alt` (what matters here) and `focus` where the subject is, so crops keep it.
- A published sort keeps its items' order: placements are saved by index (D63).
- **Carry on, do not show again**: a picture, a figure or a free object that is the same thing on the next screen gets one `continuity` key on both blocks (`elabora block continue . <block> --from <block of the previous screen>`, MCP `elabora_set_continuity`, which also sets the passage's length): it glides from where it was, a free object keeps running (D65). Only for what the learner should see as one thing; the rest of the screen changes as screens always do.

## Convert, do not rewrite
When the content is right but its form is not (panels that should be cards, a list that should be steps, cards that should be practised), convert: `elabora_convert_block { block, to: { type, presentation } }` (CLI `elabora convert <screen> <block> --to accordion:cards`). Without `to`, it lists the targets and what each keeps, loses and adds (or why it refuses). Ids, visited marks and translations follow; nothing is reordered. Switching `presentation` keeps everything. Rewrite only when the words themselves must change.
