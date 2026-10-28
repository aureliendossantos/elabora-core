---
npm/elabora: patch (Changed)
npm/@elabora/player: patch (Changed)
---

The learner's player moves with one set of rules, the same as the Elabora app's.
- **Menus and popovers.** The outline opens at once and shrinks back toward its button as it closes. Popovers (display, language, the timeline's speeds and more) grow from their button and go back to it.
- **Layers and sheets.** Modal layers and the PDF viewer grow from the centre with their veil, and leave the same way. Panels come from their side, or from the bottom on phones. Side sheets slide from their edge.
- **Smaller pieces.** Buttons give a little when pressed. The progress bar and the seek thumb move with `translate` and `scale` instead of their size.
- **Less motion asked.** Only fades stay, instead of every animation stopping.
- **Themes and components** can reuse the motion tokens: `--t-ease-*`, `--t-dur-*` and `--t-move` (docs/design.md, « The player's motion »).
