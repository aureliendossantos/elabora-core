---
npm/elabora: minor (Added)
npm/@elabora/format: minor (Added)
npm/@elabora/player: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Added)
---

The backdrop knows the course. Its decorative object hears where the screen stands (`screenIndex`, `screenCount`, `sectionIndex`, `sectionCount`, `direction` in `ctx.context`), and the backdrop element carries `data-screen-index`, `data-section-index`, `data-section-count` and `data-direction`: a theme follows the course without copying its sections. The object's safe area is the room the player's bars cover. `theme.backdrop.default` (schemas 0.1.3) is the variant of the screens that pick none, and `#elabora-app[data-backdrop]` the variant shown, for the text and the bars. The layers and the object are painted in a set order (layers `z-index: 0`, object 1). Under reduced motion the backdrop and the bars change at once. A decoration can tell it runs still frames (`host.still`, `host.onStill`). `elabora object new <id> --decoration` writes a decoration to start from; without objectives or `--decoration` it says which to give. `elabora object replay` replays the backdrop's decoration behind the course (`--screen`). A baseline recorded in a single colour is reported (W_GATE_VISUAL_BLANK). A context, safe area or view sent to an object before it is ready is no longer lost.
