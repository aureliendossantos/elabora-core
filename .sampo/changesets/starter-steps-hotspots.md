---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/cli: minor (Added)
---

Starter interactions for scroll courses (D63): a `steps` block (« Étapes », not the screen's steps) as a `carousel` (one step at a time, an intro and a summary first and last, the room of the tallest step kept), a `timeline` (« Frise »: dated steps on a line, each seen once in view) or a `scroll` (« Défilé »: native scroll, a figure that stays in view beside the text and follows the step crossing the middle of the window, replacing its picture, building up in layers or outlining a region; each step with its own picture on phones, in slides and with less motion); and `hotspots` (« Image interactive »: markers of 44 px placed at x, y of the whole picture, numbered or with an icon, their texts in a popover, beside or under the picture, or as a tour; a numbered list under the picture on narrow places). The player's `data-t-follow` primitive follows reveals as the page scrolls. A step that waits for exploration says what is left in steps, events and markers. New checks: `W_ITEMS_MANY`, `W_HOTSPOTS_CLOSE`, `W_STEPS_SCROLL_SLIDES`, `E_STEPS_FIGURE`, `E_BLOCK_ITEM_DUPLICATE`. LESSON.md, the client view and translation carry their words.
