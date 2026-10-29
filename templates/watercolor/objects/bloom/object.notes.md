# Watercolour blooms

**Decoration.** Washes of water tones bloom on the paper behind the course, as paint spreading into a wet sheet. They carry no information: the course reads the same without them, and the reading area in the middle of the window stays light.

**Follows the course.** Each screen (`screenIndex`) has its own washes around the edges; the first one sits where the second wash of the screen before was, so the paint seems to run on from screen to screen. Moving forward, the new washes spread from a drop while those of the screen before dry into pale stains. Going back, nothing un-spreads: the washes of the screen left fade out and those of the screen found again fade in. Each part (`sectionIndex`) has its tone: lagoon to open, then cerulean, sea glass and deep water, lagoon with blush and ochre to close. Variants: `quiet` (paler, further out), `ink` (light washes on the dark ground of the CSS layers), `dawn` (blush and ochre). Nothing is drawn under the player's bars (`ctx.safeArea`).

**Still frames.** Under reduced motion, once frozen (`host.onStill`) or on the first screen shown, the washes are drawn spread out and dried at once. The canvas is only drawn while something changes.
