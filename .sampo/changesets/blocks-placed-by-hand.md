---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/cli: minor (Added)
---

Blocks placed by hand (D72). `block.place { x, y, width, height?, z? }` (schemas 0.1.11) lifts a block of the screen out of the flow into the placement frame, the reference window at the screen's width, in shares of it; its slot and rank stay its anchor, its reading order and where it reads below `presentation.fit.minimum`, on phones and with larger text. In slides `y` is from the top of the frame, centred in the slide; in scroll pages from the anchor, so that a placed block moves with the text before it. `place_block` writes the place and the anchor in one change (`elabora block place`), `arrange_screen` puts a screen's placed blocks back in the flow (`elabora screen arrange`, MCP `elabora_arrange_screen`), `update_block` takes `place`. New codes: I_BLOCK_PLACED, E_PLACED_NESTED, W_PLACED_OUTSIDE, and from `elabora fit` at the reference and the minimum W_PLACED_OVERLAP, W_PLACED_OVERFLOW, W_PLACED_TARGET. The editor's canvas lifts a dragged block (`elabora/lift`), glides what a change moves (`elabora/motion`), reports the frame and the flow's places, and the engine renders a change before it is made (`canvasView { preview }`).
