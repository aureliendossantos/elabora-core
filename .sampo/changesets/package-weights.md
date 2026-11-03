---
npm/elabora: minor (Added)
npm/@elabora/node: minor (Added)
---

What a package would weigh at each media quality, before it is built: `packageWeights` in `@elabora/node` (`packaging/weights.ts`) and the engine's `packageWeights` request. Nothing is encoded, compiled or written: media are counted as their cached renditions, else estimated from their bitrates, narration tracks as cached, else at 64 kb/s, and the player, its sounds and the course's texts as deflated in the ZIP, within about 2 % of the package the build writes. The assets a package ships are listed in one place (`packaging/assets.ts`), which the build uses too.
