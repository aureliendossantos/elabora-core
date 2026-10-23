---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

Charts and diagrams (D60): twelve built-in blocks that each say one thing — key-figures, bars, donut, trend, proportion, before-after, levels (funnel or pyramid), process, cycle, matrix, milestones and diagram (Mermaid drawn by Pele) — with a takeaway as their title, a highlighted item and a data table for screen readers. The build draws them as HTML and SVG from the course's tokens and language, so packages, captures and the editor show them finished without script; the player brings them in with a playful entrance, answers the pointer, taps and arrow keys softly, and on narrated screens brings each item as the voice names it (`at`) while the others step back. A trend in predict mode lets learners draw the rest of the line before revealing it (unscored by default). Diagrams translate word by word into `labels`. New codes: E_CHART_ITEM_DUPLICATE, E_CHART_ITEM_UNKNOWN, E_CHART_DATA, W_CHART_ORDER, E_DIAGRAM_TYPE, E_DIAGRAM_SYNTAX, W_DIAGRAM_COLOR. Free objects may import `d3` and `@elabora/charts`, the kit the blocks move with; the `elabora-charts` skill and the "Charts and diagrams" page guide agents. `elabora timeline` lists a screen's chart beats and `elabora look --sheet` captures each one once its item has arrived; the LMS emulator answers a trend to predict through its slider. While a chart comes in (its entrance, or the voice still bringing its items), pointing waits: no tooltip and nothing pointed at until it is all there. A step lasts until its last chart item has arrived, so a beat near the end of the voice is never cut short. A funnel can leave out the drop between its rows (`showDrops: false`), and a trend the values written on its line (`valueLabels`: `ends`, `end` or `none`). A new sample, phishing-by-numbers, shows the twelve on narrated slides.
