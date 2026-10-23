---
name: elabora-charts
description: Show numbers, shares, trends, steps or a flow in an Elabora course with a chart block or a Mermaid diagram, bring its items in step with the narration, let learners predict a trend, or write a chart the catalogue cannot draw as a free object with D3 and the chart kit.
---

# Charts: one idea each

Read `elabora docs charts` (MCP `elabora_docs { page: "charts" }`) for the full guide; this is the checklist.

## Choose
- 2–4 numbers to remember: `key-figures`. A ranking: `bars`. A whole in 2–5 parts: `donut`. A change over time: `trend`. A risk or share as "1 in N": `proportion`. Who moved: `before-after`. A funnel or a pyramid: `levels`. A procedure: `process`. A loop: `cycle`. Two axes: `matrix`. Dates: `milestones`. Boxes and arrows, a mind map, a sequence: `diagram` (Mermaid).
- Never a chart for one number (write it, or `key-figures`), never two ideas in one chart (two charts).
- `elabora_get_schema("<type>")` (shell: `elabora tools call elabora_get_schema --args '{"name":"bars"}'`) gives the props.

## Write
- `takeaway` is the sentence the chart proves ("Most incidents start with an email"), never a label ("Incidents by origin"). When the chart carries the slide, it is the slide's title: set the screen's `showTitle: false` (kept for the menu and screen readers) and put no eyebrow over it.
- `context` only for what neither the title nor the chart says (a unit, population or period the axes do not give): most charts need none, and never a rephrasing of the takeaway. `source` says where the data comes from.
- Give every item a short stable `id`; `highlight` the one that carries the idea (one only).
- Words are in the course language; numbers are numbers (`62`, with `unit: "%"`), formatted by the build.
- Diagrams: `mermaid` holds the Mermaid text; no colours in it (`classDef`, `style`: left out); `highlight` names a node. Keep a flowchart under about 12 boxes, words short.

## With a voice
- On a narrated screen give items `at` (`{ "line": "l2", "word": "email" }`) where the voice names them: they appear then, and the others step back while the voice talks about them. A trend's points take `at`; a diagram takes `beats: [{ "node": "B", "at": … }]`. `spotlightEnd` ends the spotlight; `revealOnBeats: false` keeps everything shown and only moves the spotlight.
- Check with `elabora timeline <screen>` (its « Chart beats » list each item's time) and `elabora look --screen <id> --sheet` (one capture per beat, once the item has arrived), or `--at l2` for one moment (MCP `elabora_look` with `at`).

## Predict, then reveal
- When the learner can reasonably guess where a curve goes, use `trend` with `mode: "predict"` and `predict.from` (the last point shown): they draw the rest, then see the real line. Word `predict.hint`, `close` and `far` (`{guess}`, `{actual}`). Leave it unscored (default) unless the course asks for it to count.

## Charts the catalogue cannot draw
- Ask first whether a block with a clearer takeaway would do. Otherwise write a free object (skill `elabora-free-objects`) whose code imports `d3` and `@elabora/charts`:
  - draw once with the final layout, then reveal with `play(seconds, ease, onProgress, { clock: hostClock(ctx.host) })`: about a second, staggered 40–90 ms, playful;
  - answer the pointer with `createFocus` (nearest item, taps, arrow keys) and `createTip`: 200 ms, no bounce, others at 40 %;
  - `dataTable` for screen readers, `formatValue` for numbers, words in manifest strings, colours from tokens;
  - under `ctx.reducedMotion`, show the final state.
- Expose as props only what an author would change (the data, the highlight, labels), as lists with `x-control: "list"`.
