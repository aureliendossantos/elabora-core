---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

Three activities of D63 and two presentations of the quiz. `fill-in` (« Texte à trous »): blanks written `[[answer|other accepted]]` in its Markdown, filled by typing (tolerant to case, spaces, quotes and apostrophes, to accents with `ignoreAccents`), from menus, or by placing words from a bank, its answers kept out of the rendered text. `sort` (« Classer »): items placed in `pairs`, into two to four `categories`, or in `order`, by choosing an item then where it goes, with the keyboard or by tapping (a mouse may drag; order also has move buttons). Both score the share of their blanks or items right, take attempts, mark each blank or item and show the right answers after the last try. `reflection` (« Réflexion »): the learner's own words in a field the player builds (`maxLength`, `rows`), with an expert's `model` to compare once saved, or a point on a `scale`; never scored, answered once saved; `download` gives « Mes réponses », a text file of every reflection made in the browser. The quiz shows its options as picture cards (`presentation: "images"`) or as zones on one picture (`"image"`, options at `x`, `y`), named « Zone n » for screen readers until the answer is final. Each activity is a forkable behaviour with its hooks (docs/components.md §3), saved in the v1 suspend data (`f`, `r`, `e`, its worst case counted, a reflection at its `maxLength`), resumed, retaken, recorded as SCORM 1.2 interactions (fill-in, choice, matching, sequencing, likert), announced, given its room in slides, translated, exported as text, and answered by the LMS emulator. New codes: E_FILLIN_NO_BLANK, E_SORT_TARGET, W_ACTIVITY_NO_FEEDBACK, E_QUIZ_PICTURE.
