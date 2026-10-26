---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

Panels, characters and the gallery's carousel (D63). `accordion` becomes « Panneaux »: the same items as an accordion (as before), tabs that keep the room of their tallest panel and become an accordion in narrow containers, a grid of flip cards (title and image in front, text behind) or a stack of them one at a time; a `prompt` above them, an image per item. A new `speech` block (« Personnage ») lets a speaker of the course speak to the learner in bubbles beside its portrait, at rest, read « Marc : … » by screen readers; `kind: "thought"` for a thought. A gallery's `carousel` shows one image at a time with its caption, Previous, Next and thumbnails; `zoom` opens a gallery's images or an image in the player's lightbox. A step that waits for exploration says which panels, tabs, cards or images are left. New checks: `W_ITEMS_MANY`, `W_TABS_LABEL_LONG`, `E_SPEECH_SPEAKER`. Exports and the client view carry them as text.
