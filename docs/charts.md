# Charts and diagrams

Elabora's charts say one thing each. A chart block is a sentence the learner should remember (its
`takeaway`), proved by a few numbers or boxes drawn with care. They are built-in blocks with small
forms, drawn when the course is built and moved by the player; for what the catalogue cannot draw,
agents write a free object with D3 and the same kit. The decision and its reasons are
[D60](decisions/D60.md).

## Which block

| Block | What it says | Its items |
|---|---|---|
| `key-figures` | 2–4 numbers to remember | `items[]`: `figure`, `label`, `count`, `was`, `meter` |
| `bars` | A ranking: what dominates | `rows[]`: `label`, `value`, `note` |
| `donut` | A whole in 2–6 parts | `parts[]`: `label`, `value` |
| `trend` | A change over time, and what explains it | `points[]`: `x`, `y`; `note`; `mode: "predict"` |
| `proportion` | "1 in 10" as an icon array | `of`, `part`, `figure`, `label` |
| `before-after` | Who moved, and who moved least | `items[]`: `label`, `before`, `after` |
| `levels` | A funnel (values) or a pyramid (levels) | `items[]`: `label`, `text`, `value`; `shape` |
| `process` | A short procedure | `items[]`: `title`, `text` |
| `cycle` | A loop of stages | `items[]`: `title`, `text`; `center` |
| `matrix` | Items placed on two axes | `items[]`: `label`, `x`, `y`, `text`; `quadrants` |
| `milestones` | Dated events | `items[]`: `date`, `title`, `text` |
| `diagram` | A flow, a decision, a map of ideas | `mermaid`, `labels`, `beats` |

Every block's props are in [Built-in blocks](blocks.md).

**What every chart has.**
- `takeaway` (required): the sentence the chart proves, shown as its title. "Most incidents start with an email", not "Incidents by origin".
- `context`: one line under it (the unit, the population, the period).
- `source`: where the data comes from, under the chart.
- `highlight`: the id of the item that carries the idea. Once every item has arrived, it takes the accent and the others step back (the "focus pull").

Items have ids: highlights, voice beats and translations name them, and an id stays when its item moves.

## How they are drawn and how they move

- **At rest without script.** The build draws each chart as HTML and SVG from the course's tokens and language (numbers with its separators). Packages, captures, fit checks, the Document export and the editor's canvas all show the finished chart. A table of the data is there for screen readers; LESSON.md and the project view get the takeaway and that table.
- **Phones.** Under 560 px of width, a chart changes layout (labels above bars, a vertical timeline) instead of shrinking.
- **The entrance** plays once, when the chart first comes into view: bars grow, the line draws itself with its value riding at its head, cards count up, nodes arrive by depth. About a second, then the highlight takes the colour.
- **Pointing.** The nearest item answers the pointer, a tap or the arrow keys (each item is read aloud). It stands while the others fade to 40 %, over about 200 ms, without bounce; its value appears in a bubble that glides to the next item only while it is still shown.
- **Less motion.** When the learner asks for less motion, charts are shown at rest at once.

## With a voice

On a narrated screen, an item may take `at`, an anchor like a timing's: a line, or a word of a line.

```json
{ "id": "origin", "type": "bars", "props": {
  "takeaway": "Most incidents start with an email", "highlight": "email",
  "rows": [
    { "id": "email", "label": "Email", "value": 62, "at": { "line": "l2", "word": "email" } },
    { "id": "web", "label": "Malicious website", "value": 18, "at": { "line": "l2", "word": "websites" } }
  ] } }
```

- At its moment the item appears and becomes the one the voice talks about: the others step back as on hover. It stays so until the next item's moment, or until the block's `spotlightEnd` (an anchor); without one, until the end of the line of the last item. Then every item stands and the highlight takes the colour.
- `revealOnBeats: false` shows every item from the start and only moves the spotlight.
- A trend's points take `at`: the line draws up to each point as the voice names it. A diagram takes `beats: [{ "node": "B", "at": … }]`.
- Beats are moments of the screen's timeline, like timings: seeking back hides what had not come yet, they are translated with the narration's word markers, and an anchor on words the line does not say is `E_TIMELINE_ANCHOR_MISSING`.

