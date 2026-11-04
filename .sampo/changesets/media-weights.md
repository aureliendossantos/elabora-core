---
npm/elabora: minor (Added)
npm/@elabora/core: minor (Added)
npm/@elabora/node: minor (Changed)
npm/@elabora/engine: minor (Changed)
npm/@elabora/cli: minor (Added)
---

What each media weighs in the package, at each media quality, before any build: `elabora media weights [--media-quality q] [--all] [--json]` and MCP `elabora_media_weights` list the media heaviest first, with their kind, file, duration and size, what high, medium and low ship (the master as it is or a rendition, made or estimated, the size shipped), where the course uses them, the narration tracks and the dialogues' lines, and the rest of the package. A media that weighs more than five minutes of video at the quality stands out (about 306 MB at high, 155 MB at medium, 60 MB at low), with why and what lightens it: a long video still heavy after its resize, a large file the qualities leave as it is. `packageWeights` (and the engine's request) now returns `{ quality, qualities, media, rest }` instead of the sizes alone.
