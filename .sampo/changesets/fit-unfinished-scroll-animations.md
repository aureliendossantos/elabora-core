---
npm/elabora: minor (Added)
npm/@elabora/node: minor (Added)
npm/@elabora/core: minor (Added)
---

`elabora fit` reports `W_SCROLL_ANIMATION_UNFINISHED` on scroll pages: an animation driven by the scroll (`view()` or `scroll()`) that has not reached its end when the page is scrolled to the bottom. The block keeps its half-faded, moved or turned state. The message names the block, the animation and where it stops, and `elabora look --scroll 100% --block <id>` shows it there.