## Predict, then reveal

A trend with `mode: "predict"` stops at `predict.from`. The learner draws the rest of the line (or sets its end with the arrow keys), then presses the button: the real line draws over the guess, and the feedback names both values.

```json
{ "id": "clicks", "type": "trend", "props": {
  "takeaway": "A year of drills divides clicks by six", "unit": "%", "mode": "predict",
  "points": [{ "x": "Jan", "y": 32 }, { "x": "Mar", "y": 27 }, { "x": "May", "y": 21 }, { "x": "Jul", "y": 14 }, { "x": "Sep", "y": 9 }, { "x": "Nov", "y": 5 }],
  "predict": { "from": "May", "hint": "How far do clicks fall by November?", "close": "Well seen: {guess} for {actual}.", "far": "You said {guess}; it fell to {actual}." }
} }
```

- **Not scored by default.** Predicting is a moment of engagement, not a test (`scored: true` counts it like a question, correct within `predict.tolerance`, a tenth of the scale by default).
- The guess is kept in the learner's state (a resumed screen shows it revealed) and sent to the LMS as an interaction. An event can follow it (`quiz.submitted`), and a step can open once it is answered.
- In slides the chart keeps the room its feedback needs from the start.

## Diagrams

`diagram` takes Mermaid text in `mermaid`. [Pele](https://pele.run) draws it when the course is built: flowchart, sequenceDiagram, stateDiagram-v2, mindmap, timeline, journey, ishikawa-beta and venn-beta. Another type is `E_DIAGRAM_TYPE`; a syntax error is `E_DIAGRAM_SYNTAX` with its line and column.

- Two drawings are made: as written, and narrow for phones (left-to-right flows turn top-to-bottom).
- Colours come from the course: `classDef`, `style` and `linkStyle` lines are left out (`W_DIAGRAM_COLOR`). `highlight` names a node.
- Pointing at a node lights the path that leads to it.
- **Translation.** Flowcharts, state diagrams and mind maps are translated word by word into `labels` (by node and edge id), so the Mermaid text stays as written. Other types are translated as a whole text, their syntax kept.

## Agent-made charts

A chart the catalogue cannot draw (two series, a map, a log scale, an explorable model) is a [free object](free-object-contract.md). Its code may import D3 and the kit Elabora's charts are built with:

```js
import * as d3 from 'd3';
import { play, easeOut, hostClock, createFocus, createTip, dataTable, formatValue, dodge } from '@elabora/charts';
```

- `d3` is D3 7.9, bundled into the object; its licence notice goes with it.
- `@elabora/charts` gives: easings (`easeOut`, `easeInOut`, `springEasing` for small arriving pieces), `play(seconds, ease, onProgress, { clock: hostClock(ctx.host) })` for entrances on the host's clock (virtual in tests), `createFocus(root, { axis, items, on, off })` for the magnetic pointer, taps and arrow keys, `createTip(container)` for the value bubble, `formatValue` and `formatMinutes` in the course's language, `dodge` to push labels apart, `monotoneY` and `monotonePath` for lines a point can ride, and `dataTable` for the table screen readers read.
- The same rules hold: one takeaway, playful entrances, soothing answers to the pointer, nothing that depends on motion, words from the manifest's strings, colours from tokens.

## Why charts work this way

The design follows what research on learning from pictures and words has found:

- **Signalling.** Learners learn more when cues show what matters: a title that states the conclusion, one highlighted item, the rest stepping back (Mayer's signalling principle; van Gog, 2014).
- **Temporal contiguity.** Words and the picture they describe are better understood together than one after the other: items come with the voice that names them (Mayer and Fiorella, 2014).
- **Prediction.** Predicting data before seeing it improves recall of the data, even for wrong guesses (Kim, Reinecke and Hullman, 2017); generating an answer helps memory more than reading it (Bertsch et al., 2007).
- **Less is clearer.** A chart that says one idea, with data-ink kept for the data, reads faster than a dense one (Knaflic, 2015; Tufte, 1983).
