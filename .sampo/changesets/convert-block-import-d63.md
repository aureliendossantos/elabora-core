---
npm/elabora: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/engine: minor (Added)
npm/@elabora/cli: minor (Added)
---

« Transformer en… »: `convert_block` turns a block into another presentation of its type, or another type that holds the same content, in place and in one undoable change (CLI `elabora convert <screen> <block> --to accordion:cards [--dry-run]`, MCP `elabora_convert_block`, the engine's `conversions` request and `run convert_block`). Panels, steps, interactive pictures and galleries convert into one another, panels into a sort in pairs, steps into a sort in order or the `process` and `milestones` charts, statements, callouts and texts into one another, an image and a gallery of one, a text's list into panels or steps. Ids and item ids are kept and items never reordered, so visited marks and translations follow; each target says in French and English what it keeps, loses (learner progress included) and leaves to write, and what does not fit is refused with its reason (`E_CONVERT_REFUSED`). The canvas takes `elabora/focus` to move a picture's crop while its focal point is dragged. The Rise importer lands statements, quotes, image presentations, galleries, columns, dividers, tabs, flip cards, process, timeline, labeled graphics, sorting, matching, fill in the blank and charts on the starter blocks and D60's charts instead of fallbacks, and a Continue that waits for the block above opens once explored; Storyline publications' matching, sequence, fill-in, word bank and Likert questions become `sort`, `fill-in` and `reflection`. A new skill, `elabora-blocks`, says which starter block to use for what. `add_block` takes `optional`, and `W_COMPLETION_MISMATCH` leaves optional blocks out.
