---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

The player's primitives for starter blocks (D63), usable by any component template: one item at a time (`data-t-sequence` with `data-t-item`, `data-t-prev`, `data-t-next`, optional `data-t-goto` and `data-t-position`: the APG carousel with buttons, arrow keys and a swipe, never moving by itself), flip cards (`data-t-card` with its two `data-t-face` and a `data-t-flip` button; the face away is out of reach, and under reduced motion the turn is a cross-fade), images enlarged in a lightbox (`data-t-zoom` on a button holding the image, with its `data-t-caption`, previous and next between the images of a block, focus kept in it and given back), one part open at a time (`data-t-exclusive`, `="popover"` closing on a click outside), native disclosures that count (`<details data-t-details>`) and elements visited once in view (`data-t-reveal`). Items, cards, details and reveals are controls: visited, saved with the learner's progress and read by conditions. A sequence keeps the room of its tallest item and a card of its taller face, in scroll pages and in slides, so moving through them never moves the page; `elabora screenshot --state answered` and fit checks show the tallest item. The validator checks where each hook goes and what it needs (`E_COMPONENT_HOOK`), and the names bound on each instance. A step may open once explored (`steps.<n>.opens: "explored"`): its Continue, or Next in slides, is shown but locked until the activities above are answered and the controls of their blocks visited, and says what is left ("2 cards left to turn over."); blocks marked `optional: true` count neither for it nor for `completeWhen: "interactions-done"`. The LMS emulator explores such screens as a learner would. Additive fields of format 0.1: no migration.
